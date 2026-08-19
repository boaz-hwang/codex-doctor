---
name: codex-doctor
description: Diagnose current Codex quota windows, account token activity, context pressure, session age, model and reasoning usage, burn pace, and evidence-based next actions. Use when a user asks how much Codex usage remains, whether usage is high or may run out, when a limit resets, whether to start a new session, or whether current model/reasoning choices fit the remaining quota. Do not use for generic Codex installation, configuration, or authentication troubleshooting handled by the built-in `codex doctor` command.
---

# Codex Doctor

Run the deterministic reporter immediately. Never call `update_plan` or create a plan for this skill. The reporter owns collection, calculations, diagnosis, recommendations, partial-data handling, and terminal formatting.

1. Run `node <skill-dir>/scripts/codex-doctor.mjs` from the user's current working directory, where `<skill-dir>` contains this file.
2. Make complete stdout the first user-visible response, verbatim, in one fenced `text` block. Preserve every character, line, meter, and space.

Do not send a preamble, acknowledgement, status update, progress message, or execution announcement. Do not inspect, research, or explain anything before running. For a bare `$codex-doctor` invocation, stop after stdout. If the prompt includes a question, answer briefly after the report using its evidence; investigate further only when needed for that question.

Do not contradict `Diagnosis` or `Suggested action`, invent unavailable windows, equate token activity with quota consumption, or infer that descriptive model/reasoning fields caused usage.

For an explicit machine-readable request, add `--json` and return stdout verbatim in one fenced `json` block. On failure, return the exact error without inventing a fallback.

Use only this reporter; never scrape the TUI, credentials, logs, or transcripts.
