/**
 * Tests for the global session concurrency cap (maxConcurrentSessions).
 *
 * Runners resolve start()/startStreaming() when the session finishes, so
 * holding a semaphore slot across that promise bounds concurrent sessions.
 */

import type { AgentSessionInfo, IAgentRunner } from "cyrus-core";
import { describe, expect, it, vi } from "vitest";
import {
	capRunnerStarts,
	carryIntoPendingStart,
	RunnerStartCancelledError,
	SessionSemaphore,
	takePendingStartPrompt,
} from "../src/RunnerConcurrency.js";

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

const sessionInfo = (id: string): AgentSessionInfo =>
	({ sessionId: id }) as AgentSessionInfo;

/** A runner whose start()/startStreaming() completion the test controls. */
function fakeRunner(streaming: boolean) {
	const startGate = deferred<AgentSessionInfo>();
	const streamingGate = deferred<AgentSessionInfo>();
	const started = vi.fn(() => startGate.promise);
	const startedStreaming = vi.fn(() => streamingGate.promise);
	const stopped = vi.fn();
	const runner = {
		supportsStreamingInput: streaming,
		start: started,
		stop: stopped,
		...(streaming ? { startStreaming: startedStreaming } : {}),
	} as unknown as IAgentRunner;
	return {
		runner,
		started,
		startedStreaming,
		stopped,
		startGate,
		streamingGate,
	};
}

async function settled(): Promise<void> {
	// Let queued microtasks (semaphore admissions) run.
	await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("SessionSemaphore", () => {
	it("admits immediately below the limit and queues at it", async () => {
		const semaphore = new SessionSemaphore(2);
		await semaphore.acquire();
		await semaphore.acquire();
		expect(semaphore.active).toBe(2);

		let third = false;
		const pending = semaphore.acquire().then(() => {
			third = true;
		});
		await settled();
		expect(third).toBe(false);
		expect(semaphore.waiting).toBe(1);

		semaphore.release();
		await pending;
		expect(third).toBe(true);
		expect(semaphore.active).toBe(2);
		expect(semaphore.waiting).toBe(0);
	});

	it("wakes waiters in FIFO order", async () => {
		const semaphore = new SessionSemaphore(1);
		await semaphore.acquire();

		const order: number[] = [];
		const first = semaphore.acquire().then(() => order.push(1));
		const second = semaphore.acquire().then(() => order.push(2));

		semaphore.release();
		await first;
		semaphore.release();
		await second;
		expect(order).toEqual([1, 2]);
	});

	it("never blocks when the limit is Infinity", async () => {
		const semaphore = new SessionSemaphore(Number.POSITIVE_INFINITY);
		for (let i = 0; i < 100; i++) {
			await semaphore.acquire();
		}
		expect(semaphore.active).toBe(100);
		expect(semaphore.waiting).toBe(0);
	});

	it("admits queued waiters when the limit is raised", async () => {
		const semaphore = new SessionSemaphore(1);
		await semaphore.acquire();
		let admitted = false;
		const pending = semaphore.acquire().then(() => {
			admitted = true;
		});
		await settled();
		expect(admitted).toBe(false);

		semaphore.setLimit(2);
		await pending;
		expect(admitted).toBe(true);
	});

	it("applies a lowered limit as sessions finish", async () => {
		const semaphore = new SessionSemaphore(2);
		await semaphore.acquire();
		await semaphore.acquire();

		semaphore.setLimit(1);
		semaphore.release();
		// Still at the (new) limit: one active, so a new acquire queues.
		let admitted = false;
		semaphore.acquire().then(() => {
			admitted = true;
		});
		await settled();
		expect(admitted).toBe(false);
		expect(semaphore.active).toBe(1);
	});

	it("reports queueing through the onQueued callback", async () => {
		const onQueued = vi.fn();
		const semaphore = new SessionSemaphore(1, onQueued);
		await semaphore.acquire();
		expect(onQueued).not.toHaveBeenCalled();
		void semaphore.acquire();
		expect(onQueued).toHaveBeenCalledOnce();
	});

	it("queues priority waiters ahead of normal ones, FIFO among themselves", async () => {
		const semaphore = new SessionSemaphore(1);
		await semaphore.acquire();

		const order: string[] = [];
		const waits = [
			semaphore.acquire().then(() => order.push("new-1")),
			semaphore.acquire().then(() => order.push("new-2")),
			semaphore.acquire(true).then(() => order.push("follow-up-1")),
			semaphore.acquire(true).then(() => order.push("follow-up-2")),
			semaphore.acquire().then(() => order.push("new-3")),
		];
		for (let i = 0; i < waits.length; i++) {
			semaphore.release();
			await settled();
		}
		await Promise.all(waits);
		expect(order).toEqual([
			"follow-up-1",
			"follow-up-2",
			"new-1",
			"new-2",
			"new-3",
		]);
	});

	it("appends priority waiters when only priority waiters are queued", async () => {
		const semaphore = new SessionSemaphore(1);
		await semaphore.acquire();

		const order: number[] = [];
		const first = semaphore.acquire(true).then(() => order.push(1));
		const second = semaphore.acquire(true).then(() => order.push(2));

		semaphore.release();
		await first;
		semaphore.release();
		await second;
		expect(order).toEqual([1, 2]);
	});

	it("marks priority queueing in the onQueued message", async () => {
		const onQueued = vi.fn();
		const semaphore = new SessionSemaphore(1, onQueued);
		await semaphore.acquire();
		void semaphore.acquire();
		void semaphore.acquire(true);
		expect(onQueued.mock.calls[0]?.[0]).not.toContain("follow-up");
		expect(onQueued.mock.calls[1]?.[0]).toContain(
			"(follow-up: queued ahead of new tickets)",
		);
	});

	it("rejects invalid limits", () => {
		expect(() => new SessionSemaphore(0)).toThrow();
		expect(() => new SessionSemaphore(Number.NaN)).toThrow();
		expect(() => new SessionSemaphore(1).setLimit(0)).toThrow();
	});
});

describe("capRunnerStarts", () => {
	it("holds a slot for the full duration of start()", async () => {
		const semaphore = new SessionSemaphore(1);
		const first = fakeRunner(false);
		const second = fakeRunner(false);
		const firstWrapped = capRunnerStarts(first.runner, semaphore);
		const secondWrapped = capRunnerStarts(second.runner, semaphore);

		const firstDone = firstWrapped.start("one");
		const secondDone = secondWrapped.start("two");
		await settled();

		expect(first.started).toHaveBeenCalledOnce();
		// Second session must not begin while the first is still running.
		expect(second.started).not.toHaveBeenCalled();

		first.startGate.resolve(sessionInfo("s1"));
		await firstDone;
		await settled();
		expect(second.started).toHaveBeenCalledOnce();

		second.startGate.resolve(sessionInfo("s2"));
		await expect(secondDone).resolves.toEqual(sessionInfo("s2"));
	});

	it("gates startStreaming() the same way", async () => {
		const semaphore = new SessionSemaphore(1);
		const first = fakeRunner(true);
		const second = fakeRunner(true);
		const firstWrapped = capRunnerStarts(first.runner, semaphore);
		const secondWrapped = capRunnerStarts(second.runner, semaphore);

		const firstDone = firstWrapped.startStreaming?.("one");
		void secondWrapped.startStreaming?.("two");
		await settled();

		expect(first.startedStreaming).toHaveBeenCalledOnce();
		expect(second.startedStreaming).not.toHaveBeenCalled();

		first.streamingGate.resolve(sessionInfo("s1"));
		await firstDone;
		await settled();
		expect(second.startedStreaming).toHaveBeenCalledOnce();
	});

	it("releases the slot when a session fails", async () => {
		const semaphore = new SessionSemaphore(1);
		const failing = fakeRunner(false);
		const next = fakeRunner(false);
		const failingWrapped = capRunnerStarts(failing.runner, semaphore);
		const nextWrapped = capRunnerStarts(next.runner, semaphore);

		const failingDone = failingWrapped.start("boom");
		const nextDone = nextWrapped.start("after");
		await settled();

		failing.startGate.reject(new Error("session crashed"));
		await expect(failingDone).rejects.toThrow("session crashed");
		await settled();

		expect(next.started).toHaveBeenCalledOnce();
		next.startGate.resolve(sessionInfo("s2"));
		await nextDone;
		expect(semaphore.active).toBe(0);
	});

	it("starts a priority runner before an earlier-queued normal one", async () => {
		const semaphore = new SessionSemaphore(1);
		const running = fakeRunner(false);
		const newTicket = fakeRunner(false);
		const followUp = fakeRunner(false);

		const runningDone = capRunnerStarts(running.runner, semaphore).start("a");
		void capRunnerStarts(newTicket.runner, semaphore).start("new");
		void capRunnerStarts(followUp.runner, semaphore, true).start("reply");
		await settled();
		expect(newTicket.started).not.toHaveBeenCalled();
		expect(followUp.started).not.toHaveBeenCalled();

		running.startGate.resolve(sessionInfo("s1"));
		await runningDone;
		await settled();
		expect(followUp.started).toHaveBeenCalledOnce();
		expect(newTicket.started).not.toHaveBeenCalled();
	});

	it("does not add startStreaming to runners without it", () => {
		const semaphore = new SessionSemaphore(1);
		const plain = fakeRunner(false);
		const wrapped = capRunnerStarts(plain.runner, semaphore);
		expect(wrapped.startStreaming).toBeUndefined();
	});

	it("passes prompts and results through unchanged", async () => {
		const semaphore = new SessionSemaphore(Number.POSITIVE_INFINITY);
		const { runner, started, startGate } = fakeRunner(false);
		const wrapped = capRunnerStarts(runner, semaphore);

		const done = wrapped.start("the prompt");
		startGate.resolve(sessionInfo("s1"));
		await expect(done).resolves.toEqual(sessionInfo("s1"));
		expect(started).toHaveBeenCalledWith("the prompt");
	});

	it("leaves the underlying runner untouched and its spies observable", async () => {
		// Regression guard: an earlier draft mutated runner.start in place,
		// which broke every test that asserts on a mock runner's methods.
		const semaphore = new SessionSemaphore(Number.POSITIVE_INFINITY);
		const { runner, started, startGate } = fakeRunner(false);
		const originalStart = runner.start;
		const wrapped = capRunnerStarts(runner, semaphore);

		const done = wrapped.start("p");
		startGate.resolve(sessionInfo("s"));
		await done;

		expect(runner.start).toBe(originalStart);
		expect(runner.start).toHaveBeenCalledOnce();
		expect(started).toHaveBeenCalledOnce();
	});

	it("forwards other members through to the underlying runner", () => {
		const semaphore = new SessionSemaphore(1);
		const addStreamMessage = vi.fn();
		const runner = {
			supportsStreamingInput: true,
			start: vi.fn(),
			startStreaming: vi.fn(),
			addStreamMessage,
		} as unknown as IAgentRunner;
		const wrapped = capRunnerStarts(runner, semaphore);

		expect(wrapped.supportsStreamingInput).toBe(true);
		wrapped.addStreamMessage?.("follow-up");
		expect(addStreamMessage).toHaveBeenCalledWith("follow-up");
	});
});

describe("stopping a runner before it holds a slot", () => {
	it("withdraws a queued start without touching the active count", async () => {
		const semaphore = new SessionSemaphore(1);
		const running = fakeRunner(false);
		const queued = fakeRunner(true);
		const runningWrapped = capRunnerStarts(running.runner, semaphore);
		const queuedWrapped = capRunnerStarts(queued.runner, semaphore, true);

		const runningDone = runningWrapped.start("a");
		const queuedDone = queuedWrapped.startStreaming?.("reply");
		await settled();
		expect(semaphore.active).toBe(1);
		expect(semaphore.waiting).toBe(1);

		queuedWrapped.stop();
		await expect(queuedDone).rejects.toBeInstanceOf(RunnerStartCancelledError);
		await expect(queuedDone).rejects.toMatchObject({ prompt: "reply" });
		expect(semaphore.active).toBe(1);
		expect(semaphore.waiting).toBe(0);
		// The underlying runner's own stop() is a no-op before start; it isn't called.
		expect(queued.stopped).not.toHaveBeenCalled();

		running.startGate.resolve(sessionInfo("s1"));
		await runningDone;
		expect(semaphore.active).toBe(0);
	});

	it("never starts the underlying runner once stopped while queued", async () => {
		const semaphore = new SessionSemaphore(1);
		const running = fakeRunner(false);
		const queued = fakeRunner(false);
		const runningDone = capRunnerStarts(running.runner, semaphore).start("a");
		const queuedWrapped = capRunnerStarts(queued.runner, semaphore);
		const queuedDone = queuedWrapped.start("old prompt");
		await settled();

		queuedWrapped.stop();
		await expect(queuedDone).rejects.toBeInstanceOf(RunnerStartCancelledError);

		// The slot frees up; the stale start must not take it.
		running.startGate.resolve(sessionInfo("s1"));
		await runningDone;
		await settled();
		expect(queued.started).not.toHaveBeenCalled();
		expect(semaphore.active).toBe(0);
	});

	it("rejects a start() made after stop() on an idle runner", async () => {
		// resumeAgentSession registers a runner, then awaits prompt building
		// before start(). A follow-up in that window stops it first.
		const semaphore = new SessionSemaphore(1);
		const idle = fakeRunner(false);
		const wrapped = capRunnerStarts(idle.runner, semaphore);

		wrapped.stop();
		await expect(wrapped.start("late prompt")).rejects.toMatchObject({
			name: "RunnerStartCancelledError",
			prompt: "late prompt",
		});
		expect(idle.started).not.toHaveBeenCalled();
		expect(semaphore.active).toBe(0);
	});

	it("releases exactly once when stopped between admission and starting", async () => {
		const semaphore = new SessionSemaphore(1);
		await semaphore.acquire();
		const queued = fakeRunner(false);
		const wrapped = capRunnerStarts(queued.runner, semaphore);
		const done = wrapped.start("p");
		await settled();

		// release() admits the waiter synchronously; stop() lands before the
		// gate's continuation runs.
		semaphore.release();
		wrapped.stop();

		await expect(done).rejects.toBeInstanceOf(RunnerStartCancelledError);
		expect(queued.started).not.toHaveBeenCalled();
		expect(semaphore.active).toBe(0);
		expect(semaphore.waiting).toBe(0);
	});

	it("passes stop() through once the runner holds a slot, releasing once", async () => {
		const semaphore = new SessionSemaphore(1);
		const running = fakeRunner(false);
		const next = fakeRunner(false);
		const wrapped = capRunnerStarts(running.runner, semaphore);
		const done = wrapped.start("a");
		const nextDone = capRunnerStarts(next.runner, semaphore).start("b");
		await settled();

		wrapped.stop();
		expect(running.stopped).toHaveBeenCalledOnce();
		// The real runner ends its session when stopped.
		running.startGate.resolve(sessionInfo("s1"));
		await done;
		await settled();

		// Exactly one slot came back: the next runner holds it, count is 1.
		expect(next.started).toHaveBeenCalledOnce();
		expect(semaphore.active).toBe(1);
		next.startGate.resolve(sessionInfo("s2"));
		await nextDone;
		expect(semaphore.active).toBe(0);
	});
});

describe("carrying a replaced start's prompt forward", () => {
	it("hands a queued prompt to the replacement, ahead of its own", async () => {
		const semaphore = new SessionSemaphore(1);
		const running = fakeRunner(false);
		const runningDone = capRunnerStarts(running.runner, semaphore).start("a");

		const old = capRunnerStarts(fakeRunner(false).runner, semaphore, true);
		const oldDone = old.start("user reply");
		await settled();

		// What resumeAgentSession does when a newer follow-up arrives.
		const carried = takePendingStartPrompt(old);
		old.stop();
		const replacement = fakeRunner(false);
		const replacementWrapped = capRunnerStarts(
			replacement.runner,
			semaphore,
			true,
		);
		expect(carriedPrompt(carried, replacementWrapped)).toBe(true);
		const replacementDone = replacementWrapped.start("CI failed");

		// Taken once: the cancelled start doesn't offer it again.
		await expect(oldDone).rejects.toMatchObject({ prompt: undefined });

		running.startGate.resolve(sessionInfo("s1"));
		await runningDone;
		await settled();
		const prompt = replacement.started.mock.calls[0]?.[0] as string;
		expect(prompt.indexOf("user reply")).toBeGreaterThan(-1);
		expect(prompt.indexOf("user reply")).toBeLessThan(
			prompt.indexOf("CI failed"),
		);
		replacement.startGate.resolve(sessionInfo("s2"));
		await replacementDone;
	});

	it("doesn't carry into a runner that already started", async () => {
		const semaphore = new SessionSemaphore(1);
		const running = fakeRunner(false);
		const wrapped = capRunnerStarts(running.runner, semaphore);
		void wrapped.start("a");
		await settled();
		expect(carryIntoPendingStart(wrapped, "late")).toBe(false);
		expect(takePendingStartPrompt(wrapped)).toBeUndefined();
	});
});

function carriedPrompt(
	carried: string | undefined,
	runner: IAgentRunner,
): boolean {
	return carried !== undefined && carryIntoPendingStart(runner, carried);
}
