import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const esmRequire = createRequire(import.meta.url);

export interface PiAuthData {
	"openai-codex"?: { access?: string; refresh?: string };
	anthropic?: { access?: string; refresh?: string };
}

interface CodexUsageApiResponse {
	plan_type?: string;
	rate_limit?: {
		primary_window?: {
			used_percent?: number;
			reset_after_seconds?: number;
		};
		secondary_window?: {
			used_percent?: number;
			reset_after_seconds?: number;
		};
	};
}

export interface CodexUsageSummary {
	loggedIn: boolean;
	available: boolean;
	planType: string | null;
	primaryUsedPercent: number | null;
	primaryRemainingPercent: number | null;
	primaryResetAfterSeconds: number | null;
	secondaryUsedPercent: number | null;
	secondaryRemainingPercent: number | null;
	secondaryResetAfterSeconds: number | null;
	error?: string;
}

function getHomeDir(): string {
	return process.env.HOME ?? os.homedir();
}

export function getPiAuthPath(homeDir: string = getHomeDir()): string {
	return path.join(homeDir, ".pi", "agent", "auth.json");
}

export function readPiAuth(
	authPath: string = getPiAuthPath(),
): PiAuthData | null {
	try {
		return JSON.parse(fs.readFileSync(authPath, "utf-8")) as PiAuthData;
	} catch {
		return null;
	}
}

export function readOpenAiCodexAccessToken(
	authPath: string = getPiAuthPath(),
): string | null {
	const auth = readPiAuth(authPath);
	const token = auth?.["openai-codex"]?.access?.trim();
	return token ? token : null;
}

function toFiniteNumber(value: unknown): number | null {
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : null;
}

function toPercent(value: unknown): number | null {
	const parsed = toFiniteNumber(value);
	if (parsed == null) return null;
	if (parsed > 0 && parsed <= 1) {
		return Math.max(0, Math.min(100, Math.round(parsed * 100)));
	}
	return Math.max(0, Math.min(100, Math.round(parsed)));
}

function toRemainingPercent(usedPercent: number | null): number | null {
	if (usedPercent == null) return null;
	return Math.max(0, Math.min(100, 100 - usedPercent));
}

function buildUnavailableCodexSummary(
	loggedIn: boolean,
	error?: string,
): CodexUsageSummary {
	return {
		loggedIn,
		available: false,
		planType: null,
		primaryUsedPercent: null,
		primaryRemainingPercent: null,
		primaryResetAfterSeconds: null,
		secondaryUsedPercent: null,
		secondaryRemainingPercent: null,
		secondaryResetAfterSeconds: null,
		...(error ? { error } : {}),
	};
}

export async function fetchCodexUsageSummary(
	token: string,
	fetchImpl: typeof fetch = fetch,
): Promise<CodexUsageSummary> {
	const trimmedToken = token.trim();
	if (!trimmedToken) {
		return buildUnavailableCodexSummary(false);
	}

	try {
		const res = await fetchImpl("https://chatgpt.com/backend-api/wham/usage", {
			headers: { Authorization: `Bearer ${trimmedToken}` },
		});
		if (!res.ok) {
			return buildUnavailableCodexSummary(true, `HTTP ${res.status}`);
		}

		const data = (await res.json()) as CodexUsageApiResponse;
		const primaryUsedPercent = toPercent(
			data.rate_limit?.primary_window?.used_percent,
		);
		const secondaryUsedPercent = toPercent(
			data.rate_limit?.secondary_window?.used_percent,
		);
		const primaryResetAfterSeconds = toFiniteNumber(
			data.rate_limit?.primary_window?.reset_after_seconds,
		);
		const secondaryResetAfterSeconds = toFiniteNumber(
			data.rate_limit?.secondary_window?.reset_after_seconds,
		);

		return {
			loggedIn: true,
			available: true,
			planType: typeof data.plan_type === "string" ? data.plan_type : null,
			primaryUsedPercent,
			primaryRemainingPercent: toRemainingPercent(primaryUsedPercent),
			primaryResetAfterSeconds,
			secondaryUsedPercent,
			secondaryRemainingPercent: toRemainingPercent(secondaryUsedPercent),
			secondaryResetAfterSeconds,
		};
	} catch (error) {
		return buildUnavailableCodexSummary(true, String(error));
	}
}

export async function readCodexUsageSummaryFromAuth(
	fetchImpl: typeof fetch = fetch,
	authPath: string = getPiAuthPath(),
): Promise<CodexUsageSummary> {
	const token = readOpenAiCodexAccessToken(authPath);
	if (!token) {
		return buildUnavailableCodexSummary(false);
	}
	return fetchCodexUsageSummary(token, fetchImpl);
}

// ============================================================================
// Kiro Usage (via kiro-cli SQLite database + CodeWhisperer GetUsageLimits)
// ============================================================================

interface KiroCliToken {
	access_token?: string;
	refresh_token?: string;
	expires_at?: string;
	region?: string;
}

interface KiroUsageBreakdown {
	resourceType?: string;
	displayName?: string;
	currentUsage?: number;
	currentUsageWithPrecision?: number;
	usageLimit?: number;
	usageLimitWithPrecision?: number;
	unit?: string;
	nextDateReset?: number;
	freeTrialInfo?: {
		currentUsage?: number;
		usageLimit?: number;
		freeTrialExpiry?: number;
	};
}

interface KiroGetUsageLimitsResponse {
	nextDateReset?: number;
	daysUntilReset?: number;
	usageBreakdown?: KiroUsageBreakdown;
	usageBreakdownList?: KiroUsageBreakdown[];
	subscriptionInfo?: {
		type?: string;
		subscriptionTitle?: string;
		overageCapability?: string;
	};
	overageConfiguration?: {
		overageStatus?: string;
	};
}

export interface KiroUsageSummary {
	loggedIn: boolean;
	available: boolean;
	planTitle: string | null;
	daysUntilReset: number | null;
	resetDate: string | null;
	overageStatus: string | null;
	usageBuckets: Array<{
		label: string;
		used: string;
		limit: string | null;
		unit: string | null;
	}>;
	bonusCredits: {
		used: string;
		limit: string | null;
		expiresAt: string | null;
	} | null;
	manageUrl: string;
	error?: string;
}

function getKiroCliDbPath(): string | undefined {
	const p = process.platform;
	let dbPath: string;
	if (p === "win32") {
		dbPath = path.join(
			process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"),
			"kiro-cli",
			"data.sqlite3",
		);
	} else if (p === "darwin") {
		dbPath = path.join(
			os.homedir(),
			"Library",
			"Application Support",
			"kiro-cli",
			"data.sqlite3",
		);
	} else {
		dbPath = path.join(
			os.homedir(),
			".local",
			"share",
			"kiro-cli",
			"data.sqlite3",
		);
	}
	return fs.existsSync(dbPath) ? dbPath : undefined;
}

function queryKiroCliDbValue(dbPath: string, key: string): string | undefined {
	try {
		// @ts-ignore — node:sqlite is experimental
		const { DatabaseSync } = esmRequire("node:sqlite");
		const db = new DatabaseSync(dbPath, { open: true, readOnly: true });
		try {
			const row = db
				.prepare("SELECT value FROM auth_kv WHERE key = ?")
				.get(key) as { value: string } | undefined;
			return row?.value || undefined;
		} finally {
			db.close();
		}
	} catch {
		return undefined;
	}
}

function readKiroCliToken(
	dbPath: string,
): { accessToken: string; region: string } | null {
	// Try social token first (Google/GitHub), then IDC (Builder ID)
	for (const key of ["kirocli:social:token", "kirocli:odic:token"]) {
		const value = queryKiroCliDbValue(dbPath, key);
		if (!value) continue;
		try {
			const token = JSON.parse(value) as KiroCliToken;
			if (!token.access_token) continue;
			// Check expiry (with 2-min buffer)
			if (token.expires_at) {
				const expiresAt = new Date(token.expires_at).getTime();
				if (Date.now() >= expiresAt - 2 * 60 * 1000) continue;
			}
			return {
				accessToken: token.access_token,
				region: token.region || "us-east-1",
			};
		} catch {}
	}
	return null;
}

function formatCount(value: number | undefined): string {
	if (value === undefined || !Number.isFinite(value)) return "0";
	return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function buildUnavailableKiroSummary(
	loggedIn: boolean,
	error?: string,
): KiroUsageSummary {
	return {
		loggedIn,
		available: false,
		planTitle: null,
		daysUntilReset: null,
		resetDate: null,
		overageStatus: null,
		usageBuckets: [],
		bonusCredits: null,
		manageUrl: "https://app.kiro.dev/account/usage",
		...(error ? { error } : {}),
	};
}

export async function fetchKiroUsageSummary(
	accessToken: string,
	region: string,
	fetchImpl: typeof fetch = fetch,
): Promise<KiroUsageSummary> {
	const endpoint = `https://q.${region}.amazonaws.com/`;

	// Try a few request body variants since different Kiro accounts may require different params
	const bodies = [
		{ origin: "CLI", resourceType: "CREDIT", isEmailRequired: false },
		{ origin: "CLI", resourceType: "CREDIT" },
		{ origin: "CLI" },
		{ origin: "CHATBOT", resourceType: "CREDIT", isEmailRequired: false },
		{},
	];

	const errors: string[] = [];
	for (const body of bodies) {
		try {
			const res = await fetchImpl(endpoint, {
				method: "POST",
				headers: {
					"Content-Type": "application/x-amz-json-1.0",
					"X-Amz-Target": "AmazonCodeWhispererService.GetUsageLimits",
					Authorization: `Bearer ${accessToken}`,
				},
				body: JSON.stringify(body),
			});

			if (!res.ok) {
				errors.push(`HTTP ${res.status}`);
				continue;
			}

			const data = (await res.json()) as KiroGetUsageLimitsResponse;
			return mapKiroUsageResponse(data);
		} catch (err) {
			errors.push(err instanceof Error ? err.message : String(err));
		}
	}

	return buildUnavailableKiroSummary(
		true,
		errors[0] || "All request variants failed",
	);
}

function mapKiroUsageResponse(
	data: KiroGetUsageLimitsResponse,
): KiroUsageSummary {
	const buckets: KiroUsageSummary["usageBuckets"] = [];

	// Use usageBreakdownList if available, otherwise usageBreakdown
	const breakdowns =
		data.usageBreakdownList ??
		(data.usageBreakdown ? [data.usageBreakdown] : []);
	for (const bd of breakdowns) {
		const used = bd.currentUsageWithPrecision ?? bd.currentUsage;
		const limit = bd.usageLimitWithPrecision ?? bd.usageLimit;
		buckets.push({
			label: bd.displayName || bd.resourceType || "Credits",
			used: formatCount(used),
			limit: limit !== undefined ? formatCount(limit) : null,
			unit: bd.unit || null,
		});
	}

	let bonusCredits: KiroUsageSummary["bonusCredits"] = null;
	// Check first breakdown for free trial/bonus info
	const firstBd = breakdowns[0];
	if (firstBd?.freeTrialInfo) {
		const ft = firstBd.freeTrialInfo;
		bonusCredits = {
			used: formatCount(ft.currentUsage),
			limit: ft.usageLimit !== undefined ? formatCount(ft.usageLimit) : null,
			expiresAt: ft.freeTrialExpiry
				? new Date(ft.freeTrialExpiry * 1000).toISOString().slice(0, 10)
				: null,
		};
	}

	let resetDate: string | null = null;
	if (data.nextDateReset) {
		resetDate = new Date(data.nextDateReset * 1000).toISOString().slice(0, 10);
	}

	return {
		loggedIn: true,
		available: true,
		planTitle:
			data.subscriptionInfo?.subscriptionTitle ||
			data.subscriptionInfo?.type ||
			null,
		daysUntilReset: data.daysUntilReset ?? null,
		resetDate,
		overageStatus: data.overageConfiguration?.overageStatus || null,
		usageBuckets: buckets,
		bonusCredits,
		manageUrl: "https://app.kiro.dev/account/usage",
	};
}

export async function readKiroUsageSummaryFromAuth(
	fetchImpl: typeof fetch = fetch,
): Promise<KiroUsageSummary> {
	const dbPath = getKiroCliDbPath();
	if (!dbPath) {
		return buildUnavailableKiroSummary(false);
	}

	const creds = readKiroCliToken(dbPath);
	if (!creds) {
		return buildUnavailableKiroSummary(false);
	}

	return fetchKiroUsageSummary(creds.accessToken, creds.region, fetchImpl);
}
