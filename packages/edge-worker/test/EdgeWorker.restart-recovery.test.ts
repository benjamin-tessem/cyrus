import { LinearClient } from "@linear/sdk";
import { ClaudeRunner } from "cyrus-claude-runner";
import { AgentSessionStatus } from "cyrus-core";
import { LinearEventTransport } from "cyrus-linear-event-transport";
import { createCyrusToolsServer } from "cyrus-mcp-tools";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSessionManager } from "../src/AgentSessionManager.js";
import { EdgeWorker } from "../src/EdgeWorker.js";
import {
	INTERRUPTED_PROMPT,
	queuedMessagePrompt,
} from "../src/RestartRecovery.js";
import { capRunnerStarts, SessionSemaphore } from "../src/RunnerConcurrency.js";
import { SharedApplicationServer } from "../src/SharedApplicationServer.js";
import type { EdgeWorkerConfig, RepositoryConfig } from "../src/types.js";
import { TEST_CYRUS_HOME } from "./test-dirs.js";

vi.mock("fs/promises");
vi.mock("cyrus-claude-runner");
vi.mock("cyrus-mcp-tools");
vi.mock("cyrus-codex-runner");
vi.mock("cyrus-linear-event-transport");
vi.mock("@linear/sdk");
vi.mock("../src/SharedApplicationServer.js");
vi.mock("../src/AgentSessionManager.js");
vi.mock("cyrus-core", async (importOriginal) => {
	const actual = (await importOriginal()) as any;
	return {
		...actual,
		PersistenceManager: vi.fn().mockImplementation(function () {
			return {
				loadEdgeWorkerState: vi.fn().mockResolvedValue(null),
				saveEdgeWorkerState: vi.fn().mockResolvedValue(undefined),
			};
		}),
	};
});

/**
 * A restart used to kill every runner and forget queued work: interrupted
 * sessions sat "active" in Linear until a human replied, and a follow-up
 * queued behind the concurrency cap was lost outright.
 */
describe("EdgeWorker - restart recovery", () => {
	const repo: RepositoryConfig = {
		id: "repo-a",
		name: "Repo A",
		repositoryPath: "/test/repo-a",
		workspaceBaseDir: "/test/workspaces",
		baseBranch: "main",
		linearWorkspaceId: "test-workspace",
		isActive: true,
		teamKeys: ["DEF"],
	};

	function session(id: string, extra: Record<string, unknown> = {}) {
		return {
			id,
			status: AgentSessionStatus.Active,
			createdAt: Number(id.replace(/\D/g, "")) || 1,
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
			...extra,
		};
	}

	let sessions: any[];
	let mockConfig: EdgeWorkerConfig;

	beforeEach(() => {
		vi.clearAllMocks();
		sessions = [];

		vi.mocked(createCyrusToolsServer).mockImplementation(
			() => ({ server: {} }) as any,
		);
		vi.mocked(ClaudeRunner).mockImplementation(function () {
			return { stop: vi.fn(), isRunning: vi.fn().mockReturnValue(false) };
		} as any);
		vi.mocked(AgentSessionManager).mockImplementation(function () {
			return {
				serializeState: vi.fn().mockReturnValue({ sessions: {}, entries: {} }),
				restoreState: vi.fn(),
				setActivitySink: vi.fn(),
				getAllSessions: vi.fn(() => sessions),
				getAllAgentRunners: vi.fn(() =>
					sessions.map((s) => s.agentRunner).filter(Boolean),
				),
				on: vi.fn(),
			};
		} as any);
		vi.mocked(SharedApplicationServer).mockImplementation(function () {
			return {
				start: vi.fn().mockResolvedValue(undefined),
				stop: vi.fn().mockResolvedValue(undefined),
				getFastifyInstance: vi.fn().mockReturnValue({ post: vi.fn() }),
				getWebhookUrl: vi.fn().mockReturnValue("http://localhost:3456/webhook"),
				registerOAuthCallbackHandler: vi.fn(),
			};
		} as any);
		vi.mocked(LinearEventTransport).mockImplementation(function () {
			return { register: vi.fn(), on: vi.fn(), removeAllListeners: vi.fn() };
		} as any);
		vi.mocked(LinearClient).mockImplementation(function () {
			return { users: { me: vi.fn().mockResolvedValue({ id: "user-1" }) } };
		} as any);

		mockConfig = {
			proxyUrl: "http://localhost:3000",
			cyrusHome: TEST_CYRUS_HOME,
			repositories: [repo],
			linearWorkspaces: { "test-workspace": { linearToken: "test-token" } },
			handlers: {},
		};
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	/** A runner stuck behind a full semaphore, waiting to deliver `prompt`. */
	function queuedRunner(prompt: string) {
		const full = new SessionSemaphore(1);
		void full.acquire();
		const runner = capRunnerStarts(
			{
				start: vi.fn(),
				stop: vi.fn(),
				isRunning: () => false,
			} as any,
			full,
			true,
		);
		runner.start(prompt).catch(() => {});
		return runner;
	}

	function spyHandlers(worker: EdgeWorker) {
		(worker as any).repositoryRouter.getIssueRepositoryCache().clear();
		for (const s of sessions) {
			(worker as any).repositoryRouter
				.getIssueRepositoryCache()
				.set(s.issue.id, [repo.id]);
		}
		vi.spyOn(worker as any, "savePersistedState").mockResolvedValue(undefined);
		return {
			prompted: vi
				.spyOn(worker as any, "handleUserPromptedAgentActivity")
				.mockResolvedValue(undefined),
			created: vi
				.spyOn(worker as any, "handleAgentSessionCreatedWebhook")
				.mockResolvedValue(undefined),
		};
	}

	it("saves a queued follow-up on stop and delivers it after the restart", async () => {
		const before = new EdgeWorker(mockConfig);
		sessions = [
			session("s1", {
				status: AgentSessionStatus.Complete,
				claudeSessionId: "claude-1",
				agentRunner: queuedRunner("fix the review comments"),
			}),
		];
		await Promise.resolve();

		await before.stop();
		const state = before.serializeMappings();
		expect(state.pendingRestartPrompts).toEqual({
			s1: "fix the review comments",
		});

		const after = new EdgeWorker(mockConfig);
		after.restoreMappings(state);
		sessions = sessions.map(({ agentRunner: _, ...s }) => s);
		const { prompted, created } = spyHandlers(after);

		await (after as any).recoverAfterRestart();

		expect(created).not.toHaveBeenCalled();
		expect(prompted).toHaveBeenCalledTimes(1);
		expect(prompted.mock.calls[0]![0]).toMatchObject({
			organizationId: "test-workspace",
			agentSession: {
				id: "s1",
				issue: { id: "issue-s1", identifier: "DEF-s1" },
			},
			agentActivity: {
				content: {
					type: "prompt",
					body: queuedMessagePrompt("fix the review comments"),
				},
			},
		});
		// Replayed once, then forgotten.
		expect(after.serializeMappings().pendingRestartPrompts).toBeUndefined();
	});

	it("re-prompts interrupted runs and restarts never-started ones", async () => {
		sessions = [session("s1", { claudeSessionId: "claude-1" }), session("s2")];
		const worker = new EdgeWorker(mockConfig);
		(worker as any).issueTrackers.set("test-workspace", {
			fetchAgentSession: vi.fn().mockResolvedValue({
				comment: Promise.resolve({ id: "c-1", body: "delegated" }),
				creator: Promise.resolve({ id: "u-1", name: "Ben", email: "b@x" }),
			}),
			fetchIssue: vi.fn().mockResolvedValue({
				description: "Do the thing",
				team: Promise.resolve({ key: "DEF" }),
			}),
		});
		const { prompted, created } = spyHandlers(worker);

		await (worker as any).recoverAfterRestart();

		expect(prompted).toHaveBeenCalledTimes(1);
		expect(prompted.mock.calls[0]![0]).toMatchObject({
			agentSession: { id: "s1" },
			agentActivity: { content: { body: INTERRUPTED_PROMPT } },
		});
		expect(created).toHaveBeenCalledTimes(1);
		expect(created.mock.calls[0]![0]).toMatchObject({
			action: "created",
			organizationId: "test-workspace",
			agentSession: {
				id: "s2",
				issue: {
					id: "issue-s2",
					identifier: "DEF-s2",
					description: "Do the thing",
					team: { key: "DEF" },
				},
				comment: { id: "c-1", body: "delegated" },
				creator: { id: "u-1", name: "Ben", email: "b@x" },
			},
		});
		expect(created.mock.calls[0]![1]).toEqual([repo]);
	});

	it("keeps going when one session fails to recover", async () => {
		sessions = [
			session("s1", { claudeSessionId: "claude-1" }),
			session("s2", { claudeSessionId: "claude-2" }),
		];
		const worker = new EdgeWorker(mockConfig);
		const { prompted } = spyHandlers(worker);
		prompted.mockRejectedValueOnce(new Error("boom"));

		await (worker as any).recoverAfterRestart();

		expect(prompted).toHaveBeenCalledTimes(2);
	});
});
