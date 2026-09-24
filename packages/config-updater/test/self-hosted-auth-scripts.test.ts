import { execFileSync, spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	ensureGhShim,
	ensureGitHubCredentialHelper,
} from "../src/handlers/githubTokens.js";

/**
 * End-to-end checks of the auth wiring a self-hosted install relies on:
 * the gh shim on PATH and the git credential helper in the global git
 * config, both reading a token store under a non-default Cyrus home.
 * Uses a throwaway HOME and a stub gh — never the real GitHub API.
 */
describe("self-hosted GitHub auth scripts", () => {
	let dir: string;
	let home: string;
	let cyrusHome: string;
	let realGhDir: string;
	let savedHome: string | undefined;
	let savedCwd: string;

	function saveTokens(tokens: Array<{ organization: string; token: string }>) {
		writeFileSync(
			join(cyrusHome, "github-tokens.json"),
			JSON.stringify({
				version: 1,
				updatedAt: new Date().toISOString(),
				tokens: tokens.map((t, i) => ({
					installationId: String(i + 1),
					accountType: "Organization",
					expiresAt: new Date(Date.now() + 3600_000).toISOString(),
					source: "self-hosted-app",
					...t,
				})),
			}),
		);
	}

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "cyrus-self-hosted-auth-"));
		home = join(dir, "home");
		cyrusHome = join(dir, "custom cyrus home");
		realGhDir = join(dir, "usr-bin");
		mkdirSync(home, { recursive: true });
		mkdirSync(cyrusHome, { recursive: true });
		mkdirSync(realGhDir, { recursive: true });
		writeFileSync(
			join(realGhDir, "gh"),
			`#!/usr/bin/env bash
echo "GH_TOKEN=\${GH_TOKEN:-<unset>}"
echo "ARGS=$*"
`,
			{ mode: 0o755 },
		);
		savedHome = process.env.HOME;
		process.env.HOME = home;
		// git config --global still discovers a repository from the cwd; run
		// from outside any checkout so it cannot trip over one.
		savedCwd = process.cwd();
		process.chdir(dir);
	});

	afterEach(() => {
		process.chdir(savedCwd);
		if (savedHome === undefined) delete process.env.HOME;
		else process.env.HOME = savedHome;
		rmSync(dir, { recursive: true, force: true });
	});

	describe("ensureGhShim", () => {
		function runGh(args: string[], binDir: string, cwd = dir) {
			return spawnSync("gh", args, {
				cwd,
				encoding: "utf8",
				env: {
					HOME: home,
					PATH: `${binDir}:${realGhDir}:/usr/local/bin:/usr/bin:/bin`,
					GH_TOKEN: "customer_token",
				},
			});
		}

		it("installs an executable shim next to the resolver", () => {
			const binDir = ensureGhShim(cyrusHome);

			expect(binDir).toBe(join(cyrusHome, "bin"));
			expect(statSync(join(binDir, "gh")).mode & 0o111).not.toBe(0);
			expect(existsSync(join(cyrusHome, "scripts", "gh-cyrus.cjs"))).toBe(true);
		});

		it("resolves the token per invocation from the store, skipping itself on PATH", () => {
			const binDir = ensureGhShim(cyrusHome);
			saveTokens([{ organization: "SelfOrg", token: "ghs_first" }]);

			const first = runGh(["api", "/user"], binDir);
			expect(first.status).toBe(0);
			expect(first.stdout).toContain("GH_TOKEN=ghs_first");
			expect(first.stdout).toContain("ARGS=api /user");

			// A refresh rewrites the store; the next gh call sees the new token.
			saveTokens([{ organization: "SelfOrg", token: "ghs_second" }]);
			expect(runGh(["pr", "list"], binDir).stdout).toContain(
				"GH_TOKEN=ghs_second",
			);
		});

		it("exits 127 when no real gh is on PATH", () => {
			const binDir = ensureGhShim(cyrusHome);
			const result = spawnSync("/bin/bash", [join(binDir, "gh"), "--version"], {
				encoding: "utf8",
				env: { HOME: home, PATH: `${binDir}:/nonexistent` },
			});
			expect(result.status).toBe(127);
			expect(result.stderr).toContain("GitHub CLI not found");
		});
	});

	describe("ensureGitHubCredentialHelper", () => {
		function credentialFill(path: string): string {
			return execFileSync("git", ["credential", "fill"], {
				cwd: dir,
				encoding: "utf8",
				input: `protocol=https\nhost=github.com\npath=${path}\n\n`,
				env: {
					HOME: home,
					PATH: process.env.PATH,
					GIT_CONFIG_NOSYSTEM: "1",
					GIT_TERMINAL_PROMPT: "0",
				},
			});
		}

		it("pins a non-default CYRUS_HOME so git reads this install's store", () => {
			ensureGitHubCredentialHelper(cyrusHome);
			saveTokens([{ organization: "SelfOrg", token: "ghs_first" }]);

			expect(readFileSync(join(home, ".gitconfig"), "utf8")).toContain(
				"CYRUS_HOME=",
			);
			expect(credentialFill("SelfOrg/repo.git")).toContain(
				"password=ghs_first",
			);

			saveTokens([{ organization: "SelfOrg", token: "ghs_second" }]);
			expect(credentialFill("SelfOrg/repo.git")).toContain(
				"password=ghs_second",
			);
		});

		it("takes precedence over a pre-existing global credential.helper for github.com", () => {
			const oldHelper = join(dir, "old-helper.sh");
			writeFileSync(
				oldHelper,
				"#!/bin/sh\necho username=x-access-token\necho password=OLD_HELPER\n",
				{ mode: 0o755 },
			);
			execFileSync(
				"git",
				["config", "--global", "credential.helper", oldHelper],
				{ cwd: dir, env: { HOME: home, PATH: process.env.PATH } },
			);

			ensureGitHubCredentialHelper(cyrusHome);
			saveTokens([{ organization: "SelfOrg", token: "ghs_first" }]);

			expect(credentialFill("SelfOrg/repo.git")).toContain(
				"password=ghs_first",
			);
		});
	});
});
