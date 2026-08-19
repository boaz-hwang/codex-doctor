# Privacy Policy

Effective: August 18, 2026

Codex Doctor is a local, open-source diagnostic plugin. It has no developer-operated service, analytics, advertising, or telemetry, and it does not send diagnostic results to the developer.

## Data the plugin accesses

When invoked, Codex Doctor may:

- Ask the locally installed Codex app-server for account rate-limit and token-activity summaries using the user's existing Codex authentication.
- Ask app-server for metadata about the current Codex thread.
- Read the active thread's local session file to obtain recent token-count, model, reasoning, and timestamp metadata when needed.

The local session file can contain conversation records. Codex Doctor parses that file only to select the diagnostic event types it needs; it does not retain or output conversation content. It does not read, copy, or print `auth.json` or authentication tokens.

## Processing and retention

Diagnostic data is processed locally and held in memory for the duration of the command. Codex Doctor does not maintain its own database. It can use a recent diagnostic snapshot already present in the active Codex session as a clearly labeled fallback.

Starting app-server can perform Codex's normal local runtime maintenance inside `CODEX_HOME`. Communications between the Codex CLI and OpenAI use the user's existing Codex account and are governed by OpenAI's applicable policies.

## Sharing

Codex Doctor does not share data with the developer or third parties. Users control whether they copy, publish, or otherwise share its report.

## Contact

Questions or privacy reports can be filed through [GitHub Issues](https://github.com/boaz-hwang/codex-usage/issues) or sent to [hkc7180@gmail.com](mailto:hkc7180@gmail.com).
