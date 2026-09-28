#!/usr/bin/env node
// Added 2026-09-27: direct MCP client for diagnostics and clients awaiting reload.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
const args = process.argv.slice(2);
const tool = args.shift() || "rh_status";
const option = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
const input = option("--input-file") ? await readFile(option("--input-file"), "utf8") : option("--json") || "{}";
const client = new Client({ name: "runninghub-mcp-client", version: "0.3.0" });
const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL("../server/mcp.mjs", import.meta.url))], stderr: "inherit", env: process.env });
try {
  await client.connect(transport);
  if (tool === "list") {
    const result = await client.listTools();
    console.log(JSON.stringify(result.tools.map(({name,description})=>({name,description})), null, 2));
  } else {
    if (option("--canvas")) {
      const selected = await client.callTool({ name: "rh_select_canvas", arguments: { canvasUrl: option("--canvas"), allowWrites: args.includes("--write") } });
      if (selected.isError) throw new Error(selected.content?.[0]?.text || "Canvas selection failed");
    }
    const result = await client.callTool({ name: tool, arguments: JSON.parse(input) }, undefined, { timeout: 90000 });
    console.log(JSON.stringify(result.structuredContent || result, null, 2));
    if (result.isError) process.exitCode = 1;
  }
} finally { await client.close(); }
