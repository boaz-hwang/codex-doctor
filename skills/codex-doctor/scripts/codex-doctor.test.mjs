import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildDiagnosis,
  buildRecommendations,
  cachedBucketResult,
  calculateContextRemainingPercent,
  fetchAppServerData,
  labelWindow,
  normalizeRateLimitResponse,
  parseSessionFile,
  projectWindow,
  renderReport,
  runDoctor,
} from "./codex-doctor.mjs";

test("uses the configured app-server environment to read account data", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-doctor-app-server-test-"));
  const sourceHome = join(directory, "source-home");
  const mockBinary = join(directory, "mock-codex.mjs");
  const probePath = join(directory, "probe.json");
  await mkdir(sourceHome);
  await writeFile(join(sourceHome, "auth.json"), "{}\n", { mode: 0o600 });
  await writeFile(
    mockBinary,
    `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import readline from "node:readline";

writeFileSync(process.env.CODEX_DOCTOR_PROBE_PATH, JSON.stringify({
  args: process.argv.slice(2),
  codexHome: process.env.CODEX_HOME,
}));

const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lines) {
  const request = JSON.parse(line);
  if (request.id === undefined) continue;
  let result = {};
  if (request.method === "account/rateLimits/read") {
    result = { rateLimits: { primary: { usedPercent: 25, windowDurationMins: 300 } } };
  } else if (request.method === "account/usage/read") {
    result = { summary: { lifetimeTokens: 100 }, dailyUsageBuckets: [] };
  }
  process.stdout.write(JSON.stringify({ id: request.id, result }) + "\\n");
}
`,
    { mode: 0o755 },
  );

  try {
    const data = await fetchAppServerData({
      env: {
        ...process.env,
        CODEX_HOME: sourceHome,
        CODEX_DOCTOR_CODEX_BINARY: mockBinary,
        CODEX_DOCTOR_PROBE_PATH: probePath,
      },
    });
    const probe = JSON.parse(await readFile(probePath, "utf8"));
    assert.deepEqual(probe.args, ["app-server", "--listen", "stdio://"]);
    assert.equal(probe.codexHome, sourceHome);
    assert.equal(data.limits.rateLimits.primary.usedPercent, 25);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("matches Codex's 12k-baseline context calculation", () => {
  assert.equal(calculateContextRemainingPercent(12_000, 258_400), 100);
  assert.equal(calculateContextRemainingPercent(73_478, 258_400), 75);
  assert.equal(calculateContextRemainingPercent(258_400, 258_400), 0);
});

test("labels only windows actually returned by the service", () => {
  assert.equal(labelWindow(300), "5h");
  assert.equal(labelWindow(10_080), "weekly");
  assert.equal(labelWindow(90), "90m");
});

test("normalizes multi-bucket app-server results without inventing a 5h window", () => {
  const nowMs = Date.parse("2026-08-18T00:00:00Z");
  const buckets = normalizeRateLimitResponse(
    {
      rateLimitsByLimitId: {
        codex: {
          limitId: "codex",
          primary: {
            usedPercent: 40,
            windowDurationMins: 10_080,
            resetsAt: nowMs / 1_000 + 86_400,
          },
          secondary: null,
        },
        codex_fast: {
          limitId: "codex_fast",
          limitName: "Fast model",
          primary: {
            usedPercent: 10,
            windowDurationMins: 10_080,
            resetsAt: nowMs / 1_000 + 86_400,
          },
        },
      },
    },
    nowMs,
  );
  assert.equal(buckets.length, 2);
  assert.deepEqual(buckets[0].windows.map((window) => window.label), ["weekly"]);
  assert.equal(buckets[1].name, "Fast model");
});

test("clamps out-of-range service percentages", () => {
  const buckets = normalizeRateLimitResponse({
    rateLimits: {
      primary: { usedPercent: 130, windowDurationMins: 300 },
      secondary: { usedPercent: -20, windowDurationMins: 10_080 },
    },
  });
  assert.deepEqual(
    buckets[0].windows.map((window) => [window.usedPercent, window.remainingPercent]),
    [
      [100, 0],
      [0, 100],
    ],
  );
});

test("keeps null rate-limit fields unavailable", () => {
  const buckets = normalizeRateLimitResponse({
    rateLimitsByLimitId: {},
    rateLimits: {
      primary: { usedPercent: 20, windowDurationMins: null, resetsAt: null },
    },
  });
  assert.equal(buckets[0].windows[0].durationMinutes, null);
  assert.equal(buckets[0].windows[0].resetsAt, null);
  assert.equal(buckets[0].windows[0].label, "usage");
});

test("preserves authoritative reached status without a percentage window", () => {
  const buckets = normalizeRateLimitResponse({
    rateLimits: { rateLimitReachedType: "rate_limit_reached", primary: null, secondary: null },
  });
  assert.equal(buckets.length, 1);
  const diagnoses = buildDiagnosis(buckets, { available: false }, "live-app-server", null);
  assert.equal(diagnoses[0].code, "rate-limit-reached");
  assert.equal(diagnoses[0].severity, "critical");
  const recommendations = buildRecommendations(buckets, { available: false }, diagnoses);
  assert.match(recommendations[0], /Pause quota-sensitive work/);
  assert.doesNotMatch(recommendations.join(" "), /No quota-driven model change/);

  const invalid = normalizeRateLimitResponse({
    rateLimits: { rateLimitReachedType: "primary", primary: null, secondary: null },
  });
  assert.equal(invalid.length, 0);
});

test("gives an actionable recommendation for status-only spend control", () => {
  const buckets = normalizeRateLimitResponse({
    rateLimits: { spendControlReached: true, primary: null, secondary: null },
  });
  const diagnoses = buildDiagnosis(buckets, { available: false }, "live-app-server", null);
  const recommendations = buildRecommendations(buckets, { available: false }, diagnoses);
  assert.equal(diagnoses[0].code, "spend-control-reached");
  assert.match(recommendations[0], /Check the workspace spend control/);
  assert.doesNotMatch(recommendations.join(" "), /No quota-driven model change/);
});

test("gives a quota-preserving action when a percentage window is low", () => {
  const buckets = normalizeRateLimitResponse({
    rateLimits: {
      limitId: "codex",
      primary: { usedPercent: 95, windowDurationMins: 300 },
    },
  });
  const session = { model: "gpt-5.6-sol", reasoningEffort: "high" };
  const diagnoses = buildDiagnosis(buckets, session, "live-app-server", null);
  const recommendations = buildRecommendations(buckets, session, diagnoses);
  assert.equal(diagnoses[0].code, "quota-critical");
  assert.match(recommendations[0], /Reserve the remaining Codex quota/);
  assert.doesNotMatch(recommendations.join(" "), /No quota-driven model change/);
  assert.doesNotMatch(recommendations.join(" "), /lower reasoning/);
});

test("does not recommend an alternative bucket with another pressured window", () => {
  const buckets = normalizeRateLimitResponse({
    rateLimitsByLimitId: {
      codex: {
        limitId: "codex",
        primary: { usedPercent: 10, windowDurationMins: 300 },
        secondary: { usedPercent: 90, windowDurationMins: 10_080 },
      },
      alt: {
        limitId: "alt",
        limitName: "Alt",
        primary: { usedPercent: 0, windowDurationMins: 300 },
        secondary: { usedPercent: 95, windowDurationMins: 10_080 },
      },
    },
  });
  const session = { model: "gpt-5.6-sol", reasoningEffort: "ultra" };
  const diagnoses = buildDiagnosis(buckets, session, "live-app-server", null);
  const recommendations = buildRecommendations(buckets, session, diagnoses);
  assert.doesNotMatch(recommendations.join(" "), /use Alt/);
});

test("does not lower current reasoning for pressure isolated to another bucket", () => {
  const buckets = normalizeRateLimitResponse({
    rateLimitsByLimitId: {
      codex: {
        limitId: "codex",
        primary: { usedPercent: 10, windowDurationMins: 10_080 },
      },
      alt: {
        limitId: "alt",
        limitName: "Alt",
        primary: { usedPercent: 95, windowDurationMins: 10_080 },
      },
    },
  });
  const session = { model: "gpt-5.6-sol", reasoningEffort: "ultra" };
  const diagnoses = buildDiagnosis(buckets, session, "live-app-server", null);
  const recommendations = buildRecommendations(buckets, session, diagnoses);
  assert.doesNotMatch(recommendations.join(" "), /lower reasoning/);
  assert.match(recommendations[0], /Alt quota/);
});

test("recommends a separate bucket only for a matching healthier window", () => {
  const buckets = normalizeRateLimitResponse({
    rateLimitsByLimitId: {
      codex: {
        limitId: "codex",
        primary: { usedPercent: 90, windowDurationMins: 10_080 },
      },
      alt: {
        limitId: "alt",
        limitName: "Alt",
        primary: { usedPercent: 10, windowDurationMins: 10_080 },
      },
    },
  });
  const session = { model: "gpt-5.6-sol", reasoningEffort: "medium" };
  const diagnoses = buildDiagnosis(buckets, session, "live-app-server", null);
  const recommendations = buildRecommendations(buckets, session, diagnoses);
  assert.match(recommendations.join(" "), /use Alt; its separate weekly window has 90% remaining/);
});

test("rejects stale and expired cached rate limits", () => {
  const nowMs = Date.parse("2026-08-18T12:00:00Z");
  const snapshot = {
    limit_id: "codex",
    primary: {
      used_percent: 95,
      window_minutes: 300,
      resets_at: nowMs / 1_000 + 3_600,
    },
  };
  const stale = cachedBucketResult(
    {
      cachedRateLimits: snapshot,
      rateLimitsObservedAt: "2026-08-18T11:44:00Z",
    },
    nowMs,
  );
  assert.equal(stale.reason, "stale");
  assert.equal(stale.buckets.length, 0);

  const expired = cachedBucketResult(
    {
      cachedRateLimits: {
        ...snapshot,
        primary: { ...snapshot.primary, resets_at: nowMs / 1_000 - 1 },
      },
      rateLimitsObservedAt: "2026-08-18T11:59:00Z",
    },
    nowMs,
  );
  assert.equal(expired.reason, "expired");
  assert.equal(expired.buckets.length, 0);

  const expiredReached = cachedBucketResult(
    {
      cachedRateLimits: {
        ...snapshot,
        rate_limit_reached_type: "rate_limit_reached",
        primary: { ...snapshot.primary, resets_at: nowMs / 1_000 - 1 },
      },
      rateLimitsObservedAt: "2026-08-18T11:59:30Z",
    },
    nowMs,
  );
  assert.equal(expiredReached.reason, "expired");
  assert.equal(expiredReached.buckets.length, 0);

  const statusOnly = cachedBucketResult(
    {
      cachedRateLimits: {
        limit_id: "codex",
        rate_limit_reached_type: "rate_limit_reached",
      },
      rateLimitsObservedAt: "2026-08-18T11:59:30Z",
    },
    nowMs,
  );
  assert.equal(statusOnly.reason, null);
  assert.equal(statusOnly.buckets.length, 1);

  const partiallyReset = cachedBucketResult(
    {
      cachedRateLimits: {
        ...snapshot,
        rate_limit_reached_type: "rate_limit_reached",
        primary: { ...snapshot.primary, resets_at: nowMs / 1_000 - 1 },
        secondary: {
          used_percent: 10,
          window_minutes: 10_080,
          resets_at: nowMs / 1_000 + 86_400,
        },
      },
      rateLimitsObservedAt: "2026-08-18T11:59:30Z",
    },
    nowMs,
  );
  assert.equal(partiallyReset.buckets.length, 1);
  assert.equal(partiallyReset.buckets[0].rateLimitReachedType, null);
  assert.deepEqual(
    partiallyReset.buckets[0].windows.map((window) => window.label),
    ["weekly"],
  );

  const workspaceReached = cachedBucketResult(
    {
      cachedRateLimits: {
        ...snapshot,
        rate_limit_reached_type: "workspace_member_usage_limit_reached",
        primary: { ...snapshot.primary, resets_at: nowMs / 1_000 - 1 },
      },
      rateLimitsObservedAt: "2026-08-18T11:59:30Z",
    },
    nowMs,
  );
  assert.equal(workspaceReached.buckets.length, 1);
  assert.equal(
    workspaceReached.buckets[0].rateLimitReachedType,
    "workspace_member_usage_limit_reached",
  );
});

test("projects exhaustion from elapsed-window average", () => {
  const nowMs = Date.parse("2026-08-18T02:00:00Z");
  const projection = projectWindow(
    {
      usedPercent: 60,
      durationMinutes: 300,
      resetsAt: Date.parse("2026-08-18T05:00:00Z") / 1_000,
    },
    nowMs,
  );
  assert.ok(projection);
  assert.equal(projection.beforeReset, true);
  assert.equal(projection.ratePercentPerHour, 30);
});

test("does not expose conversation content parsed from a rollout", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-doctor-test-"));
  const path = join(directory, "session.jsonl");
  const lines = [
    {
      timestamp: "2026-08-18T00:00:00Z",
      type: "session_meta",
      payload: { id: "thread", timestamp: "2026-08-18T00:00:00Z" },
    },
    {
      timestamp: "2026-08-18T01:00:00Z",
      type: "response_item",
      payload: { type: "message", content: "must not appear" },
    },
    {
      timestamp: "2026-08-18T02:00:00Z",
      type: "turn_context",
      payload: { model: "gpt-old", effort: "medium", collaboration_mode: { mode: "default" } },
    },
    {
      timestamp: "2026-08-18T02:00:30Z",
      type: "event_msg",
      payload: {
        type: "thread_settings_applied",
        thread_settings: {
          model: "gpt-test",
          reasoning_effort: "high",
          collaboration_mode: "default",
        },
      },
    },
    {
      timestamp: "2026-08-18T02:01:00Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          last_token_usage: { total_tokens: 73_478 },
          total_token_usage: { total_tokens: 100_000, cached_input_tokens: 50_000 },
          model_context_window: 258_400,
        },
      },
    },
    {
      timestamp: "2026-08-18T02:02:00Z",
      type: "event_msg",
      payload: { type: "token_count", info: null, rate_limits: null },
    },
    {
      timestamp: "2026-08-18T02:03:00Z",
      type: "session_meta",
      payload: { id: "parent-thread", timestamp: "2026-08-10T00:00:00Z" },
    },
  ];
  await writeFile(path, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n{"partial":`);
  try {
    const session = await parseSessionFile(
      path,
      Date.parse("2026-08-18T03:00:00Z"),
      "thread",
    );
    assert.equal(session.available, true);
    assert.equal(session.model, "gpt-test");
    assert.equal(session.reasoningEffort, "high");
    assert.equal(session.context.remainingPercent, 75);
    assert.equal(session.ageSeconds, 3 * 60 * 60);
    assert.equal(session.malformedLines, 1);
    assert.equal(JSON.stringify(session).includes("must not appear"), false);

    const mismatched = await parseSessionFile(
      path,
      Date.parse("2026-08-18T03:00:00Z"),
      "missing-thread",
    );
    assert.equal(mismatched.createdAt, null);
    assert.equal(mismatched.ageSeconds, null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("keeps context unavailable when last_token_usage lacks total_tokens", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-doctor-context-test-"));
  const path = join(directory, "session.jsonl");
  await writeFile(
    path,
    `${JSON.stringify({
      timestamp: "2026-08-18T00:00:00Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          last_token_usage: { input_tokens: 200_000 },
          model_context_window: 258_400,
        },
      },
    })}\n`,
  );
  try {
    const session = await parseSessionFile(path, Date.parse("2026-08-18T00:01:00Z"));
    assert.equal(session.available, true);
    assert.equal(session.context, null);
    const diagnoses = buildDiagnosis([], session, null, null);
    assert.equal(diagnoses[0].code, "insufficient-data");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("renders unavailable fields explicitly", () => {
  const generatedAt = "2026-08-18T00:00:00.000Z";
  const output = renderReport({
    generatedAt,
    buckets: [],
    resetCredits: null,
    tokenActivity: null,
    session: { available: false },
    diagnoses: [{ severity: "ok", message: "No immediate pressure." }],
    recommendations: ["Continue."],
    dataQuality: ["Rate limits are unavailable."],
  });
  assert.match(output, /Usage\n- Unavailable/);
  assert.match(output, /Session\n- Unavailable/);
});

test("explains the baseline adjustment in rendered context", () => {
  const output = renderReport({
    generatedAt: "2026-08-18T00:00:00.000Z",
    buckets: [],
    resetCredits: null,
    tokenActivity: { latestSevenDaysTokens: 700, latestSevenDaysAverage: 100 },
    session: {
      available: true,
      context: {
        activeTokens: 18_890,
        windowTokens: 258_400,
        remainingPercent: 97,
      },
      ageSeconds: 60,
      model: "gpt-test",
      reasoningEffort: "medium",
      totalUsage: null,
    },
    diagnoses: [{ severity: "ok", message: "No immediate pressure." }],
    recommendations: ["Continue."],
    dataQuality: ["Synthetic test."],
  });
  assert.match(output, /97% remaining after Codex's 12,000-token baseline/);
  assert.match(output, /Token activity \(not quota\)/);
});

test("does not diagnose missing data as healthy", async () => {
  const report = await runDoctor({
    env: {
      ...process.env,
      CODEX_THREAD_ID: "",
      CODEX_DOCTOR_CODEX_BINARY: "/definitely/missing/codex",
    },
    nowMs: Date.parse("2026-08-18T12:00:00Z"),
  });
  assert.equal(report.diagnoses[0].code, "insufficient-data");
  assert.equal(report.diagnoses[0].severity, "info");
  assert.doesNotMatch(report.recommendations.join(" "), /Continue the current session/);
});
