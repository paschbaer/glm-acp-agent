import test from "node:test";
import assert from "node:assert/strict";
import {
  PlanUsageMonitor,
  formatPlanUsageStatus,
  parsePlanUsage,
  planStatusEnabled,
} from "../llm/plan-usage.js";

/**
 * Fixture mirroring the live `GET /api/monitor/usage/quota/limit` response
 * (observed 2026-10-11): TOKENS_LIMIT unit=3/number=5 is the 5-hour window,
 * unit=6/number=1 the weekly window, TIME_LIMIT is the MCP tool budget.
 */
const LIVE_FIXTURE = {
  code: 200,
  msg: "Operation successful",
  success: true,
  data: {
    limits: [
      { type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 29, nextResetTime: 1791716802571 },
      { type: "TOKENS_LIMIT", unit: 6, number: 1, percentage: 22, nextResetTime: 1792236032999 },
      {
        type: "TIME_LIMIT",
        unit: 5,
        number: 1,
        usage: 4000,
        currentValue: 0,
        remaining: 4000,
        percentage: 0,
        nextResetTime: 1793092832999,
        usageDetails: [{ modelCode: "search-prime", usage: 0 }],
      },
    ],
    level: "max",
  },
};

test("parsePlanUsage accepts a zero percentage and rejects non-positive resets", () => {
  const usage = parsePlanUsage({
    data: {
      limits: [
        { type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 0, nextResetTime: 1791716802571 },
        { type: "TOKENS_LIMIT", unit: 6, number: 1, percentage: 5, nextResetTime: 0 },
        { type: "TOKENS_LIMIT", unit: 6, number: 1, percentage: 6, nextResetTime: -1 },
      ],
    },
  });
  assert.ok(usage);
  assert.equal(usage.fiveHour?.usedPercentage, 0);
  assert.equal(usage.weekly, undefined, "non-positive reset times must be rejected");
});

test("parsePlanUsage keeps the first entry for duplicate window signatures", () => {
  const usage = parsePlanUsage({
    data: {
      limits: [
        { type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 11, nextResetTime: 1791716802571 },
        { type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 99, nextResetTime: 1791719999999 },
      ],
    },
  });
  assert.equal(usage?.fiveHour?.usedPercentage, 11);
});

test("formatPlanUsageStatus renders a zero-usage window", () => {
  const status = formatPlanUsageStatus(
    { weekly: { usedPercentage: 0, resetAtMs: Date.now() + 86_400_000 } },
    "en-US"
  );
  assert.match(status, /week used 0%/);
  assert.doesNotMatch(status, /5h/);
});

test("parsePlanUsage extracts the 5h and weekly windows and the plan level", () => {
  const usage = parsePlanUsage(LIVE_FIXTURE);
  assert.ok(usage);
  assert.deepEqual(usage.fiveHour, { usedPercentage: 29, resetAtMs: 1791716802571 });
  assert.deepEqual(usage.weekly, { usedPercentage: 22, resetAtMs: 1792236032999 });
  assert.equal(usage.planLevel, "max");
});

test("parsePlanUsage ignores unknown TOKENS_LIMIT signatures", () => {
  const usage = parsePlanUsage({
    data: {
      limits: [
        { type: "TOKENS_LIMIT", unit: 9, number: 2, percentage: 10, nextResetTime: 1791716802571 },
        { type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 41, nextResetTime: 1791716802571 },
      ],
    },
  });
  assert.ok(usage);
  assert.equal(usage.weekly, undefined);
  assert.equal(usage.fiveHour?.usedPercentage, 41);
});

test("parsePlanUsage returns undefined on malformed or windowless input", () => {
  assert.equal(parsePlanUsage(null), undefined);
  assert.equal(parsePlanUsage("nope"), undefined);
  assert.equal(parsePlanUsage({ data: {} }), undefined);
  assert.equal(parsePlanUsage({ data: { limits: "nope" } }), undefined);
  assert.equal(
    parsePlanUsage({ data: { limits: [{ type: "TIME_LIMIT", percentage: 1, nextResetTime: 1 }] } }),
    undefined
  );
  // Recognized signature but unusable numbers must not yield a window.
  assert.equal(
    parsePlanUsage({
      data: { limits: [{ type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: "29" }] },
    }),
    undefined
  );
});

test("formatPlanUsageStatus renders both windows with used percentages", () => {
  const status = formatPlanUsageStatus(parsePlanUsage(LIVE_FIXTURE)!, "en-US");
  assert.match(status, /^GLM plan \(max\): /);
  assert.match(status, /5h used 29%/);
  assert.match(status, /week used 22%/);
  assert.match(status, /resets /);
});

test("formatPlanUsageStatus omits missing windows and clamps nothing", () => {
  const status = formatPlanUsageStatus(
    { fiveHour: { usedPercentage: 130, resetAtMs: Date.now() + 3_600_000 } },
    "en-US"
  );
  assert.match(status, /5h used 130%/);
  assert.doesNotMatch(status, /week/);
});

test("formatPlanUsageStatus picks the reset format from the distance", () => {
  const now = Date.now();
  const sameDay = formatPlanUsageStatus(
    { fiveHour: { usedPercentage: 1, resetAtMs: now + 60_000 } },
    "en-US"
  );
  // Same-day resets render as a bare time, so no weekday abbreviation.
  assert.doesNotMatch(sameDay, /Mon|Tue|Wed|Thu|Fri|Sat|Sun/);

  const nextWeek = formatPlanUsageStatus(
    { weekly: { usedPercentage: 1, resetAtMs: now + 5 * 86_400_000 } },
    "en-US"
  );
  assert.match(nextWeek, /(Mon|Tue|Wed|Thu|Fri|Sat|Sun)/);

  const farOut = formatPlanUsageStatus(
    { weekly: { usedPercentage: 1, resetAtMs: now + 30 * 86_400_000 } },
    "en-US"
  );
  assert.match(farOut, /(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)/);
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

test("PlanUsageMonitor serves repeated calls from cache within the TTL", async () => {
  let calls = 0;
  const monitor = new PlanUsageMonitor({
    apiKey: "test-key",
    ttlMs: 60_000,
    fetchFn: async () => {
      calls += 1;
      return jsonResponse(LIVE_FIXTURE);
    },
  });
  const first = await monitor.current();
  const second = await monitor.current();
  assert.ok(first);
  assert.equal(second, first);
  assert.equal(calls, 1);
});

test("PlanUsageMonitor collapses concurrent callers onto one in-flight fetch", async () => {
  let calls = 0;
  let releaseFetch!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseFetch = resolve;
  });
  const monitor = new PlanUsageMonitor({
    apiKey: "test-key",
    ttlMs: 60_000,
    fetchFn: async () => {
      calls += 1;
      await gate;
      return jsonResponse(LIVE_FIXTURE);
    },
  });
  const pending = [monitor.current(), monitor.current(), monitor.current()];
  releaseFetch();
  const results = await Promise.all(pending);
  assert.equal(calls, 1);
  assert.ok(results.every((r) => r === results[0]));
});

test("PlanUsageMonitor current(force) bypasses the cache", async () => {
  let calls = 0;
  const monitor = new PlanUsageMonitor({
    apiKey: "test-key",
    ttlMs: 60_000,
    fetchFn: async () => {
      calls += 1;
      return jsonResponse(LIVE_FIXTURE);
    },
  });
  await monitor.current();
  await monitor.current(true);
  assert.equal(calls, 2, "forced read must re-fetch despite fresh cache");
});

test("PlanUsageMonitor resolves to undefined on HTTP and network failures", async () => {
  const httpError = new PlanUsageMonitor({
    apiKey: "test-key",
    fetchFn: async () => new Response("nope", { status: 403 }),
  });
  assert.equal(await httpError.current(), undefined);

  const networkError = new PlanUsageMonitor({
    apiKey: "test-key",
    fetchFn: async () => {
      throw new Error("connection refused");
    },
  });
  assert.equal(await networkError.current(), undefined);
});

test("PlanUsageMonitor negative-caches failures within the failure TTL", async () => {
  let calls = 0;
  const monitor = new PlanUsageMonitor({
    apiKey: "test-key",
    failureTtlMs: 60_000,
    fetchFn: async () => {
      calls += 1;
      return new Response("nope", { status: 500 });
    },
  });
  assert.equal(await monitor.current(), undefined);
  assert.equal(await monitor.current(), undefined);
  assert.equal(calls, 1);
});

test("PlanUsageMonitor tolerates a malformed ACP_GLM_BASE_URL", async () => {
  const old = process.env["ACP_GLM_BASE_URL"];
  process.env["ACP_GLM_BASE_URL"] = "not-a-url";
  try {
    let calls = 0;
    const monitor = new PlanUsageMonitor({
      apiKey: "test-key",
      fetchFn: async () => {
        calls += 1;
        return jsonResponse(LIVE_FIXTURE);
      },
    });
    assert.equal(await monitor.current(), undefined);
    assert.equal(calls, 0);
  } finally {
    if (old === undefined) {
      delete process.env["ACP_GLM_BASE_URL"];
    } else {
      process.env["ACP_GLM_BASE_URL"] = old;
    }
  }
});

test("PlanUsageMonitor skips fetching without an API key", async () => {
  // `apiKey: undefined` deliberately falls back to resolveApiKey(); simulate a
  // machine with no credentials by clearing the env var AND isolating the
  // credentials-file lookup roots (HOME/USERPROFILE/XDG_CONFIG_HOME).
  const saved: Record<string, string | undefined> = {};
  for (const key of ["Z_AI_API_KEY", "HOME", "USERPROFILE", "XDG_CONFIG_HOME"]) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  let calls = 0;
  try {
    const monitor = new PlanUsageMonitor({
      apiKey: undefined,
      fetchFn: async () => {
        calls += 1;
        return jsonResponse(LIVE_FIXTURE);
      },
    });
    assert.equal(await monitor.current(), undefined);
    assert.equal(calls, 0);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

test("planStatusEnabled honours the GLM_ACP_PLAN_STATUS opt-out", () => {
  const old = process.env["GLM_ACP_PLAN_STATUS"];
  try {
    delete process.env["GLM_ACP_PLAN_STATUS"];
    assert.equal(planStatusEnabled(), true);
    for (const off of ["0", "false", "off", "FALSE"]) {
      process.env["GLM_ACP_PLAN_STATUS"] = off;
      assert.equal(planStatusEnabled(), false, `expected off for ${off}`);
    }
    process.env["GLM_ACP_PLAN_STATUS"] = "1";
    assert.equal(planStatusEnabled(), true);
  } finally {
    if (old === undefined) {
      delete process.env["GLM_ACP_PLAN_STATUS"];
    } else {
      process.env["GLM_ACP_PLAN_STATUS"] = old;
    }
  }
});
