import { delimiter, join, resolve } from "node:path";
import {
	ensureGhShim,
	ensureGitHubCredentialHelper,
} from "cyrus-config-updater";
import {
	extractOwnerFromGitHubUrl,
	GitHubTokenStore,
	type ILogger,
} from "cyrus-core";
import {
	type GitHubAppInstallationAccount,
	type GitHubAppInstallationToken,
	GitHubAppTokenProvider,
} from "cyrus-github-event-transport";

/** Refresh the stored token this long before it expires */
export const SELF_HOSTED_TOKEN_REFRESH_LEAD_MS = 15 * 60 * 1000;
/** Retry delay after a failed refresh (the previous token is still valid) */
export const SELF_HOSTED_TOKEN_RETRY_MS = 60 * 1000;
/** Floor on the refresh interval, guarding against a tight loop */
const MIN_REFRESH_DELAY_MS = 30 * 1000;

/** The subset of {@link GitHubAppTokenProvider} the refresher needs */
export interface GitHubAppTokenSource {
	readonly installationId: string;
	getInstallationToken(
		minValidityMs?: number,
	): Promise<GitHubAppInstallationToken>;
	getInstallationAccount(): Promise<GitHubAppInstallationAccount>;
}

/**
 * Create the self-hosted GitHub App token provider when both
 * `GITHUB_APP_ID` and `GITHUB_APP_INSTALLATION_ID` are set, with the App's
 * private key at `<cyrusHome>/github-app.pem`. Returns null otherwise.
 */
export function createGitHubAppTokenProviderFromEnv(
	env: NodeJS.ProcessEnv,
	cyrusHome: string,
): GitHubAppTokenProvider | null {
	const appId = env.GITHUB_APP_ID?.trim();
	const installationId = env.GITHUB_APP_INSTALLATION_ID?.trim();
	if (!appId || !installationId) return null;
	return new GitHubAppTokenProvider({
		appId,
		installationId,
		privateKeyPath: join(cyrusHome, "github-app.pem"),
	});
}

/**
 * Put `dir` first on `env.PATH` (removing any other occurrence), so it wins
 * over the system `gh`. Idempotent.
 */
export function prependToPath(env: NodeJS.ProcessEnv, dir: string): void {
	const target = resolve(dir);
	const rest = (env.PATH ?? "")
		.split(delimiter)
		.filter((entry) => entry !== "" && resolve(entry) !== target);
	env.PATH = [target, ...rest].join(delimiter);
}

/** Install the git credential helper and the gh shim; returns the shim dir */
function installAuthScripts(cyrusHome: string): string {
	ensureGitHubCredentialHelper(cyrusHome);
	return ensureGhShim(cyrusHome);
}

export interface SelfHostedGitHubAppCredentialsOptions {
	cyrusHome: string;
	provider: GitHubAppTokenSource;
	logger: ILogger;
	/**
	 * GitHub URLs of the configured repositories. Used to name the
	 * installation's org only when the installation lookup fails.
	 */
	getRepositoryUrls: () => string[];
	/** Defaults to the store at `<cyrusHome>/github-tokens.json` */
	store?: GitHubTokenStore;
	/** Environment whose PATH gets the gh shim (default: process.env) */
	env?: NodeJS.ProcessEnv;
	/** Test seam for the git/gh script installation */
	installAuthScripts?: (cyrusHome: string) => string;
}

/**
 * Keeps agents supplied with fresh GitHub credentials when Cyrus runs
 * self-hosted with its own GitHub App.
 *
 * Reuses the multi-org token machinery built for cyrus-hosted: the App
 * installation's token goes into the token store (`github-tokens.json`)
 * under the installation's org, and the git credential helper and the gh
 * resolver read that store on every invocation. On start this installs
 * both (the helper in the global git config, a gh shim first on PATH),
 * writes a token, and from then on re-mints it
 * {@link SELF_HOSTED_TOKEN_REFRESH_LEAD_MS} before it expires, so any git
 * or gh call — however long the session — finds a token with at least
 * that much life left.
 *
 * Tokens pushed by cyrus-hosted are never overwritten: the self-minted
 * token is only stored for an org no valid pushed token covers.
 */
export class SelfHostedGitHubAppCredentials {
	private readonly cyrusHome: string;
	private readonly provider: GitHubAppTokenSource;
	private readonly logger: ILogger;
	private readonly getRepositoryUrls: () => string[];
	private readonly store: GitHubTokenStore;
	private readonly env: NodeJS.ProcessEnv;
	private readonly installAuthScripts: (cyrusHome: string) => string;
	private account: GitHubAppInstallationAccount | null = null;
	private timer: NodeJS.Timeout | null = null;
	private running = false;

	constructor(options: SelfHostedGitHubAppCredentialsOptions) {
		this.cyrusHome = options.cyrusHome;
		this.provider = options.provider;
		this.logger = options.logger;
		this.getRepositoryUrls = options.getRepositoryUrls;
		this.store = options.store ?? new GitHubTokenStore(options.cyrusHome);
		this.env = options.env ?? process.env;
		this.installAuthScripts = options.installAuthScripts ?? installAuthScripts;
	}

	/**
	 * Wire up git and gh, store a first token, and start the refresh timer.
	 * Never throws: failures are logged and the refresh is retried.
	 */
	async start(): Promise<void> {
		this.running = true;
		try {
			const ghShimDir = this.installAuthScripts(this.cyrusHome);
			prependToPath(this.env, ghShimDir);
			this.logger.info(
				`GitHub App credentials: git credential helper and gh shim (${ghShimDir}) installed`,
			);
		} catch (error) {
			this.logger.warn(
				"GitHub App credentials: failed to install git/gh auth scripts",
				error instanceof Error ? error : new Error(String(error)),
			);
		}
		await this.refresh();
	}

	/** Stop refreshing. The last stored token simply expires. */
	stop(): void {
		this.running = false;
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
		}
	}

	/** Mint (if due) and store the installation token, then reschedule */
	private async refresh(): Promise<void> {
		this.timer = null;
		let nextDelayMs = SELF_HOSTED_TOKEN_RETRY_MS;
		try {
			// Ask for more validity than the lead so a refresh at the lead
			// time mints a new token rather than reusing the cached one.
			const { token, expiresAt } = await this.provider.getInstallationToken(
				SELF_HOSTED_TOKEN_REFRESH_LEAD_MS + 5 * 60 * 1000,
			);
			const account = await this.resolveAccount();
			if (!this.running) return;

			const written = this.store.upsertSelfHostedAppToken({
				installationId: this.provider.installationId,
				organization: account?.login ?? null,
				accountType: account?.type ?? null,
				token,
				expiresAt,
			});
			const org = account?.login ?? "unknown org";
			if (written) {
				this.logger.debug(
					`GitHub App credentials: stored installation token for ${org} (expires ${expiresAt})`,
				);
			} else {
				this.logger.debug(
					`GitHub App credentials: a pushed token already covers ${org}; not storing the self-minted one`,
				);
			}
			nextDelayMs = Math.max(
				MIN_REFRESH_DELAY_MS,
				Date.parse(expiresAt) - SELF_HOSTED_TOKEN_REFRESH_LEAD_MS - Date.now(),
			);
		} catch (error) {
			this.logger.warn(
				`GitHub App credentials: token refresh failed, retrying in ${SELF_HOSTED_TOKEN_RETRY_MS / 1000}s`,
				error instanceof Error ? error : new Error(String(error)),
			);
		}
		if (!this.running) return;
		this.timer = setTimeout(() => {
			void this.refresh();
		}, nextDelayMs);
		this.timer.unref?.();
	}

	/**
	 * The installation's account, from the GitHub API (cached once found).
	 * If the lookup fails, falls back to the single owner shared by all
	 * configured repositories, or null (the store then serves the token as
	 * the only one available).
	 */
	private async resolveAccount(): Promise<GitHubAppInstallationAccount | null> {
		if (this.account) return this.account;
		try {
			this.account = await this.provider.getInstallationAccount();
			return this.account;
		} catch (error) {
			this.logger.warn(
				"GitHub App credentials: installation lookup failed; inferring the org from repository URLs",
				error instanceof Error ? error : new Error(String(error)),
			);
		}
		const owners = new Map<string, string>();
		for (const url of this.getRepositoryUrls()) {
			const owner = extractOwnerFromGitHubUrl(url);
			if (owner && !owners.has(owner.toLowerCase())) {
				owners.set(owner.toLowerCase(), owner);
			}
		}
		if (owners.size === 1) {
			const [login] = owners.values();
			return login ? { login, type: null } : null;
		}
		return null;
	}
}
