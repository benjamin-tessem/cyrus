import { LinearClient } from "@linear/sdk";
import { ClaudeRunner } from "cyrus-claude-runner";
import { AgentSessionStatus } from "cyrus-core";
import { LinearEventTransport } from "cyrus-linear-event-transport";
import { createCyrusToolsServer } from "cyrus-mcp-tools";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSessionManager } from "../src/AgentSessionManager.js";
import { EdgeWorker } from "../src/EdgeWorker.js";
import {
	issueCommentReplyPrompt,
	newestLinearSession,
} from "../src/IssueCommentReplies.js";
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

const APP_USER = "app-user";

/**
 * A plain comment on an issue ("please fix the merge conflict") used to be
 * ignored: only replies in the agent session thread reached the agent.
 */
describe("EdgeWorker - plain issue comments as replies", () => {
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

	function session(id: string, createdAt: number, issueId = "issue-1") {
		return {
			id,
			status: AgentSessionStatus.Complete,
			createdAt,
			updatedAt: createdAt,
			issueContext: {
				trackerId: "linear",
				issueId,
				issueIdentifier: "DEF-123",
			},
			issue: {
				id: issueId,
				identifier: "DEF-123",
				title: "Fix the thing",
			},
		};
	}

	interface CommentFixture {
		botActor?: unknown;
		agentSessionId?: string;
		parentId?: string;
		app?: boolean;
	}

	let sessions: any[];
	let comments: Record<string, CommentFixture>;
	let issue: { delegateId?: string; assigneeId?: string };
	let tracker: any;
	let mockConfig: EdgeWorkerConfig;

	beforeEach(() => {
		vi.clearAllMocks();
		sessions = [session("s-old", 1), session("s-new", 2)];
		comments = { "c-1": {} };
		issue = { delegateId: APP_USER, assigneeId: "human" };

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
				getSession: vi.fn((id: string) => sessions.find((s) => s.id === id)),
				getSessionsByIssueId: vi.fn((issueId: string) =>
					sessions.filter((s) => s.issue.id === issueId),
				),
				getAllAgentRunners: vi.fn(() => []),
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

		tracker = {
			fetchComment: vi.fn(async (id: string) => {
				const fixture = comments[id];
				if (!fixture) throw new Error(`no comment ${id}`);
				const { app, ...facts } = fixture;
				return {
					id,
					body: "",
					...facts,
					user: Promise.resolve({ id: "human", app: Boolean(app) }),
				};
			}),
			fetchIssue: vi.fn(async () => issue),
		};

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

	function makeWorker(config: EdgeWorkerConfig = mockConfig) {
		const worker = new EdgeWorker(config);
		(worker as any).issueTrackers.set("test-workspace", tracker);
		(worker as any).repositoryRouter
			.getIssueRepositoryCache()
			.set("issue-1", [repo.id]);
		vi.spyOn(worker as any, "savePersistedState").mockResolvedValue(undefined);
		return worker;
	}

	function newCommentWebhook(
		overrides: Record<string, unknown> = {},
		commentId = "c-1",
	) {
		return {
			type: "AppUserNotification",
			action: "issueNewComment",
			appUserId: APP_USER,
			organizationId: "test-workspace",
			oauthClientId: "oauth-client",
			createdAt: new Date().toISOString(),
			notification: {
				id: `n-${commentId}`,
				type: "issueNewComment",
				commentId,
				comment: { id: commentId, body: "please fix the merge conflict" },
				issueId: "issue-1",
				issue: { id: "issue-1", identifier: "DEF-123", title: "Fix the thing" },
				actorId: "human",
				actor: { id: "human", name: "Pat", email: "pat@example.com" },
				...overrides,
			},
		};
	}

	async function deliver(worker: EdgeWorker, webhook: unknown) {
		await (worker as any).handleWebhook(webhook, [repo]);
	}

	it("delivers a human comment to the newest session for the issue", async () => {
		const worker = makeWorker();
		const prompted = vi
			.spyOn(worker as any, "handleUserPromptedAgentActivity")
			.mockResolvedValue(undefined);

		await deliver(worker, newCommentWebhook());

		expect(prompted).toHaveBeenCalledTimes(1);
		expect(prompted.mock.calls[0]![0]).toMatchObject({
			action: "prompted",
			organizationId: "test-workspace",
			agentSession: {
				id: "s-new",
				issue: { id: "issue-1", identifier: "DEF-123" },
				creator: { id: "human", name: "Pat", email: "pat@example.com" },
			},
			agentActivity: {
				sourceCommentId: "c-1",
				content: {
					type: "prompt",
					body: issueCommentReplyPrompt("Pat", "please fix the merge conflict"),
				},
			},
		});
	});

	it("does not treat a plain 'stop' comment as a stop signal", async () => {
		const worker = makeWorker();
		const stop = vi
			.spyOn(worker as any, "handleStopSignal")
			.mockResolvedValue(undefined);
		const normal = vi
			.spyOn(worker as any, "handleNormalPromptedActivity")
			.mockResolvedValue(undefined);

		await deliver(
			worker,
			newCommentWebhook({ comment: { id: "c-1", body: "stop" } }),
		);

		expect(stop).not.toHaveBeenCalled();
		expect(normal).toHaveBeenCalledTimes(1);
	});

	it("ignores comments by Cyrus itself", async () => {
		const worker = makeWorker();
		const prompted = vi.spyOn(worker as any, "handleUserPromptedAgentActivity");

		await deliver(
			worker,
			newCommentWebhook({ actorId: APP_USER, actor: { id: APP_USER } }),
		);

		expect(prompted).not.toHaveBeenCalled();
		expect(tracker.fetchComment).not.toHaveBeenCalled();
	});

	it("ignores comments by other apps and integrations", async () => {
		const worker = makeWorker();
		const prompted = vi.spyOn(worker as any, "handleUserPromptedAgentActivity");

		comments["c-1"] = { botActor: { name: "Some integration" } };
		await deliver(worker, newCommentWebhook());
		comments["c-2"] = { app: true };
		await deliver(worker, newCommentWebhook({}, "c-2"));
		// No Linear user at all (synced from an external tool).
		comments["c-3"] = {};
		await deliver(
			worker,
			newCommentWebhook({ actorId: undefined, actor: undefined }, "c-3"),
		);

		expect(prompted).not.toHaveBeenCalled();
	});

	it("ignores replies in an agent session thread", async () => {
		const worker = makeWorker();
		const prompted = vi.spyOn(worker as any, "handleUserPromptedAgentActivity");
		comments["c-root"] = { agentSessionId: "s-new" };
		comments["c-1"] = { parentId: "c-root" };

		await deliver(worker, newCommentWebhook({ parentCommentId: "c-root" }));

		expect(prompted).not.toHaveBeenCalled();
	});

	it("delivers a reply in an ordinary comment thread", async () => {
		const worker = makeWorker();
		const prompted = vi
			.spyOn(worker as any, "handleUserPromptedAgentActivity")
			.mockResolvedValue(undefined);
		comments["c-root"] = {};
		comments["c-1"] = { parentId: "c-root" };

		await deliver(worker, newCommentWebhook({ parentCommentId: "c-root" }));

		expect(prompted).toHaveBeenCalledTimes(1);
	});

	it("ignores a comment that started an agent session (an @mention)", async () => {
		const worker = makeWorker();
		const prompted = vi.spyOn(worker as any, "handleUserPromptedAgentActivity");
		comments["c-1"] = { agentSessionId: "s-other" };

		await deliver(worker, newCommentWebhook());

		expect(prompted).not.toHaveBeenCalled();
	});

	it("does not deliver a thread reply that already arrived as prompted", async () => {
		const worker = makeWorker();
		const prompted = vi
			.spyOn(worker as any, "handleUserPromptedAgentActivity")
			.mockResolvedValue(undefined);

		await deliver(worker, {
			type: "AgentSessionEvent",
			action: "prompted",
			organizationId: "test-workspace",
			createdAt: new Date().toISOString(),
			agentSession: { id: "s-new", issue: { id: "issue-1" } },
			agentActivity: {
				sourceCommentId: "c-1",
				content: { type: "prompt", body: "please fix the merge conflict" },
			},
		});
		await deliver(worker, newCommentWebhook());

		expect(prompted).toHaveBeenCalledTimes(1);
		expect(tracker.fetchComment).not.toHaveBeenCalled();
	});

	it("delivers the same comment only once", async () => {
		const worker = makeWorker();
		const prompted = vi
			.spyOn(worker as any, "handleUserPromptedAgentActivity")
			.mockResolvedValue(undefined);

		await Promise.all([
			deliver(worker, newCommentWebhook()),
			deliver(worker, newCommentWebhook()),
		]);
		await deliver(worker, newCommentWebhook());

		expect(prompted).toHaveBeenCalledTimes(1);
	});

	it("ignores comments on issues without a Cyrus session", async () => {
		const worker = makeWorker();
		const prompted = vi.spyOn(worker as any, "handleUserPromptedAgentActivity");

		await deliver(
			worker,
			newCommentWebhook({
				issueId: "issue-2",
				issue: { id: "issue-2", identifier: "DEF-456", title: "Other" },
			}),
		);

		expect(prompted).not.toHaveBeenCalled();
	});

	it("ignores comments once the issue is no longer delegated to Cyrus", async () => {
		const worker = makeWorker();
		const prompted = vi.spyOn(worker as any, "handleUserPromptedAgentActivity");
		issue = { delegateId: "another-agent", assigneeId: "human" };

		await deliver(worker, newCommentWebhook());

		expect(prompted).not.toHaveBeenCalled();
	});

	it("accepts an issue assigned (rather than delegated) to Cyrus", async () => {
		const worker = makeWorker();
		const prompted = vi
			.spyOn(worker as any, "handleUserPromptedAgentActivity")
			.mockResolvedValue(undefined);
		issue = { assigneeId: APP_USER };

		await deliver(worker, newCommentWebhook());

		expect(prompted).toHaveBeenCalledTimes(1);
	});

	it("applies user access control to the comment's author", async () => {
		const worker = makeWorker({
			...mockConfig,
			userAccessControl: { blockedUsers: ["human"] },
		});
		const blocked = vi
			.spyOn(worker as any, "handleBlockedUser")
			.mockResolvedValue(undefined);
		const normal = vi
			.spyOn(worker as any, "handleNormalPromptedActivity")
			.mockResolvedValue(undefined);

		await deliver(worker, newCommentWebhook());

		expect(normal).not.toHaveBeenCalled();
		expect(blocked).toHaveBeenCalledTimes(1);
		expect(blocked.mock.calls[0]![0]).toMatchObject({
			agentSession: { id: "s-new", creator: { id: "human" } },
		});
	});

	it("does nothing when issueCommentsAsReplies is false", async () => {
		const worker = makeWorker({ ...mockConfig, issueCommentsAsReplies: false });
		const prompted = vi.spyOn(worker as any, "handleUserPromptedAgentActivity");

		await deliver(worker, newCommentWebhook());

		expect(prompted).not.toHaveBeenCalled();
		expect(tracker.fetchComment).not.toHaveBeenCalled();
	});

	it("does not deliver a comment it could not check", async () => {
		const worker = makeWorker();
		const prompted = vi.spyOn(worker as any, "handleUserPromptedAgentActivity");
		tracker.fetchComment.mockRejectedValueOnce(new Error("rate limited"));

		await deliver(worker, newCommentWebhook());

		expect(prompted).not.toHaveBeenCalled();
	});
});

describe("newestLinearSession", () => {
	it("picks the newest Linear session whatever its status", () => {
		const base = { issue: { id: "i" }, repositories: [], workspace: {} };
		const picked = newestLinearSession([
			{ ...base, id: "a", createdAt: 1, status: "active" },
			{ ...base, id: "b", createdAt: 3, status: "complete" },
			{
				...base,
				id: "c",
				createdAt: 5,
				issueContext: { trackerId: "github" },
			},
		] as any);
		expect(picked?.id).toBe("b");
	});

	it("returns null when there is none", () => {
		expect(newestLinearSession([])).toBeNull();
	});
});
