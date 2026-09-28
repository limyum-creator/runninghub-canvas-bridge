# Agent installation

Modified 2026-09-28: international canvas, stdio MCP and Windows support, version 0.5.0.

1. Ensure ffprobe is available (or set `RH_FFPROBE`). From this source checkout run `npm ci` and `npm run build`. Source and release artifacts are available at https://github.com/limyum-creator/runninghub-canvas-bridge. No npm registry publication is required.
2. Start `RH_BRIDGE_ALLOW_GENERATION=1 npm start`, or on macOS install the background service with `RH_BRIDGE_ALLOW_GENERATION=1 npm run service:install`. Do not start both.
3. Load `extension/` as an unpacked extension into the Chrome profile holding the user's RunningHub login. Refresh the chosen canvas and allow its connection to localhost if Chrome asks.
4. Register the absolute Node executable and `server/mcp.mjs` as a stdio MCP server named `runninghub-canvas`. Use a tool timeout of 90 seconds. Node, the bridge and Chrome must run on the same host.
5. Call `rh_status`, then `rh_select_canvas` with the observed connected URL. Set `allowWrites: true` for editing, uploads and generation. Canvas selection refreshes runtime access automatically.
6. Read `rh_canvas_summary` and one full node. First mutation verification belongs on a blank test canvas. Preview where available, then read back and visually check retained state.

The macOS service stores canvas scope at `~/.runninghub-canvas-bridge/access.json` with private permissions and starts at login. `npm run service:status`, `service:restart` and `service:uninstall` manage it. Changing generation access for an installed service requires reinstalling its service definition.

Use `node scripts/mcp-call.mjs rh_status` before a client has reloaded its MCP configuration. It uses the actual MCP protocol. For missing clients check Chrome login, open canvas, extension status and local network permission. Never include cookies, tokens, temporary storage credentials or private canvas contents in installation reports. Arbitrary page scripts, arbitrary API requests and snapshot replacement are not exposed.

Optional automatic archiving requires a separately installed Lumen MCP. Canvas reading, editing, uploads, generation and result queries work without Lumen when no archive destination is configured. On macOS, archiving reads `~/Library/Application Support/Lumen/mcp-client.json`; use `RH_LUMEN_MCP_CONFIG` for another configuration path. Archive data defaults to `~/.runninghub-canvas-bridge/archives`; keep it across service restarts. `RH_ARCHIVE_DIR` can select a different private directory.


Windows: `npm ci`, `npm run build`, then `npm run service:install` installs a per-user login startup launcher and starts a hidden supervisor. No administrator privileges are required. Install ffmpeg/ffprobe in PATH or set `RH_FFPROBE` before service installation. Set `RH_BRIDGE_ALLOW_GENERATION=1` before installation only when generation is wanted. For optional Lumen integration set `RH_LUMEN_MCP_CONFIG` to an exported MCP client configuration. Reinstall the service after changing these persisted settings. `service:uninstall` stops and removes login startup while retaining archives and configuration. The project directory must remain at its installed path.
