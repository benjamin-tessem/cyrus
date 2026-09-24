import { createSign } from "node:crypto";
import { readFile } from "node:fs/promises";

export interface GitHubAppTokenProviderConfig {
	appId: string;
	installationId: string;
	privateKeyPath: string;
	/** GitHub API base URL (default: https://api.github.com) */
	apiBaseUrl?: string;
}

/** A minted installation token and its expiry */
export interface GitHubAppInstallationToken {
	token: string;
	/** ISO timestamp when the token expires */
	expiresAt: string;
}

/** The GitHub account (org or user) the App installation belongs to */
export interface GitHubAppInstallationAccount {
	login: string;
	type: "Organization" | "User" | null;
}

/** Default minimum remaining lifetime for a cached token to be reused */
const DEFAULT_MIN_VALIDITY_MS = 5 * 60 * 1000;
/** Upper bound on each GitHub API request */
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Mints and caches GitHub App installation tokens for self-hosted users.
 *
 * Uses the App's private key to sign a JWT, then exchanges it for a
 * short-lived installation access token via the GitHub API.
 * Tokens are cached and refreshed 5 minutes before expiry.
 */
export class GitHubAppTokenProvider {
	private config: GitHubAppTokenProviderConfig;
	private cachedToken: string | null = null;
	private expiresAt = 0;
	private privateKeyPromise: Promise<string> | null = null;
	private account: GitHubAppInstallationAccount | null = null;

	constructor(config: GitHubAppTokenProviderConfig) {
		this.config = config;
	}

	/** The installation this provider mints tokens for */
	get installationId(): string {
		return this.config.installationId;
	}

	/**
	 * Get a valid installation access token.
	 * Returns cached token if still valid, otherwise mints a new one.
	 */
	async getToken(): Promise<string> {
		return (await this.getInstallationToken()).token;
	}

	/**
	 * Get an installation token with its expiry. The cached token is reused
	 * only while it has more than `minValidityMs` left (default 5 minutes);
	 * pass a larger value to force a fresh token ahead of expiry.
	 */
	async getInstallationToken(
		minValidityMs = DEFAULT_MIN_VALIDITY_MS,
	): Promise<GitHubAppInstallationToken> {
		if (this.cachedToken && Date.now() < this.expiresAt - minValidityMs) {
			return {
				token: this.cachedToken,
				expiresAt: new Date(this.expiresAt).toISOString(),
			};
		}

		const response = await this.appRequest(
			"POST",
			`/app/installations/${this.config.installationId}/access_tokens`,
		);

		if (!response.ok) {
			const body = await response.text();
			throw new Error(
				`[GitHubAppTokenProvider] Failed to create installation token: ${response.status} ${response.statusText} - ${body}`,
			);
		}

		const data = (await response.json()) as {
			token: string;
			expires_at: string;
		};

		this.cachedToken = data.token;
		this.expiresAt = new Date(data.expires_at).getTime();

		return {
			token: data.token,
			expiresAt: new Date(this.expiresAt).toISOString(),
		};
	}

	/**
	 * Look up the account (org or user login) the installation belongs to.
	 * The token exchange response does not say, so this asks
	 * `GET /app/installations/{id}`. Cached after the first success.
	 */
	async getInstallationAccount(): Promise<GitHubAppInstallationAccount> {
		if (this.account) return this.account;

		const response = await this.appRequest(
			"GET",
			`/app/installations/${this.config.installationId}`,
		);
		if (!response.ok) {
			const body = await response.text();
			throw new Error(
				`[GitHubAppTokenProvider] Failed to look up installation: ${response.status} ${response.statusText} - ${body}`,
			);
		}

		const data = (await response.json()) as {
			account?: { login?: string; type?: string } | null;
			target_type?: string;
		};
		const login = data.account?.login;
		if (!login) {
			throw new Error(
				"[GitHubAppTokenProvider] Installation response has no account login",
			);
		}
		const type = data.account?.type ?? data.target_type;
		this.account = {
			login,
			type: type === "Organization" || type === "User" ? type : null,
		};
		return this.account;
	}

	/** Call the GitHub API authenticated as the App (JWT) */
	private async appRequest(
		method: "GET" | "POST",
		path: string,
	): Promise<Response> {
		const pem = await this.loadPrivateKey();
		const jwt = createAppJwt(this.config.appId, pem);
		const apiBase = this.config.apiBaseUrl ?? "https://api.github.com";

		return fetch(`${apiBase}${path}`, {
			method,
			headers: {
				Authorization: `Bearer ${jwt}`,
				Accept: "application/vnd.github+json",
				"X-GitHub-Api-Version": "2022-11-28",
			},
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
	}

	private loadPrivateKey(): Promise<string> {
		if (!this.privateKeyPromise) {
			this.privateKeyPromise = readFile(this.config.privateKeyPath, "utf-8");
		}
		return this.privateKeyPromise;
	}
}

/**
 * Create a JWT for GitHub App authentication.
 * Uses Node's native crypto — no external JWT library needed.
 *
 * @see https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app
 */
export function createAppJwt(appId: string, privateKey: string): string {
	const now = Math.floor(Date.now() / 1000);
	const header = Buffer.from(
		JSON.stringify({ alg: "RS256", typ: "JWT" }),
	).toString("base64url");
	const payload = Buffer.from(
		JSON.stringify({
			iat: now - 60,
			exp: now + 10 * 60,
			iss: appId,
		}),
	).toString("base64url");

	const sign = createSign("RSA-SHA256");
	sign.update(`${header}.${payload}`);
	const signature = sign.sign(privateKey, "base64url");

	return `${header}.${payload}.${signature}`;
}
