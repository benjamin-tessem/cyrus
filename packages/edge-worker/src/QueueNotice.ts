/**
 * Tells a session's issue tracker that its runner is waiting for a
 * concurrency slot (see {@link SessionSemaphore}).
 *
 * Linear marks an agent session "stale" after roughly 30 minutes without an
 * activity, which reads as an error. A runner queued behind
 * maxConcurrentSessions is silent by construction, so while it waits we post
 * an ephemeral thought saying where it is in line, and refresh it well inside
 * that window. Ephemeral activities are replaced by the agent's next message,
 * so the thread doesn't fill up with notices.
 */

import type { ILogger } from "cyrus-core";
import type {
	QueuedWaiter,
	RunnerStartObserver,
	SessionSemaphore,
} from "./RunnerConcurrency.js";

/** How often a still-waiting runner re-posts its notice. */
export const QUEUE_NOTICE_INTERVAL_MS = 15 * 60 * 1000;

/** What the notifier needs to know about the session a runner belongs to. */
export interface QueueNoticeTarget {
	/** Names the session in other sessions' notices while it runs, e.g. "DEF-12". */
	label?: string;
	/**
	 * Post the notice to the session (an ephemeral thought). Omit for sessions
	 * with nowhere to post; they still show up as running. Failures are logged.
	 */
	post?: (body: string) => Promise<unknown>;
}

export function queueNoticeBody(
	limit: number,
	running: number,
	runningLabels: string[],
	position: number,
): string {
	const unnamed = running - runningLabels.length;
	const names = [
		...runningLabels,
		...(unnamed > 0 ? [`+${unnamed} other${unnamed === 1 ? "" : "s"}`] : []),
	];
	const runningNow =
		names.length > 0 ? `${running} (${names.join(", ")})` : `${running}`;
	const place =
		position <= 1 ? "next in line" : `${position - 1} ahead of this one`;
	return (
		`Queued — waiting for a free slot (Cyrus runs ${limit} at a time). ` +
		`Running now: ${runningNow}; ${place}. ` +
		"Work starts automatically; nothing to do."
	);
}

export class QueueNotifier {
	/** Labels of observed runners that currently hold a slot. */
	private readonly running = new Map<object, string | undefined>();
	private readonly timers = new Set<ReturnType<typeof setInterval>>();

	constructor(
		private readonly slots: Pick<SessionSemaphore, "active" | "currentLimit">,
		private readonly logger: ILogger,
		private readonly intervalMs = QUEUE_NOTICE_INTERVAL_MS,
	) {}

	/** An observer for one runner's starts (pass to capRunnerStarts). */
	observe(target: QueueNoticeTarget): RunnerStartObserver {
		const token = {};
		let timer: ReturnType<typeof setInterval> | undefined;
		const stopTimer = () => {
			if (timer === undefined) return;
			clearInterval(timer);
			this.timers.delete(timer);
			timer = undefined;
		};

		return {
			queued: (waiter) => {
				const post = target.post;
				if (!post) return;
				stopTimer();
				const notify = () => {
					if (!this.postPosition(waiter, post, target.label)) stopTimer();
				};
				notify();
				timer = setInterval(notify, this.intervalMs);
				timer.unref?.();
				this.timers.add(timer);
			},
			started: () => {
				stopTimer();
				this.running.set(token, target.label);
			},
			withdrawn: stopTimer,
			finished: () => {
				this.running.delete(token);
			},
		};
	}

	/** Stop every refresh timer (EdgeWorker shutdown). */
	stop(): void {
		for (const timer of this.timers) clearInterval(timer);
		this.timers.clear();
	}

	/** Post the waiter's current place in line; false once it has left the queue. */
	private postPosition(
		waiter: QueuedWaiter,
		post: (body: string) => Promise<unknown>,
		label: string | undefined,
	): boolean {
		const position = waiter.position();
		if (position === undefined) return false;
		const runningLabels = [...this.running.values()].filter(
			(name): name is string => name !== undefined,
		);
		const body = queueNoticeBody(
			this.slots.currentLimit,
			this.slots.active,
			runningLabels,
			position,
		);
		const failed = (error: unknown) =>
			this.logger.warn(
				`Failed to post queue notice${label ? ` for ${label}` : ""}`,
				error,
			);
		try {
			post(body).catch(failed);
		} catch (error) {
			failed(error);
		}
		return true;
	}
}
