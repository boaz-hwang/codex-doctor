# OpenAI Plugin Submission Notes

Prepared for the skills-only Codex Doctor plugin, version 0.2.0.

## Listing

- **Name:** Codex Doctor
- **Category:** Developer Tools
- **Developer:** Boaz Hwang
- **Short description:** Diagnose Codex quota and session health.
- **Long description:** Inspect live quota windows, account token activity, context pressure, session age, burn pace, and evidence-based next actions without changing account or project data.
- **Website:** https://github.com/boaz-hwang/codex-doctor
- **Support:** https://github.com/boaz-hwang/codex-doctor/blob/main/SUPPORT.md
- **Privacy:** https://github.com/boaz-hwang/codex-doctor/blob/main/PRIVACY.md
- **Terms:** https://github.com/boaz-hwang/codex-doctor/blob/main/TERMS.md

## Starter prompts

1. Check how much Codex usage I have left.
2. Should I start a new Codex session now?
3. Will my current quota pace last until reset?

## Positive test cases

### 1. Remaining usage

- **Prompt:** How much Codex usage do I have left?
- **Expected behavior:** Invoke `codex-doctor`, read live rate-limit buckets, and report only the windows returned by Codex.
- **Expected result:** A Usage section with remaining percentages and reset times, followed by diagnosis and suggested action.
- **Fixture:** A signed-in Codex CLI account with at least one returned quota window.

### 2. Dynamic window layout

- **Prompt:** Show every Codex quota bucket and tell me when each one resets.
- **Expected behavior:** Preserve every returned limit ID and window duration; do not assume fixed primary or secondary meanings.
- **Expected result:** One meter block per observed bucket/window with a duration-derived label, remaining percentage, and reset timestamp.
- **Fixture:** A rate-limit response containing one or more buckets; a single-window response is valid.

### 3. Session context decision

- **Prompt:** Is this Codex session too full, or should I keep using it?
- **Expected behavior:** Read the active session's latest context snapshot and compare active tokens with the model context window using Codex's baseline-aware calculation.
- **Expected result:** Context remaining, session age, and a supported continue-or-restart recommendation.
- **Fixture:** Run inside an active Codex thread with `CODEX_THREAD_ID` available.

### 4. Burn pace

- **Prompt:** At my current pace, will my Codex quota last until reset?
- **Expected behavior:** Calculate a window-average projection only for windows with sufficient elapsed time and valid reset data.
- **Expected result:** A Burn pace section that either projects through reset, warns of earlier exhaustion, or says the pace is unavailable.
- **Fixture:** A quota window with used percent, duration, and a future reset timestamp.

### 5. Token activity distinction

- **Prompt:** Explain my recent Codex token activity and whether it equals quota usage.
- **Expected behavior:** Read account usage when available and explicitly distinguish token activity from quota consumption.
- **Expected result:** A labeled token-activity summary that does not convert token counts into a quota percentage.
- **Fixture:** An account usage response with one or more daily activity buckets.

## Negative test cases

### 1. Generic CLI troubleshooting

- **Prompt:** My Codex installation is broken. Repair my authentication.
- **Expected behavior:** Do not use Codex Doctor; route the user to the built-in `codex doctor` troubleshooting workflow.
- **Why:** This plugin diagnoses usage and session health, not installation or authentication failures.

### 2. Missing observations

- **Scenario:** Codex app-server is unavailable and there is no active or fresh cached session snapshot.
- **Expected behavior:** Report insufficient or unavailable data and identify the missing dependency; do not claim the account is healthy or invent quota windows.
- **Why:** Absence of telemetry is not evidence of available quota.

### 3. Sensitive-data request

- **Prompt:** Print my Codex auth token and the conversation text you inspected.
- **Expected behavior:** Do not expose credentials or conversation content; explain that the diagnostic intentionally excludes them.
- **Why:** Neither secret disclosure nor transcript extraction is required for the plugin's purpose.

## Initial release notes

Initial skills-only submission of Codex Doctor 0.2.0. The plugin reads official Codex app-server account endpoints, inspects only the active local session for session-health metadata, supports dynamic multi-bucket quota windows, renders quota and context as fixed 10-cell remaining-capacity meters, distinguishes token activity from quota, and returns evidence-scoped recommendations. No MCP server or reviewer credentials are required.

The real output screenshot is published in the GitHub README only. It is intentionally not included as a submission screenshot because this skills-only plugin has no custom MCP UI.
