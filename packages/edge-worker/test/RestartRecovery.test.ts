import { AgentSessionStatus, type CyrusAgentSession } from "cyrus-core";
import { describe, expect, it } from "vitest";
import {
	INTERRUPTED_PROMPT,
	planRestartRecovery,
	queuedMessagePrompt,
} from "../src/RestartRecovery.js";

function session(
	id: string,
	overrides: Partial<CyrusAgentSession> = {},
): CyrusAgentSession {
	return {
		id,
		type: "commentThread",
		context: "commentThread",
		status: AgentSessionStatus.Active,
		createdAt: 1,
		updatedAt: 1,
		issueContext: {
			trackerId: "linear",
			issueId: `issue-${id}`,
			issueIdentifier: `DEF-${id}`,
		},
		issue: {
			id: `issue-${id}`,
			identifier: `DEF-${id}`,
			title: `Title ${id}`,
			branchName: `cyrus/def-${id}`,
		},
		repositories: [],
		workspace: { path: "/w", isGitWorktree: true },
		...overrides,
	} as CyrusAgentSession;
}

describe("planRestartRecovery", () => {
	it("re-prompts an active session whose agent had started", () => {
		const actions = planRestartRecovery([
			session("1", { claudeSessionId: "c-1" }),
		]);

		expect(actions).toEqual([
			{
				kind: "prompt",
				sessionId: "1",
				issue: { id: "issue-1", identifier: "DEF-1", title: "Title 1" },
				prompt: INTERRUPTED_PROMPT,
			},
		]);
	});

	it("restarts an active session that never started", () => {
		const actions = planRestartRecovery([session("1")]);

		expect(actions).toEqual([
			{
				kind: "restart",
				sessionId: "1",
				issue: { id: "issue-1", identifier: "DEF-1", title: "Title 1" },
			},
		]);
	});

	it("delivers a queued follow-up instead of the generic nudge", () => {
		const actions = planRestartRecovery(
			[session("1", { codexSessionId: "x-1" })],
			{ "1": "please also fix the tests" },
		);

		expect(actions).toHaveLength(1);
		expect(actions[0]).toMatchObject({
			kind: "prompt",
			prompt: queuedMessagePrompt("please also fix the tests"),
		});
	});

	it("includes a completed session when a follow-up was queued for it", () => {
		const actions = planRestartRecovery(
			[
				session("1", {
					status: AgentSessionStatus.Complete,
					claudeSessionId: "c-1",
				}),
			],
			{ "1": "reply to the review" },
		);

		expect(actions).toHaveLength(1);
		expect(actions[0]).toMatchObject({ kind: "prompt", sessionId: "1" });
	});

	it("skips finished sessions with nothing queued, and non-Linear sessions", () => {
		const actions = planRestartRecovery([
			session("1", {
				status: AgentSessionStatus.Complete,
				claudeSessionId: "c-1",
			}),
			session("2", {
				claudeSessionId: "c-2",
				issueContext: {
					trackerId: "github",
					issueId: "pr-2",
					issueIdentifier: "org/repo#2",
				},
			}),
			session("3", { issue: undefined }),
		]);

		expect(actions).toEqual([]);
	});

	it("returns sessions oldest first", () => {
		const actions = planRestartRecovery([
			session("new", { createdAt: 30 }),
			session("old", { createdAt: 10 }),
			session("mid", { createdAt: 20, claudeSessionId: "c" }),
		]);

		expect(actions.map((a) => a.sessionId)).toEqual(["old", "mid", "new"]);
	});
});
