# AGENTS.md

## Project

This repository investigates RunningHub infinite canvas API/tool-level control for external agents.

Primary goal:

- allow Codex or another Agent to operate RunningHub canvas without mouse automation.

Primary integration shape:

- local bridge server
- Chrome extension injected into the logged-in RunningHub page
- page-context API calls
- stdio MCP server

## Documentation ownership

- Keep reusable installation and usage guidance in README.md, AGENT_INSTALL.md and AGENT_QUICKSTART.md.
- If local-private/LOCAL_SETUP.md exists, read it for owner-machine installation and test setup. This directory is Git-ignored and excluded from release packages; do not publish its contents.
- Production projects own their canvas IDs, prompts, references, task receipts, media and approval state. Keep those in their project directories; do not relocate them into this repository just because they use this MCP.

## Communication

- Prefer concise, direct status updates.
- Keep English technical terms when useful.
- Be direct about uncertainty and blockers.
- Do not expose cookies, access tokens, or private payloads in chat or committed files.

## Development Notes

- Prefer small, inspectable changes.
- Keep the bridge local-only by default.
- Do not commit captured private RunningHub data.
- Do not print raw auth headers.
- If adding logs, redact `authorization`, `token`, and `cookie`.
- Treat `page.eval` as a dangerous local debugging hook.

## Useful Commands

- `node --check server/server.mjs`
- `node server/server.mjs`
- `curl http://127.0.0.1:18765/health`
- `node scripts/mcp-call.mjs rh_status`
