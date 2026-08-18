# Contributing

Focused issues and pull requests are welcome.

Before submitting a change:

1. Keep the collector dependency-free and compatible with Node.js 18 or newer.
2. Preserve dynamic quota buckets and windows; do not hard-code `primary` as 5 hours or `secondary` as weekly.
3. Keep token activity distinct from quota consumption.
4. Do not add TUI, credential, history, or conversation-text scraping.
5. Keep unavailable data unavailable and recommendations within the evidence produced by the diagnosis.
6. Run the test suite and the Codex skill validator when available.

```bash
node --test skills/codex-doctor/scripts/codex-doctor.test.mjs
python3 "$CODEX_HOME/skills/.system/skill-creator/scripts/quick_validate.py" skills/codex-doctor
```

By contributing, you agree that your contribution is licensed under the project's MIT License.
