#!/usr/bin/env node
// Modified 2026-09-27: scoped editing, uploads and generation; MCP is preferred.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

const DEFAULT_BRIDGE = "http://127.0.0.1:18765";
const bridge = process.env.RH_BRIDGE_URL || DEFAULT_BRIDGE;
const MANIFEST_VERSION = "2026-09-27";

const AGENT_MANIFEST = {
  name: "runninghub-canvas-bridge",
  manifestVersion: MANIFEST_VERSION,
  bridgeUrl: bridge,
  purpose: "Let external Agents operate a logged-in RunningHub infinite canvas through a local bridge without mouse automation.",
  safety: {
    localOnlyByDefault: true,
    secretsPolicy: "Do not print, store, or commit cookies, tokens, authorization headers, or private payloads.",
    generationAvailable: true,
    generationEnabled: "Read live health.access.generationEnabled; configure RH_BRIDGE_ALLOW_GENERATION=1.",
    uploadAvailable: true,
    writesRequireCanvasScope: true,
    disabledCommands: ["page.eval", "api-post", "create-text-workflow"]
  },
  preflight: {
    command: "node scripts/rh-bridge.mjs preflight",
    checks: ["bridgeServer", "runtimeVersion", "pageClient", "runtimeFreshness", "capabilities"],
    readyWhen: "ok is true and no blockingReasons are returned."
  },
  recommendedWorkflows: {
    agentFirstRun: [
      "node scripts/rh-bridge.mjs agent-manifest",
      "node scripts/rh-bridge.mjs preflight",
      "node scripts/rh-bridge.mjs canvas-summary"
    ],
    canvasEditing: [
      "node scripts/rh-bridge.mjs canvas-summary",
      "node scripts/rh-bridge.mjs create-text-node --dry-run --config-json '{\"text\":\"Bridge test\",\"x\":100,\"y\":100}'",
      "Enable writes for one chosen canvas, then repeat the intended edit without --dry-run."
    ]
  },
  commands: {
    "agent-manifest": {
      summary: "Return this machine-readable manifest.",
      requiresPageClient: false,
      mutatesCanvas: false,
      costsCredits: false,
      supportsDryRun: false
    },
    preflight: {
      summary: "Check bridge server, page client, runtime version freshness, and runtime command support.",
      requiresPageClient: false,
      mutatesCanvas: false,
      costsCredits: false,
      supportsDryRun: false
    },
    "diagnose-extension": {
      summary: "Return first-run diagnostics for extension injection and localhost reachability.",
      requiresPageClient: false,
      mutatesCanvas: false,
      costsCredits: false,
      supportsDryRun: false
    },
    capabilities: {
      summary: "Return runtime command capabilities from the live page.",
      requiresPageClient: true,
      mutatesCanvas: false,
      costsCredits: false,
      supportsDryRun: false
    },
    "yjs-snapshot": {
      summary: "Read canonical Yjs canvas nodes and edges.",
      requiresPageClient: true,
      mutatesCanvas: false,
      costsCredits: false,
      supportsDryRun: false
    },
    "canvas-summary": {
      summary: "Return a compact Agent-oriented canvas summary.",
      requiresPageClient: true,
      mutatesCanvas: false,
      costsCredits: false,
      supportsDryRun: false
    },
    "create-text-node": {
      summary: "Create an rh-text node.",
      requiresPageClient: true,
      mutatesCanvas: true,
      costsCredits: false,
      supportsDryRun: true
    },
    "create-text-nodes": {
      summary: "Create multiple rh-text nodes in one canvas mutation with one rollback id.",
      requiresPageClient: true,
      mutatesCanvas: true,
      costsCredits: false,
      supportsDryRun: true
    },
    "suggest-empty-region": {
      summary: "Suggest a conservative empty canvas region for new Agent-created nodes.",
      requiresPageClient: true,
      mutatesCanvas: false,
      costsCredits: false,
      supportsDryRun: false
    },
    "group-elements": {
      summary: "Create a group around explicitly provided nodes.",
      requiresPageClient: true,
      mutatesCanvas: true,
      costsCredits: false,
      supportsDryRun: true
    },
    "create-image-node": {
      summary: "Create an rh-image generation node without running it.",
      requiresPageClient: true,
      mutatesCanvas: true,
      costsCredits: false,
      supportsDryRun: true
    },
    "prepare-image-workflow": {
      summary: "Atomically prepare a prompt text node, image generation node, and reference edges without running generation.",
      requiresPageClient: true,
      mutatesCanvas: true,
      costsCredits: false,
      supportsDryRun: true,
      defaultRunBehavior: "prepared-but-not-run"
    },
    "find-reference-candidates": {
      summary: "Find reusable rh-image reference candidates by semantic title, label, prompt preview, or upstream lineage.",
      requiresPageClient: true,
      mutatesCanvas: false,
      costsCredits: false,
      supportsDryRun: false
    },
    "describe-image-node": {
      summary: "Return compact identity/provenance for one rh-image node without media URLs by default.",
      requiresPageClient: true,
      mutatesCanvas: false,
      costsCredits: false,
      supportsDryRun: false
    },
    "create-video-node": {
      summary: "Create an rh-video generation node without running it.",
      requiresPageClient: true,
      mutatesCanvas: true,
      costsCredits: false,
      supportsDryRun: true
    },
    "upload-reference-image": {
      summary: "Upload a local image through the live page and create/connect a native reference image node.",
      requiresPageClient: true,
      mutatesCanvas: true,
      costsCredits: false,
      supportsDryRun: false
    },
    "upload-local-reference-image": {
      summary: "Upload an image through native canvas storage and create a usable reference node with its URL.",
      requiresPageClient: true,
      mutatesCanvas: true,
      costsCredits: false,
      supportsDryRun: false,
      primaryOutput: "result.primaryReference.nodeId"
    },
    "create-reference-from-url": {
      summary: "Create a directly usable reference image node from an existing image URL.",
      requiresPageClient: true,
      mutatesCanvas: true,
      costsCredits: false,
      supportsDryRun: true,
      primaryOutput: "primaryReference.nodeId"
    },
    "prepare-video-node": {
      summary: "Collect upstream text/image inputs into effective rh-video params without generation.",
      requiresPageClient: true,
      mutatesCanvas: true,
      costsCredits: false,
      supportsDryRun: true,
      validationOutput: "result.validation.ok"
    },
    "validate-video-run": {
      summary: "Validate effective video prompt, multimodal model settings, imageUrls, and upstream image edges.",
      requiresPageClient: true,
      mutatesCanvas: false,
      costsCredits: false,
      supportsDryRun: false,
      successField: "ok"
    },
    "validate-node-run": {
      summary: "Generic pre-run validation for text, image, and video nodes.",
      requiresPageClient: true,
      mutatesCanvas: false,
      costsCredits: false,
      supportsDryRun: false,
      successField: "ok"
    },
    "generate-video-node": {
      summary: "Legacy video flow: prepare, validate, then run. Not adapted for native H3; use MCP template/params/run tools for H3.",
      requiresPageClient: true,
      mutatesCanvas: true,
      costsCredits: true,
      supportsDryRun: true,
      safePreflightCommand: "generate-video-node <nodeId> --dry-run",
      blockingRule: "Never run without a successful dry-run or explicit user approval."
    },
    "run-node": {
      summary: "Run one node through /canvas/task/run.",
      requiresPageClient: true,
      mutatesCanvas: true,
      costsCredits: true,
      supportsDryRun: true,
      safeUsage: "Prefer MCP rh_run_node with a stable requestId. --dry-run previews without submitting."
    },
    "poll-node-result": {
      summary: "Poll one node until output URLs are available or a terminal status is observed.",
      requiresPageClient: true,
      mutatesCanvas: false,
      costsCredits: false,
      supportsDryRun: false,
      primaryOutput: "outputs[].url"
    },
    "poll-task-result": {
      summary: "Poll the canvas until outputs matching a RunningHub taskId are available.",
      requiresPageClient: true,
      mutatesCanvas: false,
      costsCredits: false,
      supportsDryRun: false,
      primaryOutput: "outputs[].url"
    },
    "delete-elements": {
      summary: "Delete nodes/edges by id.",
      requiresPageClient: true,
      mutatesCanvas: true,
      costsCredits: false,
      supportsDryRun: true
    },
    "page.eval": {
      summary: "Dangerous local debug hook exposed only through raw command/API paths.",
      requiresPageClient: true,
      mutatesCanvas: "unknown",
      costsCredits: "unknown",
      supportsDryRun: false,
      warning: "Do not use in autonomous workflows."
    }
  },
  stableErrorCodes: {
    BRIDGE_OFFLINE: "Local bridge server is not reachable.",
    NO_PAGE_CLIENT: "No live RunningHub canvas page client is connected.",
    STALE_RUNTIME: "A page client runtime version does not match the server runtime version.",
    MISSING_CAPABILITY: "The live runtime does not advertise a required command.",
    VALIDATION_FAILED: "A validation command returned ok:false or blocking errors.",
    WOULD_SPEND_CREDITS: "A command can spend RH credits and should not run without preflight/approval."
  }
};

for (const name of AGENT_MANIFEST.safety.disabledCommands) delete AGENT_MANIFEST.commands[name];
AGENT_MANIFEST.stableErrorCodes.READ_ONLY = "Canvas editing is disabled by the local server.";
AGENT_MANIFEST.stableErrorCodes.CANVAS_NOT_ALLOWED = "This canvas is not the configured edit target.";
AGENT_MANIFEST.stableErrorCodes.COMMAND_DISABLED = "This release does not enable this command.";

const usage = `Usage:
  node scripts/rh-bridge.mjs health
  node scripts/rh-bridge.mjs agent-manifest
  node scripts/rh-bridge.mjs preflight [--client <clientId>] [--timeout <ms>]
  node scripts/rh-bridge.mjs diagnose-extension
  node scripts/rh-bridge.mjs clients
  node scripts/rh-bridge.mjs events [--since <seq>]
  node scripts/rh-bridge.mjs snapshot [--client <clientId>] [--timeout <ms>]
  node scripts/rh-bridge.mjs export-workflow [--client <clientId>] [--timeout <ms>]
  node scripts/rh-bridge.mjs yjs-snapshot [--client <clientId>] [--timeout <ms>]
  node scripts/rh-bridge.mjs canvas-summary [--client <clientId>] [--timeout <ms>] [--compact] [--full] [--limit <n>] [--types <csv>] [--status <csv>] [--fields <csv>] [--no-urls] [--no-text-preview] [--text-preview-length <n>]
  node scripts/rh-bridge.mjs rollback-list [--client <clientId>] [--timeout <ms>]
  node scripts/rh-bridge.mjs rollback [rollbackId] [--client <clientId>] [--timeout <ms>]
  node scripts/rh-bridge.mjs capabilities [--client <clientId>] [--timeout <ms>]
  node scripts/rh-bridge.mjs find-elements [--client <clientId>] [--timeout <ms>] [--query-json <json>] [--summary] [--fields <csv>] [--limit <n>] [--no-outputs] [--no-params] [--text-preview-length <n>]
  node scripts/rh-bridge.mjs get-element <id> [--client <clientId>] [--timeout <ms>]
  node scripts/rh-bridge.mjs inspect-node-template <nodeId> [--client <clientId>] [--timeout <ms>] [--include-position]
  node scripts/rh-bridge.mjs inspect-model-options [--client <clientId>] [--timeout <ms>] [--node-type <type>] [--sub-type <subType>]
  node scripts/rh-bridge.mjs resolve-model-alias <modelName> [--client <clientId>] [--timeout <ms>] [--sub-type <subType>]
  node scripts/rh-bridge.mjs connections <nodeId> [--client <clientId>] [--timeout <ms>] [--direction <both|upstream|downstream>] [--depth <n>] [--summary] [--fields <csv>] [--no-outputs] [--no-params] [--text-preview-length <n>]
  node scripts/rh-bridge.mjs find-reference-candidates --text <description> [--client <clientId>] [--timeout <ms>] [--limit <n>] [--include-urls] [--text-preview-length <n>]
  node scripts/rh-bridge.mjs describe-image-node <nodeId> [--client <clientId>] [--timeout <ms>] [--include-urls] [--text-preview-length <n>]
  node scripts/rh-bridge.mjs create-text-node [--client <clientId>] [--timeout <ms>] [--config-json <json>] [--dry-run]
  node scripts/rh-bridge.mjs create-text-nodes [--client <clientId>] [--timeout <ms>] [--config-json <json-array>] [--x <n>] [--y <n>] [--gap-x <n>] [--gap-y <n>] [--dry-run]
  node scripts/rh-bridge.mjs suggest-empty-region [--client <clientId>] [--timeout <ms>] [--near-text <text>] [--around-node <nodeId>] [--direction <right-down|right-up|left-down|left-up>] [--width <n>] [--height <n>] [--padding <n>]
  node scripts/rh-bridge.mjs group-elements <id...> [--client <clientId>] [--timeout <ms>] [--title <title>] [--padding <n>] [--style-json <json>] [--dry-run]
  node scripts/rh-bridge.mjs create-node [--client <clientId>] [--timeout <ms>] [--config-json <json>] [--dry-run]
  node scripts/rh-bridge.mjs create-video-node [--client <clientId>] [--timeout <ms>] [--config-json <json>] [--multimodal] [--dry-run]
  node scripts/rh-bridge.mjs create-image-node [--client <clientId>] [--timeout <ms>] [--config-json <json>] [--dry-run]
  node scripts/rh-bridge.mjs prepare-image-workflow [--client <clientId>] [--timeout <ms>] [--config-json <json>] [--dry-run] [--full]
  node scripts/rh-bridge.mjs create-reference-image-node [--client <clientId>] [--timeout <ms>] [--config-json <json>] [--dry-run]
  node scripts/rh-bridge.mjs create-reference-from-url --url <url> [--client <clientId>] [--timeout <ms>] [--config-json <json>] [--connect-to-node <nodeId>] [--dry-run]
  node scripts/rh-bridge.mjs prepare-video-node <nodeId> [--client <clientId>] [--timeout <ms>] [--max-depth <n>] [--prompt <text>] [--append-prompt <text>] [--prompt-merge-mode <merge|replace|append>] [--reference-node-ids-json <json>] [--dry-run]
  node scripts/rh-bridge.mjs validate-video-run <nodeId> [--client <clientId>] [--timeout <ms>] [--allow-no-references]
  node scripts/rh-bridge.mjs validate-node-run <nodeId> [--client <clientId>] [--timeout <ms>] [--require-references]
  node scripts/rh-bridge.mjs run-node <nodeId> [--client <clientId>] [--timeout <ms>] [--validate-references] [--dry-run]
  node scripts/rh-bridge.mjs poll-node-result <nodeId> [--client <clientId>] [--timeout <ms>] [--poll-timeout <ms>] [--poll-interval <ms>] [--allow-no-output]
  node scripts/rh-bridge.mjs poll-task-result <taskId> [--client <clientId>] [--timeout <ms>] [--poll-timeout <ms>] [--poll-interval <ms>] [--allow-no-output]
  node scripts/rh-bridge.mjs connect-nodes <sourceId> <targetId> [--client <clientId>] [--timeout <ms>] [--dry-run]
  node scripts/rh-bridge.mjs update-node-model <nodeId> <modelCode> [--client <clientId>] [--timeout <ms>] [--model-name <name>] [--dry-run]
  node scripts/rh-bridge.mjs update-node-params <nodeId> [--client <clientId>] [--timeout <ms>] [--params-json <json>] [--dry-run] [--full]
  node scripts/rh-bridge.mjs update-node <nodeId> [--client <clientId>] [--timeout <ms>] [--patch-json <json>] [--data-json <json>] [--title <title>] [--dry-run] [--full]
  node scripts/rh-bridge.mjs update-node-text <nodeId> <text> [--client <clientId>] [--timeout <ms>] [--title <title>] [--dry-run] [--full]
  node scripts/rh-bridge.mjs move-node <nodeId> <x> <y> [--client <clientId>] [--timeout <ms>] [--dry-run]
  node scripts/rh-bridge.mjs move-nodes <id...> [--client <clientId>] [--timeout <ms>] [--dx <n>] [--dy <n>] [--positions-json <json>] [--dry-run]
  node scripts/rh-bridge.mjs delete-elements <id...> [--client <clientId>] [--timeout <ms>] [--dry-run]
  node scripts/rh-bridge.mjs get-canvas-detail <canvasId> [--timeout <ms>] [--body-json <json>]
  node scripts/rh-bridge.mjs workflow-list <canvasId> [--timeout <ms>] [--body-json <json>]
  node scripts/rh-bridge.mjs result <commandId>

Environment:
  RH_BRIDGE_URL  Bridge base URL. Defaults to ${DEFAULT_BRIDGE}

Output:
  Default output is JSON. Add --pretty-summary for compact human-readable output.
`;

const args = process.argv.slice(2);
const commandName = args.shift();

const fail = (message, code = 1) => {
  console.error(message);
  process.exit(code);
};

const option = (name, fallback) => {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) fail(`Missing value for ${name}`);
  args.splice(index, 2);
  return value;
};

const flag = (name) => {
  const index = args.indexOf(name);
  if (index === -1) return false;
  args.splice(index, 1);
  return true;
};

const bodyOption = (fallback) => {
  const raw = option("--body-json");
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch (error) {
    fail(`Invalid --body-json: ${error.message}`);
  }
};

const configOption = (fallback = {}) => {
  const raw = option("--config-json");
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch (error) {
    fail(`Invalid --config-json: ${error.message}`);
  }
};

const jsonOption = (name, fallback = {}) => {
  const raw = option(name);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch (error) {
    fail(`Invalid ${name}: ${error.message}`);
  }
};

const summarizeForHuman = (value) => {
  const lines = [];
  const route = value?.commandRoute;
  if (route) {
    lines.push(`Route: ${route.selectedClientId || "none"} (${route.runtimeFreshness || "unknown"}, ${route.selectionReason || "no reason"})`);
    if (route.sameCanvasClients > 1) lines.push(`Same-canvas clients: ${route.sameCanvasClients}; ignored older/stale: ${(route.olderClientsIgnored || []).length}`);
  }
  if (value?.ok === false) {
    lines.push(`Result: blocked${value.errorCode ? ` (${value.errorCode})` : ""}`);
    if (value.error) lines.push(`Error: ${String(value.error).split("\n")[0]}`);
  } else if (value?.ok === true) {
    lines.push("Result: ok");
  }
  const counts = value?.counts || value?.result?.counts;
  if (counts) {
    const compactCounts = Object.entries(counts)
      .filter(([, item]) => typeof item !== "object")
      .map(([key, item]) => `${key}=${item}`)
      .join(", ");
    if (compactCounts) lines.push(`Counts: ${compactCounts}`);
  }
  const diff = value?.diff;
  if (diff) {
    lines.push(
      `Diff: nodes +${diff.nodes?.counts?.added || 0}/-${diff.nodes?.counts?.removed || 0}/~${diff.nodes?.counts?.updated || 0}, edges +${diff.edges?.counts?.added || 0}/-${diff.edges?.counts?.removed || 0}/~${diff.edges?.counts?.updated || 0}`
    );
  }
  if (value?.rollbackId) lines.push(`Rollback: ${value.rollbackId}`);
  const nodeIds = value?.nodeIds || value?.result?.nodeIds || value?.groupedNodeIds || value?.result?.groupedNodeIds;
  if (Array.isArray(nodeIds) && nodeIds.length) lines.push(`Node ids: ${nodeIds.join(", ")}`);
  const groupId = value?.groupId || value?.result?.groupId;
  if (groupId) lines.push(`Group: ${groupId}`);
  const region = value?.region || value?.result?.region;
  if (region) lines.push(`Region: x=${region.x} y=${region.y} width=${region.width} height=${region.height}`);
  const nodes = value?.nodes || value?.result?.nodes || value?.groupedNodes || value?.result?.groupedNodes;
  if (Array.isArray(nodes) && nodes.length) {
    lines.push("Nodes:");
    for (const node of nodes.slice(0, 12)) {
      const pos = node.position ? ` x=${Math.round(Number(node.position.x) || 0)} y=${Math.round(Number(node.position.y) || 0)}` : "";
      lines.push(`- ${node.id || node.nodeId} ${node.title || ""}${pos}`.trim());
    }
    if (nodes.length > 12) lines.push(`- ... ${nodes.length - 12} more`);
  }
  if (Array.isArray(value?.nextActions) && value.nextActions.length) {
    lines.push("Next actions:");
    for (const item of value.nextActions) lines.push(`- ${item}`);
  }
  return lines.length ? lines.join("\n") : JSON.stringify(value, null, 2);
};

const request = async (path, init) => {
  let response;
  try {
    response = await fetch(new URL(path, bridge), init);
  } catch (error) {
    fail(
      JSON.stringify(
        {
          ok: false,
          errorCode: "BRIDGE_OFFLINE",
          error: error?.message || String(error),
          bridgeUrl: bridge,
          nextActions: ["Start the local bridge server with `npm run start` or `node server/server.mjs`, then retry the command."]
        },
        null,
        2
      )
    );
  }
  const text = await response.text();
  let value;
  try {
    value = text ? JSON.parse(text) : null;
  } catch {
    value = text;
  }
  if (!response.ok) fail(JSON.stringify(value, null, 2));
  return value;
};

const safeRequest = async (path, init) => {
  try {
    const response = await fetch(new URL(path, bridge), init);
    const text = await response.text();
    let value;
    try {
      value = text ? JSON.parse(text) : null;
    } catch {
      value = text;
    }
    if (!response.ok) return { ok: false, status: response.status, value, error: typeof value === "string" ? value : value?.error || JSON.stringify(value) };
    return { ok: true, value };
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
};

const outputMode = { prettySummary: false };

const print = (value) => {
  console.log(outputMode.prettySummary ? summarizeForHuman(value) : JSON.stringify(value, null, 2));
};

const commandTypesFromCapabilities = (capabilities) => {
  if (Array.isArray(capabilities?.commands)) {
    return capabilities.commands.map((item) => (typeof item === "string" ? item : item?.type)).filter(Boolean);
  }
  return [];
};

const preflight = async ({ clientId, timeoutMs }) => {
  const requiredRuntimeCommands = [
    "graph.snapshot", "canvas.summary", "canvas.getElement", "canvas.createTextNode",
    "canvas.updateNodeText", "canvas.moveNodes", "canvas.connectNodes"
  ];
  const checks = {};
  const blockingReasons = [];

  const health = await safeRequest("/health");
  checks.bridgeServer = health.ok ? { ok: true, health: health.value } : { ok: false, errorCode: "BRIDGE_OFFLINE", error: health.error };
  if (!health.ok) {
    blockingReasons.push("BRIDGE_OFFLINE");
    return {
      ok: false,
      bridgeUrl: bridge,
      checks,
      blockingReasons,
      manifestVersion: MANIFEST_VERSION,
      nextActions: ["Start the local bridge server with `npm run start` or `node server/server.mjs`, then rerun preflight."]
    };
  }

  const runtime = await safeRequest("/runtime-version");
  checks.runtimeVersion = runtime.ok ? { ok: true, ...runtime.value } : { ok: false, error: runtime.error };

  const clients = await safeRequest("/clients");
  const liveClients = clients.ok ? clients.value || [] : [];
  const selectedClient = clientId ? liveClients.find((client) => client.clientId === clientId) : liveClients.find((client) => client.selected) || liveClients[0];
  const sameCanvasClients = selectedClient?.canvasId ? liveClients.filter((client) => client.canvasId === selectedClient.canvasId) : [];
  checks.pageClient = {
    ok: Boolean(selectedClient),
    selectedClientId: selectedClient?.clientId,
    selectionReason: selectedClient?.selectionReason,
    connectedClients: liveClients.length,
    sameCanvasClients: sameCanvasClients.length,
    olderClientsIgnored: liveClients
      .filter((client) => client.clientId !== selectedClient?.clientId)
      .slice(0, 10)
      .map((client) => ({ clientId: client.clientId, canvasId: client.canvasId, runtimeFreshness: client.runtimeFreshness })),
    href: selectedClient?.href,
    title: selectedClient?.title
  };
  if (!selectedClient) blockingReasons.push("NO_PAGE_CLIENT");

  const staleClients = runtime.ok
    ? liveClients.filter((client) => client.runtimeVersion && client.runtimeVersion !== runtime.value.version)
    : [];
  checks.runtimeFreshness = {
    ok: runtime.ok && (!selectedClient?.runtimeVersion || selectedClient.runtimeVersion === runtime.value.version),
    serverRuntimeVersion: runtime.value?.version,
    selectedClientRuntimeVersion: selectedClient?.runtimeVersion,
    staleClientIds: staleClients.map((client) => client.clientId)
  };
  if (selectedClient?.runtimeVersion && runtime.ok && selectedClient.runtimeVersion !== runtime.value.version) blockingReasons.push("STALE_RUNTIME");

  let capabilities = null;
  if (selectedClient) {
    const capCommand = { type: "canvas.capabilities", clientId: selectedClient.clientId };
    const cap = await safeRequest("/command", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(capCommand)
    });
    if (cap.ok) {
      const result = await waitForResult(cap.value.id, timeoutMs);
      capabilities = result.result || result;
      const commandTypes = commandTypesFromCapabilities(capabilities);
      const missing = requiredRuntimeCommands.filter((type) => !commandTypes.includes(type));
      checks.capabilities = { ok: missing.length === 0, required: requiredRuntimeCommands, missing, commandCount: commandTypes.length };
      if (missing.length) blockingReasons.push("MISSING_CAPABILITY");
    } else {
      checks.capabilities = { ok: false, error: cap.error };
      blockingReasons.push("MISSING_CAPABILITY");
    }
  } else {
    checks.capabilities = { ok: false, skipped: true, reason: "NO_PAGE_CLIENT" };
  }

  return {
    ok: blockingReasons.length === 0,
    bridgeUrl: bridge,
    selectedClientId: selectedClient?.clientId,
    checks,
    blockingReasons,
    manifestVersion: MANIFEST_VERSION,
    nextActions: blockingReasons.length
      ? blockingReasons.map((reason) => {
          if (reason === "NO_PAGE_CLIENT") return "Open a logged-in RunningHub canvas page with the Chrome extension enabled, allow Chrome local-network access if prompted, then rerun preflight or diagnose-extension.";
          if (reason === "STALE_RUNTIME") return "Reload the RunningHub canvas tab so it picks up the latest bridge runtime.";
          if (reason === "MISSING_CAPABILITY") return "Reload the RunningHub canvas tab and verify the extension injected the latest runtime.";
          return `Resolve ${reason}, then rerun preflight.`;
        })
      : []
  };
};

const waitForResult = async (id, timeoutMs) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const result = await request(`/result?id=${encodeURIComponent(id)}`);
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  fail(`Timed out waiting for command result: ${id}`);
};

const enqueue = async (command, timeoutMs) => {
  command.id ||= randomUUID();
  const accepted = await request("/command", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(command)
  });
  if (!timeoutMs) return accepted;
  const event = await waitForResult(accepted.id, timeoutMs);
  const result = event.result ?? event;
  if (result && typeof result === "object" && !Array.isArray(result)) {
    return { commandRoute: accepted.route, ...result };
  }
  return { commandRoute: accepted.route, result };
};

if (!commandName || commandName === "-h" || commandName === "--help") {
  console.log(usage);
  process.exit(commandName ? 0 : 1);
}

if (args.includes("-h") || args.includes("--help")) {
  console.log(usage);
  process.exit(0);
}

const timeoutMs = Number(option("--timeout", "15000"));
const clientId = option("--client");
const title = option("--title");
const nodeType = option("--node-type");
const subType = option("--sub-type");
const modelName = option("--model-name");
const promptOption = option("--prompt");
const appendPrompt = option("--append-prompt", "");
const promptMergeMode = option("--prompt-merge-mode");
const direction = option("--direction", "both");
const depth = option("--depth", "1");
const maxDepth = option("--max-depth", "8");
const runMaxDepth = option("--run-max-depth", "8");
const dx = option("--dx", "0");
const dy = option("--dy", "0");
const inputIndex = option("--input-index", "1");
const waitMs = option("--wait-ms", "8000");
const pollTimeout = option("--poll-timeout", String(timeoutMs));
const pollInterval = option("--poll-interval", "3000");
const connectToNodeId = option("--connect-to-node");
const urlOption = option("--url");
const nearText = option("--near-text");
const aroundNode = option("--around-node");
const regionDirection = option("--direction", direction);
const width = option("--width");
const height = option("--height");
const padding = option("--padding");
const x = option("--x");
const y = option("--y");
const gapX = option("--gap-x");
const gapY = option("--gap-y");
const limit = option("--limit");
const types = option("--types");
const status = option("--status");
const fields = option("--fields");
const referenceText = option("--text");
const textPreviewLength = option("--text-preview-length");
const dryRun = flag("--dry-run");
const includePosition = flag("--include-position");
const validateReferences = flag("--validate-references");
const allowNoReferences = flag("--allow-no-references");
const allowNoOutput = flag("--allow-no-output");
const requireReferences = flag("--require-references");
const noUrls = flag("--no-urls");
const noTextPreview = flag("--no-text-preview");
const noOutputs = flag("--no-outputs");
const noParams = flag("--no-params");
const includeUrls = flag("--include-urls");
const compact = flag("--compact");
const full = flag("--full");
const summary = flag("--summary");
const prettySummary = flag("--pretty-summary");
const explicitJson = flag("--json");
outputMode.prettySummary = prettySummary && !explicitJson;
const multimodal = flag("--multimodal");
const baseCommand = clientId ? { clientId } : {};
const compactMutation = !full && !explicitJson;

if (commandName === "agent-manifest") {
  print(AGENT_MANIFEST);
} else if (commandName === "preflight") {
  print(await preflight({ clientId, timeoutMs }));
} else if (commandName === "health") {
  print(await request("/health"));
} else if (commandName === "diagnose-extension") {
  print(await request("/diagnose-extension"));
} else if (commandName === "clients") {
  print(await request("/clients"));
} else if (commandName === "events") {
  const since = option("--since", "0");
  print(await request(`/events?since=${encodeURIComponent(since)}`));
} else if (commandName === "snapshot") {
  print(await enqueue({ ...baseCommand, type: "graph.snapshot" }, timeoutMs));
} else if (commandName === "export-workflow") {
  print(await enqueue({ ...baseCommand, type: "canvas.exportWorkflow" }, timeoutMs));
} else if (commandName === "yjs-snapshot") {
  print(await enqueue({ ...baseCommand, type: "canvas.yjsSnapshot" }, timeoutMs));
} else if (commandName === "canvas-summary") {
  print(
    await enqueue(
      {
        ...baseCommand,
        type: "canvas.summary",
        compact: compact || !full,
        full,
        limit: limit === undefined ? undefined : Number(limit),
        types,
        status,
        fields,
        textPreviewLength: textPreviewLength === undefined ? undefined : Number(textPreviewLength),
        includeUrls: full && !noUrls,
        includeTextPreview: !noTextPreview
      },
      timeoutMs
    )
  );
} else if (commandName === "rollback-list") {
  print(await enqueue({ ...baseCommand, type: "canvas.rollbackList" }, timeoutMs));
} else if (commandName === "rollback") {
  const rollbackId = args.shift();
  print(await enqueue({ ...baseCommand, type: "canvas.rollback", rollbackId }, timeoutMs));
} else if (commandName === "capabilities") {
  print(await enqueue({ ...baseCommand, type: "canvas.capabilities" }, timeoutMs));
} else if (commandName === "find-elements") {
  const query = {
    ...jsonOption("--query-json"),
    ...(summary ? { summary: true } : {}),
    ...(fields ? { fields } : {}),
    ...(limit === undefined ? {} : { limit: Number(limit) }),
    ...(noOutputs ? { noOutputs: true } : {}),
    ...(noParams ? { noParams: true } : {}),
    ...(textPreviewLength === undefined ? {} : { textPreviewLength: Number(textPreviewLength) })
  };
  print(await enqueue({ ...baseCommand, type: "canvas.findElements", query }, timeoutMs));
} else if (commandName === "get-element") {
  const id = args.shift();
  if (!id) fail("Missing id");
  print(await enqueue({ ...baseCommand, type: "canvas.getElement", elementId: id }, timeoutMs));
} else if (commandName === "inspect-node-template") {
  const nodeId = args.shift();
  if (!nodeId) fail("Missing nodeId");
  print(await enqueue({ ...baseCommand, type: "canvas.inspectNodeTemplate", nodeId, includePosition }, timeoutMs));
} else if (commandName === "inspect-model-options") {
  print(await enqueue({ ...baseCommand, type: "canvas.inspectModelOptions", nodeType, subType }, timeoutMs));
} else if (commandName === "resolve-model-alias") {
  const modelName = args.shift();
  if (!modelName) fail("Missing modelName");
  print(await enqueue({ ...baseCommand, type: "canvas.resolveModelAlias", modelName, subType }, timeoutMs));
} else if (commandName === "connections") {
  const nodeId = args.shift();
  if (!nodeId) fail("Missing nodeId");
  print(
    await enqueue(
      {
        ...baseCommand,
        type: "canvas.getConnections",
        nodeId,
        direction,
        depth,
        summary,
        compact,
        fields,
        noOutputs,
        noParams,
        includeUrls,
        textPreviewLength: textPreviewLength === undefined ? undefined : Number(textPreviewLength)
      },
      timeoutMs
    )
  );
} else if (commandName === "find-reference-candidates") {
  if (!referenceText) fail("Missing --text");
  print(
    await enqueue(
      {
        ...baseCommand,
        type: "canvas.findReferenceCandidates",
        text: referenceText,
        limit: limit === undefined ? undefined : Number(limit),
        includeUrls,
        textPreviewLength: textPreviewLength === undefined ? undefined : Number(textPreviewLength)
      },
      timeoutMs
    )
  );
} else if (commandName === "describe-image-node") {
  const nodeId = args.shift();
  if (!nodeId) fail("Missing nodeId");
  print(
    await enqueue(
      {
        ...baseCommand,
        type: "canvas.describeImageNode",
        nodeId,
        includeUrls,
        textPreviewLength: textPreviewLength === undefined ? undefined : Number(textPreviewLength)
      },
      timeoutMs
    )
  );
} else if (commandName === "create-text-workflow") {
  const config = configOption();
  print(await enqueue({ ...baseCommand, type: "canvas.createTextWorkflow", config, dryRun }, timeoutMs));
} else if (commandName === "create-text-node") {
  const config = configOption();
  print(await enqueue({ ...baseCommand, type: "canvas.createTextNode", config, dryRun }, timeoutMs));
} else if (commandName === "create-text-nodes") {
  const config = configOption([]);
  print(
    await enqueue(
      {
        ...baseCommand,
        type: "canvas.createTextNodes",
        config,
        x: x === undefined ? undefined : Number(x),
        y: y === undefined ? undefined : Number(y),
        gapX: gapX === undefined ? undefined : Number(gapX),
        gapY: gapY === undefined ? undefined : Number(gapY),
        dryRun
      },
      timeoutMs
    )
  );
} else if (commandName === "suggest-empty-region") {
  print(
    await enqueue(
      {
        ...baseCommand,
        type: "canvas.suggestEmptyRegion",
        nearText,
        aroundNode,
        direction: regionDirection,
        width: width === undefined ? undefined : Number(width),
        height: height === undefined ? undefined : Number(height),
        padding: padding === undefined ? undefined : Number(padding)
      },
      timeoutMs
    )
  );
} else if (commandName === "group-elements") {
  const style = jsonOption("--style-json", {});
  const ids = args.splice(0);
  if (!ids.length) fail("Missing id");
  print(
    await enqueue(
      {
        ...baseCommand,
        type: "canvas.groupElements",
        ids,
        title,
        padding: padding === undefined ? undefined : Number(padding),
        style,
        dryRun
      },
      timeoutMs
    )
  );
} else if (commandName === "create-node") {
  const config = configOption();
  print(await enqueue({ ...baseCommand, type: "canvas.createNode", config, dryRun }, timeoutMs));
} else if (commandName === "create-video-node") {
  const config = configOption();
  print(await enqueue({ ...baseCommand, type: "canvas.createVideoNode", config: { ...config, ...(multimodal ? { subType: "multimodal-video" } : {}) }, dryRun }, timeoutMs));
} else if (commandName === "create-image-node") {
  const config = configOption();
  print(await enqueue({ ...baseCommand, type: "canvas.createImageNode", config, dryRun }, timeoutMs));
} else if (commandName === "prepare-image-workflow") {
  const config = configOption();
  print(await enqueue({ ...baseCommand, type: "canvas.prepareImageWorkflow", config, dryRun, compactMutation }, timeoutMs));
} else if (commandName === "create-reference-image-node") {
  const config = configOption();
  print(await enqueue({ ...baseCommand, type: "canvas.createReferenceImageNode", config, dryRun }, timeoutMs));
} else if (commandName === "upload-reference-image") {
  const nodeId = args.shift();
  if (!nodeId) fail("Missing nodeId");
  const filePath = option("--file");
  if (!filePath) fail("Missing --file");
  const name = filePath.split(/[\\/]/).pop() || "reference.jpg";
  const suffix = name.split(".").pop()?.toLowerCase();
  const type = suffix === "png" ? "image/png" : suffix === "webp" ? "image/webp" : "image/jpeg";
  const base64 = readFileSync(filePath).toString("base64");
  print(
    await enqueue(
      {
        ...baseCommand,
        type: "canvas.uploadReferenceImage",
        nodeId,
        inputIndex: Number(inputIndex),
        waitMs: Number(waitMs),
        file: { name, type, base64 }
      },
      timeoutMs
    )
  );
} else if (commandName === "upload-local-reference-image") {
  const filePath = option("--file");
  if (!filePath) fail("Missing --file");
  const config = configOption();
  const name = filePath.split(/[\\/]/).pop() || "reference.jpg";
  const suffix = name.split(".").pop()?.toLowerCase();
  const type = suffix === "png" ? "image/png" : suffix === "webp" ? "image/webp" : "image/jpeg";
  const base64 = readFileSync(filePath).toString("base64");
  print(
    await enqueue(
      {
        ...baseCommand,
        type: "canvas.uploadLocalReferenceImage",
        config,
        inputIndex: Number(inputIndex),
        waitMs: Number(waitMs),
        connectToNodeId,
        file: { name, type, base64 }
      },
      timeoutMs
    )
  );
} else if (commandName === "create-reference-from-url") {
  if (!urlOption) fail("Missing --url");
  const config = configOption();
  print(
    await enqueue(
      {
        ...baseCommand,
        type: "canvas.createReferenceFromUrl",
        url: urlOption,
        config,
        targetNodeId: connectToNodeId,
        dryRun
      },
      timeoutMs
    )
  );
} else if (commandName === "prepare-video-node") {
  const nodeId = args.shift();
  if (!nodeId) fail("Missing nodeId");
  const referenceNodeIds = jsonOption("--reference-node-ids-json", undefined);
  print(
    await enqueue(
      {
        ...baseCommand,
        type: "canvas.prepareVideoNode",
        nodeId,
        maxDepth: Number(maxDepth),
        prompt: promptOption,
        appendPrompt,
        promptMergeMode,
        referenceNodeIds,
        dryRun
      },
      timeoutMs
    )
  );
} else if (commandName === "validate-video-run") {
  const nodeId = args.shift();
  if (!nodeId) fail("Missing nodeId");
  print(await enqueue({ ...baseCommand, type: "canvas.validateVideoRun", nodeId, requireReferences: !allowNoReferences }, timeoutMs));
} else if (commandName === "validate-node-run") {
  const nodeId = args.shift();
  if (!nodeId) fail("Missing nodeId");
  print(await enqueue({ ...baseCommand, type: "canvas.validateNodeRun", nodeId, requireReferences }, timeoutMs));
} else if (commandName === "generate-video-node") {
  const nodeId = args.shift();
  if (!nodeId) fail("Missing nodeId");
  const referenceNodeIds = jsonOption("--reference-node-ids-json", undefined);
  print(
    await enqueue(
      {
        ...baseCommand,
        type: "canvas.generateVideoNode",
        nodeId,
        maxDepth: Number(maxDepth),
        runMaxDepth: Number(runMaxDepth),
        prompt: promptOption,
        appendPrompt,
        promptMergeMode,
        referenceNodeIds,
        dryRun
      },
      timeoutMs
    )
  );
} else if (commandName === "run-node") {
  const nodeId = args.shift();
  if (!nodeId) fail("Missing nodeId");
  print(await enqueue({ ...baseCommand, type: "canvas.runNode", nodeId, maxDepth: Number(maxDepth), validateReferences, dryRun }, timeoutMs));
} else if (commandName === "poll-node-result") {
  const nodeId = args.shift();
  if (!nodeId) fail("Missing nodeId");
  print(
    await enqueue(
      {
        ...baseCommand,
        type: "canvas.pollNodeResult",
        nodeId,
        timeoutMs: Number(pollTimeout),
        intervalMs: Number(pollInterval),
        requireOutput: !allowNoOutput
      },
      Math.max(timeoutMs, Number(pollTimeout) + 5000)
    )
  );
} else if (commandName === "poll-task-result") {
  const taskId = args.shift();
  if (!taskId) fail("Missing taskId");
  print(
    await enqueue(
      {
        ...baseCommand,
        type: "canvas.pollTaskResult",
        taskId,
        timeoutMs: Number(pollTimeout),
        intervalMs: Number(pollInterval),
        requireOutput: !allowNoOutput
      },
      Math.max(timeoutMs, Number(pollTimeout) + 5000)
    )
  );
} else if (commandName === "connect-nodes") {
  const source = args.shift();
  const target = args.shift();
  if (!source) fail("Missing sourceId");
  if (!target) fail("Missing targetId");
  print(await enqueue({ ...baseCommand, type: "canvas.connectNodes", source, target, dryRun }, timeoutMs));
} else if (commandName === "update-node-model") {
  const nodeId = args.shift();
  const modelCode = args.shift();
  if (!nodeId) fail("Missing nodeId");
  if (!modelCode) fail("Missing modelCode");
  print(await enqueue({ ...baseCommand, type: "canvas.updateNodeModel", nodeId, modelCode, modelName, dryRun }, timeoutMs));
} else if (commandName === "update-node-params") {
  const nodeId = args.shift();
  if (!nodeId) fail("Missing nodeId");
  const params = jsonOption("--params-json");
  print(await enqueue({ ...baseCommand, type: "canvas.updateNodeParams", nodeId, params, dryRun, compactMutation }, timeoutMs));
} else if (commandName === "update-node") {
  const nodeId = args.shift();
  if (!nodeId) fail("Missing nodeId");
  const patch = jsonOption("--patch-json");
  const data = jsonOption("--data-json", undefined);
  print(await enqueue({ ...baseCommand, type: "canvas.updateNode", nodeId, patch, data, title, dryRun, compactMutation }, timeoutMs));
} else if (commandName === "update-node-text") {
  const nodeId = args.shift();
  const text = args.shift();
  if (!nodeId) fail("Missing nodeId");
  if (text === undefined) fail("Missing text");
  print(await enqueue({ ...baseCommand, type: "canvas.updateNodeText", nodeId, text, title, dryRun, compactMutation }, timeoutMs));
} else if (commandName === "move-node") {
  const nodeId = args.shift();
  const x = args.shift();
  const y = args.shift();
  if (!nodeId) fail("Missing nodeId");
  if (x === undefined) fail("Missing x");
  if (y === undefined) fail("Missing y");
  print(await enqueue({ ...baseCommand, type: "canvas.updateNodePosition", nodeId, x, y, dryRun }, timeoutMs));
} else if (commandName === "move-nodes") {
  const positions = jsonOption("--positions-json", {});
  const ids = args.splice(0);
  if (!ids.length) fail("Missing id");
  print(await enqueue({ ...baseCommand, type: "canvas.moveNodes", ids, dx, dy, positions, dryRun }, timeoutMs));
} else if (commandName === "delete-elements") {
  const ids = args.splice(0);
  if (!ids.length) fail("Missing id");
  print(await enqueue({ ...baseCommand, type: "canvas.deleteElements", ids, dryRun }, timeoutMs));
} else if (commandName === "get-canvas-detail") {
  const canvasId = args.shift();
  if (!canvasId) fail("Missing canvasId");
  const body = bodyOption({ id: canvasId });
  print(await enqueue({ ...baseCommand, type: "canvas.getDetail", canvasId, body }, timeoutMs));
} else if (commandName === "workflow-list") {
  const canvasId = args.shift();
  if (!canvasId) fail("Missing canvasId");
  const body = bodyOption({ canvasId });
  print(await enqueue({ ...baseCommand, type: "canvas.workflowList", canvasId, body }, timeoutMs));
} else if (commandName === "api-post") {
  const endpoint = args.shift();
  if (!endpoint) fail("Missing endpoint");
  const body = bodyOption({});
  print(await enqueue({ ...baseCommand, type: "api.post", endpoint, body }, timeoutMs));
} else if (commandName === "result") {
  const id = args.shift();
  if (!id) fail("Missing commandId");
  print(await request(`/result?id=${encodeURIComponent(id)}`));
} else {
  fail(`Unknown command: ${commandName}\n\n${usage}`);
}
