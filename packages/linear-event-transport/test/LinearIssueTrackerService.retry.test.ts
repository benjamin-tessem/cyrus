/**
 * The retry wraps the GraphQL client's request(), which every SDK call goes
 * through. These tests use a real LinearClient with its transport stubbed, so
 * they exercise the same path as production.
 */

import { LinearClient } from "@linear/sdk";
import { describe, expect, it, vi } from "vitest";
import { LinearIssueTrackerService } from "../src/LinearIssueTrackerService.js";

function httpError(status: number) {
	return Object.assign(new Error(`HTTP ${status}`), {
		response: { status, headers: new Headers() },
	});
}

interface Call {
	operation: string;
	variables: Record<string, any>;
}

/**
 * A LinearClient whose transport runs `handler` for each request and records
 * the operation name and variables.
 */
function stubbedService(
	handler: (call: Call, attempt: number) => unknown,
	oauth = false,
) {
	const client = new LinearClient({ accessToken: "test-token" });
	const calls: Call[] = [];
	client.client.request = vi.fn(async (document: any, variables: any) => {
		const op = document.definitions?.find(
			(d: any) => d.kind === "OperationDefinition",
		);
		const call = { operation: op?.name?.value, variables };
		calls.push(call);
		const attempt = calls.filter((c) => c.operation === call.operation).length;
		const result = handler(call, attempt);
		if (result instanceof Error) throw result;
		return result;
	}) as any;
	const logger = {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	} as any;
	const service = new LinearIssueTrackerService(
		client,
		oauth
			? {
					clientId: "id",
					clientSecret: "secret",
					refreshToken: "refresh",
					workspaceId: `ws-${Math.random()}`,
				}
			: undefined,
		logger,
		{ sleep: async () => {}, random: () => 0 },
	);
	return { service, calls, logger };
}

/** Minimal issue data the SDK's Issue constructor accepts. */
const ISSUE = { id: "issue-1", identifier: "DEF-1", title: "T", reactions: [] };

const activityInput = {
	agentSessionId: "session-1",
	content: { type: "thought", body: "hello" },
};

describe("LinearIssueTrackerService transient-failure retry", () => {
	it("retries an issue fetch through a 503 (the dropped-reply case)", async () => {
		const { service, calls } = stubbedService((_call, attempt) =>
			attempt === 1 ? httpError(503) : { issue: ISSUE },
		);

		const issue = await service.fetchIssue("issue-1");
		expect(issue.identifier).toBe("DEF-1");
		expect(calls.map((c) => c.operation)).toEqual(["issue", "issue"]);
	});

	it("installs the retry even without OAuth config", async () => {
		// Production runs without LINEAR_CLIENT_ID/SECRET in some setups; the
		// retry must not depend on the 401 refresh being configured.
		const { service, calls } = stubbedService((_call, attempt) =>
			attempt < 3 ? httpError(502) : { issue: ISSUE },
		);
		await service.fetchIssue("issue-1");
		expect(calls).toHaveLength(3);
	});

	it("posts an activity with a client id and replays it with the same id", async () => {
		const { service, calls } = stubbedService((call, attempt) =>
			attempt === 1
				? httpError(503)
				: {
						agentActivityCreate: {
							success: true,
							lastSyncId: 1,
							agentActivity: { id: call.variables.input.id },
						},
					},
		);

		const result = await service.createAgentActivity(activityInput);
		const ids = calls.map((c) => c.variables.input.id);
		expect(ids).toHaveLength(2);
		expect(ids[0]).toMatch(/^[0-9a-f-]{36}$/);
		expect(ids[1]).toBe(ids[0]);
		expect(result.success).toBe(true);
		expect(result.agentActivityId).toBe(ids[0]);
	});

	it("keeps a caller-supplied activity id", async () => {
		const { service, calls } = stubbedService(() => ({
			agentActivityCreate: {
				success: true,
				lastSyncId: 1,
				agentActivity: { id: "caller-id" },
			},
		}));
		await service.createAgentActivity({ ...activityInput, id: "caller-id" });
		expect(calls[0]?.variables.input.id).toBe("caller-id");
	});

	it("treats a post whose responses were all lost as successful if the activity exists", async () => {
		let postedId: string | undefined;
		const { service, calls } = stubbedService((call) => {
			if (call.operation === "createAgentActivity") {
				postedId = call.variables.input.id;
				return httpError(503);
			}
			// The probe: the first attempt was applied after all.
			return {
				agentActivity: {
					id: call.variables.id,
					createdAt: new Date().toISOString(),
					updatedAt: new Date().toISOString(),
					content: { __typename: "AgentActivityThoughtContent", body: "hello" },
					agentSession: { id: "session-1" },
				},
			};
		});

		const result = await service.createAgentActivity(activityInput);
		expect(
			calls.filter((c) => c.operation === "createAgentActivity"),
		).toHaveLength(4);
		expect(calls.at(-1)?.operation).toBe("agentActivity");
		expect(result.success).toBe(true);
		expect(result.agentActivityId).toBe(postedId);
	});

	it("does not retry a validation error, and rethrows it when the activity doesn't exist", async () => {
		// Both the post and the existence probe get a 400.
		const { service, calls } = stubbedService(() => httpError(400));

		await expect(service.createAgentActivity(activityInput)).rejects.toThrow();
		expect(
			calls.filter((c) => c.operation === "createAgentActivity"),
		).toHaveLength(1);
	});

	it("does not replay a non-idempotent mutation after a 503", async () => {
		const { service, calls } = stubbedService(() => httpError(503));

		await expect(
			service.updateIssue("issue-1", { title: "new" }),
		).rejects.toThrow();
		expect(calls).toHaveLength(1);
	});

	it("still refreshes the token on 401, then retries transient failures", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(
				JSON.stringify({
					access_token: "new-token",
					refresh_token: "new-refresh",
					expires_in: 3600,
				}),
				{ status: 200 },
			),
		);
		try {
			const { service, calls } = stubbedService((_call, attempt) => {
				if (attempt === 1) return httpError(401);
				if (attempt === 2) return httpError(503);
				return { issue: ISSUE };
			}, true);

			const issue = await service.fetchIssue("issue-1");
			expect(issue.identifier).toBe("DEF-1");
			expect(calls).toHaveLength(3);
			expect(fetchSpy).toHaveBeenCalledOnce();
		} finally {
			fetchSpy.mockRestore();
		}
	});
});
