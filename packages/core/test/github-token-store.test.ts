import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	extractOwnerFromGitHubUrl,
	type GitHubInstallationToken,
	GitHubTokenStore,
} from "../src/github-token-store.js";

function token(
	overrides: Partial<GitHubInstallationToken> = {},
): GitHubInstallationToken {
	return {
		installationId: "12345",
		organization: "CeedarAgents",
		accountType: "Organization",
		token: "ghs_org_token",
		expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
		...overrides,
	};
}

describe("extractOwnerFromGitHubUrl", () => {
	it("extracts owner from https URLs with and without .git", () => {
		expect(extractOwnerFromGitHubUrl("https://github.com/myorg/repo")).toBe(
			"myorg",
		);
		expect(extractOwnerFromGitHubUrl("https://github.com/myorg/repo.git")).toBe(
			"myorg",
		);
	});

	it("extracts owner from scp-style ssh URLs", () => {
		expect(extractOwnerFromGitHubUrl("git@github.com:myorg/repo.git")).toBe(
			"myorg",
		);
	});

	it("extracts owner from ssh:// URLs", () => {
		expect(
			extractOwnerFromGitHubUrl("ssh://git@github.com/myorg/repo.git"),
		).toBe("myorg");
	});

	it("extracts owner from scheme-less URLs", () => {
		expect(extractOwnerFromGitHubUrl("github.com/myorg/repo")).toBe("myorg");
	});

	it("returns null for non-GitHub hosts", () => {
		expect(
			extractOwnerFromGitHubUrl("https://gitlab.com/myorg/repo"),
		).toBeNull();
		expect(
			extractOwnerFromGitHubUrl("git@gitlab.com:myorg/repo.git"),
		).toBeNull();
	});

	it("returns null for unparseable input", () => {
		expect(extractOwnerFromGitHubUrl("")).toBeNull();
		expect(extractOwnerFromGitHubUrl("https://github.com/")).toBeNull();
	});
});

describe("GitHubTokenStore", () => {
	let cyrusHome: string;
	let store: GitHubTokenStore;

	beforeEach(() => {
		cyrusHome = mkdtempSync(join(tmpdir(), "cyrus-token-store-"));
		store = new GitHubTokenStore(cyrusHome);
	});

	afterEach(() => {
		rmSync(cyrusHome, { recursive: true, force: true });
	});

	describe("save / load", () => {
		it("round-trips tokens through the file", () => {
			const tokens = [
				token(),
				token({ organization: "other", token: "ghs_2" }),
			];
			store.save(tokens);
			expect(store.load()).toEqual(tokens);
		});

		it("writes the versioned file shape with owner-only permissions", () => {
			store.save([token()]);
			const filePath = join(cyrusHome, "github-tokens.json");
			const parsed = JSON.parse(readFileSync(filePath, "utf-8"));
			expect(parsed.version).toBe(1);
			expect(typeof parsed.updatedAt).toBe("string");
			expect(parsed.tokens).toHaveLength(1);
			// mode 0600 (owner read/write only)
			expect(statSync(filePath).mode & 0o777).toBe(0o600);
		});

		it("uses CYRUS_GITHUB_TOKEN_STORE_MODE for group access, never for others", () => {
			const filePath = join(cyrusHome, "github-tokens.json");
			const previous = process.env.CYRUS_GITHUB_TOKEN_STORE_MODE;
			try {
				process.env.CYRUS_GITHUB_TOKEN_STORE_MODE = "0640";
				store.save([token()]);
				expect(statSync(filePath).mode & 0o777).toBe(0o640);

				process.env.CYRUS_GITHUB_TOKEN_STORE_MODE = "0644";
				store.save([token()]);
				expect(statSync(filePath).mode & 0o777).toBe(0o600);

				process.env.CYRUS_GITHUB_TOKEN_STORE_MODE = "rw-r-----";
				store.save([token()]);
				expect(statSync(filePath).mode & 0o777).toBe(0o600);
			} finally {
				if (previous === undefined) {
					delete process.env.CYRUS_GITHUB_TOKEN_STORE_MODE;
				} else {
					process.env.CYRUS_GITHUB_TOKEN_STORE_MODE = previous;
				}
			}
		});

		it("does not leave a temp file behind", () => {
			store.save([token()]);
			expect(existsSync(join(cyrusHome, "github-tokens.json.tmp"))).toBe(false);
		});

		it("returns an empty array when the file is missing", () => {
			expect(store.load()).toEqual([]);
		});

		it("picks up a subsequent save (cache invalidation)", () => {
			store.save([token({ token: "ghs_first" })]);
			expect(store.load()[0]?.token).toBe("ghs_first");
			store.save([token({ token: "ghs_second" })]);
			expect(store.load()[0]?.token).toBe("ghs_second");
		});

		it("sees writes made by a different store instance", () => {
			store.save([token({ token: "ghs_first" })]);
			expect(store.load()[0]?.token).toBe("ghs_first");
			const writer = new GitHubTokenStore(cyrusHome);
			writer.save([
				token({ token: "ghs_second" }),
				token({ organization: "another", token: "ghs_third" }),
			]);
			expect(store.load()).toHaveLength(2);
		});
	});

	describe("getTokenForOrg", () => {
		it("matches case-insensitively", () => {
			store.save([token({ organization: "CeedarAgents", token: "ghs_org" })]);
			expect(store.getTokenForOrg("ceedaragents")).toBe("ghs_org");
			expect(store.getTokenForOrg("CEEDARAGENTS")).toBe("ghs_org");
		});

		it("returns undefined when no org matches", () => {
			store.save([token({ organization: "CeedarAgents" })]);
			expect(store.getTokenForOrg("unrelated")).toBeUndefined();
		});

		it("ignores expired tokens", () => {
			store.save([
				token({
					organization: "CeedarAgents",
					expiresAt: new Date(Date.now() - 1000).toISOString(),
				}),
			]);
			expect(store.getTokenForOrg("ceedaragents")).toBeUndefined();
		});

		it("treats tokens with unparseable expiry as absent", () => {
			store.save([token({ organization: "CeedarAgents", expiresAt: "nope" })]);
			expect(store.getTokenForOrg("ceedaragents")).toBeUndefined();
		});
	});

	describe("getTokenForRepoUrl", () => {
		beforeEach(() => {
			store.save([
				token({ organization: "OrgOne", token: "ghs_one" }),
				token({ organization: "orgtwo", token: "ghs_two" }),
			]);
		});

		it("matches the owner of an https URL", () => {
			expect(store.getTokenForRepoUrl("https://github.com/orgone/repo")).toBe(
				"ghs_one",
			);
		});

		it("matches the owner of an ssh URL", () => {
			expect(store.getTokenForRepoUrl("git@github.com:OrgTwo/repo.git")).toBe(
				"ghs_two",
			);
		});

		it("returns undefined for non-GitHub URLs", () => {
			expect(
				store.getTokenForRepoUrl("https://gitlab.com/orgone/repo"),
			).toBeUndefined();
		});

		it("returns undefined when the owner has no token", () => {
			expect(
				store.getTokenForRepoUrl("https://github.com/stranger/repo"),
			).toBeUndefined();
		});
	});

	describe("getFallbackToken", () => {
		it("returns the token when exactly one non-expired token exists", () => {
			store.save([token({ token: "ghs_only" })]);
			expect(store.getFallbackToken()).toBe("ghs_only");
		});

		it("returns the sole valid token when the others are expired", () => {
			store.save([
				token({ token: "ghs_valid" }),
				token({
					organization: "stale",
					token: "ghs_stale",
					expiresAt: new Date(Date.now() - 1000).toISOString(),
				}),
			]);
			expect(store.getFallbackToken()).toBe("ghs_valid");
		});

		it("returns undefined when multiple valid tokens exist", () => {
			store.save([token(), token({ organization: "other", token: "ghs_2" })]);
			expect(store.getFallbackToken()).toBeUndefined();
		});

		it("returns undefined when no tokens exist", () => {
			expect(store.getFallbackToken()).toBeUndefined();
		});
	});

	describe("self-hosted App tokens", () => {
		const selfHosted = (overrides: Partial<GitHubInstallationToken> = {}) =>
			token({
				installationId: "999",
				organization: "SelfOrg",
				token: "ghs_self_1",
				...overrides,
			});

		it("upserts the self-minted token, replacing the previous one for the installation", () => {
			expect(store.upsertSelfHostedAppToken(selfHosted())).toBe(true);
			expect(
				store.upsertSelfHostedAppToken(selfHosted({ token: "ghs_self_2" })),
			).toBe(true);

			const tokens = store.load();
			expect(tokens).toHaveLength(1);
			expect(tokens[0]).toMatchObject({
				token: "ghs_self_2",
				source: "self-hosted-app",
			});
			expect(store.getTokenForOrg("selforg")).toBe("ghs_self_2");
			expect(statSync(store.filePath).mode & 0o777).toBe(0o600);
		});

		it("keeps pushed tokens for other orgs untouched", () => {
			store.save([token()]);
			store.upsertSelfHostedAppToken(selfHosted());

			expect(store.getTokenForOrg("CeedarAgents")).toBe("ghs_org_token");
			expect(store.getTokenForOrg("SelfOrg")).toBe("ghs_self_1");
			expect(store.load()[0]).not.toHaveProperty("source");
		});

		it("does not write when a valid pushed token covers the same org", () => {
			store.save([token({ organization: "SelfOrg", token: "ghs_pushed" })]);
			expect(store.upsertSelfHostedAppToken(selfHosted())).toBe(false);
			expect(store.load()).toHaveLength(1);
			expect(store.getTokenForOrg("SelfOrg")).toBe("ghs_pushed");
		});

		it("fills the gap when the pushed token for the org has expired", () => {
			store.save([
				token({
					organization: "SelfOrg",
					token: "ghs_pushed_old",
					expiresAt: new Date(Date.now() - 1000).toISOString(),
				}),
			]);
			expect(store.upsertSelfHostedAppToken(selfHosted())).toBe(true);
			expect(store.getTokenForOrg("SelfOrg")).toBe("ghs_self_1");
		});

		it("a hosted push keeps self-minted tokens for orgs it does not cover", () => {
			store.upsertSelfHostedAppToken(selfHosted());
			store.saveHostedTokens([token()]);

			expect(store.getTokenForOrg("CeedarAgents")).toBe("ghs_org_token");
			expect(store.getTokenForOrg("SelfOrg")).toBe("ghs_self_1");
		});

		it("a hosted push for the same org replaces the self-minted token", () => {
			store.upsertSelfHostedAppToken(selfHosted());
			store.saveHostedTokens([
				token({ organization: "selforg", token: "ghs_pushed" }),
			]);

			expect(store.load()).toHaveLength(1);
			expect(store.getTokenForOrg("SelfOrg")).toBe("ghs_pushed");
		});
	});
});
