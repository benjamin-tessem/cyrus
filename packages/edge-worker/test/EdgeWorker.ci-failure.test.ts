import { LinearClient } from "@linear/sdk";
import { ClaudeRunner } from "cyrus-claude-runner";
import { AgentSessionStatus } from "cyrus-core";
import { LinearEventTransport } from "cyrus-linear-event-transport";
import { createCyrusToolsServer } from "cyrus-mcp-tools";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSessionManager } from "../src/AgentSessionManager.js";
import {
	ciFailurePrompt,
	evaluateCiState,
	findSessionForBranch,
	identifierFromBranch,
	NotifiedShaSet,
} from "../src/CiFailureNotifier.js";
import { EdgeWorker } from "../src/EdgeWorker.js";
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

const SHA = "abc1234def5678900000000000000000000000000";

/**
 * CI failing on a PR a Cyrus agent opened used to go unnoticed until a
 * human looked (or an external script polled `gh pr list`). A finished
 * check suite now tells the agent that owns the branch, once per commit.
 */
describe("EdgeWorker - CI failure notifications", () => {
	const repo: RepositoryConfig = {
		id: "repo-a",
		name: "Repo A",
		repositoryPath: "/test/repo-a",
		workspaceBaseDir: "/test/workspaces",
		baseBranch: "main",
		linearWorkspaceId: "test-workspace",
		isActive: true,
		teamKeys: ["DEF"],
		githubUrl: "https://github.com/acme/app",
	};

	function session(id: string, extra: Record<string, unknown> = {}) {
		return {
			id,
			status: AgentSessionStatus.Complete,
			createdAt: Number(id.replace(/\D/g, "")) || 1,
			updatedAt: 1,
			issueContext: {
				trackerId: "linear",
				issueId: "issue-123",
				issueIdentifier: "DEF-123",
			},
			issue: {
				id: "issue-123",
				identifier: "DEF-123",
				title: "Fix login",
				branchName: "cyrus/def-123",
			},
			repositories: [{ repositoryId: repo.id, branchName: "cyrus/def-123" }],
			...extra,
		};
	}

	function checkSuiteEvent(
		branch = "cyrus/def-123",
		pullRequests: unknown[] = [
			{
				number: 42,
				head: { ref: branch, sha: SHA },
				base: { ref: "main", sha: "base" },
			},
		],
	) {
		return {
			eventType: "check_suite",
			deliveryId: "delivery-1",
			installationToken: "inst-token",
			payload: {
				action: "completed",
				check_suite: {
					id: 1,
					head_branch: branch,
					head_sha: SHA,
					status: "completed",
					conclusion: "failure",
					pull_requests: pullRequests,
				},
				repository: { full_name: "acme/app" },
				sender: { login: "github-actions[bot]" },
			},
		} as any;
	}

	/** Answer GitHub API calls from a fixed set of check runs and statuses. */
	function githubReturns(
		checkRuns: Array<{
			name: string;
			status: string;
			conclusion: string | null;
		}>,
		statuses: Array<{ context: string; state: string }> = [],
		checkRunsStatus = 200,
	) {
		const fetchMock = vi.fn(async (url: string) => {
			if (url.includes("/check-runs")) {
				return new Response(
					JSON.stringify({
						total_count: checkRuns.length,
						check_runs: checkRuns,
					}),
					{ status: checkRunsStatus },
				);
			}
			if (url.includes("/status")) {
				return new Response(JSON.stringify({ statuses }), { status: 200 });
			}
			if (url.includes("/pulls")) {
				return new Response(
					JSON.stringify([{ number: 42, head: { sha: SHA } }]),
					{ status: 200 },
				);
			}
			return new Response("{}", { status: 404 });
		});
		vi.stubGlobal("fetch", fetchMock);
		return fetchMock;
	}

	let sessions: any[];
	let mockConfig: EdgeWorkerConfig;

	beforeEach(() => {
		vi.clearAllMocks();
		sessions = [session("s1")];

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

		mockConfig = {
			proxyUrl: "http://localhost:3000",
			cyrusHome: TEST_CYRUS_HOME,
			repositories: [repo],
			linearWorkspaces: { "test-workspace": { linearToken: "test-token" } },
			handlers: {},
		};
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	function makeWorker() {
		const worker = new EdgeWorker(mockConfig);
		(worker as any).repositoryRouter
			.getIssueRepositoryCache()
			.set("issue-123", [repo.id]);
		vi.spyOn(worker as any, "savePersistedState").mockResolvedValue(undefined);
		const prompted = vi
			.spyOn(worker as any, "handleUserPromptedAgentActivity")
			.mockResolvedValue(undefined);
		// Linear still has the issue delegated to Cyrus unless a test says
		// otherwise.
		const linear = {
			delegateId: "app-user" as string | null,
			stateType: "started",
		};
		(worker as any).issueTrackers.set("test-workspace", {
			fetchCurrentUser: vi.fn().mockResolvedValue({ id: "app-user" }),
			fetchIssue: vi.fn(async () => ({
				delegateId: linear.delegateId,
				assigneeId: null,
				state: Promise.resolve({ type: linear.stateType }),
			})),
		});
		return { worker, prompted, linear };
	}

	it("doesn't prompt once the issue is unassigned from Cyrus or closed", async () => {
		githubReturns(
			[{ name: "test", status: "completed", conclusion: "failure" }],
			[],
		);
		const { worker, prompted, linear } = makeWorker();

		linear.delegateId = null;
		await (worker as any).handleGitHubCheckSuiteWebhook(checkSuiteEvent());
		expect(prompted).not.toHaveBeenCalled();

		linear.delegateId = "app-user";
		linear.stateType = "canceled";
		await (worker as any).handleGitHubCheckSuiteWebhook(checkSuiteEvent());
		expect(prompted).not.toHaveBeenCalled();

		// Handed back to Cyrus: the same red commit is reported after all.
		linear.stateType = "started";
		await (worker as any).handleGitHubCheckSuiteWebhook(checkSuiteEvent());
		expect(prompted).toHaveBeenCalledTimes(1);
	});

	it("prompts the owning session when checks finished red", async () => {
		const fetchMock = githubReturns(
			[
				{ name: "build", status: "completed", conclusion: "success" },
				{ name: "test", status: "completed", conclusion: "failure" },
			],
			[{ context: "ci/legacy", state: "error" }],
		);
		const { worker, prompted } = makeWorker();

		await (worker as any).handleGitHubCheckSuiteWebhook(checkSuiteEvent());

		expect(prompted).toHaveBeenCalledTimes(1);
		expect(prompted.mock.calls[0]![0]).toMatchObject({
			action: "prompted",
			organizationId: "test-workspace",
			agentSession: {
				id: "s1",
				issue: { id: "issue-123", identifier: "DEF-123" },
			},
			agentActivity: {
				content: {
					type: "prompt",
					body: ciFailurePrompt(42, SHA, ["test", "ci/legacy"]),
				},
			},
		});
		const body = (prompted.mock.calls[0]![0] as any).agentActivity.content.body;
		expect(body).toBe(
			"CI failed on your PR #42 (commit abc1234). Failing checks: test, ci/legacy. Read the failures with `gh pr checks 42` and `gh run view <run-id> --log-failed`, fix them on this branch, push, and confirm CI goes green. If a failure is unrelated to this change (flaky, or already failing on main), say so with the evidence instead of changing code.",
		);
		// Used the installation token and asked about the head commit.
		const checkRunsCall = fetchMock.mock.calls.find(([url]) =>
			String(url).includes("/check-runs"),
		)!;
		expect(checkRunsCall[0]).toContain(`/repos/acme/app/commits/${SHA}/`);
		expect((checkRunsCall[1] as any).headers.Authorization).toBe(
			"Bearer inst-token",
		);
	});

	it("waits while any check is still running", async () => {
		githubReturns([
			{ name: "test", status: "completed", conclusion: "failure" },
			{ name: "e2e", status: "in_progress", conclusion: null },
		]);
		const { worker, prompted } = makeWorker();

		await (worker as any).handleGitHubCheckSuiteWebhook(checkSuiteEvent());

		expect(prompted).not.toHaveBeenCalled();
		// Not marked: the last suite to finish still gets its say.
		expect(worker.serializeMappings().ciFailureNotifiedShas).toBeUndefined();
	});

	it("waits on a pending commit status too", async () => {
		githubReturns(
			[{ name: "test", status: "completed", conclusion: "failure" }],
			[{ context: "deploy/preview", state: "pending" }],
		);
		const { worker, prompted } = makeWorker();

		await (worker as any).handleGitHubCheckSuiteWebhook(checkSuiteEvent());

		expect(prompted).not.toHaveBeenCalled();
	});

	it("stays quiet when everything passed", async () => {
		githubReturns([
			{ name: "build", status: "completed", conclusion: "success" },
			{ name: "lint", status: "completed", conclusion: "skipped" },
		]);
		const { worker, prompted } = makeWorker();

		await (worker as any).handleGitHubCheckSuiteWebhook(checkSuiteEvent());

		expect(prompted).not.toHaveBeenCalled();
	});

	it("reports a commit once, however many suites finish", async () => {
		const fetchMock = githubReturns([
			{ name: "test", status: "completed", conclusion: "failure" },
		]);
		const { worker, prompted } = makeWorker();

		await Promise.all([
			(worker as any).handleGitHubCheckSuiteWebhook(checkSuiteEvent()),
			(worker as any).handleGitHubCheckSuiteWebhook(checkSuiteEvent()),
		]);
		const callsAfterFirst = fetchMock.mock.calls.length;
		await (worker as any).handleGitHubCheckSuiteWebhook(checkSuiteEvent());

		expect(prompted).toHaveBeenCalledTimes(1);
		// Once reported, later suites don't even hit the API.
		expect(fetchMock.mock.calls.length).toBe(callsAfterFirst);
	});

	it("ignores branches no Cyrus session owns", async () => {
		const fetchMock = githubReturns([
			{ name: "test", status: "completed", conclusion: "failure" },
		]);
		const { worker, prompted } = makeWorker();

		await (worker as any).handleGitHubCheckSuiteWebhook(
			checkSuiteEvent("dependabot/npm/lodash-4.17.21"),
		);
		await (worker as any).handleGitHubCheckSuiteWebhook({
			...checkSuiteEvent(),
			payload: {
				...checkSuiteEvent().payload,
				repository: { full_name: "someone/else" },
			},
		});

		expect(prompted).not.toHaveBeenCalled();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("looks up the PR when the event doesn't carry it", async () => {
		const fetchMock = githubReturns([
			{ name: "test", status: "completed", conclusion: "timed_out" },
		]);
		const { worker, prompted } = makeWorker();

		await (worker as any).handleGitHubCheckSuiteWebhook(
			checkSuiteEvent("cyrus/def-123", []),
		);

		expect(
			fetchMock.mock.calls.some(([url]) =>
				String(url).includes(
					`/pulls?state=open&head=${encodeURIComponent("acme:cyrus/def-123")}`,
				),
			),
		).toBe(true);
		expect(prompted).toHaveBeenCalledTimes(1);
		expect(
			(prompted.mock.calls[0]![0] as any).agentActivity.content.body,
		).toContain("PR #42");
	});

	it("skips a commit the PR has already moved past", async () => {
		githubReturns([
			{ name: "test", status: "completed", conclusion: "failure" },
		]);
		const { worker, prompted } = makeWorker();

		await (worker as any).handleGitHubCheckSuiteWebhook(
			checkSuiteEvent("cyrus/def-123", [
				{
					number: 42,
					head: { ref: "cyrus/def-123", sha: "newer" },
					base: { ref: "main", sha: "base" },
				},
			]),
		);

		expect(prompted).not.toHaveBeenCalled();
	});

	it("warns once, and does nothing, without Checks permission", async () => {
		githubReturns([], [], 403);
		const { worker, prompted } = makeWorker();
		const warn = vi.spyOn((worker as any).logger, "warn");

		await (worker as any).handleGitHubCheckSuiteWebhook(checkSuiteEvent());
		await (worker as any).handleGitHubCheckSuiteWebhook(checkSuiteEvent());

		expect(prompted).not.toHaveBeenCalled();
		const permissionWarnings = warn.mock.calls.filter(([msg]) =>
			String(msg).includes("Checks: read"),
		);
		expect(permissionWarnings).toHaveLength(1);
	});

	it("remembers reported commits across a restart", async () => {
		githubReturns([
			{ name: "test", status: "completed", conclusion: "failure" },
		]);
		const before = makeWorker();
		await (before.worker as any).handleGitHubCheckSuiteWebhook(
			checkSuiteEvent(),
		);
		expect(before.prompted).toHaveBeenCalledTimes(1);
		const state = before.worker.serializeMappings();
		expect(state.ciFailureNotifiedShas).toEqual([SHA]);

		const after = makeWorker();
		after.worker.restoreMappings(state);
		await (after.worker as any).handleGitHubCheckSuiteWebhook(
			checkSuiteEvent(),
		);

		expect(after.prompted).not.toHaveBeenCalled();
	});
});

describe("CiFailureNotifier", () => {
	it("counts the same conclusions as failures that the old script did", () => {
		const verdict = evaluateCiState(
			[
				{ name: "a", status: "completed", conclusion: "failure" },
				{ name: "b", status: "completed", conclusion: "timed_out" },
				{ name: "c", status: "completed", conclusion: "startup_failure" },
				{ name: "d", status: "completed", conclusion: "action_required" },
				{ name: "e", status: "completed", conclusion: "cancelled" },
				{ name: "f", status: "completed", conclusion: "neutral" },
			],
			[{ context: "g", state: "failure" }],
		);
		expect(verdict).toEqual({
			kind: "failed",
			failingChecks: ["a", "b", "c", "d", "g"],
		});
		expect(evaluateCiState([], [])).toEqual({ kind: "passed" });
	});

	it("parses the issue identifier out of a branch name", () => {
		expect(identifierFromBranch("cyrus/def-123")).toBe("DEF-123");
		expect(identifierFromBranch("someone/def-7-fix-login")).toBe("DEF-7");
		expect(identifierFromBranch("main")).toBeNull();
	});

	it("maps a branch to the newest Linear session that owns it", () => {
		const base = {
			status: AgentSessionStatus.Complete,
			updatedAt: 0,
			issueContext: {
				trackerId: "linear",
				issueId: "i",
				issueIdentifier: "DEF-1",
			},
			issue: {
				id: "i",
				identifier: "DEF-1",
				title: "t",
				branchName: "cyrus/def-1",
			},
			repositories: [{ repositoryId: "repo-a" }],
		};
		const sessions = [
			{ ...base, id: "old", createdAt: 1 },
			{ ...base, id: "new", createdAt: 2 },
			// A GitHub @mention session on the same branch isn't ours to prompt.
			{
				...base,
				id: "github-x",
				createdAt: 3,
				issueContext: { ...base.issueContext, trackerId: "github" },
			},
			// Same branch name in another repository.
			{
				...base,
				id: "other-repo",
				createdAt: 4,
				repositories: [{ repositoryId: "repo-b" }],
			},
		] as any[];

		expect(findSessionForBranch(sessions, "cyrus/def-1", "repo-a")?.id).toBe(
			"new",
		);
		// Falls back to the identifier when no session recorded the branch.
		expect(
			findSessionForBranch(sessions, "someone/def-1-renamed", "repo-a")?.id,
		).toBe("new");
		expect(findSessionForBranch(sessions, "cyrus/def-2", "repo-a")).toBeNull();
	});

	it("keeps only the most recent reported commits", () => {
		const set = new NotifiedShaSet(2);
		set.add("a");
		set.add("b");
		set.add("c");
		expect(set.toJSON()).toEqual(["b", "c"]);
		const restored = new NotifiedShaSet(2);
		restored.restore(["x", "y", "z"]);
		expect(restored.toJSON()).toEqual(["y", "z"]);
	});
});
