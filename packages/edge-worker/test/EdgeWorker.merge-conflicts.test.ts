import { LinearClient } from "@linear/sdk";
import { ClaudeRunner } from "cyrus-claude-runner";
import { AgentSessionStatus } from "cyrus-core";
import { LinearEventTransport } from "cyrus-linear-event-transport";
import { createCyrusToolsServer } from "cyrus-mcp-tools";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSessionManager } from "../src/AgentSessionManager.js";
import { EdgeWorker } from "../src/EdgeWorker.js";
import {
	conflictKey,
	MERGE_CONFLICT_SWEEP_INTERVAL_MS,
	mergeConflictPrompt,
	repoFullNameFromGitHubUrl,
} from "../src/MergeConflictNotifier.js";
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

const HEAD = "1111111aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const BASE = "2222222bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const NEWER_BASE = "3333333ccccccccccccccccccccccccccccccccc";

/**
 * A PR a Cyrus agent opened could start conflicting with its base branch
 * (usually because the base moved on) and sit there until a human noticed.
 * Cyrus now checks those PRs on push / pull_request webhooks and a periodic
 * sweep, and tells the owning agent once per (head, base) commit pair.
 */
describe("EdgeWorker - merge conflict notifications", () => {
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

	function session(id: string) {
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
		};
	}

	/** What the fake GitHub API currently says. */
	interface GitHubState {
		/** mergeable per successive read of the PR; the last value repeats */
		mergeable: Array<boolean | null>;
		headRef: string;
		headSha: string;
		baseTip: string;
		prState: string;
		pullsStatus: number;
	}
	let gh: GitHubState;

	function githubApi() {
		let reads = 0;
		const fetchMock = vi.fn(async (url: string) => {
			if (gh.pullsStatus !== 200 && url.includes("/pulls")) {
				return new Response("{}", { status: gh.pullsStatus });
			}
			if (/\/pulls\/42$/.test(url)) {
				const mergeable =
					gh.mergeable[Math.min(reads, gh.mergeable.length - 1)] ?? null;
				reads++;
				return new Response(
					JSON.stringify({
						number: 42,
						state: gh.prState,
						merged: false,
						mergeable,
						head: { ref: gh.headRef, sha: gh.headSha },
						base: { ref: "main", sha: BASE },
					}),
					{ status: 200 },
				);
			}
			if (url.includes("/pulls?")) {
				return new Response(
					JSON.stringify([
						{
							number: 42,
							head: { ref: gh.headRef, repo: { full_name: "acme/app" } },
						},
					]),
					{ status: 200 },
				);
			}
			if (url.includes("/git/ref/heads/main")) {
				return new Response(JSON.stringify({ object: { sha: gh.baseTip } }), {
					status: 200,
				});
			}
			return new Response("{}", { status: 404 });
		});
		vi.stubGlobal("fetch", fetchMock);
		return fetchMock;
	}

	function pullRequestEvent(action = "synchronize", branch = "cyrus/def-123") {
		return {
			eventType: "pull_request",
			deliveryId: "delivery-1",
			installationToken: "inst-token",
			payload: {
				action,
				number: 42,
				pull_request: {
					number: 42,
					state: "open",
					head: {
						ref: branch,
						sha: HEAD,
						repo: { full_name: "acme/app" },
					},
					base: { ref: "main", sha: BASE, repo: { full_name: "acme/app" } },
				},
				repository: { full_name: "acme/app" },
				sender: { login: "someone" },
			},
		} as any;
	}

	function pushEvent(branch = "main", after = NEWER_BASE) {
		return {
			eventType: "push",
			deliveryId: "delivery-2",
			installationToken: "inst-token",
			payload: {
				ref: `refs/heads/${branch}`,
				before: BASE,
				after,
				deleted: false,
				commits: [],
				repository: { full_name: "acme/app" },
			},
		} as any;
	}

	let sessions: any[];
	let mockConfig: EdgeWorkerConfig;

	beforeEach(() => {
		vi.clearAllMocks();
		sessions = [session("s1")];
		gh = {
			mergeable: [false],
			headRef: "cyrus/def-123",
			headSha: HEAD,
			baseTip: BASE,
			prState: "open",
			pullsStatus: 200,
		};

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
				getSessionsByBaseBranch: vi.fn(() => []),
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
		vi.useRealTimers();
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	function makeWorker() {
		const worker = new EdgeWorker(mockConfig);
		(worker as any).repositoryRouter
			.getIssueRepositoryCache()
			.set("issue-123", [repo.id]);
		(worker as any).mergeableRetryDelaysMs = [0, 0, 0];
		vi.spyOn(worker as any, "savePersistedState").mockResolvedValue(undefined);
		const prompted = vi
			.spyOn(worker as any, "handleUserPromptedAgentActivity")
			.mockResolvedValue(undefined);
		return { worker, prompted };
	}

	function promptBodies(prompted: any): string[] {
		return prompted.mock.calls.map(
			([webhook]: any[]) => webhook.agentActivity.content.body,
		);
	}

	it("prompts the owning session when its PR conflicts", async () => {
		const fetchMock = githubApi();
		const { worker, prompted } = makeWorker();

		await (worker as any).handleGitHubPullRequestWebhook(pullRequestEvent());

		expect(prompted).toHaveBeenCalledTimes(1);
		expect(prompted.mock.calls[0]![0]).toMatchObject({
			action: "prompted",
			organizationId: "test-workspace",
			agentSession: {
				id: "s1",
				issue: { id: "issue-123", identifier: "DEF-123" },
			},
		});
		expect(promptBodies(prompted)).toEqual([
			"Your PR #42 has merge conflicts with main (main is now at 2222222). Update your branch with the latest main — merge or rebase, whichever this repository's instructions prefer — resolve every conflict so both sides' intent is kept, run the checks the repository requires, and push. If a conflict can't be resolved without a product decision, explain the options instead of guessing.",
		]);
		const prCall = fetchMock.mock.calls.find(([url]) =>
			String(url).endsWith("/repos/acme/app/pulls/42"),
		)!;
		expect((prCall[1] as any).headers.Authorization).toBe("Bearer inst-token");
	});

	it("stays quiet when the PR merges cleanly", async () => {
		gh.mergeable = [true];
		githubApi();
		const { worker, prompted } = makeWorker();

		await (worker as any).handleGitHubPullRequestWebhook(pullRequestEvent());

		expect(prompted).not.toHaveBeenCalled();
		expect(
			worker.serializeMappings().mergeConflictNotifiedPairs,
		).toBeUndefined();
	});

	it("waits for GitHub to compute mergeability", async () => {
		gh.mergeable = [null, null, false];
		const fetchMock = githubApi();
		const { worker, prompted } = makeWorker();

		await (worker as any).handleGitHubPullRequestWebhook(pullRequestEvent());

		expect(prompted).toHaveBeenCalledTimes(1);
		const prReads = fetchMock.mock.calls.filter(([url]) =>
			String(url).endsWith("/pulls/42"),
		);
		expect(prReads).toHaveLength(3);
	});

	it("gives up after a bounded number of reads while mergeability is unknown", async () => {
		gh.mergeable = [null];
		const fetchMock = githubApi();
		const { worker, prompted } = makeWorker();

		await (worker as any).handleGitHubPullRequestWebhook(pullRequestEvent());

		expect(prompted).not.toHaveBeenCalled();
		const prReads = fetchMock.mock.calls.filter(([url]) =>
			String(url).endsWith("/pulls/42"),
		);
		// First read plus one per retry delay.
		expect(prReads).toHaveLength(4);
	});

	it("reports the same head/base pair once", async () => {
		githubApi();
		const { worker, prompted } = makeWorker();

		await Promise.all([
			(worker as any).handleGitHubPullRequestWebhook(pullRequestEvent()),
			(worker as any).handleGitHubPullRequestWebhook(pullRequestEvent()),
		]);
		await (worker as any).handleGitHubPullRequestWebhook(pullRequestEvent());
		await (worker as any).sweepMergeConflicts();

		expect(prompted).toHaveBeenCalledTimes(1);
	});

	it("reports again when the base branch moves on", async () => {
		githubApi();
		const { worker, prompted } = makeWorker();

		await (worker as any).handleGitHubPullRequestWebhook(pullRequestEvent());
		gh.baseTip = NEWER_BASE;
		await (worker as any).checkMergeConflictsAfterPush(pushEvent("main"));

		expect(prompted).toHaveBeenCalledTimes(2);
		expect(promptBodies(prompted)[1]).toBe(
			mergeConflictPrompt(42, "main", NEWER_BASE),
		);
		expect(promptBodies(prompted)[1]).toContain("main is now at 3333333");
	});

	it("reports again after a new push to the PR that still conflicts", async () => {
		githubApi();
		const { worker, prompted } = makeWorker();

		await (worker as any).handleGitHubPullRequestWebhook(pullRequestEvent());
		gh.headSha = "4444444ddddddddddddddddddddddddddddddddd";
		await (worker as any).handleGitHubPullRequestWebhook(pullRequestEvent());

		expect(prompted).toHaveBeenCalledTimes(2);
	});

	it("checks the agent PRs based on a branch when that branch is pushed", async () => {
		gh.baseTip = NEWER_BASE;
		const fetchMock = githubApi();
		const { worker, prompted } = makeWorker();

		await (worker as any).checkMergeConflictsAfterPush(pushEvent("main"));

		expect(
			fetchMock.mock.calls.some(([url]) =>
				String(url).includes("/repos/acme/app/pulls?state=open&base=main"),
			),
		).toBe(true);
		expect(promptBodies(prompted)).toEqual([
			mergeConflictPrompt(42, "main", NEWER_BASE),
		]);
	});

	it("routes push and pull_request webhooks to the conflict check", async () => {
		githubApi();
		const { worker } = makeWorker();
		const afterPush = vi
			.spyOn(worker as any, "checkMergeConflictsAfterPush")
			.mockResolvedValue(undefined);
		const onPullRequest = vi
			.spyOn(worker as any, "handleGitHubPullRequestWebhook")
			.mockResolvedValue(undefined);
		vi.spyOn(worker as any, "handleGitHubPushWebhook").mockResolvedValue(
			undefined,
		);
		(worker as any).registerGitHubEventTransport();
		const transport = (worker as any).gitHubEventTransport;

		transport.emit("event", pushEvent("main"));
		transport.emit("event", pullRequestEvent());

		expect(afterPush).toHaveBeenCalledTimes(1);
		expect(onPullRequest).toHaveBeenCalledTimes(1);
	});

	it("ignores branches no Cyrus session owns", async () => {
		gh.headRef = "dependabot/npm/lodash-4.17.21";
		const fetchMock = githubApi();
		const { worker, prompted } = makeWorker();

		await (worker as any).handleGitHubPullRequestWebhook(
			pullRequestEvent("synchronize", "dependabot/npm/lodash-4.17.21"),
		);
		// A push to main lists the PRs based on it, but none is ours.
		await (worker as any).checkMergeConflictsAfterPush(pushEvent("main"));

		expect(prompted).not.toHaveBeenCalled();
		expect(
			fetchMock.mock.calls.some(([url]) => String(url).endsWith("/pulls/42")),
		).toBe(false);
	});

	it("ignores closed PRs and edits that don't change the base", async () => {
		const fetchMock = githubApi();
		const { worker, prompted } = makeWorker();
		const closed = pullRequestEvent();
		closed.payload.pull_request.state = "closed";

		await (worker as any).handleGitHubPullRequestWebhook(closed);
		await (worker as any).handleGitHubPullRequestWebhook(
			pullRequestEvent("edited"),
		);

		expect(prompted).not.toHaveBeenCalled();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("finds a conflict in the periodic sweep", async () => {
		process.env.GITHUB_TOKEN = "pat";
		try {
			const fetchMock = githubApi();
			const { worker, prompted } = makeWorker();

			await (worker as any).sweepMergeConflicts();

			expect(prompted).toHaveBeenCalledTimes(1);
			expect(
				fetchMock.mock.calls.some(([url]) =>
					String(url).includes("/repos/acme/app/pulls?state=open&per_page"),
				),
			).toBe(true);
		} finally {
			delete process.env.GITHUB_TOKEN;
		}
	});

	it("runs the sweep on a timer and clears it on stop", async () => {
		vi.useFakeTimers();
		githubApi();
		const { worker } = makeWorker();
		const sweep = vi
			.spyOn(worker as any, "sweepMergeConflicts")
			.mockResolvedValue(undefined);

		(worker as any).startMergeConflictSweep();
		await vi.advanceTimersByTimeAsync(MERGE_CONFLICT_SWEEP_INTERVAL_MS);
		expect(sweep).toHaveBeenCalledTimes(1);

		await worker.stop();
		expect((worker as any).mergeConflictSweepTimer).toBeNull();
		await vi.advanceTimersByTimeAsync(MERGE_CONFLICT_SWEEP_INTERVAL_MS * 3);
		expect(sweep).toHaveBeenCalledTimes(1);
	});

	it("remembers reported conflicts across a restart", async () => {
		githubApi();
		const before = makeWorker();
		await (before.worker as any).handleGitHubPullRequestWebhook(
			pullRequestEvent(),
		);
		expect(before.prompted).toHaveBeenCalledTimes(1);
		const state = before.worker.serializeMappings();
		expect(state.mergeConflictNotifiedPairs).toEqual([conflictKey(HEAD, BASE)]);

		const after = makeWorker();
		after.worker.restoreMappings(state);
		await (after.worker as any).handleGitHubPullRequestWebhook(
			pullRequestEvent(),
		);

		expect(after.prompted).not.toHaveBeenCalled();
	});

	it("warns once, and does nothing, without pull request access", async () => {
		gh.pullsStatus = 403;
		githubApi();
		const { worker, prompted } = makeWorker();
		const warn = vi.spyOn((worker as any).logger, "warn");

		await (worker as any).handleGitHubPullRequestWebhook(pullRequestEvent());
		await (worker as any).handleGitHubPullRequestWebhook(pullRequestEvent());
		await (worker as any).checkMergeConflictsAfterPush(pushEvent("main"));

		expect(prompted).not.toHaveBeenCalled();
		const permissionWarnings = warn.mock.calls.filter(([msg]) =>
			String(msg).includes("Pull requests: read"),
		);
		expect(permissionWarnings).toHaveLength(1);
	});
});

describe("MergeConflictNotifier", () => {
	it("parses owner/repo out of GitHub URLs", () => {
		expect(repoFullNameFromGitHubUrl("https://github.com/acme/app")).toBe(
			"acme/app",
		);
		expect(repoFullNameFromGitHubUrl("https://github.com/acme/app.git")).toBe(
			"acme/app",
		);
		expect(repoFullNameFromGitHubUrl("git@github.com:acme/app.git")).toBe(
			"acme/app",
		);
		expect(repoFullNameFromGitHubUrl("https://gitlab.com/acme/app")).toBeNull();
		expect(repoFullNameFromGitHubUrl(undefined)).toBeNull();
	});
});
