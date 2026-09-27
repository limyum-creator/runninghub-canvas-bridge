# International canvas validation

2026-09-28 · version 0.4.0

## Live browser and MCP evidence

- Chrome unpacked extension updated to 0.4.0; local background bridge runs on port 18765 with generation enabled.
- Standard MCP stdio handshake lists 23 tools; registration was verified with a Codex client.
- MCP read and edit of a test canvas succeeded; complete Chinese text and updated title were visible in Chrome.
- Uploaded a synthetic 128×128 PNG through native international canvas storage. Returned a usable URL and an rh-image node; reread confirmed the node. No generation was involved.
- Deleted the failed earlier upload staging node by exact ID. Test canvas then held three nodes and one edge.
- Production canvas read returned 17 nodes and 16 edges, including existing H3 results and a genuine blank H3 template.
- Clone preview preserved that template's native model/settings, returned `applied: false`, and left the production canvas unchanged.
- Earlier 0.2 verification created, edited, moved and connected text nodes, then confirmed state after page refresh and a fresh synchronized read.

## 0.4.0 media and archive verification

- Native MP4 (1 second) and WAV (0.5 seconds, 48 kHz mono) upload succeeded with SHA-confirmed URLs and rh-video/rh-audio nodes. Chrome refresh retained both nodes.
- Recovered those real uploaded files, validated their media metadata and full SHA, and imported both through the installed Lumen MCP into an isolated library. Both exact Revision/SHA identities were read back. Completion signaling was simulated; no actual generation was submitted.
- Interrupted import-response tests reused the same token/request and retained downloads across an archive-manager restart without duplicate versions.
- Import into an explicitly registered empty project Work requires a compatible Lumen App runtime. Verified with the complete 0.8.8 (22.20) App; updating external Python modules alone does not update the bundled App runtime.
- 2026-09-28 joint retest passed through fresh MCP connections to the installed 22.20 App: the same disposable registered Work had zero revisions, accepted its first version, then a second real downloaded output. Both SHA/Revision identities were read back in the original Project/Work. Replaying each exact import request and restarting/retrying the archive manager retained exactly two revisions. Title, project, locks and pin/final fields remained unchanged. Completion signaling was simulated; the formal library was not modified.

## Automated checks

All 25 tests passed for this release, including archive registration before generation, refusal to submit on registration failure, and retention of all outputs while first-version import is unavailable.

Tests cover MCP handshake/schema, real stdio startup, canvas selection, local-only transport, read-only Yjs sessions, schema mismatch, scoped writes, generation access, graph preview/mock submission, H3 reference validation, blank template cloning, node/command ID separation, HTTP origin/host restrictions, duplicate command IDs, result ownership and prompt deduplication.

Syntax checks, dependency bundles with licenses and extension packaging are part of release checks. Private account details, canvas IDs and media URLs are excluded from this record.

## Evidence limits

No actual generation was submitted in this integration test. Real billing/entitlement, generation completion, production generation-to-archive completion, asset-drawer search, multi-user conflict handling and long-term storage durability are not validated by these checks. Node completion can expose historical outputs; match to the current task ID. Refresh and fresh reads establish this session's retained state only.

This conversation used the standard MCP client script for live calls; registration alone does not prove that an already-open Codex conversation hot-loaded its native tools.
