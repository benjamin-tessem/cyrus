/**
 * Telling an agent that its pull request has merge conflicts.
 *
 * Conflicts usually appear because the base branch moved, and GitHub sends
 * no pull_request event for that. So the EdgeWorker checks a Cyrus-owned
 * open PR when:
 * - a `push` lands on a branch that is the base of such a PR (or on the
 *   PR's own head branch),
 * - a `pull_request` event (opened, reopened, synchronize, ready_for_review,
 *   or edited with a new base) arrives for it,
 * - a low-frequency in-process sweep of every Cyrus-owned open PR runs, as
 *   a fallback for missed webhooks and Apps without those subscriptions.
 *
 * Each check reads the PR from the pulls API. GitHub computes `mergeable`
 * lazily in the background, so a `null` is re-read a few times with a
 * growing delay; if it is still unknown the next trigger or sweep looks
 * again. `mergeable === false` means conflicts (mergeable_state "dirty").
 * Draft PRs are checked too: an agent's draft still has to merge cleanly.
 *
 * A conflict is reported once per (head commit, base commit) pair, so a
 * new push to either side can report it again but a restart does not.
 */

/** How many reported (head, base) pairs the state file remembers. */
export const MAX_NOTIFIED_CONFLICTS = 500;

/**
 * Delays before re-reading a PR whose `mergeable` is still null (GitHub
 * computing it). Bounded: after the last one the check gives up.
 */
export const MERGEABLE_RETRY_DELAYS_MS: readonly number[] = [
	3_000, 10_000, 30_000,
];

/** How often every Cyrus-owned open PR is checked, as a fallback. */
export const MERGE_CONFLICT_SWEEP_INTERVAL_MS = 20 * 60 * 1000;

export function mergeConflictPrompt(
	prNumber: number,
	baseRef: string,
	baseSha: string,
): string {
	return `Your PR #${prNumber} has merge conflicts with ${baseRef} (${baseRef} is now at ${baseSha.slice(0, 7)}). Update your branch with the latest ${baseRef} — merge or rebase, whichever this repository's instructions prefer — resolve every conflict so both sides' intent is kept, run the checks the repository requires, and push. If a conflict can't be resolved without a product decision, explain the options instead of guessing.`;
}

/** Dedupe key for one conflict: the PR's head commit against a base commit. */
export function conflictKey(headSha: string, baseSha: string): string {
	return `${headSha}:${baseSha}`;
}

/**
 * `owner/repo` from a GitHub repository URL (https, ssh or scp-like), or
 * null when it isn't one.
 */
export function repoFullNameFromGitHubUrl(
	url: string | undefined,
): string | null {
	if (!url) return null;
	const match = /github\.com[/:]([^/\s]+)\/([^/\s#?]+?)(?:\.git)?\/?$/i.exec(
		url.trim(),
	);
	return match ? `${match[1]}/${match[2]}` : null;
}
