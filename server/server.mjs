// Modified 2026-09-27: international routing, origin restrictions and canvas-scoped writes.
import http from "node:http";
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { readFile, stat, writeFile, rename, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { MediaTickets } from "./media.mjs";
import { ArchiveManager } from "./archive.mjs";
const mediaTickets = new MediaTickets();
const archives = new ArchiveManager();
await archives.init();
archives.start();

import "../extension/site-policy.js";
const SITE_POLICY = globalThis.RHCanvasSitePolicy;
const PORT = Number(process.env.RH_BRIDGE_PORT || 18765);
if (!Number.isInteger(PORT) || PORT < 1024 || PORT > 65535) throw new Error("Invalid local bridge port");
const ACCESS_FILE = process.env.RH_BRIDGE_ACCESS_FILE;
let ACCESS = {
  allowWrites: process.env.RH_BRIDGE_ALLOW_WRITES === "1",
  canvasId: process.env.RH_BRIDGE_CANVAS_ID || null,
  origin: process.env.RH_BRIDGE_ORIGIN || "https://www.runninghub.ai",
  generationEnabled: process.env.RH_BRIDGE_ALLOW_GENERATION === "1"
};
if (ACCESS_FILE) {
  try {
    const stored = JSON.parse(await readFile(ACCESS_FILE, "utf8"));
    if (SITE_POLICY.parseCanvas(`${stored.origin}/project/canvas/${stored.canvasId}`)) {
      ACCESS = { ...ACCESS, origin: stored.origin, canvasId: stored.canvasId, allowWrites: stored.allowWrites === true };
    }
  } catch (error) { if (error.code !== "ENOENT") throw error; }
}
const CLIENT_TTL = 15000;
const PRODUCT_NAME = "runninghub-canvas-bridge";
const PRODUCT_VERSION = "0.5.0";
const BRIDGE_PROTOCOL_VERSION = "1";
const RUNTIME_PATH = new URL("./bridge-runtime.js", import.meta.url);
const events = [];
const pendingCommands = new Map();
const commandResults = new Map();
const commandRecords = new Map();
const clients = new Map();
const sessions = new Map();
const canvasMutations = new Map();
const accessFor = input => input.sessionId ? sessions.get(input.sessionId) : ACCESS;

const canvasIdFromHref = (href) => SITE_POLICY.parseCanvas(href)?.canvasId || null;
const isCanvasClient = (client) => Boolean(SITE_POLICY.parseCanvas(client?.href)) && Date.now() - Number(client.lastSeenAt || 0) < CLIENT_TTL;
const cleanHref = (href) => {
  const canvas = SITE_POLICY.parseCanvas(href);
  if (!canvas) return null;
  const url = new URL(href);
  return url.origin + url.pathname;
};

const runtimeInfo = async () => {
  const [runtime, runtimeSource, sitePolicy, features] = await Promise.all([
    stat(RUNTIME_PATH), readFile(RUNTIME_PATH, "utf8"),
    readFile(new URL("../extension/site-policy.js", import.meta.url), "utf8"),
    readFile(new URL("./canvas-features.js", import.meta.url), "utf8")
  ]);
  const source = `${sitePolicy}\n${features}\nwindow.__RUNNINGHUB_CANVAS_BRIDGE_URL__ = "http://127.0.0.1:${PORT}";\nwindow.__RUNNINGHUB_CANVAS_BRIDGE_ACCESS__ = ${JSON.stringify({ ...ACCESS, allowWrites: false, canvasId: null, origin: null })};\n${runtimeSource}`;
  const hash = createHash("sha256").update(source).digest("hex").slice(0, 16);
  return {
    mtimeMs: runtime.mtimeMs,
    size: runtime.size,
    hash,
    version: `${PRODUCT_VERSION}:${BRIDGE_PROTOCOL_VERSION}:${runtime.mtimeMs}:${runtime.size}:${hash}`,
    productVersion: PRODUCT_VERSION,
    protocolVersion: BRIDGE_PROTOCOL_VERSION,
    source
  };
};

const selectClient = async (requestedClientId) => {
  const { source, ...runtime } = await runtimeInfo();
  const sorted = [...clients.values()]
    .filter(isCanvasClient)
    .sort((a, b) => Number(b.lastSeenAt || 0) - Number(a.lastSeenAt || 0));
  const requested = requestedClientId ? clients.get(requestedClientId) : null;
  const fresh = sorted.filter((client) => !client.runtimeVersion || client.runtimeVersion === runtime.version);
  const selected = requestedClientId ? (requested && isCanvasClient(requested) ? requested : null) : fresh[0] || sorted[0] || null;
  const staleClients = sorted.filter((client) => client.runtimeVersion && client.runtimeVersion !== runtime.version);
  const selectedCanvasId = canvasIdFromHref(selected?.href);
  const sameCanvasClients = selectedCanvasId ? sorted.filter((client) => SITE_POLICY.parseCanvas(client.href)?.key === SITE_POLICY.parseCanvas(selected.href)?.key) : [];
  const route = {
    selectedClientId: selected?.clientId,
    selectionReason: requested
      ? "requested clientId"
      : fresh[0]
        ? "latest active fresh RunningHub canvas tab"
        : sorted[0]
          ? "latest active canvas tab is stale"
          : "no RunningHub canvas client",
    canvasId: selectedCanvasId,
    href: selected?.href,
    runtimeFreshness: selected
      ? selected.runtimeVersion && selected.runtimeVersion !== runtime.version
        ? "stale"
        : "fresh"
      : "none",
    sameCanvasClients: sameCanvasClients.length,
    olderClientsIgnored: sorted
      .filter((client) => client.clientId !== selected?.clientId)
      .slice(0, 10)
      .map((client) => ({
        clientId: client.clientId,
        canvasId: canvasIdFromHref(client.href),
        reason: client.runtimeVersion && client.runtimeVersion !== runtime.version ? "stale runtime" : "older active client"
      })),
    staleClientIds: staleClients.map((client) => client.clientId),
    serverRuntimeVersion: runtime.version,
    selectedClientRuntimeVersion: selected?.runtimeVersion
  };
  return { runtime, sorted, selected, route };
};

const json = (res, status, value) => {
  const body = JSON.stringify(value, null, 2);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    ...(res.bridgeOrigin ? { "Access-Control-Allow-Origin": res.bridgeOrigin, Vary: "Origin" } : {}),
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS"
  });
  res.end(body);
};

const javascript = (res, status, body) => {
  res.writeHead(status, {
    "Content-Type": "application/javascript; charset=utf-8",
    ...(res.bridgeOrigin ? { "Access-Control-Allow-Origin": res.bridgeOrigin, Vary: "Origin" } : {}),
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Cache-Control": "no-store"
  });
  res.end(body);
};

const readBody = (req) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 44 * 1024 * 1024) { reject(new Error("Request body too large")); req.destroy(); }
      else chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });

const server = http.createServer(async (req, res) => {
  try {
    if (![ `127.0.0.1:${PORT}`, `localhost:${PORT}` ].includes(req.headers.host)) return json(res, 403, { error: "INVALID_HOST" });
    const origin = req.headers.origin;
    if (origin && !SITE_POLICY.origins.includes(origin)) return json(res, 403, { error: "ORIGIN_NOT_ALLOWED" });
    if (origin) res.bridgeOrigin = origin;
    if (req.method === "OPTIONS") return json(res, 200, { ok: true });
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

    const pageRoutes = new Set(["/bridge-runtime.js", "/runtime-version", "/vendor/yjs.js", "/vendor/upload.js", "/commands", "/events", "/health"]);
    if (origin && ((!pageRoutes.has(url.pathname) && !/^\/media\/[0-9a-f-]{36}$/.test(url.pathname)) || (url.pathname === "/events" && req.method !== "POST"))) {
      return json(res, 403, { error: "LOCAL_CLIENT_ONLY" });
    }
    if (req.method === "POST" && url.pathname === "/media") {
      const input = JSON.parse(await readBody(req));
      const canvas = SITE_POLICY.parseCanvas(input.canvasUrl);
      const scope = accessFor(input);
      if (!canvas || !scope?.allowWrites || canvas.canvasId !== scope.canvasId || canvas.origin !== scope.origin) return json(res, 403, { error: "CANVAS_NOT_ALLOWED" });
      return json(res, 200, await mediaTickets.create(input.filePath, canvas.origin));
    }
    if (url.pathname === '/archives/binding' && req.method === 'GET') return json(res,200,archives.binding(url.searchParams.get('canvasUrl'),url.searchParams.get('nodeId')));
    if (url.pathname === '/archives/binding' && req.method === 'POST') return json(res,200,await archives.bind(JSON.parse(await readBody(req))));
    if (url.pathname === '/archives' && req.method === 'GET') return json(res,200,{ok:true,archives:archives.status(url.searchParams.get('id'))});
    if (url.pathname === '/archives' && req.method === 'POST') return json(res,200,{ok:true,archive:await archives.add(JSON.parse(await readBody(req)))});
    if (url.pathname === '/archives/retry' && req.method === 'POST') {const input=JSON.parse(await readBody(req));return json(res,200,{ok:true,archive:await archives.retry(input.archiveId,input.taskId)});}
    if (req.method === "GET" && /^\/media\/[0-9a-f-]{36}$/.test(url.pathname)) {
      await mediaTickets.serve(url.pathname.split('/').pop(), origin, res);
      return;
    }
    if (req.method === "GET" && ["/vendor/yjs.js", "/vendor/upload.js"].includes(url.pathname)) {
      return javascript(res, 200, await readFile(new URL(`.${url.pathname}`, import.meta.url), "utf8"));
    }
    if (req.method === "GET" && url.pathname === "/bridge-runtime.js") {
      const runtime = await runtimeInfo();
      const source = `window.__RUNNINGHUB_CANVAS_BRIDGE_EXPECTED_VERSION__ = ${JSON.stringify(runtime.version)};\n${runtime.source}`;
      return javascript(res, 200, source);
    }

    if (req.method === "GET" && url.pathname === "/runtime-version") {
      const { source, ...runtime } = await runtimeInfo();
      return json(res, 200, runtime);
    }

    if (req.method === "POST" && url.pathname === "/sessions") {
      const input = JSON.parse(await readBody(req));
      const canvas = SITE_POLICY.parseCanvas(input.canvasUrl);
      if (!canvas || typeof input.allowWrites !== 'boolean') return json(res,400,{error:'INVALID_CANVAS_SCOPE'});
      if (![...clients.values()].some(c => isCanvasClient(c) && SITE_POLICY.parseCanvas(c.href)?.key === canvas.key)) return json(res,409,{error:'CANVAS_NOT_CONNECTED'});
      const id = input.sessionId || randomUUID();
      if (input.sessionId && !sessions.has(id)) return json(res,409,{error:'SESSION_EXPIRED: select again without a session ID'});
      const access = {...ACCESS, origin:canvas.origin, canvasId:canvas.canvasId, allowWrites:input.allowWrites};
      sessions.set(id,access);
      return json(res,200,{ok:true,sessionId:id,access});
    }

    if (req.method === "POST" && url.pathname === "/access") {
      const input = JSON.parse(await readBody(req));
      const canvas = SITE_POLICY.parseCanvas(input.canvasUrl);
      if (!canvas || typeof input.allowWrites !== "boolean") return json(res, 400, { error: "INVALID_CANVAS_SCOPE" });
      if (![...clients.values()].some(client => isCanvasClient(client) && SITE_POLICY.parseCanvas(client.href)?.key === canvas.key)) {
        return json(res, 409, { error: "CANVAS_NOT_CONNECTED" });
      }
      const next = { ...ACCESS, origin: canvas.origin, canvasId: canvas.canvasId, allowWrites: input.allowWrites };
      if (ACCESS_FILE) {
        await mkdir(dirname(ACCESS_FILE), { recursive: true });
        const temp = `${ACCESS_FILE}.${randomUUID()}.tmp`;
        await writeFile(temp, JSON.stringify(next, null, 2), { mode: 0o600 });
        await rename(temp, ACCESS_FILE);
      }
      ACCESS = next;
      return json(res, 200, { ok: true, access: ACCESS });
    }

    if (req.method === "POST" && url.pathname === "/events") {
      const body = await readBody(req);
      const event = JSON.parse(body || "{}");
      if (!event || typeof event !== "object" || !SITE_POLICY.parseCanvas(event.href) || (origin && new URL(event.href).origin !== origin)) {
        return json(res, 400, { error: "INVALID_PAGE_CLIENT" });
      }
      event.href = cleanHref(event.href);
      events.push(event);
      if (event.clientId) {
        clients.set(event.clientId, {
          clientId: event.clientId,
          href: event.href,
          title: event.title,
          runtimeVersion: event.runtimeVersion,
          loaderVersion: event.loaderVersion,
          protocolVersion: event.protocolVersion,
          runtimeCommands: event.runtimeCommands,
          canvasId: canvasIdFromHref(event.href),
          lastSeq: event.seq,
          lastSeenAt: Date.now()
        });
      }
      if (events.length > 1000) events.splice(0, events.length - 1000);
      if (event.kind === "command.result" && event.commandId) {
        const record = commandRecords.get(event.commandId);
        if (!record || record.clientId !== event.clientId) return json(res, 409, { error: "UNEXPECTED_COMMAND_RESULT" });
        commandResults.set(event.commandId, event);
        record.state = "completed";
        if (canvasMutations.get(record.canvasKey) === event.commandId) canvasMutations.delete(record.canvasKey);
      }
      return json(res, 200, { ok: true });
    }

    if (req.method === "GET" && url.pathname === "/events") {
      const since = Number(url.searchParams.get("since") || "0");
      return json(res, 200, events.filter((event) => Number(event.seq || 0) > since));
    }

    if (req.method === "GET" && url.pathname === "/clients") {
      const { selected, route, sorted } = await selectClient();
      return json(
        res,
        200,
        sorted.map((client) => ({
          ...client,
          selected: client.clientId === selected?.clientId,
          selectionReason: client.clientId === selected?.clientId ? route.selectionReason : undefined,
          runtimeFreshness:
            client.runtimeVersion && client.runtimeVersion !== route.serverRuntimeVersion ? "stale" : "fresh",
          sameCanvasClients: route.canvasId && canvasIdFromHref(client.href) === route.canvasId ? route.sameCanvasClients : undefined
        }))
      );
    }

    if (req.method === "GET" && url.pathname === "/diagnose-extension") {
      const { route, sorted } = await selectClient();
      const recentEvents = events.slice(-20).map(({ kind, clientId, ts, href, runtimeVersion, loaderVersion, protocolVersion, error }) => ({
        kind,
        clientId,
        ts,
        href,
        runtimeVersion,
        loaderVersion,
        protocolVersion,
        error
      }));
      return json(res, 200, {
        ok: Boolean(route.selectedClientId && route.runtimeFreshness === "fresh"),
        bridgeUrl: `http://127.0.0.1:${PORT}`,
        product: PRODUCT_NAME,
        version: PRODUCT_VERSION,
        protocolVersion: BRIDGE_PROTOCOL_VERSION,
        runtimeUrl: `http://127.0.0.1:${PORT}/bridge-runtime.js`,
        expectedExtensionMatches: SITE_POLICY.origins.map((origin) => `${origin}/*`),
        access: ACCESS,
        connectedCanvasClients: sorted.length,
        route,
        recentEvents,
        nextActions: route.selectedClientId
          ? route.runtimeFreshness === "fresh"
            ? []
            : ["Refresh the RunningHub canvas tab so the extension reloads the latest bridge runtime."]
          : [
              "Open or refresh a logged-in RunningHub canvas page.",
              "Verify the unpacked extension is enabled in the same Chrome profile as the RunningHub tab.",
              "If the browser asks about local-network access, the canvas needs access to the local bridge.",
              "Open extension details and confirm this RunningHub site is supported."
            ]
      });
    }

    if (req.method === "POST" && url.pathname === "/command") {
      const body = await readBody(req);
      const command = JSON.parse(body || "{}");
      if (!command || typeof command !== "object" || Array.isArray(command)) return json(res, 400, { error: "INVALID_COMMAND" });
      command.id ||= randomUUID();
      const { route, selected } = await selectClient(command.clientId);
      const scope = accessFor(command);
      if (!scope) return json(res,409,{errorCode:'SESSION_EXPIRED'});
      if (command.sessionId && selected && (scope.canvasId !== canvasIdFromHref(selected.href) || scope.origin !== SITE_POLICY.parseCanvas(selected.href).origin)) return json(res,403,{errorCode:'SESSION_CANVAS_MISMATCH'});
      const denied = SITE_POLICY.authorizeCommand(command, scope, SITE_POLICY.parseCanvas(selected?.href));
      if (denied) return json(res, 403, { ok: false, errorCode: denied, generationEnabled: ACCESS.generationEnabled });
      const clientId = command.clientId || route.selectedClientId;
      const selectedClient = clientId === "broadcast" ? null : selected;
      if (clientId !== "broadcast" && !selectedClient) {
        return json(res, 409, {
          ok: false,
          errorCode: "NO_PAGE_CLIENT",
          error: "No live RunningHub canvas page client is connected.",
          route,
          nextActions: [
            "Open or refresh a logged-in RunningHub canvas page with the unpacked extension enabled.",
            "Run `npm run bridge -- diagnose-extension` for setup diagnostics."
          ]
        });
      }
      if (clientId !== "broadcast" && selectedClient.runtimeVersion && selectedClient.runtimeVersion !== route.serverRuntimeVersion) {
        return json(res, 409, {
          ok: false,
          errorCode: "STALE_RUNTIME",
          error: "stale runtime client",
          clientId,
          clientRuntimeVersion: selectedClient.runtimeVersion,
          serverRuntimeVersion: route.serverRuntimeVersion,
          route,
          nextActions: ["Refresh the RunningHub canvas tab so it picks up the latest bridge runtime."]
        });
      }
      command.canvasId = route.canvasId;
      command.canvasOrigin = SITE_POLICY.parseCanvas(selected.href).origin;
      delete command.access;
      const { clientId: ignoredClient, expiresAt: ignoredExpiry, ...identity } = command;
      const fingerprint = createHash("sha256").update(JSON.stringify(identity)).digest("hex");
      const previous = commandRecords.get(command.id);
      if (previous) {
        if (previous.fingerprint !== fingerprint) return json(res, 409, { errorCode: "REQUEST_ID_CONFLICT" });
        return json(res, 200, { ok: true, id: command.id, clientId: previous.clientId, route, duplicate: true, state: previous.state });
      }
      command.expiresAt = Date.now() + Math.min(Math.max(Number(command.queueTimeoutMs) || 30000, 1000), 60000);
      command.access = {...scope, generationEnabled:ACCESS.generationEnabled};
      commandRecords.set(command.id, { fingerprint, clientId, state: "queued", canvasKey: SITE_POLICY.parseCanvas(selected.href).key });
      const queue = pendingCommands.get(clientId) || [];
      queue.push(command);
      pendingCommands.set(clientId, queue);
      return json(res, 200, { ok: true, id: command.id, clientId, route });
    }

    if (req.method === "GET" && url.pathname === "/commands") {
      const clientId = url.searchParams.get("clientId") || "";
      const client = clients.get(clientId);
      const href = cleanHref(url.searchParams.get("href"));
      if (!client || !href || (origin && new URL(href).origin !== origin)) return json(res, 403, { error: "UNKNOWN_PAGE_CLIENT" });
      client.lastSeenAt = Date.now();
      client.href = href;
      let commands = [];
      const direct = pendingCommands.get(clientId);
      if (direct?.length) {
        commands = commands.concat(direct.splice(0));
        pendingCommands.set(clientId, direct);
      }
      commands = commands.filter(command => {
        const record = commandRecords.get(command.id);
        if (command.expiresAt < Date.now()) {
          record.state = "expired";
          commandResults.set(command.id, { ok: false, errorCode: "COMMAND_EXPIRED", commandId: command.id });
          return false;
        }
        if (SITE_POLICY.parseCanvas(href)?.key !== record.canvasKey) {
          record.state = 'expired';
          commandResults.set(command.id,{ok:false,errorCode:'CANVAS_MISMATCH',commandId:command.id});
          return false;
        }
        const currentScope=accessFor(command);
        const denial=!currentScope ? 'SESSION_EXPIRED' : command.sessionId && (currentScope.canvasId!==command.canvasId || currentScope.origin!==command.canvasOrigin) ? 'SESSION_CANVAS_MISMATCH' : SITE_POLICY.authorizeCommand(command,currentScope,SITE_POLICY.parseCanvas(href));
        if(denial) {
          record.state='rejected';commandResults.set(command.id,{ok:false,errorCode:denial,commandId:command.id});return false;
        }
        command.access={...currentScope,generationEnabled:ACCESS.generationEnabled};
        const mode = SITE_POLICY.commandMode(command);
        if (mode === 'edit' || mode === 'generate') {
          if (canvasMutations.has(record.canvasKey)) {
            const queue = pendingCommands.get(clientId) || [];
            queue.push(command); pendingCommands.set(clientId,queue);
            return false;
          }
          canvasMutations.set(record.canvasKey,command.id);
        }
        record.state = "dispatched";
        return true;
      });
      return json(res, 200, commands);
    }

    if (req.method === "GET" && url.pathname === "/result") {
      const id = url.searchParams.get("id");
      return json(res, 200, id ? commandResults.get(id) || null : Object.fromEntries(commandResults));
    }

    if (req.method === "GET" && url.pathname === "/health") {
      return json(res, 200, {
        ok: true,
        product: PRODUCT_NAME,
        version: PRODUCT_VERSION,
        protocolVersion: BRIDGE_PROTOCOL_VERSION,
        events: events.length,
        access: ACCESS,
        instanceId: process.env.RH_BRIDGE_INSTANCE_ID || null,
        pendingClients: pendingCommands.size,
        activeMutations: canvasMutations.size,
        sessions: sessions.size
      });
    }

    return json(res, 404, { error: "not found" });
  } catch (error) {
    return json(res, 500, { error: error && error.stack ? error.stack : String(error) });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`RunningHub bridge server listening on http://127.0.0.1:${PORT}`);
});
