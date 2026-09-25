import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

/**
 * A short-lived GitHub App installation token pushed by cyrus-hosted.
 * One entry per GitHub App installation (org or user account) the team
 * has attached.
 */
export interface GitHubInstallationToken {
	/** GitHub App installation ID this token was minted for */
	installationId: string;
	/** Org/user login the installation belongs to (e.g. "ceedaragents") */
	organization: string | null;
	/** GitHub account type of the installation target */
	accountType: "Organization" | "User" | null;
	/** Short-lived installation access token */
	token: string;
	/** ISO timestamp when the token expires */
	expiresAt: string;
	/**
	 * Where the entry came from. Absent for tokens pushed by cyrus-hosted;
	 * `"self-hosted-app"` for tokens Cyrus mints itself from the self-hosted
	 * GitHub App credentials (GITHUB_APP_ID + GITHUB_APP_INSTALLATION_ID).
	 * The git credential helper and gh resolver ignore this field.
	 */
	source?: typeof SELF_HOSTED_APP_TOKEN_SOURCE;
}

/** `source` marker for tokens minted from self-hosted GitHub App credentials */
export const SELF_HOSTED_APP_TOKEN_SOURCE = "self-hosted-app";

/**
 * On-disk shape of `<cyrusHome>/github-tokens.json`.
 */
export interface GitHubTokensFile {
	version: 1;
	updatedAt: string;
	tokens: GitHubInstallationToken[];
}

/** Filename of the token store inside the Cyrus home directory */
export const GITHUB_TOKENS_FILENAME = "github-tokens.json";

/**
 * Extract the owner (org or user login) from a GitHub repository URL.
 * Supports:
 *   - https://github.com/owner/name and https://github.com/owner/name.git
 *   - git@github.com:owner/name.git
 *   - ssh://git@github.com/owner/name.git
 *   - github.com/owner/name (no scheme)
 *
 * Returns null for non-GitHub hosts or unparseable URLs.
 */
export function extractOwnerFromGitHubUrl(url: string): string | null {
	if (!url || typeof url !== "string") return null;
	const trimmed = url.trim();

	// SCP-like SSH form: git@github.com:owner/name.git
	const scpMatch = trimmed.match(/^[\w.-]+@github\.com:(.+)$/i);
	if (scpMatch?.[1]) {
		const owner = scpMatch[1].split("/")[0];
		return owner ? owner : null;
	}

	// URL forms (https://, ssh://, or scheme-less)
	const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
		? trimmed
		: `https://${trimmed}`;
	try {
		const parsed = new URL(withScheme);
		if (parsed.hostname.toLowerCase() !== "github.com") return null;
		const segments = parsed.pathname.split("/").filter(Boolean);
		const owner = segments[0];
		return owner ? owner : null;
	} catch {
		return null;
	}
}

/**
 * Returns true when the token is missing an expiry, the expiry is
 * unparseable, or the expiry is in the past.
 */
function isExpired(token: GitHubInstallationToken, now: number): boolean {
	const expiresAt = Date.parse(token.expiresAt);
	return Number.isNaN(expiresAt) || expiresAt <= now;
}

/**
 * Persistent store for per-installation GitHub App tokens, keyed by org.
 *
 * Tokens are pushed by cyrus-hosted via the `/api/update/github-tokens`
 * ConfigUpdater route and consumed lazily by the EdgeWorker (token
 * resolution, session env) and by the git credential helper script.
 *
 * Reads are cached on file mtime+size, so frequent lookups don't re-parse
 * the JSON while still picking up writes from the ConfigUpdater handler
 * (which runs in the same process but writes via this class too) or any
 * external writer.
 */
/**
 * File mode for the token store: owner-only (0600) unless
 * CYRUS_GITHUB_TOKEN_STORE_MODE sets another octal mode, e.g. 0640 when
 * agents run as a separate OS user in Cyrus's group and need the tokens for
 * git and gh. Values granting access to others are ignored.
 */
function tokenStoreMode(): number {
	const raw = process.env.CYRUS_GITHUB_TOKEN_STORE_MODE?.trim();
	if (!raw || !/^0?[0-7]{3}$/.test(raw)) return 0o600;
	const mode = Number.parseInt(raw, 8);
	return (mode & 0o007) === 0 ? mode : 0o600;
}

export class GitHubTokenStore {
	private cyrusHome: string;
	private cachedTokens: GitHubInstallationToken[] | null = null;
	private cachedMtimeMs: number | null = null;
	private cachedSize: number | null = null;

	constructor(cyrusHome: string) {
		this.cyrusHome = cyrusHome;
	}

	/** Absolute path of the token store file */
	get filePath(): string {
		return join(this.cyrusHome, GITHUB_TOKENS_FILENAME);
	}

	/**
	 * Atomically persist the given tokens (write to a temp file, then rename)
	 * with owner-only permissions (0600).
	 */
	save(tokens: GitHubInstallationToken[]): void {
		const file: GitHubTokensFile = {
			version: 1,
			updatedAt: new Date().toISOString(),
			tokens,
		};
		const target = this.filePath;
		mkdirSync(dirname(target), { recursive: true });
		const tmpPath = `${target}.tmp`;
		const mode = tokenStoreMode();
		writeFileSync(tmpPath, JSON.stringify(file, null, 2), { mode });
		// writeFileSync `mode` only applies on creation — enforce on overwrite too
		chmodSync(tmpPath, mode);
		renameSync(tmpPath, target);
		// Invalidate the read cache so the next load reflects this write even
		// if the rename lands within the same mtime granularity window.
		this.cachedTokens = null;
		this.cachedMtimeMs = null;
		this.cachedSize = null;
	}

	/**
	 * Persist a push from cyrus-hosted. The pushed set replaces every
	 * previously pushed token, but self-minted App tokens survive for orgs
	 * the push does not cover (kept after the pushed entries, so pushed
	 * tokens always win lookups).
	 */
	saveHostedTokens(tokens: GitHubInstallationToken[]): void {
		const pushedOrgs = new Set(
			tokens
				.map((t) => t.organization?.toLowerCase())
				.filter((org): org is string => !!org),
		);
		const preserved = this.load().filter(
			(t) =>
				t.source === SELF_HOSTED_APP_TOKEN_SOURCE &&
				!(t.organization && pushedOrgs.has(t.organization.toLowerCase())),
		);
		this.save([...tokens, ...preserved]);
	}

	/**
	 * Insert or replace the self-minted token for a self-hosted GitHub App
	 * installation. Pushed (hosted) tokens are never modified: when a
	 * non-expired pushed token already covers the same org, the self-minted
	 * one is not written (and any stale self-minted entry for that
	 * installation is dropped), so it only ever fills gaps.
	 *
	 * @returns true when the token was written, false when a pushed token
	 *   for the same org takes precedence.
	 */
	upsertSelfHostedAppToken(
		token: Omit<GitHubInstallationToken, "source">,
	): boolean {
		const now = Date.now();
		const current = this.load();
		const others = current.filter(
			(t) =>
				!(
					t.source === SELF_HOSTED_APP_TOKEN_SOURCE &&
					t.installationId === token.installationId
				),
		);
		const org = token.organization?.toLowerCase();
		const coveredByPushed =
			!!org &&
			others.some(
				(t) =>
					t.source !== SELF_HOSTED_APP_TOKEN_SOURCE &&
					t.organization?.toLowerCase() === org &&
					!isExpired(t, now),
			);
		if (coveredByPushed) {
			if (others.length !== current.length) this.save(others);
			return false;
		}
		this.save([...others, { ...token, source: SELF_HOSTED_APP_TOKEN_SOURCE }]);
		return true;
	}

	/**
	 * Load all tokens from disk (including expired ones). Returns an empty
	 * array when the file is missing or unreadable/corrupt.
	 */
	load(): GitHubInstallationToken[] {
		const target = this.filePath;
		if (!existsSync(target)) {
			this.cachedTokens = null;
			this.cachedMtimeMs = null;
			this.cachedSize = null;
			return [];
		}

		try {
			const stat = statSync(target);
			if (
				this.cachedTokens !== null &&
				this.cachedMtimeMs === stat.mtimeMs &&
				this.cachedSize === stat.size
			) {
				return this.cachedTokens;
			}

			const parsed = JSON.parse(
				readFileSync(target, "utf-8"),
			) as Partial<GitHubTokensFile>;
			const tokens = Array.isArray(parsed.tokens)
				? parsed.tokens.filter(
						(t): t is GitHubInstallationToken =>
							!!t && typeof t === "object" && typeof t.token === "string",
					)
				: [];
			this.cachedTokens = tokens;
			this.cachedMtimeMs = stat.mtimeMs;
			this.cachedSize = stat.size;
			return tokens;
		} catch {
			return [];
		}
	}

	/**
	 * All non-expired tokens currently on disk.
	 */
	private loadValid(): GitHubInstallationToken[] {
		const now = Date.now();
		return this.load().filter((t) => !isExpired(t, now));
	}

	/**
	 * Return the non-expired token for the given org (case-insensitive),
	 * or undefined when no installation matches.
	 */
	getTokenForOrg(org: string): string | undefined {
		if (!org) return undefined;
		const lowered = org.toLowerCase();
		const match = this.loadValid().find(
			(t) =>
				typeof t.organization === "string" &&
				t.organization.toLowerCase() === lowered,
		);
		return match?.token;
	}

	/**
	 * Return the non-expired token for the owner of the given GitHub
	 * repository URL (https or ssh form), or undefined when the URL is not
	 * a GitHub URL or no installation matches the owner.
	 */
	getTokenForRepoUrl(url: string): string | undefined {
		const owner = extractOwnerFromGitHubUrl(url);
		if (!owner) return undefined;
		return this.getTokenForOrg(owner);
	}

	/**
	 * When exactly one non-expired token exists, return it (covers
	 * single-installation teams where the org name may not match, e.g.
	 * user-account installs). Otherwise undefined.
	 */
	getFallbackToken(): string | undefined {
		const valid = this.loadValid();
		return valid.length === 1 ? valid[0]?.token : undefined;
	}
}
