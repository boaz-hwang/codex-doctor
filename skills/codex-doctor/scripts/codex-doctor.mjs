#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createReadStream, realpathSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

export const BASELINE_TOKENS = 12_000;

const RPC_TIMEOUT_MS = 8_000;
const INITIALIZE_TIMEOUT_MS = 20_000;
const ACCOUNT_USAGE_TIMEOUT_MS = 5_000;
const CACHE_MAX_AGE_SECONDS = 15 * 60;
const CONTEXT_WARNING_USED_PERCENT = 80;
const CONTEXT_CRITICAL_USED_PERCENT = 90;
const QUOTA_WARNING_REMAINING_PERCENT = 25;
const QUOTA_CRITICAL_REMAINING_PERCENT = 10;
const QUOTA_PRESSURE_CODES = new Set([
  "quota-critical",
  "quota-low",
  "quota-pace",
  "rate-limit-reached",
  "spend-control-reached",
]);
const RATE_LIMIT_REACHED_TYPES = new Set([
  "rate_limit_reached",
  "workspace_owner_credits_depleted",
  "workspace_member_credits_depleted",
  "workspace_owner_usage_limit_reached",
  "workspace_member_usage_limit_reached",
]);

const numberFormatter = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 0,
});

function finiteNumber(value) {
  if (value === null || value === undefined || value === "" || typeof value === "boolean") {
    return null;
  }
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function firstDefined(object, ...keys) {
  for (const key of keys) {
    if (object?.[key] !== undefined && object[key] !== null) return object[key];
  }
  return null;
}

function safeMessage(error) {
  if (error instanceof Error && error.message) return error.message;
  return String(error || "unknown error");
}

function resolveCodexHome(env) {
  const platformHome = env.HOME || env.USERPROFILE || homedir();
  return resolve(env.CODEX_HOME || join(platformHome, ".codex"));
}

export function calculateContextRemainingPercent(activeTokens, contextWindow) {
  const active = finiteNumber(activeTokens);
  const window = finiteNumber(contextWindow);
  if (active === null || window === null) return null;
  if (window <= BASELINE_TOKENS) return 0;

  const effectiveWindow = window - BASELINE_TOKENS;
  const used = Math.max(active - BASELINE_TOKENS, 0);
  const remaining = Math.max(effectiveWindow - used, 0);
  return Math.round(clamp((remaining / effectiveWindow) * 100, 0, 100));
}

function isApproximateWindow(minutes, expected) {
  return minutes >= expected * 0.95 && minutes <= expected * 1.05;
}

export function labelWindow(durationMinutes, fallback = "usage") {
  const minutes = finiteNumber(durationMinutes);
  if (minutes === null || minutes < 0) return fallback;

  const named = [
    [5 * 60, "5h"],
    [24 * 60, "daily"],
    [7 * 24 * 60, "weekly"],
    [30 * 24 * 60, "monthly"],
    [365 * 24 * 60, "annual"],
  ].find(([expected]) => isApproximateWindow(minutes, expected));
  if (named) return named[1];
  if (minutes >= 60 && minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

export function projectWindow(window, nowMs = Date.now()) {
  const usedPercent = finiteNumber(window?.usedPercent);
  const durationMinutes = finiteNumber(window?.durationMinutes);
  const resetsAtSeconds = finiteNumber(window?.resetsAt);
  if (
    usedPercent === null ||
    durationMinutes === null ||
    resetsAtSeconds === null ||
    usedPercent <= 0 ||
    durationMinutes <= 0
  ) {
    return null;
  }

  const resetMs = resetsAtSeconds * 1_000;
  const startMs = resetMs - durationMinutes * 60_000;
  const elapsedMs = nowMs - startMs;
  if (elapsedMs < 60_000 || nowMs >= resetMs) return null;

  const ratePercentPerHour = usedPercent / (elapsedMs / 3_600_000);
  if (!Number.isFinite(ratePercentPerHour) || ratePercentPerHour <= 0) return null;

  const remainingPercent = clamp(100 - usedPercent, 0, 100);
  const exhaustsAtMs = nowMs + (remainingPercent / ratePercentPerHour) * 3_600_000;
  return {
    ratePercentPerHour,
    exhaustsAt: new Date(exhaustsAtMs).toISOString(),
    beforeReset: exhaustsAtMs < resetMs,
    leadSeconds: Math.max(0, Math.round((resetMs - exhaustsAtMs) / 1_000)),
  };
}

function normalizeTokenUsage(raw) {
  if (!raw || typeof raw !== "object") return null;
  const totalTokens = finiteNumber(firstDefined(raw, "total_tokens", "totalTokens"));
  if (totalTokens === null) return null;
  const usage = {
    inputTokens: finiteNumber(firstDefined(raw, "input_tokens", "inputTokens")) ?? 0,
    cachedInputTokens:
      finiteNumber(firstDefined(raw, "cached_input_tokens", "cachedInputTokens")) ?? 0,
    outputTokens: finiteNumber(firstDefined(raw, "output_tokens", "outputTokens")) ?? 0,
    reasoningOutputTokens:
      finiteNumber(firstDefined(raw, "reasoning_output_tokens", "reasoningOutputTokens")) ?? 0,
    totalTokens,
  };
  return usage;
}

function normalizeWindow(raw, slot, bucketId, bucketName, nowMs) {
  if (!raw || typeof raw !== "object") return null;
  const usedPercent = finiteNumber(firstDefined(raw, "usedPercent", "used_percent"));
  if (usedPercent === null) return null;

  const durationMinutes = finiteNumber(
    firstDefined(raw, "windowDurationMins", "window_minutes", "windowMinutes"),
  );
  const resetsAt = finiteNumber(firstDefined(raw, "resetsAt", "resets_at"));
  const window = {
    bucketId,
    bucketName,
    slot,
    label: labelWindow(durationMinutes, slot === "secondary" ? "secondary usage" : "usage"),
    usedPercent: clamp(usedPercent, 0, 100),
    remainingPercent: clamp(100 - usedPercent, 0, 100),
    durationMinutes,
    resetsAt,
  };
  window.projection = projectWindow(window, nowMs);
  return window;
}

function normalizeSnapshot(snapshot, bucketId, nowMs) {
  if (!snapshot || typeof snapshot !== "object") return null;
  const normalizedId = firstDefined(snapshot, "limitId", "limit_id") || bucketId || "codex";
  const bucketName =
    firstDefined(snapshot, "limitName", "limit_name") ||
    (String(normalizedId).toLowerCase() === "codex" ? "Codex" : String(normalizedId));
  const windows = [
    normalizeWindow(snapshot.primary, "primary", normalizedId, bucketName, nowMs),
    normalizeWindow(snapshot.secondary, "secondary", normalizedId, bucketName, nowMs),
  ]
    .filter(Boolean)
    .sort((left, right) => (left.durationMinutes ?? Infinity) - (right.durationMinutes ?? Infinity));
  const reachedType = firstDefined(
    snapshot,
    "rateLimitReachedType",
    "rate_limit_reached_type",
  );

  return {
    id: normalizedId,
    name: bucketName,
    planType: firstDefined(snapshot, "planType", "plan_type"),
    rateLimitReachedType:
      typeof reachedType === "string" && RATE_LIMIT_REACHED_TYPES.has(reachedType)
        ? reachedType
        : null,
    spendControlReached: firstDefined(
      snapshot,
      "spendControlReached",
      "spend_control_reached",
    ),
    windows,
  };
}

export function normalizeRateLimitResponse(result, nowMs = Date.now()) {
  if (!result || typeof result !== "object") return [];
  const byId = firstDefined(result, "rateLimitsByLimitId", "rate_limits_by_limit_id");
  const mappedEntries =
    byId && typeof byId === "object" && !Array.isArray(byId)
      ? Object.entries(byId)
      : [];
  const entries = mappedEntries.length
    ? mappedEntries
    : [["codex", firstDefined(result, "rateLimits", "rate_limits")]];

  return entries
    .map(([id, snapshot]) => normalizeSnapshot(snapshot, id, nowMs))
    .filter(
      (bucket) =>
        bucket &&
        (bucket.windows.length ||
          bucket.rateLimitReachedType !== null ||
          bucket.spendControlReached === true),
    )
    .sort((left, right) => {
      if (String(left.id).toLowerCase() === "codex") return -1;
      if (String(right.id).toLowerCase() === "codex") return 1;
      return String(left.name).localeCompare(String(right.name));
    });
}

function normalizeAccountUsage(result, nowMs) {
  if (!result || typeof result !== "object") return null;
  const summary = result.summary || {};
  const today = new Date(nowMs).toISOString().slice(0, 10);
  const buckets = (result.dailyUsageBuckets || result.daily_usage_buckets || [])
    .map((bucket) => ({
      startDate: firstDefined(bucket, "startDate", "start_date"),
      tokens: finiteNumber(bucket.tokens),
    }))
    .filter((bucket) => typeof bucket.startDate === "string" && bucket.tokens !== null)
    .sort((left, right) => left.startDate.localeCompare(right.startDate));
  const throughToday = buckets.filter((bucket) => bucket.startDate <= today);
  const latestSeven = throughToday.slice(-7);

  return {
    lifetimeTokens: finiteNumber(firstDefined(summary, "lifetimeTokens", "lifetime_tokens")),
    currentStreakDays: finiteNumber(
      firstDefined(summary, "currentStreakDays", "current_streak_days"),
    ),
    latestSevenDaysTokens: latestSeven.reduce((total, bucket) => total + bucket.tokens, 0),
    latestSevenDaysAverage:
      latestSeven.length > 0
        ? latestSeven.reduce((total, bucket) => total + bucket.tokens, 0) / latestSeven.length
        : null,
    reportedDayCount: buckets.length,
  };
}

class AppServerClient {
  constructor(command, env) {
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = "";
    this.closed = false;
    this.child = spawn(command, ["app-server", "--listen", "stdio://"], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => this.consume(chunk));
    this.child.on("error", (error) => this.failAll(error));
    this.child.stdin.on("error", (error) => this.failAll(error));
    this.child.on("exit", (code, signal) => {
      if (!this.closed) {
        this.failAll(new Error(`codex app-server exited (${code ?? signal ?? "unknown"})`));
      }
    });
    // Drain diagnostics without echoing them; they can contain environment-specific details.
    this.child.stderr.resume();
  }

  consume(chunk) {
    this.buffer += chunk;
    while (this.buffer.includes("\n")) {
      const newline = this.buffer.indexOf("\n");
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      const pending = this.pending.get(message.id);
      if (!pending) continue;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(message.error.message || "app-server request failed"));
      } else {
        pending.resolve(message.result);
      }
    }
  }

  request(method, params, timeoutMs = RPC_TIMEOUT_MS) {
    if (this.closed) return Promise.reject(new Error("app-server client is closed"));
    const id = this.nextId++;
    const payload = { method, id };
    if (params !== undefined) payload.params = params;
    return new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectPromise(new Error(`${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolvePromise, reject: rejectPromise, timer });
      this.child.stdin.write(`${JSON.stringify(payload)}\n`);
    });
  }

  notify(method, params = {}) {
    if (!this.closed) {
      this.child.stdin.write(`${JSON.stringify({ method, params })}\n`);
    }
  }

  failAll(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.failAll(new Error("app-server client closed"));
    this.child.stdin.end();
    if (this.child.exitCode === null) {
      const exited = new Promise((resolvePromise) => this.child.once("exit", resolvePromise));
      this.child.kill("SIGTERM");
      const exitedAfterTerm = await Promise.race([
        exited.then(() => true),
        new Promise((resolvePromise) => setTimeout(() => resolvePromise(false), 500)),
      ]);
      if (!exitedAfterTerm && this.child.exitCode === null) {
        this.child.kill("SIGKILL");
        await Promise.race([
          exited,
          new Promise((resolvePromise) => setTimeout(resolvePromise, 500)),
        ]);
      }
    }
  }
}

export async function fetchAppServerData({ env = process.env } = {}) {
  const command = env.CODEX_DOCTOR_CODEX_BINARY || "codex";
  let client;
  try {
    client = new AppServerClient(command, env);
    await client.request(
      "initialize",
      {
        clientInfo: {
          name: "codex_doctor",
          title: "Codex Doctor",
          version: "0.2.1",
        },
        capabilities: { experimentalApi: false },
      },
      INITIALIZE_TIMEOUT_MS,
    );
    client.notify("initialized");

    const [limits, usage] = await Promise.allSettled([
      client.request("account/rateLimits/read"),
      client.request("account/usage/read", undefined, ACCOUNT_USAGE_TIMEOUT_MS),
    ]);
    return {
      limits: limits.status === "fulfilled" ? limits.value : null,
      limitsError: limits.status === "rejected" ? safeMessage(limits.reason) : null,
      usage: usage.status === "fulfilled" ? usage.value : null,
      usageError: usage.status === "rejected" ? safeMessage(usage.reason) : null,
    };
  } catch (error) {
    return {
      limits: null,
      limitsError: safeMessage(error),
      usage: null,
      usageError: safeMessage(error),
    };
  } finally {
    await client?.close();
  }
}

async function findSessionFile(directory, threadId) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return null;
  }
  entries.sort((left, right) => right.name.localeCompare(left.name));

  const expectedSuffix = `-${threadId}.jsonl`;
  const direct = entries.find(
    (entry) => entry.isFile() && (entry.name.endsWith(expectedSuffix) || entry.name === `${threadId}.jsonl`),
  );
  if (direct) return join(directory, direct.name);

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const match = await findSessionFile(join(directory, entry.name), threadId);
    if (match) return match;
  }
  return null;
}

export async function parseSessionFile(path, nowMs = Date.now(), expectedThreadId = null) {
  const input = createReadStream(path, { encoding: "utf8" });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  let metadata = null;
  let fallbackMetadata = null;
  let turnContext = null;
  let tokenInfoEvent = null;
  let rateLimitEvent = null;
  let settingsEvent = null;
  let malformedLines = 0;

  for await (const line of lines) {
    if (!line.trim()) continue;
    let item;
    try {
      item = JSON.parse(line);
    } catch {
      malformedLines += 1;
      continue;
    }
    if (item.type === "session_meta") {
      fallbackMetadata ||= item;
      if (!expectedThreadId || item.payload?.id === expectedThreadId) metadata = item;
    }
    if (item.type === "turn_context") turnContext = item;
    if (item.type === "event_msg" && item.payload?.type === "thread_settings_applied") {
      settingsEvent = item;
    }
    if (item.type === "event_msg" && item.payload?.type === "token_count") {
      if (item.payload.info) tokenInfoEvent = item;
      if (item.payload.rate_limits) rateLimitEvent = item;
    }
  }

  if (!expectedThreadId) metadata ||= fallbackMetadata;

  const info = tokenInfoEvent?.payload?.info || {};
  const lastUsage = normalizeTokenUsage(
    firstDefined(info, "last_token_usage", "lastTokenUsage"),
  );
  const totalUsage = normalizeTokenUsage(
    firstDefined(info, "total_token_usage", "totalTokenUsage"),
  );
  const contextWindow = finiteNumber(
    firstDefined(info, "model_context_window", "modelContextWindow"),
  );
  const remainingPercent = calculateContextRemainingPercent(
    lastUsage?.totalTokens,
    contextWindow,
  );
  const createdAt = metadata?.payload?.timestamp || metadata?.timestamp || null;
  const createdAtMs = createdAt ? Date.parse(createdAt) : Number.NaN;
  const appliedSettings = settingsEvent?.payload?.thread_settings || {};
  const settingsTimestamp = Date.parse(settingsEvent?.timestamp || "");
  const turnTimestamp = Date.parse(turnContext?.timestamp || "");
  const preferSettings = Boolean(
    settingsEvent &&
      (!turnContext || (!Number.isNaN(settingsTimestamp) && settingsTimestamp > turnTimestamp)),
  );
  const currentModel = preferSettings
    ? appliedSettings.model || turnContext?.payload?.model
    : turnContext?.payload?.model || appliedSettings.model;
  const currentEffort = preferSettings
    ? appliedSettings.reasoning_effort || appliedSettings.effort || turnContext?.payload?.effort
    : turnContext?.payload?.effort ||
      turnContext?.payload?.collaboration_mode?.settings?.reasoning_effort ||
      appliedSettings.reasoning_effort ||
      appliedSettings.effort;
  const appliedMode =
    appliedSettings.collaboration_mode?.mode || appliedSettings.collaboration_mode || null;
  const currentMode = preferSettings
    ? appliedMode || turnContext?.payload?.collaboration_mode?.mode
    : turnContext?.payload?.collaboration_mode?.mode || appliedMode;

  return {
    available: Boolean(metadata || turnContext || tokenInfoEvent || rateLimitEvent || settingsEvent),
    source: "local-rollout",
    createdAt,
    ageSeconds: Number.isFinite(createdAtMs)
      ? Math.max(0, Math.round((nowMs - createdAtMs) / 1_000))
      : null,
    observedAt: tokenInfoEvent?.timestamp || turnContext?.timestamp || metadata?.timestamp || null,
    rateLimitsObservedAt: rateLimitEvent?.timestamp || null,
    model: currentModel || null,
    reasoningEffort: currentEffort || null,
    collaborationMode: currentMode || null,
    context:
      lastUsage && contextWindow !== null
        ? {
            activeTokens: lastUsage.totalTokens,
            windowTokens: contextWindow,
            remainingPercent,
            usedPercent: remainingPercent === null ? null : 100 - remainingPercent,
          }
        : null,
    totalUsage,
    cachedRateLimits: rateLimitEvent?.payload?.rate_limits || null,
    malformedLines,
  };
}

export async function readActiveSession({ env = process.env, nowMs = Date.now() } = {}) {
  const threadId = env.CODEX_THREAD_ID;
  if (!threadId) {
    return { available: false, error: "CODEX_THREAD_ID is not set" };
  }
  if (!/^[A-Za-z0-9_-]+$/.test(threadId)) {
    return { available: false, error: "CODEX_THREAD_ID has an unsupported format" };
  }

  const codexHome = resolveCodexHome(env);
  const path = await findSessionFile(join(codexHome, "sessions"), threadId);
  if (!path) {
    return { available: false, error: "active Codex session file was not found" };
  }
  try {
    return await parseSessionFile(path, nowMs, threadId);
  } catch (error) {
    return { available: false, error: `active session could not be read: ${safeMessage(error)}` };
  }
}

export function cachedBucketResult(session, nowMs) {
  if (!session?.cachedRateLimits) return { buckets: [], ageSeconds: null, reason: "missing" };
  const ageSeconds = secondsSince(session.rateLimitsObservedAt, nowMs);
  if (ageSeconds === null) return { buckets: [], ageSeconds, reason: "undated" };
  if (ageSeconds > CACHE_MAX_AGE_SECONDS) {
    return { buckets: [], ageSeconds, reason: "stale" };
  }

  const snapshot = session.cachedRateLimits;
  const id = firstDefined(snapshot, "limit_id", "limitId") || "codex";
  const bucket = normalizeSnapshot(snapshot, id, nowMs);
  if (!bucket) return { buckets: [], ageSeconds, reason: "missing" };
  const explicitWindowCount = bucket.windows.length;
  bucket.windows = bucket.windows.filter(
    (window) => window.resetsAt === null || window.resetsAt > nowMs / 1_000,
  );
  const aWindowReset = bucket.windows.length < explicitWindowCount;
  if (aWindowReset && bucket.rateLimitReachedType === "rate_limit_reached") {
    bucket.rateLimitReachedType = null;
  }
  const hasStatus = bucket.rateLimitReachedType !== null || bucket.spendControlReached === true;
  if (!bucket.windows.length && !hasStatus) {
    return { buckets: [], ageSeconds, reason: "expired" };
  }
  return { buckets: [bucket], ageSeconds, reason: null };
}

function secondsSince(isoTimestamp, nowMs) {
  const timestamp = isoTimestamp ? Date.parse(isoTimestamp) : Number.NaN;
  return Number.isFinite(timestamp) ? Math.max(0, Math.round((nowMs - timestamp) / 1_000)) : null;
}

function hasQuotaObservation(buckets) {
  return buckets.some(
    (bucket) =>
      bucket.windows.length ||
      bucket.rateLimitReachedType !== null ||
      bucket.spendControlReached === true,
  );
}

export function buildDiagnosis(buckets, session, rateLimitSource, rateLimitAge) {
  const diagnoses = [];
  const cacheNote =
    rateLimitSource === "session-cache"
      ? ` in a cached snapshot (${formatDuration(rateLimitAge)} old)`
      : "";
  for (const bucket of buckets) {
    if (bucket.spendControlReached === true) {
      diagnoses.push({
        severity: "critical",
        code: "spend-control-reached",
        bucketId: bucket.id,
        message: `${bucket.name} reports that its spend control was reached${cacheNote}.`,
      });
    } else if (bucket.rateLimitReachedType !== null) {
      diagnoses.push({
        severity: "critical",
        code: "rate-limit-reached",
        bucketId: bucket.id,
        message: `${bucket.name} reports a reached limit (${bucket.rateLimitReachedType})${cacheNote}.`,
      });
    }
    for (const window of bucket.windows) {
      const name = `${bucket.name} ${window.label}`;
      if (window.remainingPercent <= QUOTA_CRITICAL_REMAINING_PERCENT) {
        diagnoses.push({
          severity: "critical",
          code: "quota-critical",
          bucketId: bucket.id,
          windowSlot: window.slot,
          windowDurationMinutes: window.durationMinutes,
          message: `${name} has only ${Math.round(window.remainingPercent)}% remaining${cacheNote}.`,
        });
      } else if (window.remainingPercent <= QUOTA_WARNING_REMAINING_PERCENT) {
        diagnoses.push({
          severity: "warning",
          code: "quota-low",
          bucketId: bucket.id,
          windowSlot: window.slot,
          windowDurationMinutes: window.durationMinutes,
          message: `${name} has ${Math.round(window.remainingPercent)}% remaining${cacheNote}.`,
        });
      }
      if (
        window.projection?.beforeReset &&
        window.projection.leadSeconds >= 30 * 60 &&
        window.usedPercent >= 20
      ) {
        diagnoses.push({
          severity: window.remainingPercent <= 50 ? "warning" : "info",
          code: "quota-pace",
          bucketId: bucket.id,
          windowSlot: window.slot,
          windowDurationMinutes: window.durationMinutes,
          message: `${name} may exhaust before reset at the current window-average pace${cacheNote}.`,
        });
      }
    }
  }

  const contextUsed = session?.context?.usedPercent;
  if (contextUsed >= CONTEXT_CRITICAL_USED_PERCENT) {
    diagnoses.push({
      severity: "critical",
      code: "context-critical",
      message: `The active context is ${contextUsed}% used.`,
    });
  } else if (contextUsed >= CONTEXT_WARNING_USED_PERCENT) {
    diagnoses.push({
      severity: "warning",
      code: "context-high",
      message: `The active context is ${contextUsed}% used.`,
    });
  }

  const quotaObserved = hasQuotaObservation(buckets);
  const contextObserved = finiteNumber(contextUsed) !== null;
  if (diagnoses.length === 0 && !quotaObserved && !contextObserved) {
    diagnoses.push({
      severity: "info",
      code: "insufficient-data",
      message: "Quota and context data are unavailable, so session health cannot be determined.",
    });
  } else if (diagnoses.length === 0) {
    const scope = quotaObserved && contextObserved
      ? "the observed quota windows or context"
      : quotaObserved
        ? "the observed quota windows; context is unavailable"
        : "the observed context; quota is unavailable";
    diagnoses.push({
      severity: "ok",
      code: "healthy",
      message: `No immediate pressure was detected in ${scope}.`,
    });
  }
  return diagnoses;
}

function comparableName(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function currentQuotaBucket(buckets, model) {
  const modelName = comparableName(model);
  const specific = modelName
    ? buckets.find((bucket) => {
        if (String(bucket.id).toLowerCase() === "codex") return false;
        const names = [comparableName(bucket.id), comparableName(bucket.name)].filter(
          (name) => name.length >= 4,
        );
        return names.some((name) => modelName.includes(name) || name.includes(modelName));
      })
    : null;
  return specific || buckets.find((bucket) => String(bucket.id).toLowerCase() === "codex") || null;
}

function sameQuotaWindow(left, right) {
  const leftMinutes = finiteNumber(left?.durationMinutes);
  const rightMinutes = finiteNumber(right?.durationMinutes);
  if (leftMinutes !== null && rightMinutes !== null) {
    const tolerance = Math.max(2, Math.max(leftMinutes, rightMinutes) * 0.01);
    return Math.abs(leftMinutes - rightMinutes) <= tolerance;
  }
  return left?.slot === right?.slot && left?.label === right?.label;
}

export function buildRecommendations(buckets, session, diagnoses) {
  const recommendations = [];
  const quotaObserved = hasQuotaObservation(buckets);
  const contextUsed = session?.context?.usedPercent;
  const contextObserved = finiteNumber(contextUsed) !== null;
  if (!quotaObserved && !contextObserved) {
    return [
      "Re-run from an authenticated Codex session after at least one completed turn; do not change session, model, or reasoning based on this incomplete report.",
    ];
  }
  const pressureDiagnoses = diagnoses.filter((diagnosis) =>
    QUOTA_PRESSURE_CODES.has(diagnosis.code),
  );
  const pressuredBucketIds = new Set(
    pressureDiagnoses
      .map((diagnosis) => diagnosis.bucketId)
      .filter((bucketId) => bucketId !== null && bucketId !== undefined)
      .map(String),
  );
  const reachedDiagnosis = pressureDiagnoses.find((diagnosis) =>
    ["rate-limit-reached", "spend-control-reached"].includes(diagnosis.code),
  );
  const reachedBucket = reachedDiagnosis
    ? buckets.find((bucket) => String(bucket.id) === String(reachedDiagnosis.bucketId))
    : null;
  const reachedName = reachedBucket?.name || "the reported quota";
  if (reachedDiagnosis?.code === "spend-control-reached") {
    recommendations.push(
      `Check the workspace spend control for ${reachedName} or ask its owner to restore available spend before quota-sensitive work.`,
    );
  } else if (reachedDiagnosis?.code === "rate-limit-reached") {
    recommendations.push(
      `Pause quota-sensitive work on ${reachedName} and re-run after Codex reports that the reached limit has cleared.`,
    );
  } else if (pressureDiagnoses.length > 0) {
    const pressuredNames = buckets
      .filter((bucket) => pressuredBucketIds.has(String(bucket.id)))
      .map((bucket) => bucket.name);
    const target = pressuredNames.length === 1 ? `${pressuredNames[0]} quota` : "pressured quota";
    recommendations.push(
      `Reserve the remaining ${target} for essential work and re-run before long quota-sensitive tasks.`,
    );
  }
  if (contextUsed >= CONTEXT_WARNING_USED_PERCENT) {
    recommendations.push("Start a fresh session at the next safe checkpoint and carry over only the needed decisions.");
  }

  const currentBucket = currentQuotaBucket(buckets, session?.model);
  const currentBucketPressure = currentBucket
    ? pressuredBucketIds.has(String(currentBucket.id))
    : false;
  const pressuredWindows = currentBucket
    ? currentBucket.windows.filter((window) =>
        pressureDiagnoses.some(
          (diagnosis) =>
            String(diagnosis.bucketId) === String(currentBucket.id) &&
            diagnosis.windowSlot === window.slot,
        ),
      )
    : [];
  const alternative =
    !reachedDiagnosis && currentBucketPressure && pressuredWindows.length > 0
      ? buckets
          .filter(
            (bucket) =>
              bucket !== currentBucket && !pressuredBucketIds.has(String(bucket.id)),
          )
          .map((bucket) => {
            const matches = pressuredWindows.map((window) => {
              const candidate = bucket.windows.find((other) => sameQuotaWindow(window, other));
              return candidate && candidate.remainingPercent >= window.remainingPercent + 20
                ? { current: window, alternative: candidate }
                : null;
            });
            if (matches.some((match) => match === null)) return null;
            return {
              bucket,
              matches,
              improvement: Math.min(
                ...matches.map(
                  (match) =>
                    match.alternative.remainingPercent - match.current.remainingPercent,
                ),
              ),
            };
          })
          .filter(Boolean)
          .sort((left, right) => right.improvement - left.improvement)[0]
      : null;
  if (alternative) {
    const detail =
      alternative.matches.length === 1
        ? `its separate ${alternative.matches[0].alternative.label} window has ${Math.round(alternative.matches[0].alternative.remainingPercent)}% remaining`
        : `its matching quota windows each have at least ${Math.round(alternative.improvement)} percentage points more remaining`;
    recommendations.push(`If it fits the task, use ${alternative.bucket.name}; ${detail}.`);
  }

  if (recommendations.length === 0) {
    if (quotaObserved && contextObserved) {
      recommendations.push(
        "Continue the current session and re-run after a long turn or before quota-sensitive work.",
      );
    } else if (contextObserved) {
      recommendations.push(
        "No context-driven session change is indicated; quota-based model guidance is unavailable.",
      );
    } else {
      recommendations.push(
        "No quota-driven model change is indicated; re-run after a completed turn for session guidance.",
      );
    }
  }
  return recommendations;
}

export async function runDoctor({ env = process.env, nowMs = Date.now() } = {}) {
  const [live, initialSession] = await Promise.all([
    fetchAppServerData({ env }),
    readActiveSession({ env, nowMs }),
  ]);
  const session = initialSession;
  const liveBuckets = normalizeRateLimitResponse(live.limits, nowMs);
  const cached = cachedBucketResult(session, nowMs);
  const buckets = liveBuckets.length ? liveBuckets : cached.buckets;
  const rateLimitSource = liveBuckets.length ? "live-app-server" : buckets.length ? "session-cache" : null;
  const rateLimitAge = cached.ageSeconds;
  const diagnoses = buildDiagnosis(buckets, session, rateLimitSource, rateLimitAge);
  const recommendations = buildRecommendations(buckets, session, diagnoses);
  const observedAge = secondsSince(session?.observedAt, nowMs);
  const dataQuality = [];

  if (rateLimitSource === "live-app-server") {
    dataQuality.push("Rate limits were fetched live through Codex app-server.");
  } else if (rateLimitSource === "session-cache") {
    dataQuality.push(
      `Live rate limits were unavailable${live.limitsError ? ` (${live.limitsError})` : ""}; the session cache is ${formatDuration(rateLimitAge)} old.`,
    );
  } else {
    dataQuality.push(`Rate limits are unavailable${live.limitsError ? `: ${live.limitsError}` : "."}`);
    if (cached.reason === "stale") {
      dataQuality.push(
        `A cached rate-limit snapshot was ignored because it is ${formatDuration(cached.ageSeconds)} old (maximum ${formatDuration(CACHE_MAX_AGE_SECONDS)}).`,
      );
    } else if (cached.reason === "expired") {
      dataQuality.push("A cached rate-limit snapshot was ignored because its windows have reset.");
    }
  }
  if (session?.available) {
    dataQuality.push(
      `Session metrics came from the active rollout's latest completed snapshot and are ${formatDuration(observedAge)} old.`,
    );
    if (session.malformedLines > 0) {
      dataQuality.push(`${session.malformedLines} malformed session line(s) were ignored.`);
    }
  } else {
    dataQuality.push(`Session metrics are unavailable: ${session?.error || "unknown reason"}.`);
  }
  if (!live.usage && live.usageError) {
    dataQuality.push(`Account token activity is unavailable: ${live.usageError}.`);
  }

  const { cachedRateLimits: _cachedRateLimits, ...publicSession } = session;
  return {
    schemaVersion: 1,
    generatedAt: new Date(nowMs).toISOString(),
    rateLimitSource,
    buckets,
    resetCredits: finiteNumber(
      firstDefined(live.limits?.rateLimitResetCredits, "availableCount", "available_count"),
    ),
    tokenActivity: normalizeAccountUsage(live.usage, nowMs),
    session: publicSession,
    diagnoses,
    recommendations,
    dataQuality,
  };
}

function formatDuration(seconds) {
  const value = finiteNumber(seconds);
  if (value === null) return "an unknown duration";
  if (value < 60) return "<1m";
  const minutes = Math.round(value / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours < 24) return `${hours}h${remainingMinutes ? ` ${remainingMinutes}m` : ""}`;
  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  return `${days}d${remainingHours ? ` ${remainingHours}h` : ""}`;
}

function formatTimestamp(seconds) {
  const value = finiteNumber(seconds);
  if (value === null) return "unknown";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value * 1_000));
}

function progressBar(remainingPercent) {
  const segments = 10;
  const filled = Math.round((clamp(remainingPercent, 0, 100) / 100) * segments);
  return `${"█".repeat(filled)}${"░".repeat(segments - filled)}`;
}

function progressRow(remainingPercent) {
  const percent = Math.round(clamp(remainingPercent, 0, 100));
  return `  ${progressBar(percent)}  ${String(percent).padStart(3)}% remaining`;
}

function detailRow(label, value) {
  return `  ${label.padEnd(16)} ${value}`;
}

function section(lines, title) {
  lines.push("");
  lines.push(title.toUpperCase());
}

function formatRate(projection, durationMinutes) {
  if (!projection) return "Unavailable";
  if ((durationMinutes || 0) >= 24 * 60) {
    return `${(projection.ratePercentPerHour * 24).toFixed(1)}%/day`;
  }
  return `${projection.ratePercentPerHour.toFixed(1)}%/h`;
}

export function renderReport(report, nowMs = Date.parse(report.generatedAt)) {
  const lines = [
    "CODEX DOCTOR",
    "─".repeat(48),
    "",
    "USAGE · REMAINING QUOTA",
  ];
  if (report.buckets.length === 0) {
    lines.push("  Unavailable");
  } else {
    for (const bucket of report.buckets) {
      const windows = bucket.windows || [];
      if (bucket.spendControlReached === true) {
        lines.push(bucket.name, "  ! Spend control reached");
      } else if (bucket.rateLimitReachedType !== null) {
        lines.push(bucket.name, `  ! Limit reached (${bucket.rateLimitReachedType})`);
      }
      for (const window of windows) {
        const resetText =
          window.resetsAt === null
            ? "Unknown"
            : `${formatDuration(window.resetsAt - nowMs / 1_000)} · ${formatTimestamp(window.resetsAt)}`;
        lines.push(`${bucket.name} · ${window.label}`);
        lines.push(progressRow(window.remainingPercent));
        lines.push(detailRow("Reset", resetText));
      }
    }
  }
  const hasTokenActivity = finiteNumber(report.tokenActivity?.latestSevenDaysAverage) !== null;
  if (report.resetCredits !== null || hasTokenActivity) {
    section(lines, "Account");
  }
  if (report.resetCredits !== null) {
    lines.push(
      detailRow("Earned resets", `${numberFormatter.format(report.resetCredits)} available`),
    );
  }
  if (hasTokenActivity) {
    lines.push(
      detailRow(
        "Token activity",
        `${numberFormatter.format(report.tokenActivity.latestSevenDaysTokens)} over the latest 7 reported days · not quota`,
      ),
      detailRow(
        "7-day average",
        `${numberFormatter.format(report.tokenActivity.latestSevenDaysAverage)}/day`,
      ),
    );
  }

  section(lines, "Session");
  if (!report.session?.available) {
    lines.push("  Unavailable");
  } else {
    if (report.session.context) {
      lines.push("Context");
      lines.push(progressRow(report.session.context.remainingPercent));
      lines.push(
        detailRow(
          "Active",
          `${numberFormatter.format(report.session.context.activeTokens)} / ${numberFormatter.format(report.session.context.windowTokens)} tokens`,
        ),
        detailRow(
          "Baseline",
          `${numberFormatter.format(BASELINE_TOKENS)} tokens reserved by Codex`,
        ),
      );
    } else {
      lines.push(detailRow("Context", "Unavailable"));
    }
    lines.push(
      detailRow("Age", formatDuration(report.session.ageSeconds)),
      detailRow("Model", report.session.model || "unknown"),
      detailRow("Reasoning", report.session.reasoningEffort || "unknown"),
    );
    if (report.session.totalUsage) {
      lines.push(
        detailRow(
          "Session tokens",
          `${numberFormatter.format(report.session.totalUsage.totalTokens)} cumulative`,
        ),
        detailRow(
          "Cached input",
          numberFormatter.format(report.session.totalUsage.cachedInputTokens),
        ),
      );
    }
  }

  section(lines, "Burn pace · window average");
  const windows = report.buckets.flatMap((bucket) =>
    (bucket.windows || []).map((window) => ({ bucket, window })),
  );
  if (windows.length === 0) {
    lines.push("  Unavailable");
  } else {
    for (const { bucket, window } of windows) {
      let projection = "Unavailable";
      if (window.projection) {
        const exhaustsAtMs = Date.parse(window.projection.exhaustsAt);
        projection = window.projection.beforeReset
          ? `Exhaustion in ${formatDuration((exhaustsAtMs - nowMs) / 1_000)}`
          : "Projected to last through reset";
      }
      lines.push(
        `${bucket.name} · ${window.label}`,
        detailRow("Pace", formatRate(window.projection, window.durationMinutes)),
        detailRow("Projection", projection),
      );
    }
  }

  section(lines, "Diagnosis");
  const severityMark = { critical: "!", warning: "⚠", info: "i", ok: "✓" };
  for (const diagnosis of report.diagnoses) {
    lines.push(`${severityMark[diagnosis.severity] || "·"} ${diagnosis.message}`);
  }

  section(lines, "Suggested action");
  report.recommendations.forEach((recommendation) => {
    lines.push(`→ ${recommendation}`);
  });

  section(lines, "Data quality");
  for (const item of report.dataQuality) {
    lines.push(`· ${item}`);
  }
  return lines.join("\n");
}

function usage() {
  return [
    "Usage: node codex-doctor.mjs [--json]",
    "",
    "  --json  Print the machine-readable report.",
    "  --help  Show this help.",
  ].join("\n");
}

async function main(argv = process.argv.slice(2)) {
  const unknown = argv.filter((argument) => !["--json", "--help", "-h"].includes(argument));
  if (unknown.length) {
    throw new Error(`unknown option: ${unknown[0]}`);
  }
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(usage());
    return;
  }
  const report = await runDoctor();
  console.log(argv.includes("--json") ? JSON.stringify(report, null, 2) : renderReport(report));
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
  }
}

if (isMainModule()) {
  main().catch((error) => {
    console.error(`codex-doctor: ${safeMessage(error)}`);
    process.exitCode = 1;
  });
}
