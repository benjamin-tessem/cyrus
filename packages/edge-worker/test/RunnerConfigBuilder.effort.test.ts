import type { CyrusAgentSession, ILogger, RepositoryConfig } from "cyrus-core";
import { describe, expect, it } from "vitest";
import {
	type IRunnerSelector,
	RunnerConfigBuilder,
} from "../src/RunnerConfigBuilder.js";

const silentLogger = {
	debug: () => {},
	info: () => {},
	warn: () => {},
	error: () => {},
} as unknown as ILogger;

function buildConfig(
	selection: ReturnType<IRunnerSelector["determineRunnerSelection"]>,
	defaultEffort: "low" | "medium" | undefined,
	session: Partial<CyrusAgentSession> = {},
) {
	const runnerSelector: IRunnerSelector = {
		determineRunnerSelection: () => selection,
		getDefaultModelForRunner: () => "opus",
		getDefaultFallbackModelForRunner: () => "sonnet",
		getDefaultEffortForRunner: (runnerType) =>
			runnerType === "claude" ? defaultEffort : undefined,
	};
	const builder = new RunnerConfigBuilder(
		{ buildChatAllowedTools: () => [] },
		{ buildMcpConfig: () => ({}), buildMergedMcpConfigPath: () => undefined },
		runnerSelector,
	);
	return builder.buildIssueConfig({
		session: {
			issueId: "issue-1",
			issue: { identifier: "ABC-1" },
			workspace: { path: "/ws", isGitWorktree: true },
			...session,
		} as unknown as CyrusAgentSession,
		repository: {
			id: "repo-a",
			name: "Repo A",
			repositoryPath: "/repos/repo-a",
		} as unknown as RepositoryConfig,
		sessionId: "sess-1",
		systemPrompt: "test",
		allowedTools: [],
		allowedDirectories: [],
		disallowedTools: [],
		cyrusHome: "/tmp/cyrus-home",
		linearWorkspaceId: "ws-1",
		logger: silentLogger,
		onMessage: () => {},
		onError: () => {},
		requireLinearWorkspaceId: () => "ws-1",
	}).config;
}

describe("RunnerConfigBuilder effort", () => {
	it("uses the per-ticket effort over the default", () => {
		expect(
			buildConfig({ runnerType: "claude", effortOverride: "max" }, "medium")
				.effort,
		).toBe("max");
	});

	it("falls back to the default without a per-ticket effort", () => {
		expect(buildConfig({ runnerType: "claude" }, "medium").effort).toBe(
			"medium",
		);
	});

	it("sets no effort when neither is configured", () => {
		expect(buildConfig({ runnerType: "claude" }, undefined)).not.toHaveProperty(
			"effort",
		);
	});
});
