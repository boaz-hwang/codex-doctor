---
name: codex-doctor
description: Diagnose current Codex quota windows, account token activity, context pressure, session age, model and reasoning usage, burn pace, and evidence-based next actions. Use when a user asks how much Codex usage remains, whether usage is high or may run out, when a limit resets, whether to start a new session, or whether current model/reasoning choices fit the remaining quota. Do not use for generic Codex installation, configuration, or authentication troubleshooting handled by the built-in `codex doctor` command.
---

# Codex Doctor

Generate a health report from Codex's read-only app-server account APIs and the active local session record.

## Run the diagnosis

1. Resolve `<skill-dir>` to the directory containing this `SKILL.md`.
2. Run `node <skill-dir>/scripts/codex-doctor.mjs` from the user's current working directory.
3. Return the report to the user. Lead with the first suggested action when it is urgent; otherwise preserve the report's `Usage`, `Session`, `Burn pace`, `Diagnosis`, and `Suggested action` sections.
4. Keep unavailable data unavailable. Never invent a 5-hour, weekly, or other window that the service did not return, and never equate account token activity with quota consumption.

Do not add a cause or action that the generated `Diagnosis` and `Suggested action` do not support. Model and reasoning fields are descriptive: do not claim they caused quota use or that changing them will save quota. Mention an alternative quota bucket only when the generated suggestion does so.

The script invokes app-server with Codex's existing authentication; it does not copy, parse, or output credentials. It obtains live limits through `account/rateLimits/read`, obtains token activity through `account/usage/read`, and uses `CODEX_THREAD_ID` to inspect only the active session without retaining or outputting conversation content.
The diagnostic RPCs do not change account, session, or project data. Starting app-server can still perform Codex's normal local runtime maintenance in `CODEX_HOME`.

## Handle partial data

- If live account data is unavailable, use the script's explicitly labeled cached-session fallback and report its age.
- If no active session is available, still report live account limits and explain that session health requires running inside an active Codex turn.
- If `node` or `codex` is missing, report that exact dependency failure. Do not fall back to scraping the TUI, `auth.json`, or transcript content.
- Treat burn projections as window-average estimates, not instantaneous forecasts.

For machine-readable output or debugging, run `node <skill-dir>/scripts/codex-doctor.mjs --json`. Do not expose raw JSON unless the user requests it.
