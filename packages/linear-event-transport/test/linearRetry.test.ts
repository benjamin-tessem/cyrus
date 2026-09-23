import { describe, expect, it, vi } from "vitest";
import {
	classifyLinearError,
	describeLinearRequest,
	withLinearRetry,
} from "../src/linearRetry.js";

/** Shaped like the SDK's GraphQLClientError. */
function httpError(
	status: number,
	headers: Record<string, string> = {},
	errors?: unknown[],
) {
	return Object.assign(new Error(`HTTP ${status}`), {
		response: { status, headers: new Headers(headers), errors },
	});
}

/** Shaped like undici's `TypeError: fetch failed` with a coded cause. */
function networkError(code: string) {
	return Object.assign(new TypeError("fetch failed"), {
		cause: Object.assign(new Error(code), { code }),
	});
}

const query = { operationName: "issue", isMutation: false, idempotent: false };
const mutation = {
	operationName: "issueUpdate",
	isMutation: true,
	idempotent: false,
};
const idempotentMutation = {
	operationName: "agentActivityCreate",
	isMutation: true,
	idempotent: true,
};

/** Fast, deterministic retry options; records the delays it would sleep. */
function testOptions() {
	const delays: number[] = [];
	return {
		delays,
		options: {
			sleep: async (ms: number) => {
				delays.push(ms);
			},
			random: () => 0.5,
		},
	};
}

/** A send() that fails with each error in turn, then resolves "ok". */
function failingThen(...errors: unknown[]) {
	const send = vi.fn(async () => {
		const next = errors.shift();
		if (next) throw next;
		return "ok";
	});
	return send;
}

describe("classifyLinearError", () => {
	it("treats 502/503/504 as ambiguous and other statuses as fatal", () => {
		expect(classifyLinearError(httpError(502)).kind).toBe("ambiguous");
		expect(classifyLinearError(httpError(503)).kind).toBe("ambiguous");
		expect(classifyLinearError(httpError(504)).kind).toBe("ambiguous");
		expect(classifyLinearError(httpError(400)).kind).toBe("fatal");
		expect(classifyLinearError(httpError(401)).kind).toBe("fatal");
		expect(classifyLinearError(httpError(500)).kind).toBe("fatal");
	});

	it("reads retry-after from a 429", () => {
		expect(classifyLinearError(httpError(429, { "retry-after": "3" }))).toEqual(
			{ kind: "rate_limited", retryAfterMs: 3000 },
		);
	});

	it("recognises Linear's RATELIMITED error and its reset header", () => {
		const now = 1_000_000;
		const error = httpError(
			400,
			{ "x-ratelimit-requests-reset": String(now + 2500) },
			[{ extensions: { code: "RATELIMITED" } }],
		);
		expect(classifyLinearError(error, now)).toEqual({
			kind: "rate_limited",
			retryAfterMs: 2500,
		});
	});

	it("separates never-sent from mid-request network failures", () => {
		expect(classifyLinearError(networkError("ECONNREFUSED")).kind).toBe(
			"not_sent",
		);
		expect(classifyLinearError(networkError("ENOTFOUND")).kind).toBe(
			"not_sent",
		);
		expect(classifyLinearError(networkError("ECONNRESET")).kind).toBe(
			"ambiguous",
		);
		expect(classifyLinearError(new TypeError("fetch failed")).kind).toBe(
			"ambiguous",
		);
		expect(classifyLinearError(new Error("something else")).kind).toBe("fatal");
	});
});

describe("withLinearRetry", () => {
	it("retries a query through transient failures", async () => {
		const { delays, options } = testOptions();
		const send = failingThen(httpError(503), networkError("ECONNRESET"));

		await expect(withLinearRetry(send, query, options)).resolves.toBe("ok");
		expect(send).toHaveBeenCalledTimes(3);
		// Equal jitter with random()=0.5: 3/4 of the doubling cap.
		expect(delays).toEqual([1125, 2250]);
	});

	it("gives up after maxAttempts with the last error", async () => {
		const { options } = testOptions();
		const last = httpError(504);
		const send = failingThen(
			httpError(503),
			httpError(503),
			httpError(502),
			last,
		);

		await expect(withLinearRetry(send, query, options)).rejects.toBe(last);
		expect(send).toHaveBeenCalledTimes(4);
	});

	it("never retries a 4xx validation error", async () => {
		const { options } = testOptions();
		const send = failingThen(httpError(400));

		await expect(withLinearRetry(send, query, options)).rejects.toThrow(
			"HTTP 400",
		);
		expect(send).toHaveBeenCalledOnce();
	});

	it("does not replay a non-idempotent mutation after an ambiguous failure", async () => {
		const { options } = testOptions();
		const send = failingThen(httpError(503));

		await expect(withLinearRetry(send, mutation, options)).rejects.toThrow(
			"HTTP 503",
		);
		expect(send).toHaveBeenCalledOnce();
	});

	it("retries a mutation that certainly wasn't applied", async () => {
		const { options } = testOptions();
		const send = failingThen(
			networkError("ECONNREFUSED"),
			httpError(429, { "retry-after": "1" }),
		);

		await expect(withLinearRetry(send, mutation, options)).resolves.toBe("ok");
		expect(send).toHaveBeenCalledTimes(3);
	});

	it("replays an idempotent mutation after an ambiguous failure", async () => {
		const { options } = testOptions();
		const send = failingThen(httpError(503));

		await expect(
			withLinearRetry(send, idempotentMutation, options),
		).resolves.toBe("ok");
		expect(send).toHaveBeenCalledTimes(2);
	});

	it("waits at least retry-after on a rate limit", async () => {
		const { delays, options } = testOptions();
		const send = failingThen(httpError(429, { "retry-after": "5" }));

		await withLinearRetry(send, query, options);
		expect(delays).toEqual([5000]);
	});

	it("fails fast when the rate-limit reset is beyond the budget", async () => {
		const { delays, options } = testOptions();
		const send = failingThen(httpError(429, { "retry-after": "3600" }));

		await expect(withLinearRetry(send, query, options)).rejects.toThrow(
			"HTTP 429",
		);
		expect(delays).toEqual([]);
		expect(send).toHaveBeenCalledOnce();
	});
});

describe("describeLinearRequest", () => {
	const mutationDoc = {
		kind: "Document",
		definitions: [
			{
				kind: "OperationDefinition",
				operation: "mutation",
				name: { kind: "Name", value: "createAgentActivity" },
			},
		],
	};

	it("marks a mutation with a client id as idempotent", () => {
		expect(
			describeLinearRequest(mutationDoc, { input: { id: "uuid-1" } }),
		).toEqual({
			operationName: "createAgentActivity",
			isMutation: true,
			idempotent: true,
		});
		expect(describeLinearRequest(mutationDoc, { input: {} }).idempotent).toBe(
			false,
		);
	});

	it("parses string documents", () => {
		expect(
			describeLinearRequest("query issue($id: String!) { x }", {}),
		).toEqual({ operationName: "issue", isMutation: false, idempotent: false });
		expect(
			describeLinearRequest("mutation issueUpdate { x }", {}).isMutation,
		).toBe(true);
		expect(describeLinearRequest("{ viewer { id } }", {}).isMutation).toBe(
			false,
		);
	});
});
