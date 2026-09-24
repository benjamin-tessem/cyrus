/**
 * Telling an agent that CI failed on its pull request.
 *
 * GitHub sends `check_suite` `completed` once per finished suite (GitHub
 * Actions makes one suite per workflow run, other apps one each), so a
 * single suite finishing says nothing about the commit as a whole. On each
 * one the EdgeWorker asks the GitHub API for every check run and commit
 * status on the head commit, and prompts the owning session only when all
 * of them are done and at least one failed. Each head commit is reported
 * at most once; a new push is a new commit and resets that.
 */

import type { CyrusAgentSession } from "cyrus-core";

/** Check run conclusions that count as a failure. */
const FAILING_CONCLUSIONS = new Set([
	"failure",
	"timed_out",
	"startup_failure",
	"action_required",
]);

/** Commit status states that count as a failure. */
const FAILING_STATUS_STATES = new Set(["failure", "error"]);

/** How many notified head commits the state file remembers. */
export const MAX_NOTIFIED_CI_SHAS = 500;

export interface CheckRunSummary {
	name: string;
	/** queued | in_progress | completed | waiting | requested | pending */
	status: string;
	conclusion: string | null;
}

export interface CommitStatusSummary {
	context: string;
	/** pending | success | failure | error */
	state: string;
}

export type CiVerdict =
	| { kind: "pending" }
	| { kind: "passed" }
	| { kind: "failed"; failingChecks: string[] };

/**
 * Decide what the checks on one commit add up to: still running, all
 * green, or finished with failures (named in the order GitHub listed them).
 */
export function evaluateCiState(
	checkRuns: CheckRunSummary[],
	statuses: CommitStatusSummary[],
): CiVerdict {
	const pending =
		checkRuns.some((run) => run.status !== "completed") ||
		statuses.some((status) => status.state === "pending");
	if (pending) return { kind: "pending" };

	const failing = [
		...checkRuns
			.filter((run) => FAILING_CONCLUSIONS.has(run.conclusion ?? ""))
			.map((run) => run.name),
		...statuses
			.filter((status) => FAILING_STATUS_STATES.has(status.state))
			.map((status) => status.context),
	];
	if (failing.length === 0) return { kind: "passed" };
	return { kind: "failed", failingChecks: [...new Set(failing)] };
}

export function ciFailurePrompt(
	prNumber: number,
	headSha: string,
	failingChecks: string[],
): string {
	return `CI failed on your PR #${prNumber} (commit ${headSha.slice(0, 7)}). Failing checks: ${failingChecks.join(", ")}. Read the failures with \`gh pr checks ${prNumber}\` and \`gh run view <run-id> --log-failed\`, fix them on this branch, push, and confirm CI goes green. If a failure is unrelated to this change (flaky, or already failing on main), say so with the evidence instead of changing code.`;
}

/**
 * The Linear issue identifier a branch name points at, e.g.
 * `cyrus/def-123` or `someone/def-123-fix-login` → `DEF-123`.
 */
export function identifierFromBranch(branchName: string): string | null {
	const lastSegment = branchName.split("/").pop() ?? "";
	const match = /^([a-z][a-z0-9]*-\d+)(?:-|$)/i.exec(lastSegment);
	return match ? match[1]!.toUpperCase() : null;
}

function isLinearSession(session: CyrusAgentSession): boolean {
	return session.issueContext
		? session.issueContext.trackerId === "linear"
		: Boolean(session.issue?.id);
}

/**
 * The Linear session that owns a branch in a repository: the newest one
 * whose issue or repository context names the branch, whatever its status.
 * Falls back to the issue identifier in the branch name when no session
 * recorded the branch itself. `repositoryIdOf` gives the repository a
 * session is mapped to, for sessions restored without repository context.
 */
export function findSessionForBranch(
	sessions: CyrusAgentSession[],
	branchName: string,
	repositoryId: string,
	repositoryIdOf: (sessionId: string) => string | undefined = () => undefined,
): CyrusAgentSession | null {
	const candidates = sessions
		.filter(isLinearSession)
		.filter((session) => {
			const repoIds = new Set(
				(session.repositories ?? []).map((repo) => repo.repositoryId),
			);
			const mapped = repositoryIdOf(session.id);
			if (mapped) repoIds.add(mapped);
			// Unknown repository: don't rule the session out on that alone.
			return repoIds.size === 0 || repoIds.has(repositoryId);
		})
		.sort(
			(a, b) =>
				b.createdAt - a.createdAt || (b.updatedAt ?? 0) - (a.updatedAt ?? 0),
		);

	const byBranch = candidates.find(
		(session) =>
			session.issue?.branchName === branchName ||
			(session.repositories ?? []).some(
				(repo) =>
					repo.repositoryId === repositoryId && repo.branchName === branchName,
			),
	);
	if (byBranch) return byBranch;

	const identifier = identifierFromBranch(branchName);
	if (!identifier) return null;
	return (
		candidates.find(
			(session) =>
				(session.issue?.identifier ?? session.issueContext?.issueIdentifier)
					?.toUpperCase()
					.trim() === identifier,
		) ?? null
	);
}

/**
 * Head commits already reported, oldest first, capped so the state file
 * does not grow without bound.
 */
export class NotifiedShaSet {
	private shas = new Set<string>();

	constructor(private readonly limit = MAX_NOTIFIED_CI_SHAS) {}

	has(sha: string): boolean {
		return this.shas.has(sha);
	}

	add(sha: string): void {
		this.shas.delete(sha);
		this.shas.add(sha);
		while (this.shas.size > this.limit) {
			const oldest = this.shas.values().next().value;
			if (oldest === undefined) break;
			this.shas.delete(oldest);
		}
	}

	delete(sha: string): void {
		this.shas.delete(sha);
	}

	toJSON(): string[] {
		return [...this.shas];
	}

	restore(shas: string[] | undefined): void {
		this.shas.clear();
		for (const sha of shas ?? []) this.add(sha);
	}

	get size(): number {
		return this.shas.size;
	}
}
