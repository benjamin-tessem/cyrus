/**
 * Plain issue comments as replies to Cyrus's session.
 *
 * Linear only sends an AgentSessionEvent "prompted" for replies posted in
 * the agent session thread. A regular comment on the issue ("please fix the
 * merge conflict") reaches the app as an inbox notification instead
 * (AppUserNotification "issueNewComment"), sent because the app is
 * subscribed to the issue it was delegated. The EdgeWorker turns such a
 * comment into a prompt for the newest Cyrus session on the issue, through
 * the same handler a thread reply reaches.
 *
 * A comment only counts when a person wrote it (not Cyrus, not another app
 * or integration), when it is outside every agent session thread (those
 * are delivered as "prompted" already), and while the issue is still
 * delegated or assigned to Cyrus.
 */

import type { CyrusAgentSession } from "cyrus-core";

/** How many handled comment ids are remembered to drop redeliveries. */
export const MAX_SEEN_ISSUE_COMMENTS = 500;

/**
 * The parts of an "issueNewComment" notification this feature reads.
 * Linear's payload type is a union over every notification kind, so the
 * fields are read defensively.
 */
export interface IssueCommentNotification {
	commentId?: string;
	comment?: { id?: string; body?: string; userId?: string | null };
	issueId?: string;
	issue?: { id?: string; identifier?: string; title?: string };
	parentCommentId?: string | null;
	actorId?: string | null;
	actor?: { id?: string; name?: string; email?: string } | null;
}

/**
 * The fields of a fetched Linear comment that tell who wrote it and which
 * thread it is in. Linear's SDK has them; the tracker's Comment type does
 * not declare them, so they are read defensively.
 */
export interface FetchedCommentFacts {
	/** Set when an app or integration wrote the comment. */
	botActor?: unknown;
	/** Set when the comment belongs to (or started) an agent session. */
	agentSessionId?: string | null;
	parentId?: string | null;
}

function isLinearSession(session: CyrusAgentSession): boolean {
	return session.issueContext
		? session.issueContext.trackerId === "linear"
		: Boolean(session.issue?.id);
}

/**
 * The session a plain issue comment goes to: the newest Linear session for
 * the issue, whatever its status.
 */
export function newestLinearSession(
	sessions: CyrusAgentSession[],
): CyrusAgentSession | null {
	const candidates = sessions
		.filter(isLinearSession)
		.sort(
			(a, b) =>
				b.createdAt - a.createdAt || (b.updatedAt ?? 0) - (a.updatedAt ?? 0),
		);
	return candidates[0] ?? null;
}

/**
 * The prompt the session receives for a plain issue comment: the comment
 * text, introduced so the agent knows where it came from.
 */
export function issueCommentReplyPrompt(
	authorName: string,
	body: string,
): string {
	return `${authorName} left a regular comment on the issue (not in this agent session's thread):\n\n${body}`;
}
