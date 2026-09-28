#!/usr/bin/env node
// Modified 2026-09-27: persistent canvas scope and configurable generation access.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir, platform, userInfo } from "node:os";

const action = process.argv[2] || "status";
if (platform() === 'win32') {
  try { console.log(JSON.stringify(await (await import('./windows-service.mjs')).windowsService(action),null,2)); }
  catch(error) { console.error(JSON.stringify({ok:false,error:error.message}));process.exitCode=1; }
  process.exit(process.exitCode || 0);
}
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const label = "cn.runninghub.canvas-bridge";
const plistPath = resolve(homedir(), "Library/LaunchAgents", `${label}.plist`);
const logDir = resolve(homedir(), "Library/Logs/runninghub-canvas-bridge");
const outLog = resolve(logDir, "bridge.out.log");
const errLog = resolve(logDir, "bridge.err.log");
const serverPath = resolve(repoRoot, "server/server.mjs");
const nodePath = process.execPath;
const accessPath = resolve(homedir(), ".runninghub-canvas-bridge/access.json");
const xml = value => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const guiTarget = `gui/${userInfo().uid}`;

const print = (value) => console.log(JSON.stringify(value, null, 2));

const fail = (message, extra = {}) => {
  print({ ok: false, error: message, ...extra });
  process.exit(1);
};

const ensureMac = () => {
  if (platform() !== "darwin") {
    fail("Persistent service helper currently supports macOS LaunchAgent only.", {
      nextActions: ["Run `npm run start` manually on non-macOS platforms."]
    });
  }
};

const run = (cmd, args, options = {}) => {
  const result = spawnSync(cmd, args, { encoding: "utf8", ...options });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: String(result.stdout || "").trim(),
    stderr: String(result.stderr || "").trim()
  };
};

const plist = () => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(nodePath)}</string>
    <string>${xml(serverPath)}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(repoRoot)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${outLog}</string>
  <key>StandardErrorPath</key>
  <string>${errLog}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>NODE_ENV</key>
    <string>production</string>
    <key>RH_BRIDGE_ACCESS_FILE</key>
    <string>${xml(accessPath)}</string>
    <key>RH_BRIDGE_ALLOW_GENERATION</key>
    <string>${process.env.RH_BRIDGE_ALLOW_GENERATION === "1" ? "1" : "0"}</string>
  </dict>
</dict>
</plist>
`;

const serviceStatus = () => {
  ensureMac();
  const list = run("launchctl", ["list", label]);
  const health = run(nodePath, [resolve(repoRoot, "scripts/rh-bridge.mjs"), "health"], { cwd: repoRoot });
  return {
    ok: list.ok && health.ok,
    installed: existsSync(plistPath),
    loaded: list.ok,
    label,
    plistPath,
    logs: { stdout: outLog, stderr: errLog },
    launchctl: list.ok ? list.stdout : list.stderr,
    bridgeHealth: health.ok ? JSON.parse(health.stdout || "{}") : null,
    bridgeHealthError: health.ok ? null : health.stderr || health.stdout || null
  };
};

const readyStatus = async () => {
  let status;
  for (let attempt = 0; attempt < 12; attempt++) {
    status = serviceStatus();
    if (status.ok) return status;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  return status;
};

const install = async () => {
  ensureMac();
  mkdirSync(dirname(plistPath), { recursive: true });
  mkdirSync(logDir, { recursive: true });
  if (run("launchctl", ["list", label]).ok) run("launchctl", ["bootout", `${guiTarget}/${label}`]);
  writeFileSync(plistPath, plist(), "utf8");
  const bootstrap = run("launchctl", ["bootstrap", guiTarget, plistPath]);
  if (!bootstrap.ok && !/already bootstrapped|service already loaded/i.test(bootstrap.stderr)) {
    fail("Failed to bootstrap LaunchAgent.", { plistPath, launchctl: bootstrap.stderr });
  }
  run("launchctl", ["kickstart", "-k", `${guiTarget}/${label}`]);
  print({ action: "install", ...await readyStatus() });
};

const start = async () => {
  ensureMac();
  mkdirSync(dirname(plistPath), { recursive: true });
  mkdirSync(logDir, { recursive: true });
  if (!existsSync(plistPath)) writeFileSync(plistPath, plist(), "utf8");
  const bootstrap = run("launchctl", ["list", label]).ok ? { ok: true } : run("launchctl", ["bootstrap", guiTarget, plistPath]);
  if (!bootstrap.ok && !/already bootstrapped|service already loaded/i.test(bootstrap.stderr)) {
    fail("Failed to bootstrap LaunchAgent.", { plistPath, launchctl: bootstrap.stderr });
  }
  const kickstart = run("launchctl", ["kickstart", "-k", `${guiTarget}/${label}`]);
  if (!kickstart.ok) fail("Failed to start LaunchAgent.", { launchctl: kickstart.stderr });
  print({ action: "start", ...await readyStatus() });
};

const stop = () => {
  ensureMac();
  if (existsSync(plistPath)) run("launchctl", ["bootout", guiTarget, plistPath]);
};

const uninstall = () => {
  ensureMac();
  stop();
  if (existsSync(plistPath)) rmSync(plistPath);
  print({ ok: true, action: "uninstall", installed: false, label, plistPath });
};

if (action === "install") await install();
else if (action === "start") await start();
else if (action === "stop") { stop(); print({ok:true, action:"stop"}); }
else if (action === "status") print(serviceStatus());
else if (action === "restart") {
  stop();
  await start();
} else if (action === "uninstall") uninstall();
else if (action === "plist") {
  print({ ok: true, plistPath, plist: existsSync(plistPath) ? readFileSync(plistPath, "utf8") : plist() });
} else {
  fail(`Unknown service action: ${action}`, {
    usage: ["install", "start", "status", "restart", "uninstall", "plist"].map((name) => `node scripts/rh-service.mjs ${name}`)
  });
}
