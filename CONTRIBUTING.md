# Contributing

Thanks for your interest in RunningHub Canvas Bridge.

Issues and Pull Requests are welcome for bugs, feature ideas, compatibility fixes and documentation. Keep changes focused, describe the observed behavior, and include relevant validation.

## Good Issues

A useful Issue should include:

- A clear title that names the behavior or proposal.
- Your environment: operating system, Node.js version, browser, and whether the bridge server and extension were both running.
- The exact command or workflow you tried.
- Expected behavior and actual behavior.
- Relevant error messages, with cookies, tokens, authorization headers, private canvas content, and private media URLs removed.
- Reproduction steps using placeholders such as `<canvas_id>`, `<node_id>`, and `<client_id>`.

## Bug Reports

For bugs, please include:

- Output from `npm run bridge -- health`.
- Output from `npm run bridge -- preflight`.
- Whether refreshing the RunningHub canvas page changes the result.
- Whether the issue affects one canvas or every canvas you tested.

Do not paste raw request headers, localStorage values, cookies, access tokens, or private RunningHub payloads. If a payload shape matters, replace private values with placeholders.

## Feature Requests

For feature requests, please describe:

- The Agent workflow you want to enable.
- The RunningHub node types or endpoints involved, if known.
- Whether the feature should be read-only, canvas-mutating, or generation-running.
- Any safety constraints, especially if the workflow can spend credits.

## API Observations

RunningHub internal APIs can change without notice. If you share observations from browser traces or bridge events, redact private fields before posting.

Good redaction examples:

- `canvasId: "<canvas_id>"`
- `nodeId: "<node_id>"`
- `Authorization: "[REDACTED]"`
- `token: "[REDACTED]"`

## Current Maintainer Policy

- Issues are welcome.
- Pull Requests should pass `npm run check`, `npm test` (requires ffprobe) and `npm run build`.
- Security-sensitive findings should be reported without public secrets or exploitable private payloads.
