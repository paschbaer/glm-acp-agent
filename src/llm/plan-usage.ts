/**
 * GLM Coding Plan usage status.
 *
 * Queries the (undocumented) monitor endpoint that backs the Z.AI usage
 * console — `GET {origin}/api/monitor/usage/quota/limit` with the regular
 * coding-plan API key — and turns the response into a compact status line
 * showing the 5-hour and weekly quota consumption plus reset times.
 *
 * The endpoint is not part of the public API contract, so every consumer must
 * treat the data as best-effort: parsing is defensive and any failure
 * (network, auth, schema drift) resolves to `undefined`, never throws.
 */

import { resolveApiKey } from "./credentials.js";
import { debug } from "./logger.js";

/** One quota window (5-hour or weekly). */
export interface PlanUsageWindow {
  /** Percentage of the window's quota already used (0..100+, not clamped). */
  usedPercentage: number;
  /** Epoch milliseconds at which the window resets. */
  resetAtMs: number;
}

/** Parsed coding-plan usage snapshot. */
export interface PlanUsage {
  fiveHour?: PlanUsageWindow;
  weekly?: PlanUsageWindow;
  /** Plan tier as reported by the backend (e.g. "lite", "pro", "max"). */
  planLevel?: string;
}

/** Same origin as the chat completions base URL (`ACP_GLM_BASE_URL`). */
const DEFAULT_BASE_URL = "https://api.z.ai/api/coding/paas/v4";

/** One quota fetch is cheap; the TTL only coalesces bursts across sessions. */
const CACHE_TTL_MS = 60_000;

/** Failed lookups are also cached, so a dead endpoint is not re-hit per prompt. */
const FAILURE_TTL_MS = 30_000;

const FETCH_TIMEOUT_MS = 5_000;

/**
 * Whether the plan status feature is enabled. On by default; opt out with
 * `GLM_ACP_PLAN_STATUS=0` (or `false`) to suppress the background request.
 */
export function planStatusEnabled(): boolean {
  const raw = process.env["GLM_ACP_PLAN_STATUS"];
  if (!raw) return true;
  const normalized = raw.trim().toLowerCase();
  return normalized !== "0" && normalized !== "false" && normalized !== "off";
}

interface RawLimitItem {
  type?: unknown;
  unit?: unknown;
  number?: unknown;
  percentage?: unknown;
  nextResetTime?: unknown;
}

function toWindow(item: RawLimitItem): PlanUsageWindow | undefined {
  const percentage = item.percentage;
  const reset = item.nextResetTime;
  if (typeof percentage !== "number" || !Number.isFinite(percentage) || percentage < 0) {
    return undefined;
  }
  if (typeof reset !== "number" || !Number.isFinite(reset) || reset <= 0) return undefined;
  return { usedPercentage: percentage, resetAtMs: reset };
}

/**
 * Parse a quota/limit response body. Recognizes the two `TOKENS_LIMIT` window
 * signatures the backend emits (`unit=3, number=5` → 5-hour window,
 * `unit=6, number=1` → weekly window) and ignores everything else (MCP
 * time limits, unknown signatures, malformed entries). Returns `undefined`
 * when neither window can be extracted.
 */
export function parsePlanUsage(body: unknown): PlanUsage | undefined {
  if (body === null || typeof body !== "object") return undefined;
  const data = (body as { data?: unknown }).data;
  if (data === null || typeof data !== "object") return undefined;
  const limits = (data as { limits?: unknown }).limits;
  if (!Array.isArray(limits)) return undefined;

  const usage: PlanUsage = {};
  for (const entry of limits) {
    if (entry === null || typeof entry !== "object") continue;
    const item = entry as RawLimitItem;
    if (item.type !== "TOKENS_LIMIT") continue;
    const window = toWindow(item);
    if (!window) continue;
    if (item.unit === 3 && item.number === 5) {
      usage.fiveHour ??= window;
    } else if (item.unit === 6 && item.number === 1) {
      usage.weekly ??= window;
    }
  }

  const level = (data as { level?: unknown }).level;
  if (typeof level === "string" && level.length > 0) {
    usage.planLevel = level;
  }

  return usage.fiveHour !== undefined || usage.weekly !== undefined
    ? usage
    : undefined;
}

function formatReset(resetAtMs: number, now: Date, locale?: string): string {
  const reset = new Date(resetAtMs);
  const sameDay =
    reset.getFullYear() === now.getFullYear() &&
    reset.getMonth() === now.getMonth() &&
    reset.getDate() === now.getDate();
  if (sameDay) {
    return new Intl.DateTimeFormat(locale, {
      hour: "2-digit",
      minute: "2-digit",
    }).format(reset);
  }
  const daysAhead = (resetAtMs - now.getTime()) / 86_400_000;
  if (daysAhead <= 7) {
    return new Intl.DateTimeFormat(locale, {
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
    }).format(reset);
  }
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(reset);
}

/**
 * Render a usage snapshot as a single status line, e.g.
 * `GLM plan (max): 5h used 29% (resets 14:26) · week used 22% (resets Mon 09:00)`.
 * Windows without data are omitted; the result is never empty because
 * `parsePlanUsage` guarantees at least one window.
 */
export function formatPlanUsageStatus(usage: PlanUsage, locale?: string): string {
  const now = new Date();
  const parts: string[] = [];
  if (usage.fiveHour) {
    parts.push(
      `5h used ${usage.fiveHour.usedPercentage}% (resets ${formatReset(usage.fiveHour.resetAtMs, now, locale)})`
    );
  }
  if (usage.weekly) {
    parts.push(
      `week used ${usage.weekly.usedPercentage}% (resets ${formatReset(usage.weekly.resetAtMs, now, locale)})`
    );
  }
  const level = usage.planLevel ? ` (${usage.planLevel})` : "";
  return `GLM plan${level}: ${parts.join(" · ")}`;
}

/**
 * Usage monitor scoped to one agent (connection). The quota is account-wide,
 * so all sessions of that agent share one cached snapshot; repeated triggers
 * collapse into at most one request per TTL window. Failures resolve to
 * `undefined` and are logged at debug level.
 */
export class PlanUsageMonitor {
  private readonly endpoint: string | null;
  private readonly apiKey: string | undefined;
  private readonly fetchFn: typeof fetch;
  private readonly ttlMs: number;
  private readonly failureTtlMs: number;
  private cache: { usage: PlanUsage | undefined; at: number; failure: boolean } | null = null;
  private inflight: Promise<PlanUsage | undefined> | null = null;

  constructor(options: {
    baseUrl?: string;
    apiKey?: string;
    fetchFn?: typeof fetch;
    ttlMs?: number;
    failureTtlMs?: number;
  } = {}) {
    const base = options.baseUrl ?? process.env["ACP_GLM_BASE_URL"] ?? DEFAULT_BASE_URL;
    // The monitor is best-effort by contract; a malformed base URL must not
    // take the agent down, so derive the endpoint defensively.
    let endpoint: string | null;
    try {
      endpoint = new URL("/api/monitor/usage/quota/limit", base).toString();
    } catch {
      endpoint = null;
    }
    this.endpoint = endpoint;
    this.apiKey = options.apiKey ?? resolveApiKey();
    this.fetchFn = options.fetchFn ?? fetch;
    this.ttlMs = options.ttlMs ?? CACHE_TTL_MS;
    this.failureTtlMs = options.failureTtlMs ?? FAILURE_TTL_MS;
  }

  /**
   * Current usage snapshot, served from cache while fresh (successes and,
   * with a shorter TTL, failures). `force` bypasses the cache for explicit
   * user-initiated reads (`/plan`). Never rejects: any failure resolves to
   * `undefined`.
   */
  current(force = false): Promise<PlanUsage | undefined> {
    if (!force && this.cache) {
      const age = Date.now() - this.cache.at;
      if (this.cache.failure ? age < this.failureTtlMs : age < this.ttlMs) {
        return Promise.resolve(this.cache.usage);
      }
    }
    this.inflight ??= this.fetch().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async fetch(): Promise<PlanUsage | undefined> {
    if (!this.apiKey || this.endpoint === null) {
      this.cache = { usage: undefined, at: Date.now(), failure: true };
      return undefined;
    }
    try {
      const response = await this.fetchFn(this.endpoint, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!response.ok) {
        debug(`planUsage: quota endpoint returned ${response.status}`);
        this.cache = { usage: undefined, at: Date.now(), failure: true };
        return undefined;
      }
      const usage = parsePlanUsage(await response.json());
      if (!usage) {
        debug("planUsage: unrecognized quota response schema");
        this.cache = { usage: undefined, at: Date.now(), failure: true };
        return undefined;
      }
      this.cache = { usage, at: Date.now(), failure: false };
      return usage;
    } catch (err) {
      debug(
        `planUsage: fetch failed: ${err instanceof Error ? err.message : String(err)}`
      );
      this.cache = { usage: undefined, at: Date.now(), failure: true };
      return undefined;
    }
  }
}
