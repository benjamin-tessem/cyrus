/**
 * Bounded retry for transient Linear API failures.
 *
 * Linear's edge occasionally answers 502/503/504 ("upstream connect error or
 * disconnect/reset before headers") or drops the connection. Without a retry,
 * one such blip loses whatever the call was carrying: a user's reply (the
 * prompted-webhook handler couldn't fetch the issue) or an agent activity.
 *
 * Safety for mutations: a query can always be re-sent. A mutation can only be
 * re-sent when the first attempt certainly wasn't applied (rate limited, or
 * the connection never opened), or when it is idempotent — for Linear, when
 * the caller supplied the entity `id`, so a replay can't create a second one.
 * A 5xx or a reset mid-request is ambiguous: the server may have applied it
 * and only the response was lost.
 */

import type { ILogger } from "cyrus-core";

export interface LinearRetryOptions {
	/** Total attempts, including the first. */
	maxAttempts?: number;
	/** Backoff before the n-th retry is ~baseDelayMs * 2^(n-1), with jitter. */
	baseDelayMs?: number;
	/** Upper bound on a single backoff delay. */
	maxDelayMs?: number;
	/**
	 * Give up rather than wait longer than this in total. A rate limit whose
	 * reset is further away than the remaining budget fails immediately
	 * instead of stalling the caller.
	 */
	budgetMs?: number;
	logger?: ILogger;
	/** Injectable for tests. */
	sleep?: (ms: number) => Promise<void>;
	/** Injectable for tests; returns [0, 1). */
	random?: () => number;
	/** Injectable for tests. */
	now?: () => number;
}

export interface LinearRequestInfo {
	/** GraphQL operation name, for logs. */
	operationName?: string;
	isMutation: boolean;
	/** Safe to replay even if a previous attempt was applied. */
	idempotent: boolean;
}

type Failure =
	/** The server refused before doing anything (rate limit). */
	| { kind: "rate_limited"; retryAfterMs?: number }
	/** The request never reached the server (connection not established). */
	| { kind: "not_sent" }
	/** 5xx or a connection lost mid-request: may or may not have been applied. */
	| { kind: "ambiguous" }
	/** Anything else (4xx, validation, GraphQL errors): never retried. */
	| { kind: "fatal" };

const RETRYABLE_STATUS = new Set([502, 503, 504]);

/** Error codes where the TCP/TLS connection was never established. */
const NOT_SENT_CODES = new Set([
	"ECONNREFUSED",
	"ENOTFOUND",
	"EAI_AGAIN",
	"EHOSTUNREACH",
	"ENETUNREACH",
	"UND_ERR_CONNECT_TIMEOUT",
]);

/** Error codes where the connection dropped after the request may have been sent. */
const AMBIGUOUS_CODES = new Set([
	"ECONNRESET",
	"ETIMEDOUT",
	"EPIPE",
	"UND_ERR_SOCKET",
	"UND_ERR_HEADERS_TIMEOUT",
	"UND_ERR_BODY_TIMEOUT",
	"UND_ERR_CLOSED",
]);

interface HeadersLike {
	get?: (name: string) => string | null;
}

interface ErrorLike {
	name?: string;
	message?: string;
	code?: string;
	status?: number;
	cause?: unknown;
	response?: {
		status?: number;
		headers?: HeadersLike;
		errors?: Array<{ extensions?: { code?: string } }>;
	};
}

function errorCode(error: ErrorLike): string | undefined {
	let current: unknown = error;
	for (let depth = 0; current && depth < 4; depth++) {
		const code = (current as ErrorLike).code;
		if (typeof code === "string") return code;
		current = (current as ErrorLike).cause;
	}
	return undefined;
}

function parseRetryAfterMs(
	headers: HeadersLike | undefined,
	now: number,
): number | undefined {
	const get = headers?.get?.bind(headers);
	if (!get) return undefined;

	const retryAfter = get("retry-after");
	if (retryAfter) {
		const seconds = Number(retryAfter);
		if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
		const date = Date.parse(retryAfter);
		if (!Number.isNaN(date)) return Math.max(0, date - now);
	}

	// Linear's own rate-limit headers carry the reset time as epoch ms.
	const resets = ["x-ratelimit-requests-reset", "x-ratelimit-complexity-reset"]
		.map((name) => Number(get(name)))
		.filter((value) => Number.isFinite(value) && value > 0);
	if (resets.length > 0) return Math.max(0, Math.max(...resets) - now);

	return undefined;
}

/** Classify a failure from LinearGraphQLClient.request(). */
export function classifyLinearError(error: unknown, now = Date.now()): Failure {
	const err = (error ?? {}) as ErrorLike;
	const status = err.response?.status ?? err.status;

	const rateLimited =
		status === 429 ||
		err.response?.errors?.some((e) => e.extensions?.code === "RATELIMITED");
	if (rateLimited) {
		return {
			kind: "rate_limited",
			retryAfterMs: parseRetryAfterMs(err.response?.headers, now),
		};
	}

	if (typeof status === "number") {
		return RETRYABLE_STATUS.has(status)
			? { kind: "ambiguous" }
			: { kind: "fatal" };
	}

	const code = errorCode(err);
	if (code && NOT_SENT_CODES.has(code)) return { kind: "not_sent" };
	if (code && AMBIGUOUS_CODES.has(code)) return { kind: "ambiguous" };

	// undici throws a bare `TypeError: fetch failed` when it has no better code.
	if (err.name === "TypeError" && err.message === "fetch failed") {
		return { kind: "ambiguous" };
	}

	return { kind: "fatal" };
}

function shouldRetry(failure: Failure, request: LinearRequestInfo): boolean {
	switch (failure.kind) {
		case "rate_limited":
		case "not_sent":
			return true;
		case "ambiguous":
			return !request.isMutation || request.idempotent;
		case "fatal":
			return false;
	}
}

/**
 * Run `send` with bounded exponential backoff (equal jitter) on transient
 * failures, per the mutation-safety rules above.
 */
export async function withLinearRetry<T>(
	send: () => Promise<T>,
	request: LinearRequestInfo,
	options: LinearRetryOptions = {},
): Promise<T> {
	const {
		maxAttempts = 4,
		baseDelayMs = 1500,
		maxDelayMs = 8000,
		budgetMs = 20_000,
		logger,
		sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
		random = Math.random,
		now = Date.now,
	} = options;

	const startedAt = now();
	for (let attempt = 1; ; attempt++) {
		try {
			return await send();
		} catch (error) {
			const failure = classifyLinearError(error, now());
			if (attempt >= maxAttempts || !shouldRetry(failure, request)) {
				throw error;
			}

			const cap = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
			let delay = cap / 2 + random() * (cap / 2);
			if (
				failure.kind === "rate_limited" &&
				failure.retryAfterMs !== undefined
			) {
				delay = Math.max(delay, failure.retryAfterMs);
			}
			if (now() - startedAt + delay > budgetMs) {
				throw error;
			}

			logger?.warn(
				`Linear ${request.isMutation ? "mutation" : "query"} ` +
					`${request.operationName ?? "(anonymous)"} failed (${failure.kind}); ` +
					`retrying in ${Math.round(delay)}ms (attempt ${attempt + 1}/${maxAttempts})`,
			);
			await sleep(delay);
		}
	}
}

interface DocumentNodeLike {
	definitions?: Array<{
		kind?: string;
		operation?: string;
		name?: { value?: string };
	}>;
}

/** Work out whether a GraphQL document is a mutation, and its name. */
export function describeLinearRequest(
	document: unknown,
	variables: unknown,
): LinearRequestInfo {
	let operation: string | undefined;
	let operationName: string | undefined;

	if (typeof document === "string") {
		const match = /^\s*(query|mutation|subscription)\b\s*([_A-Za-z]\w*)?/.exec(
			document.replace(/^\s*#[^\n]*\n/gm, ""),
		);
		operation = match?.[1] ?? "query";
		operationName = match?.[2];
	} else {
		const op = (document as DocumentNodeLike)?.definitions?.find(
			(d) => d.kind === "OperationDefinition",
		);
		operation = op?.operation ?? "query";
		operationName = op?.name?.value;
	}

	const isMutation = operation === "mutation";
	// Linear create inputs accept a client-generated `id`; a replay then can't
	// create a second entity.
	const input = (variables as { input?: { id?: unknown } } | undefined)?.input;
	const idempotent = isMutation && typeof input?.id === "string";

	return { operationName, isMutation, idempotent };
}
