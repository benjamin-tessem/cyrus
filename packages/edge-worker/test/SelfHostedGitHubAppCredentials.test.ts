import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { GitHubTokenStore } from "cyrus-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createGitHubAppTokenProviderFromEnv,
	type GitHubAppTokenSource,
	prependToPath,
	SELF_HOSTED_TOKEN_REFRESH_LEAD_MS,
	SELF_HOSTED_TOKEN_RETRY_MS,
	SelfHostedGitHubAppCredentials,
} from "../src/SelfHostedGitHubAppCredentials.js";

const HOUR = 60 * 60 * 1000;

function silentLogger() {
	return {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	} as never;
}

/**
 * Fake App token source: each mint returns ghs_1, ghs_2, ... valid for an
 * hour from the (fake) current time, and reuses the cached token while it
 * has more than the requested validity left — like GitHubAppTokenProvider.
 */
function fakeProvider(account = { login: "SelfOrg", type: "Organization" }) {
	let minted = 0;
	let cached: { token: string; expiresAt: string } | null = null;
	const provider = {
		installationId: "4242",
		getInstallationToken: vi.fn(async (minValidityMs = 5 * 60 * 1000) => {
			if (cached && Date.now() < Date.parse(cached.expiresAt) - minValidityMs) {
				return cached;
			}
			minted++;
			cached = {
				token: `ghs_${minted}`,
				expiresAt: new Date(Date.now() + HOUR).toISOString(),
			};
			return cached;
		}),
		getInstallationAccount: vi.fn(async () => account),
	};
	return provider as typeof provider & GitHubAppTokenSource;
}

describe("SelfHostedGitHubAppCredentials", () => {
	let cyrusHome: string;
	let store: GitHubTokenStore;
	let env: NodeJS.ProcessEnv;
	let installAuthScripts: ReturnType<typeof vi.fn>;
	let credentials: SelfHostedGitHubAppCredentials | null;

	function create(
		provider: GitHubAppTokenSource,
		repositoryUrls: string[] = [],
	): SelfHostedGitHubAppCredentials {
		credentials = new SelfHostedGitHubAppCredentials({
			cyrusHome,
			provider,
			logger: silentLogger(),
			store,
			env,
			getRepositoryUrls: () => repositoryUrls,
			installAuthScripts,
		});
		return credentials;
	}

	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
		vi.setSystemTime(new Date("2026-09-24T12:00:00Z"));
		cyrusHome = mkdtempSync(join(tmpdir(), "cyrus-self-hosted-app-"));
		store = new GitHubTokenStore(cyrusHome);
		env = { PATH: ["/usr/local/bin", "/usr/bin"].join(delimiter) };
		installAuthScripts = vi.fn(() => join(cyrusHome, "bin"));
		credentials = null;
	});

	afterEach(() => {
		credentials?.stop();
		vi.useRealTimers();
		rmSync(cyrusHome, { recursive: true, force: true });
	});

	it("installs the git/gh auth scripts and puts the gh shim first on PATH", async () => {
		await create(fakeProvider()).start();

		expect(installAuthScripts).toHaveBeenCalledWith(cyrusHome);
		expect(env.PATH?.split(delimiter)).toEqual([
			join(cyrusHome, "bin"),
			"/usr/local/bin",
			"/usr/bin",
		]);
	});

	it("populates the token store for the installation's org at startup", async () => {
		await create(fakeProvider()).start();

		expect(store.load()).toEqual([
			{
				installationId: "4242",
				organization: "SelfOrg",
				accountType: "Organization",
				token: "ghs_1",
				expiresAt: new Date(Date.now() + HOUR).toISOString(),
				source: "self-hosted-app",
			},
		]);
		expect(store.getTokenForRepoUrl("https://github.com/selforg/app")).toBe(
			"ghs_1",
		);
		expect(statSync(store.filePath).mode & 0o777).toBe(0o600);
	});

	it("re-mints before expiry so the store never holds a token about to lapse", async () => {
		const provider = fakeProvider();
		await create(provider).start();
		const firstExpiry = Date.parse(store.load()[0]!.expiresAt);

		// Just before the refresh point nothing changes.
		await vi.advanceTimersByTimeAsync(
			HOUR - SELF_HOSTED_TOKEN_REFRESH_LEAD_MS - 1000,
		);
		expect(store.getTokenForOrg("SelfOrg")).toBe("ghs_1");

		// At expiry minus the lead, a fresh token replaces it.
		await vi.advanceTimersByTimeAsync(1000);
		expect(store.getTokenForOrg("SelfOrg")).toBe("ghs_2");
		expect(firstExpiry - Date.now()).toBe(SELF_HOSTED_TOKEN_REFRESH_LEAD_MS);

		// And keeps doing so for a multi-hour session.
		await vi.advanceTimersByTimeAsync(4 * HOUR);
		const [entry] = store.load();
		expect(store.load()).toHaveLength(1);
		expect(entry!.token).toBe("ghs_7");
		expect(Date.parse(entry!.expiresAt) - Date.now()).toBeGreaterThan(
			SELF_HOSTED_TOKEN_REFRESH_LEAD_MS,
		);
		// The installation account is looked up once.
		expect(provider.getInstallationAccount).toHaveBeenCalledTimes(1);
	});

	it("retries soon after a failed refresh, keeping the current token meanwhile", async () => {
		const provider = fakeProvider();
		await create(provider).start();
		provider.getInstallationToken.mockRejectedValueOnce(new Error("boom"));

		await vi.advanceTimersByTimeAsync(HOUR - SELF_HOSTED_TOKEN_REFRESH_LEAD_MS);
		expect(store.getTokenForOrg("SelfOrg")).toBe("ghs_1");

		await vi.advanceTimersByTimeAsync(SELF_HOSTED_TOKEN_RETRY_MS);
		expect(store.getTokenForOrg("SelfOrg")).toBe("ghs_2");
	});

	it("does not clobber tokens pushed by cyrus-hosted", async () => {
		const pushed = {
			installationId: "1",
			organization: "SelfOrg",
			accountType: "Organization" as const,
			token: "ghs_pushed",
			expiresAt: new Date(Date.now() + HOUR).toISOString(),
		};
		const otherOrg = {
			...pushed,
			installationId: "2",
			organization: "OtherOrg",
			token: "ghs_other",
		};
		store.save([pushed, otherOrg]);

		await create(fakeProvider()).start();

		expect(store.load()).toEqual([pushed, otherOrg]);
		expect(store.getTokenForOrg("SelfOrg")).toBe("ghs_pushed");
	});

	it("adds its token beside pushed tokens for other orgs", async () => {
		const otherOrg = {
			installationId: "2",
			organization: "OtherOrg",
			accountType: "Organization" as const,
			token: "ghs_other",
			expiresAt: new Date(Date.now() + HOUR).toISOString(),
		};
		store.save([otherOrg]);

		await create(fakeProvider()).start();

		expect(store.getTokenForOrg("OtherOrg")).toBe("ghs_other");
		expect(store.getTokenForOrg("SelfOrg")).toBe("ghs_1");
	});

	it("falls back to the repositories' single owner when the installation lookup fails", async () => {
		const provider = fakeProvider();
		provider.getInstallationAccount.mockRejectedValue(new Error("403"));

		await create(provider, [
			"https://github.com/RepoOwner/a.git",
			"git@github.com:repoowner/b.git",
		]).start();

		expect(store.load()[0]).toMatchObject({
			organization: "RepoOwner",
			accountType: null,
			token: "ghs_1",
		});
	});

	it("stores the token without an org when the owner cannot be determined", async () => {
		const provider = fakeProvider();
		provider.getInstallationAccount.mockRejectedValue(new Error("403"));

		await create(provider, [
			"https://github.com/OrgA/a",
			"https://github.com/OrgB/b",
		]).start();

		expect(store.load()[0]).toMatchObject({ organization: null });
		expect(store.getFallbackToken()).toBe("ghs_1");
	});

	it("still stores tokens when installing the auth scripts fails", async () => {
		installAuthScripts.mockImplementation(() => {
			throw new Error("git not found");
		});

		await create(fakeProvider()).start();

		expect(store.getTokenForOrg("SelfOrg")).toBe("ghs_1");
	});

	it("stop() clears the refresh timer", async () => {
		const provider = fakeProvider();
		const instance = create(provider);
		await instance.start();
		expect(vi.getTimerCount()).toBe(1);

		instance.stop();

		expect(vi.getTimerCount()).toBe(0);
		await vi.advanceTimersByTimeAsync(3 * HOUR);
		expect(provider.getInstallationToken).toHaveBeenCalledTimes(1);
	});

	it("does not reschedule when stopped during an in-flight refresh", async () => {
		const provider = fakeProvider();
		let release!: () => void;
		provider.getInstallationToken.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					release = () =>
						resolve({
							token: "ghs_late",
							expiresAt: new Date(Date.now() + HOUR).toISOString(),
						});
				}),
		);
		const instance = create(provider);
		const started = instance.start();

		instance.stop();
		release();
		await started;

		expect(vi.getTimerCount()).toBe(0);
		expect(store.load()).toEqual([]);
	});
});

describe("createGitHubAppTokenProviderFromEnv", () => {
	it("is a no-op without both App env vars", () => {
		expect(createGitHubAppTokenProviderFromEnv({}, "/cyrus")).toBeNull();
		expect(
			createGitHubAppTokenProviderFromEnv({ GITHUB_APP_ID: "1" }, "/cyrus"),
		).toBeNull();
		expect(
			createGitHubAppTokenProviderFromEnv(
				{ GITHUB_APP_INSTALLATION_ID: "2" },
				"/cyrus",
			),
		).toBeNull();
	});

	it("creates a provider for the installation when both are set", () => {
		const provider = createGitHubAppTokenProviderFromEnv(
			{ GITHUB_APP_ID: "1", GITHUB_APP_INSTALLATION_ID: "2" },
			"/cyrus",
		);
		expect(provider?.installationId).toBe("2");
	});
});

describe("prependToPath", () => {
	it("moves the directory to the front without duplicating it", () => {
		const env = { PATH: ["/a", "/shim", "/b"].join(delimiter) };
		prependToPath(env, "/shim");
		prependToPath(env, "/shim/");
		expect(env.PATH).toBe(["/shim", "/a", "/b"].join(delimiter));
	});

	it("handles an empty PATH", () => {
		const env: NodeJS.ProcessEnv = {};
		prependToPath(env, "/shim");
		expect(env.PATH).toBe("/shim");
	});
});
