/**
 * Bringing work back after a restart.
 *
 * Stopping Cyrus kills every runner. Sessions that were running, or waiting
 * for a concurrency slot, are saved as "active" but nothing restarts them:
 * without this they sit in Linear looking busy until a human replies.
 *
 * On startup the EdgeWorker plans one action per saved active Linear session,
 * plus any session with a follow-up that was still queued at shutdown (a
 * reply to a finished session queues while the session stays "complete"),
 * and replays it through its normal handlers:
 *
 * - The agent had started (it has a runner session id): prompt it to pick
 *   up where it left off, resuming the same transcript and worktree. If a
 *   follow-up message was waiting in the queue at shutdown, deliver that
 *   message instead, so it isn't lost.
 * - The agent never started (still queued for its first run): start it
 *   again from scratch, as if the ticket had just been delegated.
 */

import { AgentSessionStatus, type CyrusAgentSession } from "cyrus-core";

export const INTERRUPTED_PROMPT =
	"Cyrus was restarted while you were working on this, which interrupted your previous run. Check where things stand (git status, recent changes, anything half-finished) and continue where you left off.";

export function queuedMessagePrompt(message: string): string {
	return `Cyrus was restarted while the message below was waiting in the queue, so it was never delivered to you. Handle it now.\n\n<queued_message>\n${message}\n</queued_message>`;
}

export type RestartRecoveryAction =
	| {
			kind: "prompt";
			sessionId: string;
			issue: { id: string; identifier: string; title: string };
			prompt: string;
	  }
	| {
			kind: "restart";
			sessionId: string;
			issue: { id: string; identifier: string; title: string };
	  };

function hasStartedRunner(session: CyrusAgentSession): boolean {
	return Boolean(
		session.claudeSessionId ||
			session.codexSessionId ||
			session.geminiSessionId ||
			session.cursorSessionId ||
			session.opencodeSessionId,
	);
}

/**
 * Decide what to do with each session the previous process left unfinished.
 *
 * `pendingPrompts` maps session id to a follow-up that was queued behind the
 * concurrency cap when Cyrus last stopped cleanly; it is empty after a crash.
 * Sessions are returned oldest first so the queue keeps its order.
 */
export function planRestartRecovery(
	sessions: CyrusAgentSession[],
	pendingPrompts: Record<string, string> = {},
): RestartRecoveryAction[] {
	const actions: RestartRecoveryAction[] = [];
	const unfinished = sessions.filter(
		(session) =>
			session.status === AgentSessionStatus.Active ||
			pendingPrompts[session.id] !== undefined,
	);
	unfinished.sort((a, b) => a.createdAt - b.createdAt);
	for (const session of unfinished) {
		// Only Linear sessions can be replayed through the Linear handlers.
		if (session.issueContext && session.issueContext.trackerId !== "linear") {
			continue;
		}
		const issue = session.issue;
		if (!issue?.id) continue;
		const target = {
			id: issue.id,
			identifier: issue.identifier,
			title: issue.title,
		};

		if (!hasStartedRunner(session)) {
			actions.push({ kind: "restart", sessionId: session.id, issue: target });
			continue;
		}
		const pending = pendingPrompts[session.id];
		actions.push({
			kind: "prompt",
			sessionId: session.id,
			issue: target,
			prompt: pending ? queuedMessagePrompt(pending) : INTERRUPTED_PROMPT,
		});
	}
	return actions;
}
