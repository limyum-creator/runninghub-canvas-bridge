## 0.5.0

- Add platform asset browsing/search and URL-based canvas reuse.
- Recognize generated media outputs and bind references with live model fields.
- Discover current model configuration instead of relying on static presets.
- Isolate MCP canvas scopes; serialize canvas mutations and add optimistic batch conflict checks.
- Add Windows per-user background startup, media-tool discovery and portable ZIP packaging.
- Add Linux/macOS/Windows CI, including Windows Unicode-path launcher and service lifecycle checks.

# Changes

## 0.4.0 — 2026-09-27

- Add native video/audio upload with content inspection, metadata, SHA verification and scoped file streaming.
- Add persistent node-to-Lumen destinations and background task-specific output collection, all-output download, MCP import/readback, receipts and recovery.
- Preserve original Lumen import arguments on retries; never retry generation as part of collection.
- Recover page clients after a local service restart without requiring browser refresh.

Live tests: MP4 and WAV upload retained after refresh. Real downloads and two Lumen MCP imports passed in an isolated library, with simulated generation completion.

2026-09-28 joint validation: installed Lumen 0.8.8 (22.20) accepts the first and second outputs into the same pre-registered empty Work; exact import replay and archive-manager restart retain the original identities and exactly two revisions. No formal-library writes or actual generation were involved.

## 0.3.0 — 2026-09-27

- Add 18 stdio MCP tools for exact canvas selection, batch editing, blank templates, uploads, generation and results.
- Enable generation through service configuration; provide graph preview and original-request result recovery.
- Upload images through international canvas storage using transient page-local credentials; bundle upload dependencies and licenses.
- Persist selected canvas access for the macOS service; scope mutations to that exact canvas.
- Separate command IDs from node IDs, reject conflicting duplicate request IDs, expire unexecuted commands.
- Preserve native H3 parameters when cloning and validate native reference slots without Seedance-only fields.

Verified through real MCP: read/edit, image upload, deletion, production-canvas inspection and blank H3 clone preview. Generation request construction and mock submission pass; no live generation submitted for verification.

## 0.2.0-dev — 2026-09-27

- Add international `/project/canvas/` routing and React Flow inspection.
- Adapt page-session authentication and current Yjs generation metadata.
- Bundle synchronization dependencies locally instead of loading remote code.
- Restrict browser origins, command access and writes to one configured canvas.
- Keep generation, upload and arbitrary script/API commands disabled.
- Prevent reads from initializing missing remote canvas structures.
- Preserve displayed node labels and avoid repeated prompt text on preparation.

Verified in Chrome on the international RHTV site: empty-canvas read, dry-run, two text nodes, text edit, position edit, connection, and state retained after page refresh and fresh socket read. Image/video node variants, paid generation, long-term durability, and multi-user editing are not live-validated.
