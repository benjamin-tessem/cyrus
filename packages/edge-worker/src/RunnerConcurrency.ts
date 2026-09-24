/**
 * Global concurrency cap for agent runner sessions.
 *
 * Every runner created by the EdgeWorker resolves `start()` /
 * `startStreaming()` only when its session finishes, so holding a semaphore
 * slot for the duration of that promise bounds how many sessions execute at
 * once. Hosts running many webhook-driven sessions use this to keep total
 * runner memory/CPU inside what the machine can serve, instead of letting an
 * unbounded burst of sessions take the whole process down (e.g. via the
 * kernel OOM killer).
 */

import type { IAgentRunner } from "cyrus-core";

interface Waiter {
	admit: () => void;
	priority: boolean;
}

/** A queued acquire()'s view of its place in line. */
export interface QueuedWaiter {
	readonly priority: boolean;
	/**
	 * 1-based place in line (1 = admitted next), read live as the queue
	 * moves. Undefined once admitted or withdrawn.
	 */
	position(): number | undefined;
}

/**
 * Counting semaphore with FIFO waiters and a live-adjustable limit.
 *
 * `Number.POSITIVE_INFINITY` means uncapped — `acquire()` resolves
 * immediately. Lowering the limit never interrupts running sessions; it
 * simply stops admitting new ones until enough slots free up.
 *
 * Priority waiters (follow-ups on existing work: a Linear reply, a PR review
 * or comment) queue ahead of normal ones (brand-new tickets), FIFO among
 * themselves, so fixing a red PR doesn't wait behind every new ticket.
 */
export class SessionSemaphore {
	private activeCount = 0;
	private waiters: Waiter[] = [];

	constructor(
		private limit: number,
		private readonly onQueued?: (message: string) => void,
	) {
		if (Number.isNaN(limit) || limit < 1) {
			throw new Error(
				`SessionSemaphore limit must be >= 1 or Infinity, got ${limit}`,
			);
		}
	}

	get active(): number {
		return this.activeCount;
	}

	get waiting(): number {
		return this.waiters.length;
	}

	get currentLimit(): number {
		return this.limit;
	}

	/**
	 * Take a slot, waiting if all are in use. Aborting `signal` while still
	 * waiting withdraws from the queue and rejects with the signal's reason;
	 * the active count is untouched. Once admitted, aborting has no effect —
	 * the caller owns the slot and must release() it.
	 *
	 * `onQueued` is called (synchronously) only when the acquire has to wait,
	 * with a handle for reading its place in line while it waits.
	 */
	acquire(
		priority = false,
		signal?: AbortSignal,
		onQueued?: (waiter: QueuedWaiter) => void,
	): Promise<void> {
		if (signal?.aborted) {
			return Promise.reject(signal.reason);
		}
		if (this.activeCount < this.limit) {
			this.activeCount++;
			return Promise.resolve();
		}
		return new Promise<void>((resolve, reject) => {
			const onAbort = () => {
				const index = this.waiters.indexOf(waiter);
				if (index === -1) return; // already admitted
				this.waiters.splice(index, 1);
				reject(signal?.reason);
			};
			const waiter: Waiter = {
				admit: () => {
					signal?.removeEventListener("abort", onAbort);
					resolve();
				},
				priority,
			};
			signal?.addEventListener("abort", onAbort, { once: true });
			const firstNormal = this.waiters.findIndex((w) => !w.priority);
			if (priority && firstNormal !== -1) {
				this.waiters.splice(firstNormal, 0, waiter);
			} else {
				this.waiters.push(waiter);
			}
			this.onQueued?.(
				`Session start queued: ${this.activeCount} running at the ` +
					`maxConcurrentSessions limit of ${this.limit}, ` +
					`${this.waiters.length} waiting` +
					(priority ? " (follow-up: queued ahead of new tickets)" : ""),
			);
			onQueued?.({
				priority,
				position: () => {
					const index = this.waiters.indexOf(waiter);
					return index === -1 ? undefined : index + 1;
				},
			});
		});
	}

	release(): void {
		if (this.activeCount === 0) {
			// A release with nothing active is a bookkeeping bug in the caller;
			// clamp rather than let the count go negative and over-admit later.
			return;
		}
		this.activeCount--;
		this.admitWaiters();
	}

	/**
	 * Adjust the limit at runtime (config hot-reload). Raising it admits
	 * queued sessions immediately; lowering it applies as sessions finish.
	 */
	setLimit(limit: number): void {
		if (Number.isNaN(limit) || limit < 1) {
			throw new Error(
				`SessionSemaphore limit must be >= 1 or Infinity, got ${limit}`,
			);
		}
		this.limit = limit;
		this.admitWaiters();
	}

	private admitWaiters(): void {
		while (this.waiters.length > 0 && this.activeCount < this.limit) {
			this.activeCount++;
			const next = this.waiters.shift();
			next?.admit();
		}
	}
}

/**
 * Rejection for a start() whose runner was stopped before it got a slot.
 *
 * `prompt` is the start's prompt when nothing else has taken it (see
 * {@link takePendingStartPrompt}), so the caller can deliver it elsewhere
 * rather than drop it.
 */
export class RunnerStartCancelledError extends Error {
	constructor(readonly prompt?: string) {
		super("Runner was stopped before its session started");
		this.name = "RunnerStartCancelledError";
	}
}

/** Where a gated runner is in its start lifecycle. */
type StartStage =
	/** start() not called yet. */
	| "idle"
	/** start() called, waiting for a slot. */
	| "queued"
	/** Holds a slot; the underlying runner is running. */
	| "running"
	/** The session ended and the slot was released. */
	| "done"
	/** Stopped before it got a slot; start() never reaches the runner. */
	| "cancelled";

interface StartControl {
	stage: StartStage;
	/** Prompt of the queued (or cancelled) start. */
	prompt?: string;
	/** True once the prompt was handed to another runner. */
	promptTaken: boolean;
	/** Earlier undelivered messages to put ahead of this runner's prompt. */
	carried: string[];
	abort: AbortController;
}

/**
 * Hooks into a gated runner's start lifecycle, e.g. to tell the session's
 * issue tracker it is waiting for a slot. Each is optional; exceptions are
 * swallowed so an observer can never break a runner start.
 */
export interface RunnerStartObserver {
	/** start() has to wait for a slot. */
	queued?(waiter: QueuedWaiter): void;
	/** start() holds a slot; the session is about to run. */
	started?(): void;
	/** start() gave up its place without running (the runner was stopped). */
	withdrawn?(): void;
	/** The session ended and released its slot. */
	finished?(): void;
}

const START_CONTROL = Symbol("cyrus.startControl");

function startControlOf(runner: IAgentRunner): StartControl | undefined {
	return (runner as unknown as Record<symbol, StartControl | undefined>)[
		START_CONTROL
	];
}

/**
 * Take the prompt of a runner that is waiting for a slot (or was cancelled
 * while waiting), so a replacement runner can deliver it. Returns undefined
 * when there is none, or when it was already taken. After this the
 * cancelled start rejects without a prompt, so it isn't delivered twice.
 */
export function takePendingStartPrompt(
	runner: IAgentRunner,
): string | undefined {
	const control = startControlOf(runner);
	if (
		!control ||
		control.promptTaken ||
		control.prompt === undefined ||
		(control.stage !== "queued" && control.stage !== "cancelled")
	) {
		return undefined;
	}
	control.promptTaken = true;
	return control.prompt;
}

/**
 * The prompt a runner is still waiting for a slot to deliver, without taking
 * it. Used at shutdown to save queued follow-ups so a restart can replay them.
 */
export function peekQueuedStartPrompt(
	runner: IAgentRunner,
): string | undefined {
	const control = startControlOf(runner);
	if (!control || control.stage !== "queued" || control.promptTaken) {
		return undefined;
	}
	return withCarried(control.carried, control.prompt);
}

/**
 * Queue an earlier, undelivered message to go ahead of this runner's prompt
 * when it starts. Returns false if the runner has already started (use
 * addStreamMessage instead) or isn't a gated runner.
 */
export function carryIntoPendingStart(
	runner: IAgentRunner,
	message: string,
): boolean {
	const control = startControlOf(runner);
	if (!control || (control.stage !== "idle" && control.stage !== "queued")) {
		return false;
	}
	control.carried.push(message);
	return true;
}

function withCarried(carried: string[], prompt?: string): string | undefined {
	if (carried.length === 0) return prompt;
	const earlier = carried
		.map(
			(message) =>
				`<earlier_message note="Sent before the message below; it was queued and not delivered to you yet.">\n${message}\n</earlier_message>`,
		)
		.join("\n\n");
	return prompt ? `${earlier}\n\n${prompt}` : earlier;
}

/**
 * Wrap a runner so `start()` and `startStreaming()` hold a semaphore slot for
 * their full duration. Both resolve when the session completes, so the slot
 * is held for the session's lifetime and released on success and failure
 * alike. Follow-up messages streamed into an already-started session
 * (`addStreamMessage`) are untouched — the session already holds its slot.
 *
 * `stop()` before the runner holds a slot cancels it instead: a queued
 * start() leaves the queue and rejects with {@link RunnerStartCancelledError},
 * and a later start() rejects the same way. The underlying runner never
 * starts. (Runners' own stop() is a no-op before start, so without this a
 * replaced or stopped runner would still start once admitted.) After it holds
 * a slot, stop() goes to the runner as usual.
 *
 * The wrapper is a Proxy rather than an instance mutation: the underlying
 * runner is never modified, every other property forwards through unchanged,
 * and the original methods stay observable (e.g. as test spies).
 *
 * `priority` marks a follow-up on existing work; see {@link SessionSemaphore}.
 * `observer` hears about the start's queueing and slot lifecycle.
 */
export function capRunnerStarts(
	runner: IAgentRunner,
	semaphore: SessionSemaphore,
	priority = false,
	observer?: RunnerStartObserver,
): IAgentRunner {
	const control: StartControl = {
		stage: "idle",
		promptTaken: false,
		carried: [],
		abort: new AbortController(),
	};

	const cancelled = (prompt?: string) => {
		const untaken = control.promptTaken ? undefined : prompt;
		control.promptTaken = true;
		return new RunnerStartCancelledError(untaken);
	};

	const notify = (call: (observer: RunnerStartObserver) => void) => {
		if (!observer) return;
		try {
			call(observer);
		} catch {
			// An observer must never break a runner start.
		}
	};

	const gate = async <T>(
		prompt: string | undefined,
		run: (prompt: string | undefined) => Promise<T>,
	): Promise<T> => {
		if (control.stage === "cancelled") {
			throw cancelled(prompt);
		}
		control.stage = "queued";
		control.prompt = prompt;
		try {
			await semaphore.acquire(priority, control.abort.signal, (waiter) =>
				notify((o) => o.queued?.(waiter)),
			);
		} catch (error) {
			notify((o) => o.withdrawn?.());
			if (control.abort.signal.aborted) throw cancelled(prompt);
			throw error;
		}
		// Stopped after admission but before this continuation ran: we hold a
		// slot the session will never use.
		if (control.abort.signal.aborted) {
			semaphore.release();
			notify((o) => o.withdrawn?.());
			throw cancelled(prompt);
		}
		control.stage = "running";
		notify((o) => o.started?.());
		try {
			return await run(withCarried(control.carried, prompt));
		} finally {
			control.stage = "done";
			control.carried = [];
			semaphore.release();
			notify((o) => o.finished?.());
		}
	};

	return new Proxy(runner, {
		get(target, property, receiver) {
			if (property === START_CONTROL) {
				return control;
			}
			if (property === "start") {
				return (prompt: string) =>
					gate(prompt, (p) => target.start(p ?? prompt));
			}
			if (
				property === "startStreaming" &&
				typeof target.startStreaming === "function"
			) {
				return (initialPrompt?: string) =>
					gate(initialPrompt, (p) =>
						// biome-ignore lint/style/noNonNullAssertion: guarded by the typeof check above
						target.startStreaming!(p),
					);
			}
			if (property === "stop") {
				return () => {
					if (control.stage === "idle" || control.stage === "queued") {
						control.stage = "cancelled";
						control.abort.abort();
						return;
					}
					if (control.stage === "cancelled") return;
					return target.stop();
				};
			}
			return Reflect.get(target, property, receiver);
		},
	});
}
