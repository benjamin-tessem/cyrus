/**
 * Queue notices: a runner waiting behind maxConcurrentSessions tells its
 * Linear session where it is in line, so Linear doesn't mark the silent
 * session stale (~30 min without an activity).
 */

import type { IAgentRunner, ILogger } from "cyrus-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSessionManager } from "../src/AgentSessionManager.js";
import {
	QUEUE_NOTICE_INTERVAL_MS,
	type QueueNoticeTarget,
	QueueNotifier,
	queueNoticeBody,
} from "../src/QueueNotice.js";
import {
	capRunnerStarts,
	RunnerStartCancelledError,
	SessionSemaphore,
} from "../src/RunnerConcurrency.js";
import type { IActivitySink } from "../src/sinks/IActivitySink.js";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

function logger(): ILogger {
	return {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	} as unknown as ILogger;
}

describe("queue notices", () => {
	let semaphore: SessionSemaphore;
	let log: ILogger;
	let notifier: QueueNotifier;

	beforeEach(() => {
		vi.useFakeTimers();
		semaphore = new SessionSemaphore(2);
		log = logger();
		notifier = new QueueNotifier(semaphore, log);
	});

	afterEach(() => {
		notifier.stop();
		vi.useRealTimers();
	});

	/** A gated runner whose session runs until `finish()`. */
	function runner(target: QueueNoticeTarget, priority = false) {
		const done = deferred<{ sessionId: string }>();
		const start = vi.fn(() => done.promise);
		const gated = capRunnerStarts(
			{ start, stop: vi.fn() } as unknown as IAgentRunner,
			semaphore,
			priority,
			notifier.observe(target),
		);
		return {
			runner: gated,
			start,
			run: (prompt = "go") => gated.start(prompt),
			finish: () => done.resolve({ sessionId: "x" }),
		};
	}

	/** A Linear session's target that records what it was told. */
	function linear(label: string) {
		const post = vi.fn((_body: string) => Promise.resolve());
		return { target: { label, post }, post };
	}

	async function fillSlots(...labels: string[]) {
		const running = labels.map((label) => runner({ label }));
		for (const r of running) void r.run();
		await vi.advanceTimersByTimeAsync(0);
		return running;
	}

	it("posts one notice with the queue position when a runner has to wait", async () => {
		await fillSlots("DEF-1", "DEF-2");
		const a = linear("DEF-3");
		const b = linear("DEF-4");
		void runner(a.target).run();
		void runner(b.target).run();
		await vi.advanceTimersByTimeAsync(0);

		expect(a.post).toHaveBeenCalledTimes(1);
		expect(a.post).toHaveBeenCalledWith(
			"Queued — waiting for a free slot (Cyrus runs 2 at a time). " +
				"Running now: 2 (DEF-1, DEF-2); next in line. " +
				"Work starts automatically; nothing to do.",
		);
		expect(b.post).toHaveBeenCalledTimes(1);
		expect(b.post.mock.calls[0]![0]).toContain("1 ahead of this one");
	});

	it("posts nothing when a slot is free", async () => {
		const a = linear("DEF-1");
		const r = runner(a.target);
		void r.run();
		await vi.advanceTimersByTimeAsync(QUEUE_NOTICE_INTERVAL_MS * 3);

		expect(r.start).toHaveBeenCalled();
		expect(a.post).not.toHaveBeenCalled();
	});

	it("refreshes the notice on an interval with the current position", async () => {
		const [first] = await fillSlots("DEF-1", "DEF-2");
		void runner(linear("DEF-3").target).run();
		const b = linear("DEF-4");
		void runner(b.target).run();
		await vi.advanceTimersByTimeAsync(0);
		expect(b.post.mock.calls[0]![0]).toContain("1 ahead of this one");

		// DEF-1 finishes; DEF-3 takes its slot and DEF-4 moves up. Queue
		// movement alone doesn't post...
		first!.finish();
		await vi.advanceTimersByTimeAsync(0);
		expect(b.post).toHaveBeenCalledTimes(1);

		// ...the next refresh does, with the new position and running set.
		await vi.advanceTimersByTimeAsync(QUEUE_NOTICE_INTERVAL_MS);
		expect(b.post).toHaveBeenCalledTimes(2);
		expect(b.post.mock.calls[1]![0]).toContain(
			"Running now: 2 (DEF-2, DEF-3); next in line.",
		);
	});

	it("stops refreshing once the runner is admitted", async () => {
		const [first] = await fillSlots("DEF-1", "DEF-2");
		const a = linear("DEF-3");
		const r = runner(a.target);
		void r.run();
		await vi.advanceTimersByTimeAsync(0);

		first!.finish();
		await vi.advanceTimersByTimeAsync(0);
		expect(r.start).toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(QUEUE_NOTICE_INTERVAL_MS * 3);
		expect(a.post).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("stops refreshing when the queued runner is stopped", async () => {
		await fillSlots("DEF-1", "DEF-2");
		const a = linear("DEF-3");
		const r = runner(a.target);
		const started = r.run();
		await vi.advanceTimersByTimeAsync(0);

		r.runner.stop();
		await expect(started).rejects.toBeInstanceOf(RunnerStartCancelledError);

		await vi.advanceTimersByTimeAsync(QUEUE_NOTICE_INTERVAL_MS * 3);
		expect(a.post).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("stops every refresh when the notifier stops", async () => {
		await fillSlots("DEF-1", "DEF-2");
		const a = linear("DEF-3");
		void runner(a.target).run();
		await vi.advanceTimersByTimeAsync(0);

		notifier.stop();
		await vi.advanceTimersByTimeAsync(QUEUE_NOTICE_INTERVAL_MS * 3);
		expect(a.post).toHaveBeenCalledTimes(1);
	});

	it("shows a follow-up ahead of new tickets", async () => {
		await fillSlots("DEF-1", "DEF-2");
		const ticket = linear("DEF-3");
		const followUp = linear("DEF-4");
		void runner(ticket.target).run();
		await vi.advanceTimersByTimeAsync(0);
		void runner(followUp.target, true).run();
		await vi.advanceTimersByTimeAsync(0);

		expect(followUp.post.mock.calls[0]![0]).toContain("next in line");

		await vi.advanceTimersByTimeAsync(QUEUE_NOTICE_INTERVAL_MS);
		expect(ticket.post.mock.calls[1]![0]).toContain("1 ahead of this one");
	});

	it("counts running sessions it can't name", async () => {
		// Two unobserved runners (e.g. chat sessions) hold the slots.
		await semaphore.acquire();
		await semaphore.acquire();
		const a = linear("DEF-3");
		void runner(a.target).run();
		await vi.advanceTimersByTimeAsync(0);

		expect(a.post.mock.calls[0]![0]).toContain("Running now: 2 (+2 others);");
	});

	it("still starts the runner when posting fails", async () => {
		const [first] = await fillSlots("DEF-1", "DEF-2");
		const rejecting = vi.fn(() => Promise.reject(new Error("Linear down")));
		const throwing = vi.fn(() => {
			throw new Error("boom");
		});
		const a = runner({ label: "DEF-3", post: rejecting });
		const b = runner({ label: "DEF-4", post: throwing });
		void a.run();
		void b.run();
		await vi.advanceTimersByTimeAsync(0);
		expect(log.warn).toHaveBeenCalledTimes(2);

		await vi.advanceTimersByTimeAsync(QUEUE_NOTICE_INTERVAL_MS);
		expect(rejecting).toHaveBeenCalledTimes(2);

		first!.finish();
		await vi.advanceTimersByTimeAsync(0);
		expect(a.start).toHaveBeenCalledWith("go");
	});

	it("words positions and running sessions", () => {
		expect(queueNoticeBody(3, 3, ["DEF-1"], 4)).toBe(
			"Queued — waiting for a free slot (Cyrus runs 3 at a time). " +
				"Running now: 3 (DEF-1, +2 others); 3 ahead of this one. " +
				"Work starts automatically; nothing to do.",
		);
		expect(queueNoticeBody(1, 1, [], 1)).toContain(
			"Running now: 1 (+1 other); next in line.",
		);
	});
});

describe("AgentSessionManager.postQueuedNotice", () => {
	function manager() {
		const sink: IActivitySink = {
			id: "test-workspace",
			postActivity: vi.fn().mockResolvedValue({ activityId: "a-1" }),
			createAgentSession: vi.fn(),
		};
		const sessions = new AgentSessionManager();
		sessions.createCyrusAgentSession(
			"s1",
			"issue-1",
			{
				id: "issue-1",
				identifier: "DEF-1",
				title: "Queued work",
				description: "",
				branchName: "def-1",
			},
			{ path: "/tmp/workspace", isGitWorktree: false },
		);
		sessions.setActivitySink("s1", sink);
		return { sessions, sink };
	}

	it("posts an ephemeral thought to the session's Linear agent session", async () => {
		const { sessions, sink } = manager();

		await sessions.postQueuedNotice("s1", "Queued — …");

		expect(sink.postActivity).toHaveBeenCalledWith(
			"s1",
			{ type: "thought", body: "Queued — …" },
			{ ephemeral: true },
		);
	});

	it("is a no-op for a session it doesn't know", async () => {
		const { sessions, sink } = manager();

		await expect(
			sessions.postQueuedNotice("chat-1", "Queued — …"),
		).resolves.toBeUndefined();
		expect(sink.postActivity).not.toHaveBeenCalled();
	});

	it("logs rather than throws when the post fails", async () => {
		const { sessions, sink } = manager();
		vi.mocked(sink.postActivity).mockRejectedValue(new Error("Linear down"));

		await expect(
			sessions.postQueuedNotice("s1", "Queued — …"),
		).resolves.toBeUndefined();
	});
});
