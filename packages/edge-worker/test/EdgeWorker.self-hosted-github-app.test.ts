import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitHubTokenStore } from "cyrus-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const credentialsMock = vi.hoisted(() => ({
	instances: [] as Array<{ options: unknown; start: ReturnType<typeof vi.fn> }>,
}));

vi.mock("../src/SelfHostedGitHubAppCredentials.js", async (importOriginal) => {
	const actual =
		await importOriginal<
			typeof import("../src/SelfHostedGitHubAppCredentials.js")
		>();
	class FakeCredentials {
		options: unknown;
		start = vi.fn(async () => {});
		stop = vi.fn();
		constructor(options: unknown) {
			this.options = options;
			credentialsMock.instances.push(this);
		}
	}
	return { ...actual, SelfHostedGitHubAppCredentials: FakeCredentials };
});

import { EdgeWorker } from "../src/EdgeWorker.js";

/**
 * EdgeWorker wiring for self-hosted GitHub App credentials. The private
 * startup method runs against a minimal `this` (as in
 * EdgeWorker.github-token-resolution.test.ts); the refresher itself is
 * covered in SelfHostedGitHubAppCredentials.test.ts.
 */
describe("EdgeWorker.startSelfHostedGitHubApp", () => {
	let cyrusHome: string;
	let fakeThis: Record<string, unknown>;

	function start(env: NodeJS.ProcessEnv): Promise<void> {
		return (
			EdgeWorker.prototype as unknown as {
				startSelfHostedGitHubApp: (env: NodeJS.ProcessEnv) => Promise<void>;
			}
		).startSelfHostedGitHubApp.call(fakeThis, env);
	}

	beforeEach(() => {
		credentialsMock.instances.length = 0;
		cyrusHome = mkdtempSync(join(tmpdir(), "cyrus-edge-self-hosted-"));
		fakeThis = {
			cyrusHome,
			githubTokenStore: new GitHubTokenStore(cyrusHome),
			repositories: new Map([
				["r1", { githubUrl: "https://github.com/SelfOrg/app" }],
				["r2", { githubUrl: undefined }],
			]),
			gitHubAppTokenProvider: null,
			selfHostedGitHubAppCredentials: null,
			logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
		};
	});

	afterEach(() => {
		rmSync(cyrusHome, { recursive: true, force: true });
	});

	it("is a no-op when the App env vars are absent", async () => {
		await start({ GITHUB_APP_ID: "123" });

		expect(fakeThis.gitHubAppTokenProvider).toBeNull();
		expect(fakeThis.selfHostedGitHubAppCredentials).toBeNull();
		expect(credentialsMock.instances).toHaveLength(0);
		expect(existsSync(join(cyrusHome, "github-tokens.json"))).toBe(false);
	});

	it("creates the provider and starts the credential refresher in App mode", async () => {
		await start({ GITHUB_APP_ID: "123", GITHUB_APP_INSTALLATION_ID: "456" });

		expect(fakeThis.gitHubAppTokenProvider).not.toBeNull();
		expect(credentialsMock.instances).toHaveLength(1);
		const [instance] = credentialsMock.instances;
		expect(instance!.start).toHaveBeenCalledOnce();
		expect(fakeThis.selfHostedGitHubAppCredentials).toBe(instance);

		const options = instance!.options as {
			cyrusHome: string;
			provider: unknown;
			store: unknown;
			getRepositoryUrls: () => string[];
		};
		expect(options.cyrusHome).toBe(cyrusHome);
		expect(options.provider).toBe(fakeThis.gitHubAppTokenProvider);
		expect(options.store).toBe(fakeThis.githubTokenStore);
		expect(options.getRepositoryUrls()).toEqual([
			"https://github.com/SelfOrg/app",
		]);
	});
});
