#!/usr/bin/env node
// Modified 2026-09-27: international setup and complete extension hashes.
import { diagnoseConnection } from "../server/diagnostics.mjs";
import { BridgeClient } from "../server/bridge-client.mjs";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8"));
const bridgeScript = resolve(repoRoot, "scripts/rh-bridge.mjs");
const serverScript = resolve(repoRoot, "server/server.mjs");
const extensionDir = resolve(repoRoot, "extension");
const configDir = resolve(homedir(), ".runninghub-canvas-bridge");
const reportPath = resolve(configDir, "diagnostic-report.json");
const bridgeUrl = process.env.RH_BRIDGE_URL || "http://127.0.0.1:18765";
const issueUrl = packageJson.bugs?.url || "https://github.com/limyum-creator/runninghub-canvas-bridge/issues";

const command = process.argv[2] || "help";
const args = process.argv.slice(3);

const print = (value) => console.log(typeof value === "string" ? value : JSON.stringify(value, null, 2));

const runNode = (script, scriptArgs, options = {}) => {
  const result = spawnSync(process.execPath, [script, ...scriptArgs], {
    cwd: repoRoot,
    encoding: "utf8",
    ...options
  });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: String(result.stdout || "").trim(),
    stderr: String(result.stderr || "").trim()
  };
};

const parseJson = (text) => {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return text || null;
  }
};

const bridgeCommand = (name, commandArgs = []) => runNode(bridgeScript, [name, ...commandArgs]);

const redacted = (value) => {
  const text = JSON.stringify(value, (key, item) => (/authorization|token|cookie/i.test(key) ? "[REDACTED]" : item), 2);
  return JSON.parse(
    text.replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/g, "$1[REDACTED]").replace(/([?&][^=]*(?:authorization|token|cookie)[^=]*=)[^"&\s]+/gi, "$1[REDACTED]")
  );
};

const help = () => `RunningHub Canvas Bridge ${packageJson.version}

Usage:
  runninghub-canvas-bridge setup
  runninghub-canvas-bridge start
  runninghub-canvas-bridge doctor
  runninghub-canvas-bridge status
  runninghub-canvas-bridge report [--write]
  runninghub-canvas-bridge extension
  runninghub-canvas-bridge <bridge-command> [...args]

Common bridge commands:
  agent-manifest, preflight, diagnose-extension, canvas-summary, clients, events

Release contract:
  Agents should use this CLI, the local HTTP API, or MCP wrappers when available.
  Do not patch installed package internals to recover from product errors; run doctor/report.
  Report product issues at: ${issueUrl}
`;

const setup = () => {
  mkdirSync(configDir, { recursive: true });
  print({
    ok: true,
    product: packageJson.name,
    version: packageJson.version,
    bridgeUrl,
    configDir,
    issueUrl,
    extension: {
      unpackedPath: extensionDir,
      installSteps: [
        "Open chrome://extensions/ (or edge://extensions/) in the profile logged in to RunningHub.",
        "Enable Developer mode.",
        "Click Load unpacked and select the extension unpackedPath.",
        "Open https://www.runninghub.ai/project/canvas/<canvas_id> (or a supported China-site canvas).",
        "Allow Chrome local-network access if prompted so the page can reach 127.0.0.1."
      ]
    },
    nextCommands: ["runninghub-canvas-bridge start", "runninghub-canvas-bridge doctor"],
    feedback: {
      whenBlocked: "Run `runninghub-canvas-bridge report --write` and attach the redacted report to a GitHub Issue.",
      issueUrl
    }
  });
};

const extensionInfo = () => {
  const manifestPath = resolve(extensionDir, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const files = ["manifest.json", "site-policy.js", "bridge-main.js"];
  const hash = createHash("sha256");
  for (const file of files) hash.update(readFileSync(resolve(extensionDir, file)));
  print({
    ok: true,
    name: manifest.name,
    version: manifest.version,
    protocolVersion: manifest.runninghub_canvas_bridge_protocol || "1",
    unpackedPath: extensionDir,
    contentScriptMatches: manifest.content_scripts?.flatMap((item) => item.matches || []) || [],
    hostPermissions: manifest.host_permissions || [],
    sha256: hash.digest("hex"),
    installSteps: [
      "Download the extension zip from the matching GitHub Release, or use unpackedPath from the npm package.",
      "Open chrome://extensions/.",
      "Enable Developer mode.",
      "Load unpacked extension directory, then refresh the RunningHub canvas tab."
    ]
  });
};

const start = () => {
  const child = spawn(process.execPath, [serverScript], {
    cwd: repoRoot,
    stdio: "inherit",
    env: { ...process.env, NODE_ENV: process.env.NODE_ENV || "production" }
  });
  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    process.exit(code || 0);
  });
};

const status = () => {
  const health = bridgeCommand("health");
  const clients = health.ok ? bridgeCommand("clients") : null;
  print({
    ok: health.ok,
    product: packageJson.name,
    version: packageJson.version,
    bridgeUrl,
    issueUrl,
    bridgeHealth: health.ok ? parseJson(health.stdout) : null,
    clients: clients?.ok ? parseJson(clients.stdout) : [],
    error: health.ok ? null : parseJson(health.stdout) || health.stderr || "Bridge server is offline.",
    nextActions: health.ok ? [] : ["Start the bridge with `runninghub-canvas-bridge start`."]
  });
};

const doctor = async () => {
  const value=await diagnoseConnection(new BridgeClient(bridgeUrl));
  print(value);process.exitCode=value.ok?0:1;
};

const report = () => {
  const write = args.includes("--write");
  const commands = {
    health: bridgeCommand("health"),
    preflight: bridgeCommand("preflight"),
    diagnoseExtension: bridgeCommand("diagnose-extension"),
    clients: bridgeCommand("clients"),
    recentEvents: bridgeCommand("events")
  };
  const value = redacted({
    ok: commands.health.ok,
    generatedAt: new Date().toISOString(),
    product: packageJson.name,
    version: packageJson.version,
    bridgeUrl,
    issueUrl,
    platform: process.platform,
    nodeVersion: process.version,
    extensionPathExists: existsSync(extensionDir),
    commands: Object.fromEntries(
      Object.entries(commands).map(([key, item]) => [
        key,
        {
          ok: item.ok,
          status: item.status,
          stdout: parseJson(item.stdout),
          stderr: item.stderr || undefined
        }
      ])
    ),
    sharingPolicy: "Safe to share after review. Auth headers, cookies, and token-like fields are redacted by the CLI.",
    feedback: {
      issueUrl,
      requestedIssueContents: [
        "Attach this diagnostic report.",
        "Describe the command that failed.",
        "Describe what the Agent expected and what happened instead.",
        "Do not include cookies, tokens, authorization headers, or private RunningHub payloads."
      ]
    }
  });
  if (write) {
    mkdirSync(configDir, { recursive: true });
    writeFileSync(reportPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    print({ ok: true, reportPath, report: value });
  } else {
    print(value);
  }
};

if (command === "help" || command === "-h" || command === "--help") print(help());
else if (command === "version" || command === "--version" || command === "-v") print(packageJson.version);
else if (command === "setup" || command === "init") setup();
else if (command === "start") start();
else if (command === "doctor" || command === "diagnose") await doctor();
else if (command === "status") status();
else if (command === "report") report();
else if (command === "extension") extensionInfo();
else {
  const passthrough = runNode(bridgeScript, [command, ...args], { stdio: "inherit" });
  process.exit(passthrough.status ?? (passthrough.ok ? 0 : 1));
}
