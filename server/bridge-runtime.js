// Modified 2026-09-27: international routing, guarded editing, current sync protocol.
(() => {
  const SITE_POLICY = globalThis.RHCanvasSitePolicy;
  if (!SITE_POLICY?.parseCanvas(location.href)) return;
  const ACCESS = window.__RUNNINGHUB_CANVAS_BRIDGE_ACCESS__ || {};
  const RUNTIME_VERSION = window.__RUNNINGHUB_CANVAS_BRIDGE_EXPECTED_VERSION__ || "dev";
  const LOADER_VERSION = window.__RUNNINGHUB_CANVAS_BRIDGE_LOADER_VERSION__ || "unknown";
  const PROTOCOL_VERSION = window.__RUNNINGHUB_CANVAS_BRIDGE_PROTOCOL_VERSION__ || "1";
  if (window.__RUNNINGHUB_CANVAS_BRIDGE_INSTALLED__) {
    if (window.__RUNNINGHUB_CANVAS_BRIDGE_VERSION__ === RUNTIME_VERSION) return;
    try {
      window.__RUNNINGHUB_CANVAS_BRIDGE_CLEANUP__?.();
    } catch {}
  }
  window.__RUNNINGHUB_CANVAS_BRIDGE_INSTALLED__ = true;
  window.__RUNNINGHUB_CANVAS_BRIDGE_VERSION__ = RUNTIME_VERSION;

  const BRIDGE = window.__RUNNINGHUB_CANVAS_BRIDGE_URL__ || "http://127.0.0.1:18765";
  const CLIENT_ID = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  let seq = 0;
  let pollTimer;
  let originalFetch;
  let OriginalXHR;
  let OriginalWebSocket;

  const safeJson = (value) => {
    try {
      return JSON.parse(JSON.stringify(value));
    } catch {
      return String(value);
    }
  };

  const errorCodeFromError = (error) => {
    const message = String(error?.message || error || "");
    if (/Node not found|Element not found/i.test(message)) return "NODE_NOT_FOUND";
    if (/Rendered node not found/i.test(message)) return "NO_RENDERED_NODE";
    if (/No image input accepted file/i.test(message)) return "UPLOAD_INPUT_NOT_FOUND";
    if (/Timed out/i.test(message)) return "TIMEOUT";
    if (/validation failed|VALIDATION_FAILED/i.test(message)) return "VALIDATION_FAILED";
    if (/sourceUrl is required|url is required/i.test(message)) return "MISSING_REQUIRED_FIELD";
    if (/Rh-Accesstoken/i.test(message)) return "AUTH_TOKEN_NOT_FOUND";
    return "COMMAND_FAILED";
  };

  const shouldCapture = () => false; // No passive capture of private prompts or API payloads.

  const redactHeaders = (headers) => {
    const out = {};
    try {
      const h = new Headers(headers || {});
      for (const [key, value] of h.entries()) {
        out[key] = /authorization|token|cookie/i.test(key) ? "[REDACTED]" : value;
      }
    } catch {}
    return out;
  };

  const redactUrl = (url) => {
    try {
      const parsed = new URL(String(url), location.origin);
      for (const key of [...parsed.searchParams.keys()]) {
        if (/authorization|token|cookie/i.test(key)) parsed.searchParams.set(key, "[REDACTED]");
      }
      return parsed.pathname + parsed.search;
    } catch {
      return String(url).replace(/([?&][^=]*(?:authorization|token|cookie)[^=]*=)[^&]*/gi, "$1[REDACTED]");
    }
  };

  const postEvent = (event) => {
    const payload = {
      clientId: CLIENT_ID,
      seq: ++seq,
      ts: Date.now(),
      href: location.href,
      title: document.title,
      runtimeVersion: RUNTIME_VERSION,
      loaderVersion: LOADER_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      runtimeCommands: window.__RUNNINGHUB_CANVAS_BRIDGE__?.commands,
      ...event
    };
    fetch(`${BRIDGE}/events`, {
      method: "POST",
      mode: "cors",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }).catch(() => {});
  };

  const sessionToken = () => {
    const cookie = document.cookie.split(";").map((part) => part.trim())
      .find((part) => part.startsWith("Rh-Accesstoken="));
    let cookieValue = cookie ? cookie.slice("Rh-Accesstoken=".length) : "";
    try { cookieValue = decodeURIComponent(cookieValue); } catch {}
    const candidates = [cookieValue, localStorage.getItem("Rh-Accesstoken") || ""].filter(Boolean);
    for (const value of candidates) {
      try {
        const part = value.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
        const payload = JSON.parse(atob(part.padEnd(Math.ceil(part.length / 4) * 4, "=")));
        if (payload.exp && Date.now() >= payload.exp * 1000) continue;
      } catch {}
      return value;
    }
    throw new Error("Rh-Accesstoken unavailable or expired");
  };
  const sessionUserId = (token) => {
    try {
      const part = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
      return String(JSON.parse(atob(part.padEnd(Math.ceil(part.length / 4) * 4, "="))).sub || "");
    } catch { return ""; }
  };
  const authHeaders = () => {
    const headers = { "Content-Type": "application/json", version: "1.0.0" };
    try {
      const token = sessionToken();
      if (token) headers.Authorization = `Bearer ${token}`;
      const teamId = localStorage.getItem("currentTeamId");
      if (teamId && teamId !== "0" && teamId !== "null") headers["X-Team-Id"] = teamId;
    } catch {}
    return headers;
  };

  const summarizeGraph = () => ({
    canvasId: SITE_POLICY.parseCanvas(location.href)?.canvasId,
    nodes: Array.from(document.querySelectorAll(".react-flow__node, .vue-flow__node")).map((el) => ({
      dataId: el.getAttribute("data-id"),
      className: String(el.className),
      text: (el.innerText || el.textContent || "").trim().slice(0, 500),
      rect: (() => {
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      })()
    })),
    edges: Array.from(document.querySelectorAll(".react-flow__edge, .vue-flow__edge")).map((el) => ({
      dataId: el.getAttribute("data-id"),
      className: String(el.className)
    }))
  });

  const postJson = async (endpoint, body, maxChars) => {
    const apiOrigin = SITE_POLICY.parseCanvas(location.href).apiOrigin;
    const target = new URL(endpoint, apiOrigin);
    if (target.origin !== apiOrigin || !target.pathname.startsWith("/canvas/")) throw new Error("Cross-site API request blocked");
    const response = await fetch(target, {
      method: "POST",
      headers: authHeaders(),
      credentials: "include",
      body: JSON.stringify(body || {})
    });
    const text = await response.text();
    return {
      ok: response.ok,
      status: response.status,
      text: text.slice(0, maxChars || 120000)
    };
  };

  const parseJsonText = (text) => {
    try {
      return text ? JSON.parse(text) : null;
    } catch {
      return null;
    }
  };

  const taskInfoFromRunResponse = (response) => {
    const body = parseJsonText(response?.text);
    return {
      ok: Boolean(response?.ok && body?.code === 0),
      httpStatus: response?.status,
      code: body?.code,
      msg: body?.msg,
      taskId: body?.data?.taskId,
      status: body?.data?.status,
      nodeCount: body?.data?.nodeCount,
      targetType: body?.data?.targetType,
      targetName: body?.data?.targetName
    };
  };

  let yjsModulePromise;
  const loadYjs = () => yjsModulePromise ||= import(`${BRIDGE}/vendor/yjs.js`);

  const toYValue = (Y, value) => {
    if (Array.isArray(value)) {
      const array = new Y.Array();
      array.push(value.map((item) => toYValue(Y, item)));
      return array;
    }
    if (value && typeof value === "object" && !(value instanceof Date)) {
      const map = new Y.Map();
      Object.entries(value).forEach(([key, item]) => map.set(key, toYValue(Y, item)));
      return map;
    }
    return value;
  };

  let activeCommandAccess = null;
  let activeCommand = null;
  const withCanvasYjs = async (fn, { write = false } = {}) => {
    const site = SITE_POLICY.parseCanvas(location.href);
    if (!site) throw new Error("Unsupported canvas URL");
    if (write) {
      const denied = SITE_POLICY.authorizeCommand({ type: "canvas.updateNode" }, activeCommandAccess || ACCESS, site);
      if (denied) throw new Error(denied);
    }
    const { Y, WebsocketProvider, decoding, messageYjsSyncStep1 } = await loadYjs();
    const { canvasId } = site;
    const token = sessionToken();
    const requestData = async (endpoint, body) => {
      const response = await fetch(new URL(endpoint, SITE_POLICY.parseCanvas(location.href).apiOrigin), {
        method: "POST", headers: authHeaders(), credentials: "include", body: JSON.stringify(body)
      });
      if (!response.ok) throw new Error(`Canvas request failed (${response.status})`);
      const payload = await response.json();
      if (payload.code !== undefined && Number(payload.code) !== 0) throw new Error(`Canvas request rejected (${payload.code})`);
      return payload.data ?? payload;
    };
    const detail = await requestData("/canvas/getCanvasDetail", { id: canvasId });
    const userId = sessionUserId(token) || String(detail.user_id || detail.userId || "");
    if (!userId) throw new Error("Current account identity unavailable");
    const permissionBody = { canvasId, userId, includeYjsGeneration: true };
    const teamId = authHeaders()["X-Team-Id"];
    if (teamId) permissionBody.teamId = teamId;
    const permission = await requestData("/canvas/checkUserIdByCanvasId", permissionBody);
    const generation = permission.yjsGeneration;
    if (generation != null && (!Number.isSafeInteger(generation) || generation <= 0)) throw new Error("Invalid canvas generation metadata");
    if (permission.yjsGenerationRequired && generation == null) throw new Error("Missing required canvas generation");
    if (write && (permission.canvasLocked || permission.yjsDivergenceRepair?.roomWriteBlocked)) throw new Error("Canvas is locked for writes");
    const doc = new Y.Doc();
    const provider = new WebsocketProvider(site.websocketUrl, canvasId, doc, {
      connect: false, disableBc: true,
      params: {
        roomId: canvasId, userId, token, type: "canvas", version: "1.0.0",
        readOnly: write ? "0" : "1", durableAck: "0", durableFlow: "0",
        yjsClientId: String(doc.clientID), ...(generation == null ? {} : { generation: String(generation) })
      }
    });
    // A read must never upload a state update, including the sync-step-2 reply.
    if (!write) {
      doc.off("update", provider._updateHandler);
      const syncHandler = provider.messageHandlers[0];
      provider.messageHandlers[0] = (encoder, decoder, ...args) => {
        if (decoding.peekVarUint(decoder) === messageYjsSyncStep1) {
          decoding.readVarUint(decoder);
          decoding.readVarUint8Array(decoder);
          return;
        }
        return syncHandler(encoder, decoder, ...args);
      };
    }
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Timed out waiting for canvas sync")), 12000);
        provider.on("sync", (synced) => { if (synced) { clearTimeout(timer); resolve(); } });
        provider.on("connection-close", (event) => {
          if (event?.code >= 4000) { clearTimeout(timer); reject(new Error(`Canvas socket rejected (${event.code})`)); }
        });
        provider.connect();
      });
      const root = doc.getMap("canvas");
      const content = root.get("canvas_content");
      const nodes = content?.get?.("nodes");
      const edges = content?.get?.("edges");
      if (!(nodes instanceof Y.Array) || !(edges instanceof Y.Array)) {
        throw new Error("CANVAS_SCHEMA_UNSUPPORTED: missing synchronized nodes/edges; nothing was initialized");
      }
      const value = await fn({ Y, doc, root, content, nodes, edges, canvasId, detail });
      if (write) await new Promise((resolve) => setTimeout(resolve, 1200));
      return value;
    } finally {
      provider.destroy();
      doc.destroy();
    }
  };

  const yArrayToJson = (array) => {
    if (!array) return [];
    return Array.isArray(array.toJSON?.()) ? array.toJSON() : [];
  };

  const rollbackStack = [];

  const canvasSnapshotFromContext = ({ nodes, edges, canvasId }) => ({
    canvasId,
    nodes: yArrayToJson(nodes),
    edges: yArrayToJson(edges)
  });

  const diffById = (beforeItems, afterItems) => {
    const before = new Map(beforeItems.map((item) => [item?.id, item]).filter(([id]) => id));
    const after = new Map(afterItems.map((item) => [item?.id, item]).filter(([id]) => id));
    const added = [];
    const removed = [];
    const updated = [];

    for (const [id, item] of after.entries()) {
      if (!before.has(id)) {
        added.push(id);
        continue;
      }
      const beforeJson = JSON.stringify(before.get(id));
      const afterJson = JSON.stringify(item);
      if (beforeJson !== afterJson) {
        updated.push({ id, before: before.get(id), after: item });
      }
    }
    for (const id of before.keys()) {
      if (!after.has(id)) removed.push(id);
    }
    return {
      added,
      removed,
      updated,
      counts: { added: added.length, removed: removed.length, updated: updated.length }
    };
  };

  const diffCanvasSnapshots = (before, after) => ({
    nodes: diffById(before.nodes || [], after.nodes || []),
    edges: diffById(before.edges || [], after.edges || []),
    before: { nodes: before.nodes?.length || 0, edges: before.edges?.length || 0 },
    after: { nodes: after.nodes?.length || 0, edges: after.edges?.length || 0 }
  });

  const compactCanvasDiff = (diff = {}) => ({
    nodes: {
      added: diff.nodes?.added || [],
      removed: diff.nodes?.removed || [],
      updated: (diff.nodes?.updated || []).map(({ id, before, after }) => ({
        id,
        type: after?.type || before?.type,
        title: getNodeTitle(after || before),
        status: after?.data?.status,
        changedFields: changedFieldPaths(before, after),
        text: compactTextChange(textFromNode(before), textFromNode(after))
      })),
      counts: diff.nodes?.counts || { added: 0, removed: 0, updated: 0 }
    },
    edges: {
      added: diff.edges?.added || [],
      removed: diff.edges?.removed || [],
      updated: (diff.edges?.updated || []).map(({ id, before, after }) => ({
        id,
        source: after?.source || before?.source,
        target: after?.target || before?.target,
        changedFields: changedFieldPaths(before, after)
      })),
      counts: diff.edges?.counts || { added: 0, removed: 0, updated: 0 }
    },
    before: diff.before,
    after: diff.after
  });

  const compactTextChange = (before = "", after = "") => ({
    beforeLength: String(before || "").length,
    afterLength: String(after || "").length,
    changed: String(before || "") !== String(after || "")
  });

  const changedFieldPaths = (before, after, prefix = "", out = []) => {
    if (Object.is(before, after)) return out;
    if (
      before === null ||
      after === null ||
      typeof before !== "object" ||
      typeof after !== "object" ||
      Array.isArray(before) ||
      Array.isArray(after)
    ) {
      if (prefix) out.push(prefix);
      return out;
    }
    const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
    for (const key of keys) {
      changedFieldPaths(before?.[key], after?.[key], prefix ? `${prefix}.${key}` : key, out);
    }
    return [...new Set(out)].slice(0, 80);
  };

  const compactMutationPayload = ({ value, diff, command } = {}) => {
    const result = value && typeof value === "object" ? { ...value } : value;
    if (result?.node) {
      result.node = compactNodeSummary(result.node, { includeUrls: false, includeTextPreview: true, textPreviewLength: command?.textPreviewLength || 120 });
    }
    if (typeof result?.text === "string") {
      result.textLength = result.text.length;
      delete result.text;
    }
    if (result?.params && typeof result.params === "object") {
      result.changedParamKeys = Object.keys(result.params);
      delete result.params;
    }
    if (Array.isArray(result?.nodes)) {
      result.nodes = result.nodes.map((node) => compactNodeSummary(node, { includeUrls: false, includeTextPreview: true, textPreviewLength: command?.textPreviewLength || 120 }));
    }
    if (Array.isArray(result?.edges)) result.edges = result.edges.map((edge) => compactEdgeSummary(edge));
    if (Array.isArray(result?.addedEdges)) result.addedEdges = result.addedEdges.map((edge) => typeof edge === "string" ? edge : compactEdgeSummary(edge));
    return {
      result,
      diff: compactCanvasDiff(diff),
      generationTriggered: false,
      preserved: {
        edgesUnchanged: (diff.edges?.counts?.added || 0) === 0 && (diff.edges?.counts?.removed || 0) === 0 && (diff.edges?.counts?.updated || 0) === 0,
        runStateUnchanged: true
      }
    };
  };

  const makePreviewContext = (Y, snapshot) => {
    const doc = new Y.Doc();
    const root = doc.getMap("canvas");
    const content = new Y.Map();
    const nodes = new Y.Array();
    const edges = new Y.Array();
    nodes.push((snapshot.nodes || []).map((node) => toYValue(Y, node)));
    edges.push((snapshot.edges || []).map((edge) => toYValue(Y, edge)));
    content.set("type", "canvas");
    content.set("nodes", nodes);
    content.set("edges", edges);
    root.set("canvas_content", content);
    return { Y, doc, root, content, nodes, edges, canvasId: snapshot.canvasId, preview: true };
  };

  const rememberRollback = ({ command, before, after, diff }) => {
    const rollbackId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    rollbackStack.unshift({
      rollbackId,
      commandId: command.id,
      commandType: command.type,
      href: location.href,
      ts: Date.now(),
      before,
      after,
      diff
    });
    if (rollbackStack.length > 20) rollbackStack.splice(20);
    return rollbackId;
  };

  const FEATURES = globalThis.RHCanvasFeatures;
  const withCanvasMutation = async (command, mutate) =>
    withCanvasYjs(async (ctx) => {
      const before = canvasSnapshotFromContext(ctx);
      const expected = command.expectedRevisions || activeCommand?.expectedRevisions || {};
      await FEATURES.checkRevisions(before,expected);
      for(const id of Object.keys(expected)) {
        if(FEATURES.canonical(FEATURES.nodeState(before,id)) !== FEATURES.canonical(FEATURES.nodeState(canvasSnapshotFromContext(ctx),id))) throw new Error(`EDIT_CONFLICT: reread node ${id}`);
      }
      if (command.dryRun) {
        const preview = makePreviewContext(ctx.Y, before);
        let value;
        try {
          value = await mutate(preview);
          const after = canvasSnapshotFromContext(preview);
          const diff = diffCanvasSnapshots(before, after);
          if (command.compactMutation) {
            const compact = compactMutationPayload({ value, diff, command });
            return {
              dryRun: true,
              applied: false,
              ...compact
            };
          }
          return {
            dryRun: true,
            applied: false,
            result: value,
            diff
          };
        } finally {
          preview.doc.destroy();
        }
      }

      const value = await mutate(ctx);
      const after = canvasSnapshotFromContext(ctx);
      const diff = diffCanvasSnapshots(before, after);
      const rollbackId = rememberRollback({ command, before, after, diff });
      if (command.compactMutation) {
        const compact = compactMutationPayload({ value, diff, command });
        return {
          dryRun: false,
          applied: true,
          rollbackId,
          ...compact
        };
      }
      return {
        dryRun: false,
        applied: true,
        rollbackId,
        result: value,
        diff
      };
    }, { write: !command.dryRun });

  const replaceCanvasSnapshot = async ({ snapshot, expected } = {}) => {
    if (!snapshot || !Array.isArray(snapshot.nodes) || !Array.isArray(snapshot.edges)) {
      throw new Error("snapshot with nodes and edges is required");
    }
    return withCanvasYjs(({ Y, doc, nodes, edges, canvasId }) => {
      const before = { canvasId, nodes: yArrayToJson(nodes), edges: yArrayToJson(edges) };
      if (!expected || JSON.stringify(before) !== JSON.stringify(expected)) throw new Error("ROLLBACK_CONFLICT: canvas changed after the operation");
      doc.transact(() => {
        if (edges.length) edges.delete(0, edges.length);
        if (nodes.length) nodes.delete(0, nodes.length);
        nodes.push(snapshot.nodes.map((node) => toYValue(Y, node)));
        edges.push(snapshot.edges.map((edge) => toYValue(Y, edge)));
      });
      const after = { canvasId, nodes: yArrayToJson(nodes), edges: yArrayToJson(edges) };
      return { applied: true, diff: diffCanvasSnapshots(before, after) };
    }, { write: true });
  };

  const rollbackCanvas = async ({ rollbackId } = {}) => {
    const entry = rollbackId ? rollbackStack.find((item) => item.rollbackId === rollbackId) : rollbackStack[0];
    if (!entry) throw new Error(rollbackId ? `Rollback not found: ${rollbackId}` : "No rollback entry available");
    const result = await replaceCanvasSnapshot({ snapshot: entry.before, expected: entry.after });
    return { rollbackId: entry.rollbackId, commandId: entry.commandId, commandType: entry.commandType, ...result };
  };

  const COMMAND_CAPABILITIES = [
    {type:'canvas.preflight',description:'Validate live constraints and exact expected inputs; return graph digest.'},
    {type:'canvas.prepareShots',description:'Prepare multiple model nodes, references and positions atomically.'},
    {type:'canvas.autoLayout',description:'Lay out selected ungrouped nodes avoiding existing obstacles.'},
    {type:'canvas.listModels',description:'Read current platform model catalog.'},
    {type:'canvas.modelSchema',description:'Read live parameter options and constraints for a model.'},
    {type:'canvas.searchAssets',description:'Search or browse the platform asset drawer.'},
    {type:'canvas.addAsset',description:'Reuse a searched media asset without uploading.'},
    {type:'canvas.inspectReferences',description:'Inspect actual image, video and audio outputs.'},
    {type:'canvas.bindReferences',description:'Bind native reference slots and edges in one edit.'},
    {type:'canvas.batchUpdate',description:'Apply a revision-checked batch of node edits.'},
    { type: "canvas.cloneTemplate", description: "Clone an empty configured model template without inputs or results." },
    {
      type: "graph.snapshot",
      description: "Read DOM-level Vue Flow nodes and edges from the visible page."
    },
    {
      type: "canvas.yjsSnapshot",
      description: "Read canonical Yjs canvas nodes and edges."
    },
    {
      type: "canvas.summary",
      description: "Return a compact Agent-oriented canvas summary with node status, media URLs, and connection counts."
    },
    {
      type: "canvas.rollbackList",
      description: "List recent rollback points created by mutating commands."
    },
    {
      type: "canvas.rollback",
      description: "Restore the canvas to a previous rollback point. Uses the latest point by default."
    },
    {
      type: "canvas.restoreSnapshot",
      description: "Restore nodes and edges from an explicit snapshot."
    },
    {
      type: "canvas.findElements",
      description: "Find nodes and edges by id, type, text/title query, or position bounds.",
      params: {
        kind: "all | nodes | edges",
        q: "case-insensitive text query over node title/text/type/id and edge id/source/target",
        ids: "array of node or edge ids",
        type: "node or edge type",
        bounds: "{ xMin, xMax, yMin, yMax } for node positions",
        includeEdges: "when kind is nodes, include edges connected to matched nodes"
      }
    },
    {
      type: "canvas.getElement",
      description: "Return one node or edge by id."
    },
    {
      type: "canvas.findReferenceCandidates",
      description: "Find reusable rh-image reference candidates by semantic title, label, prompt preview, or upstream lineage."
    },
    {
      type: "canvas.describeImageNode",
      description: "Return compact identity/provenance for one rh-image node without media URLs by default."
    },
    {
      type: "canvas.inspectNodeTemplate",
      description: "Extract a reusable create-node template from one existing canvas node."
    },
    {
      type: "canvas.getConnections",
      description: "Return upstream/downstream node and edge relationships for one or more nodes."
    },
    {
      type: "canvas.createTextNode",
      description: "Create one rh-text node. Supports dryRun."
    },
    {
      type: "canvas.createTextNodes",
      description: "Create multiple rh-text nodes as one canvas mutation with one rollback id. Supports dryRun."
    },
    {
      type: "canvas.suggestEmptyRegion",
      description: "Suggest a conservative empty canvas region near matching text, around a node, or beyond existing content."
    },
    {
      type: "canvas.groupElements",
      description: "Create a group around explicitly provided node ids. Supports dryRun."
    },
    {
      type: "canvas.createNode",
      description: "Create one generic canvas node from a provided node template, type, position, and data. Supports dryRun."
    },
    {
      type: "canvas.createVideoNode",
      description: "Create one RunningHub native text-to-video rh-video node. Supports dryRun and optional upstream connection."
    },
    {
      type: "canvas.createImageNode",
      description: "Create one RunningHub native text-to-image rh-image node. Supports dryRun."
    },
    {
      type: "canvas.prepareImageWorkflow",
      description: "Atomically create or update one prompt text node, one image generation node, and reference edges without running generation. Supports dryRun."
    },
    {
      type: "canvas.createReferenceImageNode",
      description: "Create one uploaded/reference rh-image node with sourceObjects and optionally connect it to a target node. Supports dryRun."
    },
    {
      type: "canvas.createReferenceFromUrl",
      description: "Create a directly usable reference image node from an existing image URL and return primaryReference."
    },
    {
      type: "canvas.uploadReferenceImage",
      description: "Inject a local image file payload into the selected/target RunningHub image input so the page uploads it and creates the native reference image node."
    },
    {
      type: "canvas.uploadLocalReferenceImage",
      description: "Upload an image through native storage and create a reusable reference node."
    },
    { type: "canvas.uploadLocalMedia", description: "Upload verified local image, video or audio from a scoped local file ticket, then create the native reference node." },
    {
      type: "canvas.runNode",
      description: "Call /canvas/task/run for one node using its upstream connected subgraph."
    },
    {
      type: "canvas.pollNodeResult",
      description: "Poll one canvas node until it has outputs or reaches a terminal status."
    },
    {
      type: "canvas.pollTaskResult",
      description: "Poll the canvas for outputs matching a RunningHub taskId."
    },
    {
      type: "canvas.prepareVideoNode",
      description: "Agent-friendly video preparation: collect upstream text and image outputs into effective rh-video params without generating."
    },
    {
      type: "canvas.validateVideoRun",
      description: "Validate that an rh-video node has effective prompt, multimodal model settings, imageUrls, and matching upstream image edges before paid generation."
    },
    {
      type: "canvas.validateNodeRun",
      description: "Generic pre-run validation for text, image, and video nodes."
    },
    {
      type: "canvas.generateVideoNode",
      description: "Safe high-level video generation: prepare upstream text/image inputs, validate references, then run the video node."
    },
    {
      type: "canvas.inspectModelOptions",
      description: "Return currently known model options and parameter schema notes for a node type or subType."
    },
    {
      type: "canvas.resolveModelAlias",
      description: "Resolve a user-facing model name to the observed RunningHub model name and modelCode."
    },
    {
      type: "canvas.updateNodeModel",
      description: "Update one node's modelCode and optional model metadata. Supports dryRun."
    },
    {
      type: "canvas.updateNodeParams",
      description: "Merge parameter values into one node's data.params. Supports dryRun."
    },
    {
      type: "canvas.createTextWorkflow",
      description: "Create a minimal two-node text workflow with one group and one edge. Supports dryRun."
    },
    {
      type: "canvas.connectNodes",
      description: "Create an edge between two existing nodes. Supports dryRun."
    },
    {
      type: "canvas.updateNode",
      description: "Update a node's position, data, style, zIndex, dimensions, title, or text. Supports dryRun."
    },
    {
      type: "canvas.updateNodePosition",
      description: "Move one node to an absolute x/y position. Supports dryRun."
    },
    {
      type: "canvas.moveNodes",
      description: "Move multiple nodes by delta or explicit positions. Supports dryRun."
    },
    {
      type: "canvas.updateNodeText",
      description: "Update a text node's data.text and optional data.title. Supports dryRun."
    },
    {
      type: "canvas.deleteElements",
      description: "Delete nodes, groups, and edges by id. Edges connected to deleted nodes are removed too. Supports dryRun."
    },
    {
      type: "canvas.getDetail",
      description: "Call /canvas/getCanvasDetail inside the logged-in page context."
    },
    {
      type: "canvas.workflowList",
      description: "Call /canvas/workflow/list inside the logged-in page context."
    },
    {
      type: "api.post",
      description: "Run an arbitrary POST inside the logged-in page context."
    },
    {
      type: "page.eval",
      description: "Dangerous local debugging hook. Keep local-only."
    }
  ];

  const getNodeTitle = (node) => String(node?.data?.label || node?.data?.title || node?.data?.groupName || node?.label || "");
  const getNodeText = (node) => String(node?.data?.text || node?.data?.params?.prompt || node?.text || "");
  const normalizeQuery = (value) => String(value || "").trim().toLowerCase();

  const MODEL_OPTIONS = {
    "text-image": {
      nodeType: "rh-image",
      defaultModelCode: "text-image-rhart-image-g-2-official-text-to-image",
      defaultRunningHubModelName: "全能图片G2-官方稳定版",
      params: {
        prompt: "string",
        aspectRatio: "string|null",
        quality: "low | medium | high, observed default medium",
        resolution: "observed default 1k"
      },
      observedModels: [
        "全能图片G2-官方稳定版",
        "全能图片G2-低价渠道版",
        "全能图片V2-低价渠道版",
        "全能图片V2-官方稳定版",
        "全能图片Pro-低价渠道版",
        "全能图片Pro-官方稳定版",
        "全能图片V1-低价渠道版",
        "全能图片G1.5-官方稳定版",
        "全能图片X-官方稳定版",
        "全能图片X-高质量-官方稳定版",
        "全能图片X-低价渠道版",
        "z-image-turbo",
        "万相2.5",
        "Seedream-V4",
        "Seedream-V4.5",
        "Seedream-V5-Lite"
      ]
    },
    "text-video": {
      nodeType: "rh-video",
      defaultModelCode: "text-video-sparkvideo-2.0",
      defaultRunningHubModelName: "Seedance2.0",
      params: {
        prompt: "string",
        resolution: "observed default 480p",
        duration: "observed default 5",
        generateAudio: "boolean",
        ratio: "string|null",
        webSearch: "boolean"
      },
      observedModels: ["Seedance2.0"]
    },
    "multimodal-video": {
      nodeType: "rh-video",
      defaultModelCode: "multimodal-video-sparkvideo-2.0",
      defaultRunningHubModelName: "Seedance2.0",
      params: {
        prompt: "string",
        imageUrls: "string[]",
        conversionSlots: "string[]",
        resolution: "observed default 720p",
        duration: "observed default 5",
        generateAudio: "boolean",
        ratio: "string|null"
      },
      observedModels: ["Seedance2.0"]
    }
  };

  const MODEL_ALIASES = {
    "gpt image 2": {
      subType: "text-image",
      requestedModelName: "GPT Image 2",
      runningHubModelName: "全能图片G2-官方稳定版",
      modelCode: "text-image-rhart-image-g-2-official-text-to-image",
      mappingStatus: "observed-ui-alias"
    },
    "gpt-image-2": {
      subType: "text-image",
      requestedModelName: "GPT Image 2",
      runningHubModelName: "全能图片G2-官方稳定版",
      modelCode: "text-image-rhart-image-g-2-official-text-to-image",
      mappingStatus: "observed-ui-alias"
    },
    "全能图片g2-官方稳定版": {
      subType: "text-image",
      requestedModelName: "全能图片G2-官方稳定版",
      runningHubModelName: "全能图片G2-官方稳定版",
      modelCode: "text-image-rhart-image-g-2-official-text-to-image",
      mappingStatus: "exact-observed-ui-name"
    },
    "seedance 2.0": {
      subType: "text-video",
      requestedModelName: "Seedance 2.0",
      runningHubModelName: "Seedance2.0",
      modelCode: "text-video-sparkvideo-2.0",
      mappingStatus: "observed-ui-alias"
    },
    "seedance 2.0 720p": {
      subType: "text-video",
      requestedModelName: "Seedance 2.0 720p",
      runningHubModelName: "Seedance2.0",
      modelCode: "text-video-sparkvideo-2.0",
      params: { resolution: "720p" },
      mappingStatus: "observed-ui-alias"
    },
    "seedance2.0": {
      subType: "text-video",
      requestedModelName: "Seedance2.0",
      runningHubModelName: "Seedance2.0",
      modelCode: "text-video-sparkvideo-2.0",
      mappingStatus: "exact-observed-ui-name"
    }
  };

  const normalizeModelName = (value) =>
    String(value || "")
      .trim()
      .toLowerCase()
      .replace(/[-_]+/g, " ")
      .replace(/([a-z])(\d)/g, "$1 $2")
      .replace(/\s+/g, " ");

  const resolveModelAlias = ({ modelName, modelCode, subType } = {}) => {
    const alias = MODEL_ALIASES[normalizeModelName(modelName)];
    if (alias && (!subType || alias.subType === subType)) return alias;
    if (modelCode) {
      return {
        subType,
        requestedModelName: modelName,
        runningHubModelName: modelName,
        modelCode,
        mappingStatus: "explicit-model-code"
      };
    }
    const defaults = subType && MODEL_OPTIONS[subType];
    if (defaults) {
      return {
        subType,
        requestedModelName: modelName,
        runningHubModelName: defaults.defaultRunningHubModelName,
        modelCode: defaults.defaultModelCode,
        mappingStatus: alias ? "alias-subtype-mismatch-used-subtype-default" : modelName ? "fallback-default-for-subtype" : "default-for-subtype"
      };
    }
    return null;
  };

  const withinBounds = (node, bounds = {}) => {
    if (!bounds || typeof bounds !== "object") return true;
    const x = Number(node?.position?.x);
    const y = Number(node?.position?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
    if (bounds.xMin !== undefined && x < Number(bounds.xMin)) return false;
    if (bounds.xMax !== undefined && x > Number(bounds.xMax)) return false;
    if (bounds.yMin !== undefined && y < Number(bounds.yMin)) return false;
    if (bounds.yMax !== undefined && y > Number(bounds.yMax)) return false;
    return true;
  };

  const matchElement = (element, query = {}, kind) => {
    const ids = new Set([...(query.ids || []), query.id].filter(Boolean).map(String));
    if (ids.size && !ids.has(String(element?.id))) return false;
    if (query.type && String(element?.type || "") !== String(query.type)) return false;
    if (kind === "nodes" && query.bounds && !withinBounds(element, query.bounds)) return false;

    const q = normalizeQuery(query.q || query.text || query.title);
    if (!q) return true;
    const haystack =
      kind === "edges"
        ? [element?.id, element?.type, element?.source, element?.target, element?.sourceHandle, element?.targetHandle]
        : [element?.id, element?.type, getNodeTitle(element), getNodeText(element), element?.data?.agentNodeType, element?.data?.modelCode];
    return haystack.some((part) => normalizeQuery(part).includes(q));
  };

  const findElementsInSnapshot = ({ nodes, edges }, query = {}) => {
    const kind = query.kind || "all";
    const matchedNodes = kind === "edges" ? [] : nodes.filter((node) => matchElement(node, query, "nodes"));
    const matchedNodeIds = new Set(matchedNodes.map((node) => node.id));
    const matchedEdges =
      kind === "nodes"
        ? query.includeEdges
          ? edges.filter((edge) => matchedNodeIds.has(edge?.source) || matchedNodeIds.has(edge?.target))
          : []
        : edges.filter((edge) => matchElement(edge, query, "edges"));
    return {
      nodes: matchedNodes,
      edges: matchedEdges,
      counts: { nodes: matchedNodes.length, edges: matchedEdges.length }
    };
  };

  const pickFields = (value, fields) => {
    if (!Array.isArray(fields) || !fields.length) return value;
    const out = {};
    for (const field of fields) {
      if (field in value) out[field] = value[field];
    }
    return out;
  };

  const parseFields = (fields) =>
    Array.isArray(fields)
      ? fields.map(String).filter(Boolean)
      : String(fields || "")
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean);

  const compactNodeSummary = (node, { includeUrls = false, includeTextPreview = true, textPreviewLength = 120, fields } = {}) => {
    const outputs = outputUrlsFromNode(node);
    const sourceUrls = imageUrlsFromNode(node);
    const summary = {
      id: node.id,
      type: node.type,
      title: getNodeTitle(node),
      subType: node.data?.subType,
      status: node.data?.status,
      position: node.position,
      zIndex: node.zIndex,
      modelCode: node.data?.modelCode,
      taskId: node.data?.taskId || outputs.find((item) => item.taskId)?.taskId,
      outputCount: outputs.length,
      sourceUrlCount: sourceUrls.length,
      outputs: includeUrls ? outputs : undefined,
      sourceUrls: includeUrls ? sourceUrls : undefined,
      textPreview: includeTextPreview ? textFromNode(node).slice(0, Number(textPreviewLength) || 120) : undefined
    };
    return pickFields(summary, parseFields(fields));
  };

  const compactEdgeSummary = (edge, { fields } = {}) =>
    pickFields(
      {
        id: edge.id,
        type: edge.type,
        source: edge.source,
        target: edge.target,
        sourceHandle: edge.sourceHandle,
        targetHandle: edge.targetHandle
      },
      parseFields(fields)
    );

  const canvasCapabilities = () => ({
    bridgeVersion: 1,
    clientId: CLIENT_ID,
    href: location.href,
    commands: COMMAND_CAPABILITIES.filter((item) => SITE_POLICY.commandMode(item) !== "blocked"),
    access: ACCESS,
    site: SITE_POLICY.parseCanvas(location.href)
  });

  const summarizeCanvas = async ({ includeUrls = false, includeTextPreview = true, compact = true, full = false, limit, types, status, fields, textPreviewLength = 120 } = {}) =>
    withCanvasYjs(({ nodes, edges, canvasId }) => {
      const currentNodes = yArrayToJson(nodes);
      const currentEdges = yArrayToJson(edges);
      const typeSet = types ? new Set(String(types).split(",").map((item) => item.trim()).filter(Boolean)) : null;
      const statusSet = status ? new Set(String(status).split(",").map((item) => item.trim()).filter(Boolean)) : null;
      const upstreamCounts = new Map();
      const downstreamCounts = new Map();
      for (const edge of currentEdges) {
        if (edge?.target) upstreamCounts.set(edge.target, (upstreamCounts.get(edge.target) || 0) + 1);
        if (edge?.source) downstreamCounts.set(edge.source, (downstreamCounts.get(edge.source) || 0) + 1);
      }
      const nodeSummaries = currentNodes.filter((node) => {
        if (typeSet && !typeSet.has(String(node.type || ""))) return false;
        if (statusSet && !statusSet.has(String(node.data?.status || "unknown"))) return false;
        return true;
      }).map((node) => {
        const outputs = outputUrlsFromNode(node);
        const sourceUrls = imageUrlsFromNode(node);
        const summary = {
          id: node.id,
          type: node.type,
          title: getNodeTitle(node),
          subType: node.data?.subType,
          modelCode: node.data?.modelCode,
          status: node.data?.status,
          taskId: node.data?.taskId || outputs.find((item) => item.taskId)?.taskId,
          position: node.position,
          upstream: upstreamCounts.get(node.id) || 0,
          downstream: downstreamCounts.get(node.id) || 0,
          outputCount: Array.isArray(node.data?.output) ? node.data.output.length : 0,
          outputs: includeUrls ? outputs : undefined,
          sourceUrls: includeUrls ? sourceUrls : undefined,
          textPreview: includeTextPreview ? textFromNode(node).slice(0, Number(textPreviewLength) || 120) : undefined
        };
        return pickFields(summary, parseFields(fields));
      });
      const effectiveLimit = Number.isFinite(Number(limit)) && Number(limit) >= 0 ? Number(limit) : !full && compact ? 50 : undefined;
      const limitedNodes = effectiveLimit === undefined ? nodeSummaries : nodeSummaries.slice(0, effectiveLimit);
      const byType = {};
      const byStatus = {};
      for (const node of currentNodes) {
        byType[node.type || "unknown"] = (byType[node.type || "unknown"] || 0) + 1;
        byStatus[node.data?.status || "unknown"] = (byStatus[node.data?.status || "unknown"] || 0) + 1;
      }
      const result = {
        ok: true,
        canvasId,
        compact: !full && Boolean(compact),
        counts: { nodes: currentNodes.length, edges: currentEdges.length, byType, byStatus, matchedNodes: nodeSummaries.length, returnedNodes: limitedNodes.length },
        nodes: !full && Boolean(compact) && effectiveLimit === 0 ? undefined : limitedNodes,
        edges: full ? currentEdges.map((edge) => ({ id: edge.id, source: edge.source, target: edge.target, type: edge.type })) : undefined,
        truncated: effectiveLimit !== undefined && nodeSummaries.length > limitedNodes.length,
        nextActions: []
      };
      return result;
    });

  const findElements = async (query = {}) =>
    withCanvasYjs(({ nodes, edges, canvasId }) => {
      const matches = findElementsInSnapshot({ nodes: yArrayToJson(nodes), edges: yArrayToJson(edges) }, query);
      const limit = Number.isFinite(Number(query.limit)) ? Number(query.limit) : undefined;
      const summary = query.summary || query.compact || query.fields || query.noOutputs || query.noParams || query.textPreviewLength;
      const nodeMatches = summary
        ? matches.nodes.map((node) =>
            compactNodeSummary(node, {
              includeUrls: !query.noOutputs && query.includeUrls,
              includeTextPreview: query.includeTextPreview !== false,
              textPreviewLength: query.textPreviewLength,
              fields: query.fields
            })
          )
        : matches.nodes;
      const edgeMatches = summary ? matches.edges.map((edge) => compactEdgeSummary(edge, { fields: query.edgeFields })) : matches.edges;
      return {
        canvasId,
        query,
        counts: matches.counts,
        nodes: limit === undefined ? nodeMatches : nodeMatches.slice(0, limit),
        edges: limit === undefined ? edgeMatches : edgeMatches.slice(0, limit),
        limited: limit !== undefined
      };
    });

  const referenceCandidateSummary = (node, { edges = [], nodes = [], includeUrls = false, textPreviewLength = 120 } = {}) => {
    const upstream = directUpstreamNodes({ targetId: node.id, nodes, edges });
    const upstreamText = upstream.filter(({ node: upstreamNode }) => upstreamNode?.type === "rh-text").map(({ node: upstreamNode }) => textFromNode(upstreamNode)).filter(Boolean);
    return {
      ...compactNodeSummary(node, { includeUrls, includeTextPreview: true, textPreviewLength }),
      label: node.data?.label,
      promptChars: textFromNode(node).length,
      upstreamTextCount: upstreamText.length,
      upstreamTextPreview: upstreamText.join("\n\n").slice(0, Number(textPreviewLength) || 120),
      provenance: {
        agentCreated: Boolean(node.data?.agentCreated),
        from: node.data?.from,
        sourceObjectCount: Array.isArray(node.data?.sourceObjects) ? node.data.sourceObjects.length : 0,
        outputCount: Array.isArray(node.data?.output) ? node.data.output.length : 0
      }
    };
  };

  const findReferenceCandidates = async ({ text, q, query, limit = 10, includeUrls = false, textPreviewLength = 120 } = {}) =>
    withCanvasYjs(({ nodes, edges, canvasId }) => {
      const currentNodes = yArrayToJson(nodes);
      const currentEdges = yArrayToJson(edges);
      const needle = normalizeQuery(text || q || query);
      const imageNodes = currentNodes.filter((node) => imageUrlsFromNode(node).length > 0);
      const scored = imageNodes
        .map((node) => {
          const upstream = directUpstreamNodes({ targetId: node.id, nodes: currentNodes, edges: currentEdges });
          const haystackParts = [
            node.id,
            getNodeTitle(node),
            node.data?.label,
            node.data?.agentReferenceLabel,
            node.data?.referenceLabel,
            textFromNode(node),
            ...upstream.map(({ node: upstreamNode }) => [getNodeTitle(upstreamNode), textFromNode(upstreamNode)].join(" "))
          ];
          const haystack = normalizeQuery(haystackParts.join(" "));
          const score = needle ? haystackParts.reduce((sum, part) => sum + (normalizeQuery(part).includes(needle) ? 1 : 0), 0) : 1;
          return { node, score };
        })
        .filter((item) => !needle || item.score > 0)
        .sort((a, b) => b.score - a.score || String(getNodeTitle(a.node)).localeCompare(String(getNodeTitle(b.node))));
      const effectiveLimit = Math.max(0, Number(limit) || 10);
      return {
        ok: true,
        canvasId,
        query: text || q || query || "",
        counts: { candidates: scored.length, returned: scored.slice(0, effectiveLimit).length },
        candidates: scored.slice(0, effectiveLimit).map(({ node, score }) => ({
          score,
          ...referenceCandidateSummary(node, { edges: currentEdges, nodes: currentNodes, includeUrls, textPreviewLength })
        })),
        nextActions: [
          "Prefer nodes with explicit semantic titles or labels.",
          "Do not rename existing user-authored nodes unless the user explicitly approves it."
        ]
      };
    });

  const describeImageNode = async ({ nodeId, id, includeUrls = false, textPreviewLength = 160 } = {}) => {
    const targetId = nodeId || id;
    if (!targetId) throw new Error("nodeId is required");
    return withCanvasYjs(({ nodes, edges, canvasId }) => {
      const currentNodes = yArrayToJson(nodes);
      const currentEdges = yArrayToJson(edges);
      const node = currentNodes.find((item) => item?.id === targetId);
      if (!node) throw new Error(`Node not found: ${targetId}`);
      if (!imageUrlsFromNode(node).length) throw new Error(`Expected rh-image node, got ${node.type || "unknown"}`);
      return {
        ok: true,
        canvasId,
        node: referenceCandidateSummary(node, { edges: currentEdges, nodes: currentNodes, includeUrls, textPreviewLength }),
        upstream: directUpstreamNodes({ targetId, nodes: currentNodes, edges: currentEdges }).map(({ node: upstreamNode, edge }) => ({
          edge: compactEdgeSummary(edge),
          node: compactNodeSummary(upstreamNode, { includeUrls: false, includeTextPreview: true, textPreviewLength })
        }))
      };
    });
  };

  const getElement = async ({ elementId, id = elementId } = {}) => {
    id = elementId || id;
    if (!id) throw new Error("id is required");
    return withCanvasYjs(async ({ nodes, edges, canvasId }) => {
      const snapshot={nodes:yArrayToJson(nodes),edges:yArrayToJson(edges)};
      const node = snapshot.nodes.find((item) => item?.id === id);
      if (node) return { canvasId, kind: "node", element: node, revision:await FEATURES.revision(snapshot,id) };
      const edge = yArrayToJson(edges).find((item) => item?.id === id);
      if (edge) return { canvasId, kind: "edge", element: edge };
      throw new Error(`Element not found: ${id}`);
    });
  };

  const nodeBounds = (node, padding = 0) => {
    const x = Number(node?.position?.x) || 0;
    const y = Number(node?.position?.y) || 0;
    const width = Number(node?.width || node?.data?.width || node?.style?.width || 360);
    const height = Number(node?.height || node?.data?.height || node?.style?.height || 240);
    return { x: x - padding, y: y - padding, width: width + padding * 2, height: height + padding * 2 };
  };

  const rectsOverlap = (a, b) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;

  const suggestEmptyRegion = async ({ nearText, aroundNode, direction = "right-down", width = 1800, height = 800, padding = 300, stepX, stepY, maxAttempts = 80 } = {}) =>
    withCanvasYjs(({ nodes, edges, canvasId }) => {
      const currentNodes = yArrayToJson(nodes).filter((node) => node?.type !== "group");
      const currentEdges = yArrayToJson(edges);
      const paddedBounds = currentNodes.map((node) => ({ node, bounds: nodeBounds(node, Number(padding) || 0) }));
      const textQuery = normalizeQuery(nearText);
      const textMatches = textQuery
        ? currentNodes.filter((node) => normalizeQuery([node.id, getNodeTitle(node), textFromNode(node)].join(" ")).includes(textQuery))
        : [];
      const anchor =
        (aroundNode && currentNodes.find((node) => node.id === aroundNode)) ||
        textMatches[0] ||
        currentNodes.reduce((best, node) => ((Number(node?.position?.x) || 0) > (Number(best?.position?.x) || -Infinity) ? node : best), null);
      const anchorBounds = anchor ? nodeBounds(anchor, 0) : { x: 300, y: 300, width: 0, height: 0 };
      const dir = String(direction || "right-down");
      const xSign = dir.includes("left") ? -1 : 1;
      const ySign = dir.includes("up") ? -1 : 1;
      const baseX = xSign > 0 ? anchorBounds.x + anchorBounds.width + Number(padding) : anchorBounds.x - Number(width) - Number(padding);
      const baseY = ySign > 0 ? anchorBounds.y + Number(padding) : anchorBounds.y - Number(height) - Number(padding);
      const dx = Number(stepX) || Number(width) + Number(padding);
      const dy = Number(stepY) || Number(height) + Number(padding);
      let region = null;
      for (let attempt = 0; attempt < Number(maxAttempts); attempt++) {
        const ring = Math.floor(Math.sqrt(attempt));
        const offset = attempt - ring * ring;
        const candidate = {
          x: Math.round(baseX + xSign * ring * dx),
          y: Math.round(baseY + ySign * offset * dy),
          width: Number(width),
          height: Number(height)
        };
        if (!paddedBounds.some(({ bounds }) => rectsOverlap(candidate, bounds))) {
          region = candidate;
          break;
        }
      }
      region ||= {
        x: Math.round(baseX + xSign * (Number(maxAttempts) + 1) * dx),
        y: Math.round(baseY),
        width: Number(width),
        height: Number(height)
      };
      const center = { x: region.x + region.width / 2, y: region.y + region.height / 2 };
      const nearestNodes = currentNodes
        .map((node) => {
          const b = nodeBounds(node, 0);
          const nodeCenter = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
          return {
            id: node.id,
            type: node.type,
            title: getNodeTitle(node),
            position: node.position,
            distance: Math.round(Math.hypot(center.x - nodeCenter.x, center.y - nodeCenter.y))
          };
        })
        .sort((a, b) => a.distance - b.distance)
        .slice(0, 8);
      return {
        ok: true,
        canvasId,
        region,
        anchor: anchor ? compactNodeSummary(anchor, { includeTextPreview: true, textPreviewLength: 80 }) : null,
        nearestNodes,
        counts: { nodes: currentNodes.length, edges: currentEdges.length, textMatches: textMatches.length },
        warnings: region ? [] : ["No fully empty region found within maxAttempts; returned fallback region."]
      };
    });

  const inspectNodeTemplate = async ({ nodeId, id, includePosition = false } = {}) => {
    const targetId = nodeId || id;
    if (!targetId) throw new Error("nodeId is required");
    return withCanvasYjs(({ nodes, canvasId }) => {
      const node = yArrayToJson(nodes).find((item) => item?.id === targetId);
      if (!node) throw new Error(`Node not found: ${targetId}`);

      const template = safeJson(node);
      delete template.id;
      delete template.selected;
      delete template.dragging;
      if (!includePosition) {
        delete template.position;
        delete template.positionAbsolute;
        delete template.computedPosition;
        delete template.zIndex;
      }

      const suggestedCreateConfig = {
        type: node.type,
        node: template,
        data: template.data || {}
      };
      if (includePosition && node.position) suggestedCreateConfig.position = node.position;

      return {
        canvasId,
        sourceNodeId: targetId,
        type: node.type,
        dataKeys: Object.keys(node.data || {}).sort(),
        template,
        suggestedCreateConfig
      };
    });
  };

  const inspectModelOptions = ({ nodeType, subType } = {}) => {
    const entries = Object.entries(MODEL_OPTIONS).filter(([, value]) => {
      if (subType && value !== MODEL_OPTIONS[subType]) return false;
      if (nodeType && value.nodeType !== nodeType) return false;
      return true;
    });
    return {
      source: "legacy-static-presets; use canvas.listModels for live schema",
      aliases: MODEL_ALIASES,
      options: Object.fromEntries(entries.length ? entries : Object.entries(MODEL_OPTIONS))
    };
  };

  const getConnections = async ({ nodeId, nodeIds = [], direction = "both", depth = 1, summary, compact, fields, edgeFields, noOutputs, noParams, includeUrls, textPreviewLength } = {}) => {
    const seeds = [...nodeIds, nodeId].filter(Boolean);
    if (!seeds.length) throw new Error("nodeId or nodeIds is required");
    const maxDepth = Math.max(1, Number(depth) || 1);
    return withCanvasYjs(({ nodes, edges, canvasId }) => {
      const currentNodes = yArrayToJson(nodes);
      const currentEdges = yArrayToJson(edges);
      const nodeById = new Map(currentNodes.map((node) => [node?.id, node]).filter(([id]) => id));
      const seenNodes = new Set(seeds);
      const seenEdges = new Set();
      let frontier = seeds;

      for (let level = 0; level < maxDepth; level++) {
        const next = [];
        for (const edge of currentEdges) {
          const downstream = (direction === "both" || direction === "downstream") && frontier.includes(edge?.source);
          const upstream = (direction === "both" || direction === "upstream") && frontier.includes(edge?.target);
          if (!downstream && !upstream) continue;
          if (edge?.id) seenEdges.add(edge.id);
          const connectedId = downstream ? edge?.target : edge?.source;
          if (connectedId && !seenNodes.has(connectedId)) {
            seenNodes.add(connectedId);
            next.push(connectedId);
          }
        }
        frontier = next;
        if (!frontier.length) break;
      }

      const compactMode = summary || compact || fields || edgeFields || noOutputs || noParams || textPreviewLength;
      const connectedNodes = [...seenNodes].map((id) => nodeById.get(id) || { id, missing: true });
      const connectedEdges = currentEdges.filter((edge) => seenEdges.has(edge?.id));
      return {
        canvasId,
        seeds,
        direction,
        depth: maxDepth,
        compact: Boolean(compactMode),
        nodes: compactMode
          ? connectedNodes.map((node) =>
              node.missing
                ? node
                : compactNodeSummary(node, {
                    includeUrls: Boolean(includeUrls) && !noOutputs,
                    includeTextPreview: true,
                    textPreviewLength,
                    fields
                  })
            )
          : connectedNodes,
        edges: compactMode ? connectedEdges.map((edge) => compactEdgeSummary(edge, { fields: edgeFields })) : connectedEdges,
        counts: { nodes: seenNodes.size, edges: seenEdges.size }
      };
    });
  };

  const collectUpstreamSubgraph = ({ targetId, nodes, edges, maxDepth = 8 }) => {
    const nodeById = new Map(nodes.map((node) => [node?.id, node]).filter(([id]) => id));
    const includedNodeIds = new Set([targetId]);
    const includedEdgeIds = new Set();
    let frontier = [targetId];

    for (let level = 0; level < maxDepth; level++) {
      const next = [];
      for (const edge of edges) {
        if (!frontier.includes(edge?.target)) continue;
        if (edge?.id) includedEdgeIds.add(edge.id);
        if (edge?.source && !includedNodeIds.has(edge.source)) {
          includedNodeIds.add(edge.source);
          next.push(edge.source);
        }
      }
      frontier = next;
      if (!frontier.length) break;
    }

    const orderedNodes = [targetId, ...[...includedNodeIds].filter((id) => id !== targetId)]
      .map((id) => nodeById.get(id))
      .filter(Boolean);
    const includedEdges = edges.filter((edge) => includedEdgeIds.has(edge?.id));
    return { nodes: orderedNodes, edges: includedEdges };
  };

  const firstPresentString = (...values) => values.find((value) => typeof value === "string" && value.trim())?.trim() || "";

  const imageUrlsFromNode = node => FEATURES.mediaUrls(node,'image');

  const textFromNode = (node) => firstPresentString(node?.data?.text, node?.data?.params?.prompt);

  const outputUrlsFromNode = (node) =>
    (node?.data?.output || [])
      .filter((item) => item?.success !== false && item?.url)
      .map((item) => ({
        url: item.url,
        mediaCategory: item.mediaCategory,
        outputType: item.outputType,
        name: item.name,
        taskId: item.taskId,
        jobId: item.jobId
      }));

  const terminalNodeStatuses = new Set(["finished", "failed", "error", "cancelled", "canceled"]);

  const summarizeNodeResult = (node) => ({
    nodeId: node?.id,
    type: node?.type,
    title: node?.data?.title,
    status: node?.data?.status,
    taskId: node?.data?.taskId,
    outputCount: Array.isArray(node?.data?.output) ? node.data.output.length : 0,
    outputs: outputUrlsFromNode(node),
    sourceUrls: imageUrlsFromNode(node),
    hasTerminalStatus: terminalNodeStatuses.has(String(node?.data?.status || "").toLowerCase())
  });

  const directUpstreamNodes = ({ targetId, nodes, edges }) => {
    const nodeById = new Map(nodes.map((node) => [node?.id, node]).filter(([id]) => id));
    return edges
      .filter((edge) => edge?.target === targetId)
      .map((edge) => ({ edge, node: nodeById.get(edge?.source) }))
      .filter((item) => item.node);
  };

  const videoRunValidation = ({ targetId, nodes, edges, requireReferences = true } = {}) => {
    const target = nodes.find((node) => node?.id === targetId);
    const errors = [];
    if (!target) {
      return { ok: false, errors: [`Node not found: ${targetId}`], targetId };
    }
    if (target.type !== "rh-video") errors.push(`Expected rh-video node, got ${target.type || "unknown"}`);

    const params = target.data?.params || {};
    const nativeH3 = String(target.data?.modelCode || "").includes("minimax-h3");
    const imageUrls = nativeH3
      ? Object.keys(params).filter(key => /^refImage\d+$/.test(key)).sort((a,b) => Number(a.slice(8))-Number(b.slice(8))).map(key => params[key]).filter(Boolean)
      : Array.isArray(params.imageUrls) ? params.imageUrls.filter(Boolean) : [];
    const upstream = directUpstreamNodes({ targetId, nodes, edges });
    const upstreamImages = upstream
      .filter(({ node }) => imageUrlsFromNode(node).length > 0)
      .map(({ node, edge }) => ({ nodeId: node.id, edgeId: edge.id, urls: imageUrlsFromNode(node) }));
    const upstreamImageUrls = new Set(upstreamImages.flatMap((item) => item.urls));
    const missingUpstreamUrls = imageUrls.filter((url) => !upstreamImageUrls.has(url));
    const prompt = firstPresentString(params.prompt);

    if (!prompt) errors.push("Video prompt is empty");
    if (requireReferences) {
      if (target.data?.subType !== "multimodal-video") errors.push(`Expected subType multimodal-video, got ${target.data?.subType || "empty"}`);
      if (!String(target.data?.modelCode || "").includes("multimodal-video")) {
        errors.push(`Expected multimodal video modelCode, got ${target.data?.modelCode || "empty"}`);
      }
      if (!nativeH3 && !imageUrls.length) errors.push("params.imageUrls is empty");
      if (!upstreamImages.length) errors.push("No direct upstream image outputs");
      if (missingUpstreamUrls.length) errors.push(`imageUrls without matching direct upstream image output: ${missingUpstreamUrls.join(", ")}`);
      if (!nativeH3 && (!Array.isArray(params.conversionSlots) || !params.conversionSlots.length)) errors.push("params.conversionSlots is empty");
    }

    return {
      ok: errors.length === 0,
      errors,
      targetId,
      modelCode: target.data?.modelCode,
      subType: target.data?.subType,
      promptChars: prompt.length,
      references: imageUrls.map((url) => ({ url, hasDirectUpstreamImage: upstreamImageUrls.has(url) })),
      upstreamImages,
      upstreamTextNodes: upstream
        .filter(({ node }) => node?.type === "rh-text")
        .map(({ node, edge }) => ({ nodeId: node.id, edgeId: edge.id, chars: textFromNode(node).length }))
    };
  };

  const validateNodeRunSnapshot = ({ targetId, nodes, edges, requireReferences = false } = {}) => {
    const target = nodes.find((node) => node?.id === targetId);
    const errors = [];
    const warnings = [];
    if (!target) {
      return { ok: false, errorCode: "NODE_NOT_FOUND", errors: [`Node not found: ${targetId}`], warnings, targetId };
    }

    const params = target.data?.params || {};
    const prompt = firstPresentString(target.data?.text, params.prompt);
    const upstream = directUpstreamNodes({ targetId, nodes, edges });
    const upstreamImages = upstream.filter(({ node }) => imageUrlsFromNode(node).length > 0).map(({ node, edge }) => ({ nodeId: node.id, edgeId: edge.id, urls: imageUrlsFromNode(node) }));
    const upstreamTexts = upstream.filter(({ node }) => node?.type === "rh-text").map(({ node, edge }) => ({ nodeId: node.id, edgeId: edge.id, chars: textFromNode(node).length }));
    const imageUrls = Array.isArray(params.imageUrls) ? params.imageUrls.filter(Boolean) : [];

    if (!target.type) errors.push("Node type is empty");
    if (!target.data?.modelCode && target.type !== "group") warnings.push("modelCode is empty");
    if ((target.type === "rh-text" || target.type === "rh-image" || target.type === "rh-video") && !prompt && !upstreamTexts.length) {
      warnings.push("No direct prompt text found");
    }
    if (target.type === "rh-image" && target.data?.subType === "image-image" && requireReferences && !upstreamImages.length && !imageUrls.length) {
      errors.push("Image-to-image node has no image references");
    }
    if (target.type === "rh-video" && String(target.data?.subType || "").includes("video")) {
      const videoValidation = videoRunValidation({ targetId, nodes, edges, requireReferences });
      errors.push(...videoValidation.errors);
    }

    return {
      ok: errors.length === 0,
      errorCode: errors.length ? "VALIDATION_FAILED" : null,
      errors,
      warnings,
      targetId,
      type: target.type,
      subType: target.data?.subType,
      modelCode: target.data?.modelCode,
      promptChars: prompt.length,
      upstreamImages,
      upstreamTexts,
      imageUrls,
      wouldSpendCredits: ["rh-text", "rh-image", "rh-video"].includes(target.type),
      nextActions: errors.length ? ["Fix validation errors before run-node or generate-video-node."] : []
    };
  };

  const validateNodeRun = async ({ nodeId, id, targetId, requireReferences = false } = {}) => {
    const target = targetId || nodeId || id;
    if (!target) throw new Error("nodeId is required");
    return withCanvasYjs(({ nodes, edges }) =>
      validateNodeRunSnapshot({
        targetId: target,
        nodes: yArrayToJson(nodes),
        edges: yArrayToJson(edges),
        requireReferences
      })
    );
  };

  const uniquePromptParts = SITE_POLICY.mergePromptParts;

  const prepareVideoNode = async ({ nodeId, id, targetId, prompt, appendPrompt = "", promptMergeMode = "merge", referenceNodeIds, maxDepth = 1, modelCode, dryRun, ...command } = {}) => {
    const target = targetId || nodeId || id;
    if (!target) throw new Error("nodeId is required");
    return withCanvasMutation({ type: "canvas.prepareVideoNode", dryRun, ...command }, ({ Y, doc, nodes, edges }) => {
      const currentNodes = yArrayToJson(nodes);
      const currentEdges = yArrayToJson(edges);
      const nodeById = new Map(currentNodes.map((node) => [node?.id, node]).filter(([id]) => id));
      const videoNode = nodeById.get(target);
      if (!videoNode) throw new Error(`Node not found: ${target}`);
      if (videoNode.type !== "rh-video") throw new Error(`Expected rh-video node, got ${videoNode.type || "unknown"}`);

      const upstream = collectUpstreamSubgraph({ targetId: target, nodes: currentNodes, edges: currentEdges, maxDepth: Number(maxDepth) || 1 });
      const direct = directUpstreamNodes({ targetId: target, nodes: currentNodes, edges: currentEdges });
      const textNodes = upstream.nodes.filter((node) => node?.id !== target && node?.type === "rh-text");
      const existingPrompt = videoNode.data?.params?.prompt || "";
      const upstreamPrompt = textNodes.map(textFromNode).filter(Boolean).join("\n\n");
      const incomingPrompt = prompt !== undefined ? prompt : upstreamPrompt;
      const finalPrompt =
        promptMergeMode === "replace"
          ? uniquePromptParts([incomingPrompt || existingPrompt, appendPrompt]).join("\n\n")
          : promptMergeMode === "append"
            ? uniquePromptParts([existingPrompt, appendPrompt || incomingPrompt]).join("\n\n")
            : uniquePromptParts([existingPrompt, incomingPrompt, appendPrompt]).join("\n\n");

      const requestedReferenceNodes = Array.isArray(referenceNodeIds)
        ? referenceNodeIds.map((refId) => nodeById.get(refId)).filter(Boolean)
        : direct.filter(({ node }) => imageUrlsFromNode(node).length > 0).map(({ node }) => node);
      const referenceEntries = requestedReferenceNodes
        .map((node) => ({ node, url: imageUrlsFromNode(node)[0] }))
        .filter((item) => item.url);
      const imageUrls = [...new Set(referenceEntries.map((item) => item.url))];
      if (!imageUrls.length) throw new Error("No upstream image outputs found for video references");
      const existingModelCode = videoNode.data?.modelCode || "";
      const nextModelCode = modelCode || existingModelCode;
      if (!nextModelCode) throw new Error("Choose a model explicitly before preparing video references");

      const next = {
        ...videoNode,
        data: {
          ...(videoNode.data || {}),
          params: {
            ...(videoNode.data?.params || {}),
            prompt: finalPrompt,
            resolution: videoNode.data?.params?.resolution || "720p",
            duration: String(videoNode.data?.params?.duration || "5"),
            imageUrls,
            videoUrls: videoNode.data?.params?.videoUrls || [],
            audioUrls: videoNode.data?.params?.audioUrls || [],
            generateAudio: videoNode.data?.params?.generateAudio ?? true,
            ratio: videoNode.data?.params?.ratio ?? null,
            realPersonMode: videoNode.data?.params?.realPersonMode ?? false,
            conversionSlots:
              Array.isArray(videoNode.data?.params?.conversionSlots) && videoNode.data.params.conversionSlots.length
                ? videoNode.data.params.conversionSlots
                : ["all"]
          },
          modelCode: nextModelCode,
          subType: "multimodal-video",
          hasUpstream: true,
          preparedBy: "bridge",
          preparedAt: Date.now()
        }
      };

      const addedEdges = [];
      doc.transact(() => {
        for (let index = 0; index < nodes.length; index++) {
          const item = nodes.get(index);
          const json = item?.toJSON?.() || item;
          if (json?.id !== target) continue;
          nodes.delete(index, 1);
          nodes.insert(index, [toYValue(Y, next)]);
          break;
        }
        const existingEdgeIds = new Set(yArrayToJson(edges).map((edge) => edge?.id));
        for (const { node } of referenceEntries) {
          const edgeId = `e-${node.id}-${target}`;
          if (existingEdgeIds.has(edgeId)) continue;
          const edge = { id: edgeId, source: node.id, target, sourceHandle: "output", targetHandle: "input", type: "default", animated: false };
          edges.push([toYValue(Y, edge)]);
          addedEdges.push(edge);
          existingEdgeIds.add(edgeId);
        }
      });

      const afterEdges = [...currentEdges, ...addedEdges];
      return {
        nodeId: target,
        node: next,
        addedEdges,
        validation: videoRunValidation({ targetId: target, nodes: currentNodes.map((node) => (node?.id === target ? next : node)), edges: afterEdges })
      };
    });
  };

  const validateVideoRun = async ({ nodeId, id, targetId, requireReferences = true } = {}) => {
    const target = targetId || nodeId || id;
    if (!target) throw new Error("nodeId is required");
    return withCanvasYjs(({ nodes, edges }) =>
      videoRunValidation({
        targetId: target,
        nodes: yArrayToJson(nodes),
        edges: yArrayToJson(edges),
        requireReferences
      })
    );
  };

  const generateVideoNode = async ({ nodeId, id, targetId, maxDepth = 2, runMaxDepth = 8, maxChars = 120000, dryRun = false, ...command } = {}) => {
    const target = targetId || nodeId || id;
    if (!target) throw new Error("nodeId is required");
    const prepared = await prepareVideoNode({ ...command, nodeId: target, maxDepth, dryRun });
    const preparedResult = prepared.result || prepared;
    const preparedValidation = preparedResult.validation;
    if (!preparedValidation?.ok) {
      throw new Error(`Video preparation validation failed: ${(preparedValidation?.errors || []).join("; ")}`);
    }
    if (dryRun) return { dryRun: true, prepared, validation: preparedValidation, run: null };
    const validation = await validateVideoRun({ nodeId: target, requireReferences: true });
    if (!validation.ok) throw new Error(`Video run validation failed: ${validation.errors.join("; ")}`);
    const run = await runNode({ nodeId: target, maxDepth: runMaxDepth, maxChars, validateReferences: true });
    return { prepared, validation, run };
  };

  const runNode = async ({ nodeId, id, targetId, maxDepth = 8, maxChars = 120000, validateReferences = false, dryRun = false, validateParams = false, expectedDigest, expected } = {}) => {
    const target = targetId || nodeId || id;
    if (!target) throw new Error("nodeId is required");
    const schemaNode=validateParams || expectedDigest || expected ? (await withCanvasYjs(ctx=>canvasSnapshotFromContext(ctx))).nodes.find(n=>n.id===target) : null;
    const fields=schemaNode ? await featureTools.fieldsFor(schemaNode) : null;
    const payload = await withCanvasYjs(async ({ nodes, edges, canvasId }) => {
      const currentNodes = yArrayToJson(nodes);
      const currentEdges = yArrayToJson(edges);
      const targetNode = currentNodes.find((node) => node?.id === target);
      if (!targetNode) throw new Error(`Node not found: ${target}`);
      if(fields) {
        if(targetNode.data?.modelCode!==schemaNode.data?.modelCode || targetNode.data?.subType!==schemaNode.data?.subType) throw new Error('EDIT_CONFLICT: model changed during validation');
        const snapshot={nodes:currentNodes,edges:currentEdges};
        const checked=await featureTools.preflightSnapshot(snapshot,{nodeId:target,expected},fields);
        if(!checked.ok) throw new Error('PREFLIGHT_FAILED: '+checked.errors.join('; '));
        if(expectedDigest && expectedDigest!==checked.digest) throw new Error('EDIT_CONFLICT: preflight digest changed');
        if(FEATURES.canonical(snapshot)!==FEATURES.canonical({nodes:yArrayToJson(nodes),edges:yArrayToJson(edges)})) throw new Error('EDIT_CONFLICT: canvas changed during preflight');
      }
      const validation = validateNodeRunSnapshot({ targetId: target, nodes: currentNodes, edges: currentEdges, requireReferences: validateReferences });
      if (!validation.ok) throw new Error(`Node run validation failed: ${validation.errors.join("; ")}`);
      const subgraph = collectUpstreamSubgraph({ targetId: target, nodes: currentNodes, edges: currentEdges, maxDepth: Number(maxDepth) });
      return {
        canvasId,
        targetType: "NODE",
        targetId: target,
        canvas: subgraph
      };
    });
    if (dryRun) return { dryRun: true, submitted: false, request: payload };
    const response = await postJson("/canvas/task/run", payload, maxChars);
    const task = taskInfoFromRunResponse(response);
    if (!task.ok) throw new Error(`RUN_REJECTED: ${task.code ?? response.status}: ${String(task.msg || "Request rejected").slice(0, 300)}`);
    return { submitted: Boolean(task.taskId), submissionState: task.taskId ? "submitted" : "unknown", task };
  };

  const mergePlainObject = (target, patch) => {
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) return target;
    return { ...(target || {}), ...patch };
  };

  const createTextWorkflow = async (config = {}, command = {}) =>
    withCanvasMutation(command, ({ Y, doc, nodes, edges, canvasId }) => {
      const currentNodes = yArrayToJson(nodes);
      const currentEdges = yArrayToJson(edges);
      const timestamp = Date.now();
      const suffix = Math.random().toString(36).slice(2, 10);
      const groupId = `group-${timestamp}-${suffix}`;
      const sourceId = `node-${timestamp}-${suffix}-source`;
      const targetId = `node-${timestamp}-${suffix}-target`;
      const edgeId = `e-${sourceId}-${targetId}`;
      const maxX = currentNodes.reduce((max, node) => Math.max(max, Number(node?.position?.x) || 0), 0);
      const baseX = Math.max(300, maxX + 420);
      const baseY = Number(config.y) || 300;
      const groupColor = config.groupColor || "rgba(75, 130, 180, 0.18)";
      const sourceTitle = config.sourceTitle || "API 输入节点";
      const targetTitle = config.targetTitle || "API 输出节点";

      const source = {
        id: sourceId,
        type: "rh-text",
        position: { x: baseX, y: baseY },
        zIndex: currentNodes.length + 1,
        style: {},
        selectable: true,
        data: {
          params: { prompt: "" },
          modelCode: "text-text-rhart-text-g-3-flash-preview",
          generateNum: 1,
          subType: "text-text",
          textModelListType: "text-text",
          title: sourceTitle,
          agentCreated: true,
          from: "bridge",
          agentNodeType: "copywriting",
          status: "idle",
          text: config.sourceText || "API 写入：上游文本节点",
          groupId,
          groupColor,
          addNewGroup: true,
          maxConnect: { image: null, text: null, video: null }
        }
      };
      const target = {
        id: targetId,
        type: "rh-text",
        position: { x: baseX + 520, y: baseY + 80 },
        zIndex: currentNodes.length + 2,
        style: {},
        selectable: true,
        data: {
          params: { prompt: "" },
          modelCode: "text-text-rhart-text-g-3-flash-preview",
          generateNum: 1,
          subType: "text-text",
          textModelListType: "text-text",
          title: targetTitle,
          agentCreated: true,
          from: "bridge",
          agentNodeType: "output",
          status: "idle",
          text: config.targetText || "API 写入：下游文本节点，已连接上游",
          inheritedFrom: sourceId,
          hasUpstream: true,
          groupId,
          groupColor,
          addNewGroup: true,
          maxConnect: { image: null, text: null, video: null }
        }
      };
      const group = {
        id: groupId,
        type: "group",
        position: { x: baseX - 60, y: baseY - 90 },
        zIndex: -1000,
        style: {},
        selectable: false,
        data: {
          title: "节点",
          groupName: config.groupName || "API 基础连线测试",
          groupColor,
          borderColor: "rgba(75, 130, 180, 0.65)",
          nodeIds: [sourceId, targetId],
          width: 960,
          height: 470,
          nodeOffsets: {
            [sourceId]: { x: 60, y: 90 },
            [targetId]: { x: 580, y: 170 }
          },
          status: "idle"
        }
      };
      const edge = {
        id: edgeId,
        source: sourceId,
        target: targetId,
        sourceHandle: "output",
        targetHandle: "input",
        type: "default",
        animated: false
      };

      doc.transact(() => {
        nodes.push([toYValue(Y, source), toYValue(Y, target), toYValue(Y, group)]);
        edges.push([toYValue(Y, edge)]);
      });

      return {
        canvasId,
        added: { nodes: [sourceId, targetId, groupId], edges: [edgeId] },
        before: { nodes: currentNodes.length, edges: currentEdges.length },
        after: { nodes: currentNodes.length + 3, edges: currentEdges.length + 1 }
      };
    });

  const createTextNode = async (config = {}, command = {}) =>
    withCanvasMutation(command, ({ Y, doc, nodes }) => {
      const currentNodes = yArrayToJson(nodes);
      const timestamp = Date.now();
      const suffix = Math.random().toString(36).slice(2, 10);
      const nodeId = config.id || `node-${timestamp}-${suffix}`;
      const maxX = currentNodes.reduce((max, node) => Math.max(max, Number(node?.position?.x) || 0), 0);
      const node = {
        id: nodeId,
        type: "rh-text",
        position: {
          x: Number(config.x ?? Math.max(300, maxX + 360)),
          y: Number(config.y ?? 300)
        },
        zIndex: currentNodes.length + 1,
        style: {},
        selectable: true,
        data: {
          params: { prompt: "" },
          modelCode: "text-text-rhart-text-g-3-flash-preview",
          generateNum: 1,
          subType: "text-text",
          textModelListType: "text-text",
          title: config.title || "API 文本节点",
          label: config.label || config.title || "API 文本节点",
          agentCreated: true,
          from: "bridge",
          agentNodeType: config.agentNodeType || "copywriting",
          status: "idle",
          text: config.text || "API 写入：文本节点",
          maxConnect: { image: null, text: null, video: null }
        }
      };
      doc.transact(() => nodes.push([toYValue(Y, node)]));
      return { nodeId, node };
    });

  const createTextNodes = async (configs = [], command = {}) =>
    withCanvasMutation(command, ({ Y, doc, nodes, canvasId }) => {
      const items = Array.isArray(configs) ? configs : configs?.nodes || configs?.items || [];
      if (!items.length) throw new Error("config-json must be a non-empty array or object with nodes/items");
      const currentNodes = yArrayToJson(nodes);
      const timestamp = Date.now();
      const maxX = currentNodes.reduce((max, node) => Math.max(max, Number(node?.position?.x) || 0), 0);
      const baseX = Number(command.x ?? items[0]?.x ?? Math.max(300, maxX + 360));
      const baseY = Number(command.y ?? items[0]?.y ?? 300);
      const gapX = Number(command.gapX ?? 420);
      const gapY = Number(command.gapY ?? 260);
      const created = items.map((config, index) => {
        const suffix = Math.random().toString(36).slice(2, 10);
        const nodeId = config.id || `node-${timestamp}-${index}-${suffix}`;
        return {
          id: nodeId,
          type: "rh-text",
          position: {
            x: Number(config.x ?? baseX + (index % 3) * gapX),
            y: Number(config.y ?? baseY + Math.floor(index / 3) * gapY)
          },
          zIndex: currentNodes.length + index + 1,
          style: {},
          selectable: true,
          data: {
            params: { prompt: "" },
            modelCode: "text-text-rhart-text-g-3-flash-preview",
            generateNum: 1,
            subType: "text-text",
            textModelListType: "text-text",
            title: config.title || `Agent 文本节点 ${index + 1}`,
            label: config.label || config.title || `Agent 文本节点 ${index + 1}`,
            agentCreated: true,
            from: "bridge",
            agentNodeType: config.agentNodeType || "copywriting",
            status: "idle",
            text: config.text || "",
            maxConnect: { image: null, text: null, video: null },
            ...(config.data || {})
          }
        };
      });
      doc.transact(() => nodes.push(created.map((node) => toYValue(Y, node))));
      return {
        ok: true,
        canvasId,
        operationId: command.id,
        nodeIds: created.map((node) => node.id),
        nodes: created.map((node) => compactNodeSummary(node, { includeTextPreview: true, textPreviewLength: 120 })),
        counts: { createdNodes: created.length }
      };
    });

  const groupElements = async ({ ids = [], nodeIds = [], title, groupName, padding = 80, style = {}, groupId, groupColor = "rgba(75, 130, 180, 0.18)", borderColor = "rgba(75, 130, 180, 0.65)", ...command } = {}) =>
    withCanvasMutation({ type: "canvas.groupElements", ...command }, ({ Y, doc, nodes }) => {
      const targetIds = [...ids, ...nodeIds].filter(Boolean);
      if (!targetIds.length) throw new Error("At least one node id is required");
      const targetSet = new Set(targetIds);
      const currentNodes = yArrayToJson(nodes);
      const targets = currentNodes.filter((node) => targetSet.has(node?.id) && node?.type !== "group");
      const missing = targetIds.filter((id) => !targets.some((node) => node.id === id));
      if (missing.length) throw new Error(`Node not found or not groupable: ${missing.join(", ")}`);
      const pad = Number(padding) || 80;
      const bounds = targets.map((node) => nodeBounds(node, 0));
      const minX = Math.min(...bounds.map((item) => item.x));
      const minY = Math.min(...bounds.map((item) => item.y));
      const maxX = Math.max(...bounds.map((item) => item.x + item.width));
      const maxY = Math.max(...bounds.map((item) => item.y + item.height));
      const nextGroupId = groupId || `group-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const groupPosition = { x: minX - pad, y: minY - pad };
      const group = {
        id: nextGroupId,
        type: "group",
        position: groupPosition,
        zIndex: -1000,
        style,
        selectable: false,
        data: {
          title: "节点",
          groupName: groupName || title || "Agent 分组",
          groupColor,
          borderColor,
          nodeIds: targets.map((node) => node.id),
          width: maxX - minX + pad * 2,
          height: maxY - minY + pad * 2,
          nodeOffsets: Object.fromEntries(targets.map((node) => [node.id, { x: (Number(node.position?.x) || 0) - groupPosition.x, y: (Number(node.position?.y) || 0) - groupPosition.y }])),
          status: "idle"
        }
      };
      const groupedNodes = [];
      doc.transact(() => {
        for (let index = 0; index < nodes.length; index++) {
          const node = nodes.get(index);
          const nodeJson = node?.toJSON?.() || node;
          if (!targetSet.has(nodeJson?.id) || nodeJson?.type === "group") continue;
          const next = {
            ...nodeJson,
            data: {
              ...(nodeJson.data || {}),
              groupId: nextGroupId,
              groupColor,
              addNewGroup: true
            }
          };
          nodes.delete(index, 1);
          nodes.insert(index, [toYValue(Y, next)]);
          groupedNodes.push(compactNodeSummary(next, { includeTextPreview: false }));
        }
        nodes.push([toYValue(Y, group)]);
      });
      return {
        ok: true,
        groupId: nextGroupId,
        groupedNodeIds: targets.map((node) => node.id),
        group,
        groupedNodes,
        counts: { groupedNodes: targets.length, addedGroups: 1 }
      };
    });

  const createNode = async (config = {}, command = {}) =>
    withCanvasMutation(command, ({ Y, doc, nodes }) => {
      const currentNodes = yArrayToJson(nodes);
      const timestamp = Date.now();
      const suffix = Math.random().toString(36).slice(2, 10);
      const template = config.node && typeof config.node === "object" ? config.node : {};
      const nodeId = config.id || template.id || `node-${timestamp}-${suffix}`;
      if (currentNodes.some(node => node.id === nodeId)) throw new Error(`DUPLICATE_NODE_ID: ${nodeId}`);
      const maxX = currentNodes.reduce((max, node) => Math.max(max, Number(node?.position?.x) || 0), 0);
      const node = {
        ...template,
        id: nodeId,
        type: config.type || template.type || "rh-text",
        position: {
          x: Number(config.x ?? template.position?.x ?? Math.max(300, maxX + 360)),
          y: Number(config.y ?? template.position?.y ?? 300)
        },
        zIndex: Number(config.zIndex ?? template.zIndex ?? currentNodes.length + 1),
        style: template.style || config.style || {},
        selectable: config.selectable ?? template.selectable ?? true,
        data: {
          ...(template.data || {}),
          ...(config.data || {})
        }
      };
      if (config.position) node.position = { ...node.position, ...config.position };
      doc.transact(() => nodes.push([toYValue(Y, node)]));
      return { nodeId, node };
    });

  const cloneTemplate = async ({ sourceNodeId, nodeId, title, x, y, ...command }) =>
    withCanvasMutation({ type: "canvas.cloneTemplate", ...command }, ({ Y, doc, nodes, edges }) => {
      const current = yArrayToJson(nodes);
      const source = current.find(node => node.id === sourceNodeId);
      if (!source) throw new Error(`Node not found: ${sourceNodeId}`);
      if ((source.data?.output || []).length || getNodeText(source).trim() ||
          (source.data?.sourceObjects || []).length || (source.data?.params?.imageUrls || []).length ||
          Object.entries(source.data?.params || {}).some(([key, value]) => /^ref(Image|Video|Audio)\d+$/.test(key) && value) ||
          yArrayToJson(edges).some(edge => edge.target === sourceNodeId) ||
          /running|queued|processing/i.test(source.data?.status || "")) {
        throw new Error("TEMPLATE_NOT_EMPTY: select a blank configured template, not a result node");
      }
      const id = nodeId || `node_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
      if (current.some(node => node.id === id)) throw new Error(`DUPLICATE_NODE_ID: ${id}`);
      const node = JSON.parse(JSON.stringify(source));
      Object.assign(node, { id, position: { x: Number(x), y: Number(y) }, selected: false, zIndex: current.length + 1 });
      for (const key of ["parentNode", "parentId", "extent", "positionAbsolute", "dragging", "measured"]) delete node[key];
      for (const key of ["output", "taskId", "jobId", "progress", "error", "errorMsg", "queuePosition"]) delete node.data[key];
      Object.assign(node.data, { title, label: title, status: "idle" });
      doc.transact(() => nodes.push([toYValue(Y, node)]));
      return { nodeId: id, sourceNodeId, modelCode: node.data.modelCode, params: node.data.params, generationTriggered: false };
    });

  const createVideoNode = async (config = {}, command = {}) =>
    withCanvasMutation(command, ({ Y, doc, nodes, edges }) => {
      const targetSubType = config.subType || config.data?.subType || "text-video";
      const model = resolveModelAlias({ modelName: config.modelName, modelCode: config.modelCode, subType: targetSubType });
      const currentNodes = yArrayToJson(nodes);
      const timestamp = Date.now();
      const suffix = Math.random().toString(36).slice(2, 10);
      const nodeId = config.id || `node_${timestamp}_${suffix}`;
      const maxX = currentNodes.reduce((max, node) => Math.max(max, Number(node?.position?.x) || 0), 0);
      const node = {
        id: nodeId,
        type: "rh-video",
        position: {
          x: Number(config.x ?? Math.max(300, maxX + 360)),
          y: Number(config.y ?? 400)
        },
        zIndex: currentNodes.length + 1,
        style: {},
        selectable: true,
        data: {
          params: {
            prompt: config.prompt || "",
            resolution: config.resolution || "480p",
            duration: String(config.duration || "5"),
            generateAudio: config.generateAudio ?? true,
            ratio: config.ratio ?? null,
            webSearch: config.webSearch ?? false,
            ...(model?.params || {}),
            ...(config.params || {})
          },
          modelCode: model?.modelCode || config.modelCode || "text-video-sparkvideo-2.0",
          generateNum: Number(config.generateNum || 1),
          subType: targetSubType,
          title: config.title || "视频生成",
          type: "rh-video",
          status: "idle",
          ...(model
            ? {
                requestedModelName: model.requestedModelName,
                runningHubModelName: model.runningHubModelName,
                modelMappingStatus: model.mappingStatus
              }
            : {}),
          ...(config.sourceNodeId ? { inheritedFrom: config.sourceNodeId, hasUpstream: true } : {}),
          ...(config.data || {})
        }
      };
      const addedEdges = [];
      doc.transact(() => {
        nodes.push([toYValue(Y, node)]);
        if (config.sourceNodeId) {
          const edge = {
            id: config.edgeId || `e-${config.sourceNodeId}-${nodeId}`,
            source: config.sourceNodeId,
            target: nodeId,
            sourceHandle: config.sourceHandle || "output",
            targetHandle: config.targetHandle || "input",
            type: "default",
            animated: false
          };
          edges.push([toYValue(Y, edge)]);
          addedEdges.push(edge);
        }
      });
      return {
        nodeId,
        node,
        edges: addedEdges,
        nextActions: [
          "This command only creates/configures the video node; it does not run generation.",
          targetSubType === "multimodal-video"
            ? "Connect or provide reference image nodes, then run prepare-video-node and validate-video-run before paid generation."
            : "For image-conditioned video, connect reference image nodes and run prepare-video-node to switch the node to multimodal-video."
        ]
      };
    });

  const createImageNode = async (config = {}, command = {}) =>
    withCanvasMutation(command, ({ Y, doc, nodes, edges }) => {
      const model = resolveModelAlias({ modelName: config.modelName, modelCode: config.modelCode, subType: config.subType || "text-image" });
      const currentNodes = yArrayToJson(nodes);
      const timestamp = Date.now();
      const suffix = Math.random().toString(36).slice(2, 10);
      const nodeId = config.id || `node-${timestamp}-${suffix}`;
      const maxX = currentNodes.reduce((max, node) => Math.max(max, Number(node?.position?.x) || 0), 0);
      const node = {
        id: nodeId,
        type: "rh-image",
        position: {
          x: Number(config.x ?? Math.max(300, maxX + 360)),
          y: Number(config.y ?? 400)
        },
        zIndex: currentNodes.length + 1,
        style: {},
        selectable: true,
        data: {
          params: {
            prompt: config.prompt || "",
            aspectRatio: config.aspectRatio ?? null,
            quality: config.quality || "medium",
            resolution: config.resolution || "1k",
            ...(model?.params || {}),
            ...(config.params || {})
          },
          modelCode: model?.modelCode || MODEL_OPTIONS["text-image"].defaultModelCode,
          generateNum: Number(config.generateNum || 1),
          subType: config.subType || "text-image",
          title: config.title || "图片上传",
          status: "idle",
          panorama: {
            pausedModel: ""
          },
          ...(model
            ? {
                requestedModelName: model.requestedModelName,
                runningHubModelName: model.runningHubModelName,
                modelMappingStatus: model.mappingStatus
              }
            : {}),
          ...(config.sourceNodeId ? { inheritedFrom: config.sourceNodeId, hasUpstream: true } : {}),
          ...(config.data || {})
        }
      };
      const addedEdges = [];
      doc.transact(() => {
        nodes.push([toYValue(Y, node)]);
        if (config.sourceNodeId) {
          const edge = {
            id: config.edgeId || `e-${config.sourceNodeId}-${nodeId}`,
            source: config.sourceNodeId,
            target: nodeId,
            sourceHandle: config.sourceHandle || "output",
            targetHandle: config.targetHandle || "input",
            type: "default",
            animated: false
          };
          edges.push([toYValue(Y, edge)]);
          addedEdges.push(edge);
        }
      });
      return {
        nodeId,
        node,
        edges: addedEdges,
        nextActions: [
          "This command only creates/configures the image node; it does not generate an image.",
          "Run validate-node-run, then run-node when paid image generation is intended."
        ]
      };
    });

  const prepareImageWorkflow = async ({ config = {}, dryRun, ...command } = {}) =>
    withCanvasMutation({ type: "canvas.prepareImageWorkflow", dryRun, compactMutation: true, ...command }, ({ Y, doc, nodes, edges, canvasId }) => {
      const currentNodes = yArrayToJson(nodes);
      const currentEdges = yArrayToJson(edges);
      const nodeById = new Map(currentNodes.map((node) => [node?.id, node]).filter(([id]) => id));
      const textConfig = config.textNode || {};
      const imageConfig = config.imageNode || {};
      const textNodeId = config.textNodeId || textConfig.id;
      const imageNodeId = config.imageNodeId || imageConfig.id;
      const referenceNodeIds = config.referenceNodeIds || imageConfig.referenceNodeIds || [];
      if (!Array.isArray(referenceNodeIds)) throw new Error("referenceNodeIds must be an array");

      const timestamp = Date.now();
      const suffix = Math.random().toString(36).slice(2, 10);
      const maxX = currentNodes.reduce((max, node) => Math.max(max, Number(node?.position?.x) || 0), 0);
      const textId = textNodeId || `node-${timestamp}-${suffix}-prompt`;
      const imageId = imageNodeId || `node-${timestamp}-${suffix}-image`;
      const references = referenceNodeIds.map((id) => nodeById.get(id));
      const missingReferences = referenceNodeIds.filter((id, index) => !references[index]);
      if (missingReferences.length) throw new Error(`Reference node not found: ${missingReferences.join(", ")}`);

      let textNode = textNodeId ? nodeById.get(textNodeId) : null;
      let imageNode = imageNodeId ? nodeById.get(imageNodeId) : null;
      if (textNodeId && !textNode) throw new Error(`Text node not found: ${textNodeId}`);
      if (imageNodeId && !imageNode) throw new Error(`Image node not found: ${imageNodeId}`);
      if (imageNode && imageNode.type !== "rh-image") throw new Error(`Expected image node rh-image, got ${imageNode.type || "unknown"}`);

      const promptText = textConfig.text ?? config.text ?? imageConfig.prompt ?? imageConfig.params?.prompt ?? "";
      const imagePrompt = imageConfig.prompt ?? imageConfig.params?.prompt ?? promptText;
      if (!textNode && !String(promptText || "").trim()) throw new Error("textNode.text or imageNode.prompt is required for a new workflow");

      if (!textNode) {
        textNode = {
          id: textId,
          type: "rh-text",
          position: {
            x: Number(textConfig.x ?? textConfig.position?.x ?? Math.max(300, maxX + 360)),
            y: Number(textConfig.y ?? textConfig.position?.y ?? 300)
          },
          zIndex: currentNodes.length + 1,
          style: {},
          selectable: true,
          data: {
            params: { prompt: "" },
            modelCode: "text-text-rhart-text-g-3-flash-preview",
            generateNum: 1,
            subType: "text-text",
            textModelListType: "text-text",
            title: textConfig.title || config.title || "Agent 图片提示词",
            agentCreated: true,
            from: "bridge",
            agentNodeType: textConfig.agentNodeType || "image-prompt",
            status: "idle",
            text: promptText,
            maxConnect: { image: null, text: null, video: null },
            ...(textConfig.data || {})
          }
        };
      } else {
        textNode = {
          ...textNode,
          data: {
            ...(textNode.data || {}),
            ...(textConfig.data || {}),
            ...(textConfig.title !== undefined ? { title: textConfig.title } : {}),
            ...(textConfig.text !== undefined || config.text !== undefined ? { text: promptText } : {})
          }
        };
      }

      const model = resolveModelAlias({ modelName: imageConfig.modelName, modelCode: imageConfig.modelCode, subType: imageConfig.subType || imageNode?.data?.subType || "text-image" });
      if (!imageNode) {
        imageNode = {
          id: imageId,
          type: "rh-image",
          position: {
            x: Number(imageConfig.x ?? imageConfig.position?.x ?? (Number(textNode.position?.x) || Math.max(300, maxX + 360)) + 520),
            y: Number(imageConfig.y ?? imageConfig.position?.y ?? textNode.position?.y ?? 300)
          },
          zIndex: currentNodes.length + 2,
          style: {},
          selectable: true,
          data: {
            params: {
              prompt: imagePrompt,
              aspectRatio: imageConfig.aspectRatio ?? null,
              quality: imageConfig.quality || "medium",
              resolution: imageConfig.resolution || "1k",
              ...(model?.params || {}),
              ...(imageConfig.params || {})
            },
            modelCode: model?.modelCode || MODEL_OPTIONS["text-image"].defaultModelCode,
            generateNum: Number(imageConfig.generateNum || 1),
            subType: imageConfig.subType || "text-image",
            title: imageConfig.title || "Agent 图片生成｜待确认",
            status: "idle",
            panorama: { pausedModel: "" },
            agentCreated: true,
            from: "bridge",
            preparedBy: "bridge",
            preparedAt: timestamp,
            ...(imageConfig.data || {})
          }
        };
      } else {
        imageNode = {
          ...imageNode,
          data: {
            ...(imageNode.data || {}),
            ...(imageConfig.data || {}),
            params: {
              ...(imageNode.data?.params || {}),
              ...(imagePrompt !== undefined ? { prompt: imagePrompt } : {}),
              ...(model?.params || {}),
              ...(imageConfig.params || {})
            },
            ...(model?.modelCode ? { modelCode: model.modelCode } : {}),
            ...(imageConfig.title !== undefined ? { title: imageConfig.title } : {}),
            preparedBy: "bridge",
            preparedAt: timestamp
          }
        };
      }

      const upsertNode = (targetNode) => {
        const index = currentNodes.findIndex((node) => node?.id === targetNode.id);
        if (index === -1) {
          nodes.push([toYValue(Y, targetNode)]);
          currentNodes.push(targetNode);
          return "created";
        }
        nodes.delete(index, 1);
        nodes.insert(index, [toYValue(Y, targetNode)]);
        currentNodes[index] = targetNode;
        return "updated";
      };

      const addedEdges = [];
      const ensureEdge = (source, target) => {
        const edgeId = `e-${source}-${target}`;
        const exists = currentEdges.some((edge) => edge?.id === edgeId || (edge?.source === source && edge?.target === target));
        if (exists) return;
        const edge = { id: edgeId, source, target, sourceHandle: "output", targetHandle: "input", type: "default", animated: false };
        edges.push([toYValue(Y, edge)]);
        currentEdges.push(edge);
        addedEdges.push(edge);
      };

      let textAction;
      let imageAction;
      doc.transact(() => {
        textAction = upsertNode(textNode);
        imageAction = upsertNode(imageNode);
        ensureEdge(textNode.id, imageNode.id);
        for (const refNode of references.filter(Boolean)) ensureEdge(refNode.id, imageNode.id);
      });

      return {
        ok: true,
        canvasId,
        run: config.run === true ? "not-run-by-bridge" : false,
        textNodeId: textNode.id,
        imageNodeId: imageNode.id,
        referenceNodeIds,
        nodeIds: [textNode.id, imageNode.id],
        nodes: [textNode, imageNode],
        addedEdges,
        actions: { textNode: textAction, imageNode: imageAction, referencesConnected: referenceNodeIds.length },
        counts: { createdOrUpdatedNodes: 2, connectedReferences: referenceNodeIds.length, addedEdges: addedEdges.length },
        nextActions: ["Inspect the compact wiring summary, then run validate-node-run/run-node only after explicit user confirmation."]
      };
    });

  const createReferenceImageNode = async (config = {}, command = {}) =>
    withCanvasMutation(command, ({ Y, doc, nodes, edges }) => {
      const sourceUrl = config.sourceUrl || config.url || config.sourceObject;
      if (!sourceUrl) throw new Error("sourceUrl is required");
      const currentNodes = yArrayToJson(nodes);
      const timestamp = Date.now();
      const suffix = Math.random().toString(36).slice(2, 10);
      const nodeId = config.id || `node_${timestamp}_${suffix}`;
      const maxX = currentNodes.reduce((max, node) => Math.max(max, Number(node?.position?.x) || 0), 0);
      const node = {
        id: nodeId,
        type: "rh-image",
        position: {
          x: Number(config.x ?? Math.max(300, maxX + 360)),
          y: Number(config.y ?? 400)
        },
        zIndex: currentNodes.length + 1,
        style: {},
        selectable: true,
        data: {
          params: {
            prompt: "",
            aspectRatio: null,
            quality: "medium",
            resolution: "1k",
            ...(config.params || {})
          },
          modelCode: config.modelCode || MODEL_OPTIONS["text-image"].defaultModelCode,
          generateNum: Number(config.generateNum || 1),
          subType: config.subType || "text-image",
          title: config.title || "参考图",
          sourceObjects: [sourceUrl],
          status: "idle",
          panorama: {
            pausedModel: ""
          },
          width: Number(config.width || 380),
          height: Number(config.height || 320),
          label: config.label || config.name || "reference image",
          ...(config.data || {})
        }
      };
      const addedEdges = [];
      doc.transact(() => {
        nodes.push([toYValue(Y, node)]);
        if (config.targetNodeId) {
          const edge = {
            id: config.edgeId || `edge_${nodeId}_${config.targetNodeId}`,
            source: nodeId,
            target: config.targetNodeId,
            sourceHandle: config.sourceHandle || "output",
            targetHandle: config.targetHandle || "input",
            type: "default",
            animated: false
          };
          edges.push([toYValue(Y, edge)]);
          addedEdges.push(edge);
        }
      });
      return { nodeId, node, edges: addedEdges };
    });

  const createReferenceFromUrl = async ({ url, sourceUrl, targetNodeId, config = {}, dryRun, ...command } = {}) => {
    const referenceUrl = sourceUrl || url;
    if (!referenceUrl) throw new Error("url is required");
    const created = await createReferenceImageNode(
      {
        ...config,
        sourceUrl: referenceUrl,
        targetNodeId: targetNodeId || config.targetNodeId
      },
      { type: "canvas.createReferenceFromUrl", dryRun, ...command }
    );
    const result = created?.result || created;
    return {
      ok: true,
      dryRun: Boolean(created?.dryRun),
      applied: created?.applied,
      rollbackId: created?.rollbackId,
      primaryReference: {
        nodeId: result.nodeId,
        urls: [referenceUrl],
        title: result.node?.data?.title,
        label: result.node?.data?.label
      },
      usableReferences: [
        {
          nodeId: result.nodeId,
          urls: [referenceUrl],
          title: result.node?.data?.title,
          label: result.node?.data?.label
        }
      ],
      created,
      nextActions: targetNodeId ? [] : ["Connect primaryReference.nodeId to the target generation node when needed."]
    };
  };

  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  let uploadModulePromise;
  const uploadCanvasFile = async (file) => {
    if (!file.base64 && !/^[0-9a-f-]{36}$/.test(file.ticket || '')) throw new Error("file ticket or base64 is required");
    const local = file.ticket ? await fetch(`${BRIDGE}/media/${file.ticket}`) : null;
    if (local && !local.ok) throw new Error("LOCAL_MEDIA_UNAVAILABLE");
    const bytes = local ? new Uint8Array(await local.arrayBuffer()) : Uint8Array.from(atob(file.base64), char => char.charCodeAt(0));
    const limit = file.type?.startsWith('video/') ? 500 : file.type?.startsWith('audio/') ? 50 : 30;
    if (bytes.length > limit * 1024 * 1024) throw new Error(`Media exceeds ${limit} MiB`);
    const uploadFile = new File([bytes], file.name || "reference.png", { type: file.type || "image/png" });
    const cookieIdentify = document.cookie.split(";").map(part => part.trim()).find(part => part.startsWith("Rh-Identify="))?.slice("Rh-Identify=".length);
    let tokenIdentity = "";
    try { tokenIdentity = JSON.parse(atob(sessionToken().split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))).username || ""; } catch {}
    const identify = cookieIdentify ? decodeURIComponent(cookieIdentify) : tokenIdentity || localStorage.getItem("Rh-Identify");
    if (!identify) throw new Error("UPLOAD_IDENTITY_MISSING");
    const response = await fetch(new URL("/api/storage/getCredentials", SITE_POLICY.parseCanvas(location.href).apiOrigin), {
      method: "POST", headers: authHeaders(), credentials: "include", body: JSON.stringify({ scene: "canvas" })
    });
    const payload = await response.json();
    if (!response.ok || (payload.code !== undefined && Number(payload.code) !== 0)) throw new Error("UPLOAD_CREDENTIALS_UNAVAILABLE");
    const credential = payload.data?.data || payload.data || payload;
    if (!credential.accessKey || !credential.secretKey || !credential.bucket || !credential.region) throw new Error("UPLOAD_CREDENTIALS_UNAVAILABLE");
    const { S3, Upload } = await (uploadModulePromise ||= import(`${BRIDGE}/vendor/upload.js`));
    const endpoint = credential.endpoint && credential.region ? credential.endpoint.replace(credential.region, "accelerate") : credential.endpoint;
    const client = new S3({ endpoint, region: credential.region, forcePathStyle: credential.type === "minio",
      credentials: { accessKeyId: credential.accessKey, secretAccessKey: credential.secretKey, sessionToken: credential.sessionToken } });
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), n => n.toString(16).padStart(2, "0")).join("");
    if (file.sha256 && digest !== file.sha256) throw new Error("SOURCE_SHA_MISMATCH");
    const suffix = ({'image/jpeg':'.jpg','image/png':'.png','image/webp':'.webp','video/mp4':'.mp4','video/quicktime':'.mov','video/webm':'.webm','audio/wav':'.wav','audio/mpeg':'.mp3','audio/mp4':'.m4a','audio/aac':'.aac','audio/flac':'.flac','audio/ogg':'.ogg'})[file.type];
    if (!suffix) throw new Error('UNSUPPORTED_MEDIA');
    const key = `${identify}/uploads/rh-bridge-${digest}${suffix}`;
    try {
      const uploader = new Upload({ client, params: { Bucket: credential.bucket, Body: uploadFile, Key: key, ACL: "public-read",
        ContentType: uploadFile.type, Metadata: { contentType: uploadFile.type, contentLength: String(uploadFile.size) } } });
      const uploaded = await uploader.done();
      let url = String(uploaded.Location || "");
      if (!url) throw new Error("UPLOAD_EMPTY_URL");
      if (credential.cdnDomain) url = `https://${credential.cdnDomain}/${new URL(url).pathname.replace(/^\//, "")}`;
      else if (credential.region) url = url.replace("accelerate", credential.region);
      let dimensions = { width: 380, height: 320 };
      if (file.type.startsWith('image/')) try { const bitmap = await createImageBitmap(uploadFile); dimensions = { width: bitmap.width, height: bitmap.height }; bitmap.close(); } catch {}
      return { url, file: { name: uploadFile.name, type: uploadFile.type, size: uploadFile.size, sha256: digest }, dimensions };
    } finally { client.destroy(); }
  };

  const uploadLocalReferenceImage = async ({ config = {}, file = {}, connectToNodeId } = {}) => {
    if (connectToNodeId) await getElement({ elementId: connectToNodeId });
    const uploaded = await uploadCanvasFile(file);
    const created = await createNode({ id: config.id, type: "rh-image", x: config.x, y: config.y,
      data: { title: config.title || file.name, label: config.title || file.name, status: "idle",
        sourceObjects: [uploaded.url], imageUrl: uploaded.url, ...uploaded.dimensions } }, { type: "canvas.createNode" });
    const nodeId = created.result.nodeId;
    const connectedEdges = connectToNodeId ? [(await connectNodes({ source: nodeId, target: connectToNodeId })).result] : [];
    const reference = { nodeId, title: config.title || file.name, urls: [uploaded.url] };
    return { ok: true, file: uploaded.file, primaryReference: reference, usableReferences: [reference], connectedEdges, generationTriggered: false };
  };

  const uploadReferenceImage = async ({ nodeId, targetNodeId, file, config = {} }) =>
    uploadLocalReferenceImage({ file, config, connectToNodeId: targetNodeId || nodeId });

  const uploadLocalMedia = async ({ config = {}, file = {}, connectToNodeId } = {}) => {
    if (file.kind === 'image') return uploadLocalReferenceImage({ config, file, connectToNodeId });
    if (!['video','audio'].includes(file.kind) || !file.type?.startsWith(file.kind+'/')) throw new Error('UNSUPPORTED_MEDIA');
    if (connectToNodeId) await getElement({ elementId: connectToNodeId });
    const uploaded=await uploadCanvasFile(file);
    const data={title:config.title || file.name,label:config.title || file.name,status:'idle',sourceObjects:[uploaded.url],
      fileName:file.name,fileSize:uploaded.file.size,mimeType:file.type,duration:file.duration,subType:`text-${file.kind}`,
      ...(file.kind==='video' ? {videoUrl:uploaded.url,sourceVideo:uploaded.url,videoWidth:file.width,videoHeight:file.height,width:380,height:280} : {audioUrl:uploaded.url,width:380,height:160})};
    const created=await createNode({id:config.id,type:`rh-${file.kind}`,x:config.x,y:config.y,data},{type:'canvas.createNode'});
    const nodeId=created.result.nodeId;
    const connectedEdges=connectToNodeId ? [(await connectNodes({source:nodeId,target:connectToNodeId})).result] : [];
    return {ok:true,file:uploaded.file,mediaKind:file.kind,primaryReference:{nodeId,urls:[uploaded.url]},connectedEdges,generationTriggered:false};
  };

  const pollNodeResult = async ({ nodeId, id, timeoutMs = 180000, intervalMs = 3000, requireOutput = true } = {}) => {
    const target = nodeId || id;
    if (!target) throw new Error("nodeId is required");
    const startedAt = Date.now();
    let lastSummary = null;
    while (Date.now() - startedAt <= Number(timeoutMs || 180000)) {
      const summary = await withCanvasYjs(({ nodes }) => {
        const node = yArrayToJson(nodes).find((item) => item?.id === target);
        if (!node) throw new Error(`Node not found: ${target}`);
        return summarizeNodeResult(node);
      });
      lastSummary = summary;
      const hasOutput = summary.outputCount > 0 || summary.outputs.length > 0;
      if ((requireOutput && hasOutput) || (!requireOutput && (hasOutput || summary.hasTerminalStatus))) {
        return { ok: true, done: true, elapsedMs: Date.now() - startedAt, ...summary };
      }
      if (summary.hasTerminalStatus && !hasOutput) {
        return { ok: false, done: true, elapsedMs: Date.now() - startedAt, ...summary };
      }
      await wait(Number(intervalMs || 3000));
    }
    return { ok: false, done: false, elapsedMs: Date.now() - startedAt, last: lastSummary };
  };

  const findTaskResultInSnapshot = ({ taskId, nodes }) => {
    for (const node of nodes) {
      const outputs = outputUrlsFromNode(node).filter((item) => item.taskId === taskId);
      if (outputs.length || node?.data?.taskId === taskId) {
        return {
          nodeId: node.id,
          type: node.type,
          title: node.data?.title,
          status: node.data?.status,
          taskId,
          outputs,
          outputCount: outputs.length,
          nodeSummary: summarizeNodeResult(node)
        };
      }
    }
    return null;
  };

  const pollTaskResult = async ({ taskId, timeoutMs = 180000, intervalMs = 3000, requireOutput = true } = {}) => {
    if (!taskId) throw new Error("taskId is required");
    const startedAt = Date.now();
    let last = null;
    while (Date.now() - startedAt <= Number(timeoutMs || 180000)) {
      const match = await withCanvasYjs(({ nodes }) => findTaskResultInSnapshot({ taskId, nodes: yArrayToJson(nodes) }));
      last = match;
      if (match && (!requireOutput || match.outputs.length)) {
        return { ok: true, done: true, elapsedMs: Date.now() - startedAt, ...match };
      }
      await wait(Number(intervalMs || 3000));
    }
    return { ok: false, done: false, elapsedMs: Date.now() - startedAt, taskId, last };
  };

  const updateNodeModel = async ({ nodeId, id, modelCode, modelName, data = {}, ...command } = {}) => {
    const targetId = nodeId || id;
    if (!targetId) throw new Error("nodeId is required");
    const model = resolveModelAlias({ modelName, modelCode, subType: data.subType });
    if (!model?.modelCode) throw new Error("modelCode or known modelName is required");
    return withCanvasMutation({ type: "canvas.updateNodeModel", ...command }, ({ Y, doc, nodes }) => {
      let updatedNode;
      doc.transact(() => {
        for (let index = 0; index < nodes.length; index++) {
          const node = nodes.get(index);
          const nodeJson = node?.toJSON?.() || node;
          if (nodeJson?.id !== targetId) continue;
          const next = {
            ...nodeJson,
            data: {
              ...(nodeJson.data || {}),
              ...data,
              modelCode: model.modelCode,
              requestedModelName: model.requestedModelName,
              runningHubModelName: model.runningHubModelName,
              modelMappingStatus: model.mappingStatus,
              params: {
                ...(nodeJson.data?.params || {}),
                ...(data.params || {}),
                ...(model.params || {})
              }
            }
          };
          nodes.delete(index, 1);
          nodes.insert(index, [toYValue(Y, next)]);
          updatedNode = next;
          break;
        }
      });
      if (!updatedNode) throw new Error(`Node not found: ${targetId}`);
      return { updated: true, nodeId: targetId, node: updatedNode };
    });
  };

  const updateNodeParams = async ({ nodeId, id, params = {}, ...command } = {}) => {
    const targetId = nodeId || id;
    if (!targetId) throw new Error("nodeId is required");
    return withCanvasMutation({ type: "canvas.updateNodeParams", ...command }, ({ Y, doc, nodes }) => {
      let updatedNode;
      doc.transact(() => {
        for (let index = 0; index < nodes.length; index++) {
          const node = nodes.get(index);
          const nodeJson = node?.toJSON?.() || node;
          if (nodeJson?.id !== targetId) continue;
          const next = {
            ...nodeJson,
            data: {
              ...(nodeJson.data || {}),
              params: {
                ...(nodeJson.data?.params || {}),
                ...params
              }
            }
          };
          nodes.delete(index, 1);
          nodes.insert(index, [toYValue(Y, next)]);
          updatedNode = next;
          break;
        }
      });
      if (!updatedNode) throw new Error(`Node not found: ${targetId}`);
      return { updated: true, nodeId: targetId, node: updatedNode };
    });
  };

  const connectNodes = async ({ source, target, sourceHandle = "output", targetHandle = "input", edgeId: requestedEdgeId, id: commandId, ...command } = {}) => {
    if (!source) throw new Error("source is required");
    if (!target) throw new Error("target is required");
    return withCanvasMutation({ type: "canvas.connectNodes", id: commandId, ...command }, ({ Y, doc, nodes, edges }) => {
      const nodeIds = new Set(yArrayToJson(nodes).map((node) => node?.id).filter(Boolean));
      if (!nodeIds.has(source)) throw new Error(`Source node not found: ${source}`);
      if (!nodeIds.has(target)) throw new Error(`Target node not found: ${target}`);
      const edgeId = requestedEdgeId || `e-${source}-${target}`;
      const existing = yArrayToJson(edges).some((edge) => edge?.id === edgeId);
      if (existing) return { edgeId, created: false };
      const edge = { id: edgeId, source, target, sourceHandle, targetHandle, type: "default", animated: false };
      doc.transact(() => edges.push([toYValue(Y, edge)]));
      return { edgeId, created: true, edge };
    });
  };

  const updateNodePosition = async ({ nodeId, x, y, ...command } = {}) => {
    if (!nodeId) throw new Error("nodeId is required");
    return withCanvasMutation({ type: "canvas.updateNodePosition", ...command }, ({ Y, doc, nodes }) => {
      let updated = false;
      doc.transact(() => {
        for (let index = 0; index < nodes.length; index++) {
          const node = nodes.get(index);
          const nodeJson = node?.toJSON?.() || node;
          if (nodeJson?.id !== nodeId) continue;

          if (node instanceof Y.Map) {
            let position = node.get("position");
            if (!(position instanceof Y.Map)) {
              position = toYValue(Y, position || {});
              node.set("position", position);
            }
            if (x !== undefined) position.set("x", Number(x));
            if (y !== undefined) position.set("y", Number(y));
          } else {
            nodeJson.position ||= {};
            if (x !== undefined) nodeJson.position.x = Number(x);
            if (y !== undefined) nodeJson.position.y = Number(y);
            nodes.delete(index, 1);
            nodes.insert(index, [toYValue(Y, nodeJson)]);
          }
          updated = true;
          break;
        }
      });
      if (!updated) throw new Error(`Node not found: ${nodeId}`);
      return { updated: true, nodeId, x: x === undefined ? undefined : Number(x), y: y === undefined ? undefined : Number(y) };
    });
  };

  const updateNodeText = async ({ nodeId, text, title, ...command } = {}) => {
    if (!nodeId) throw new Error("nodeId is required");
    return withCanvasMutation({ type: "canvas.updateNodeText", ...command }, ({ Y, doc, nodes }) => {
      let updated = false;
      doc.transact(() => {
        for (let index = 0; index < nodes.length; index++) {
          const node = nodes.get(index);
          const nodeJson = node?.toJSON?.() || node;
          if (nodeJson?.id !== nodeId) continue;

          if (node instanceof Y.Map) {
            let data = node.get("data");
            if (!(data instanceof Y.Map)) {
              data = toYValue(Y, data || {});
              node.set("data", data);
            }
            if (text !== undefined) data.set("text", text);
            if (title !== undefined) { data.set("title", title); data.set("label", title); }
          } else {
            nodeJson.data ||= {};
            if (text !== undefined) nodeJson.data.text = text;
            if (title !== undefined) { nodeJson.data.title = title; nodeJson.data.label = title; }
            nodes.delete(index, 1);
            nodes.insert(index, [toYValue(Y, nodeJson)]);
          }
          updated = true;
          break;
        }
      });
      if (!updated) throw new Error(`Node not found: ${nodeId}`);
      return { updated: true, nodeId, text, title };
    });
  };

  const updateNode = async ({ nodeId, id, patch = {}, position, data, style, title, text, zIndex, width, height, ...command } = {}) => {
    const targetId = nodeId || id;
    if (!targetId) throw new Error("nodeId is required");
    return withCanvasMutation({ type: "canvas.updateNode", ...command }, ({ Y, doc, nodes }) => {
      let updatedNode;
      doc.transact(() => {
        for (let index = 0; index < nodes.length; index++) {
          const node = nodes.get(index);
          const nodeJson = node?.toJSON?.() || node;
          if (nodeJson?.id !== targetId) continue;

          const next = {
            ...nodeJson,
            ...patch,
            data: mergePlainObject(nodeJson.data, patch.data),
            style: mergePlainObject(nodeJson.style, patch.style),
            position: mergePlainObject(nodeJson.position, patch.position)
          };
          if (position) next.position = mergePlainObject(next.position, position);
          if (data) next.data = mergePlainObject(next.data, data);
          if (style) next.style = mergePlainObject(next.style, style);
          if (title !== undefined || text !== undefined) {
            next.data ||= {};
            if (title !== undefined) { next.data.title = title; next.data.label = title; }
            if (text !== undefined) next.data.text = text;
          }
          if (zIndex !== undefined) next.zIndex = Number(zIndex);
          if (width !== undefined) next.width = Number(width);
          if (height !== undefined) next.height = Number(height);

          nodes.delete(index, 1);
          nodes.insert(index, [toYValue(Y, next)]);
          updatedNode = next;
          break;
        }
      });
      if (!updatedNode) throw new Error(`Node not found: ${targetId}`);
      return { updated: true, nodeId: targetId, node: updatedNode };
    });
  };

  const moveNodes = async ({ nodeIds = [], ids = [], dx = 0, dy = 0, positions = {}, ...command } = {}) => {
    const targetIds = [...nodeIds, ...ids].filter(Boolean);
    if (!targetIds.length) throw new Error("nodeIds or ids is required");
    const targetSet = new Set(targetIds);
    const deltaX = Number(dx) || 0;
    const deltaY = Number(dy) || 0;
    return withCanvasMutation({ type: "canvas.moveNodes", ...command }, ({ Y, doc, nodes }) => {
      const moved = [];
      doc.transact(() => {
        for (let index = 0; index < nodes.length; index++) {
          const node = nodes.get(index);
          const nodeJson = node?.toJSON?.() || node;
          if (!targetSet.has(nodeJson?.id)) continue;

          const currentPosition = nodeJson.position || {};
          const explicit = positions[nodeJson.id] || {};
          const next = {
            ...nodeJson,
            position: {
              ...currentPosition,
              x: explicit.x !== undefined ? Number(explicit.x) : (Number(currentPosition.x) || 0) + deltaX,
              y: explicit.y !== undefined ? Number(explicit.y) : (Number(currentPosition.y) || 0) + deltaY
            }
          };
          nodes.delete(index, 1);
          nodes.insert(index, [toYValue(Y, next)]);
          moved.push({ nodeId: nodeJson.id, from: currentPosition, to: next.position });
        }
      });
      const missing = targetIds.filter((id) => !moved.some((item) => item.nodeId === id));
      return { moved, missing, counts: { moved: moved.length, missing: missing.length } };
    });
  };

  const deleteElements = async ({ ids = [], nodeIds = [], edgeIds = [], ...command } = {}) =>
    withCanvasMutation({ type: "canvas.deleteElements", ...command }, ({ nodes, edges }) => {
      const nodeSet = new Set([...ids, ...nodeIds].filter(Boolean));
      const edgeSet = new Set([...ids, ...edgeIds].filter(Boolean));
      let deletedNodes = 0;
      let deletedEdges = 0;

      for (let index = edges.length - 1; index >= 0; index--) {
        const edge = edges.get(index)?.toJSON?.() || edges.get(index);
        if (edgeSet.has(edge?.id) || nodeSet.has(edge?.source) || nodeSet.has(edge?.target)) {
          edges.delete(index, 1);
          deletedEdges++;
        }
      }
      for (let index = nodes.length - 1; index >= 0; index--) {
        const node = nodes.get(index)?.toJSON?.() || nodes.get(index);
        if (nodeSet.has(node?.id)) {
          nodes.delete(index, 1);
          deletedNodes++;
        }
      }
      return { deletedNodes, deletedEdges };
    });

  const featureTools = FEATURES.create({
    api: async (endpoint,body) => {
      const response=await fetch(new URL(endpoint,SITE_POLICY.parseCanvas(location.href).apiOrigin),{method:'POST',headers:authHeaders(),credentials:'include',body:JSON.stringify(body)});
      if(!response.ok) throw new Error(`PLATFORM_API_ERROR: ${response.status}`);
      const payload=await response.json();
      if(payload.code!==undefined && Number(payload.code)!==0) throw new Error(`PLATFORM_API_ERROR: ${payload.code}: ${String(payload.msg || payload.message || "").slice(0,250)}`);
      return payload.data ?? payload;
    },
    withMutation:withCanvasMutation,
    readSnapshot:()=>withCanvasYjs(ctx=>canvasSnapshotFromContext(ctx)),toYValue,getTitle:getNodeTitle
  });

  const executeCommand = async (command) => {
    if (!command || !command.id) return;
    let result;
    try {
      if (command.expiresAt && command.expiresAt < Date.now()) throw new Error("COMMAND_EXPIRED");
      activeCommand = command;
      activeCommandAccess = command.access ? {...command.access, generationEnabled:ACCESS.generationEnabled} : ACCESS;
      const denied = SITE_POLICY.authorizeCommand(command, activeCommandAccess, SITE_POLICY.parseCanvas(location.href));
      if (denied) throw new Error(denied);
      if(command.validateParams && ['canvas.updateNodeParams','canvas.updateNode','canvas.batchUpdate'].includes(command.type)) {
        const updates=command.type==='canvas.batchUpdate'?command.updates:[{nodeId:command.nodeId,params:command.params || command.data?.params,modelCode:command.data?.modelCode,subType:command.data?.subType}];
        for(const update of updates.filter(u=>u.params)) {
          const checked=await featureTools.validatePatch({...update,expectedRevisions:command.expectedRevisions});
          command.expectedRevisions={...command.expectedRevisions,...checked.expectedRevisions};
        }
      }
      const featureName=command.type?.replace(/^canvas\./,'');
      if (Object.hasOwn(featureTools,featureName)) {
        result = await featureTools[featureName](command);
      } else if (command.type === "graph.snapshot") {
        result = summarizeGraph();
      } else if (command.type === "canvas.exportWorkflow") {
        if (typeof window._exportWorkflow !== "function") throw new Error("window._exportWorkflow is not available");
        result = window._exportWorkflow();
      } else if (command.type === "canvas.yjsSnapshot") {
        result = await withCanvasYjs(({ nodes, edges, canvasId }) => ({
          canvasId,
          nodes: yArrayToJson(nodes),
          edges: yArrayToJson(edges)
        }));
      } else if (command.type === "canvas.summary") {
        result = await summarizeCanvas(command);
      } else if (command.type === "canvas.rollbackList") {
        result = rollbackStack.map(({ before, after, ...entry }) => ({
          ...entry,
          before: { nodes: before.nodes.length, edges: before.edges.length },
          after: { nodes: after.nodes.length, edges: after.edges.length }
        }));
      } else if (command.type === "canvas.rollback") {
        result = await rollbackCanvas(command);
      } else if (command.type === "canvas.restoreSnapshot") {
        result = await replaceCanvasSnapshot(command);
      } else if (command.type === "canvas.capabilities") {
        result = canvasCapabilities();
      } else if (command.type === "canvas.findElements") {
        result = await findElements(command.query || command);
      } else if (command.type === "canvas.findReferenceCandidates") {
        result = await findReferenceCandidates(command);
      } else if (command.type === "canvas.describeImageNode") {
        result = await describeImageNode(command);
      } else if (command.type === "canvas.suggestEmptyRegion") {
        result = await suggestEmptyRegion(command);
      } else if (command.type === "canvas.getElement") {
        result = await getElement(command);
      } else if (command.type === "canvas.inspectNodeTemplate") {
        result = await inspectNodeTemplate(command);
      } else if (command.type === "canvas.inspectModelOptions") {
        result = inspectModelOptions(command);
      } else if (command.type === "canvas.resolveModelAlias") {
        result = resolveModelAlias(command);
      } else if (command.type === "canvas.getConnections") {
        result = await getConnections(command);
      } else if (command.type === "canvas.createTextWorkflow") {
        result = await createTextWorkflow(command.config || {}, command);
      } else if (command.type === "canvas.createTextNode") {
        result = await createTextNode(command.config || {}, command);
      } else if (command.type === "canvas.createTextNodes") {
        result = await createTextNodes(command.config || command.configs || [], command);
      } else if (command.type === "canvas.groupElements") {
        result = await groupElements(command);
      } else if (command.type === "canvas.createNode") {
        result = await createNode(command.config || {}, command);
      } else if (command.type === "canvas.cloneTemplate") {
        result = await cloneTemplate(command);
      } else if (command.type === "canvas.createVideoNode") {
        result = await createVideoNode(command.config || {}, command);
      } else if (command.type === "canvas.createImageNode") {
        result = await createImageNode(command.config || {}, command);
      } else if (command.type === "canvas.prepareImageWorkflow") {
        result = await prepareImageWorkflow(command);
      } else if (command.type === "canvas.createReferenceImageNode") {
        result = await createReferenceImageNode(command.config || {}, command);
      } else if (command.type === "canvas.createReferenceFromUrl") {
        result = await createReferenceFromUrl(command);
      } else if (command.type === "canvas.uploadReferenceImage") {
        result = await uploadReferenceImage(command);
      } else if (command.type === "canvas.uploadLocalReferenceImage") {
        result = await uploadLocalReferenceImage(command);
      } else if (command.type === "canvas.uploadLocalMedia") {
        result = await uploadLocalMedia(command);
      } else if (command.type === "canvas.prepareVideoNode") {
        result = await prepareVideoNode(command);
      } else if (command.type === "canvas.validateVideoRun") {
        result = await validateVideoRun(command);
      } else if (command.type === "canvas.validateNodeRun") {
        result = await validateNodeRun(command);
      } else if (command.type === "canvas.generateVideoNode") {
        result = await generateVideoNode(command);
      } else if (command.type === "canvas.runNode") {
        result = await runNode(command);
      } else if (command.type === "canvas.pollNodeResult") {
        result = await pollNodeResult(command);
      } else if (command.type === "canvas.pollTaskResult") {
        result = await pollTaskResult(command);
      } else if (command.type === "canvas.connectNodes") {
        result = await connectNodes(command);
      } else if (command.type === "canvas.updateNodeModel") {
        result = await updateNodeModel(command);
      } else if (command.type === "canvas.updateNodeParams") {
        result = await updateNodeParams(command);
      } else if (command.type === "canvas.updateNode") {
        result = await updateNode(command);
      } else if (command.type === "canvas.updateNodePosition") {
        result = await updateNodePosition(command);
      } else if (command.type === "canvas.moveNodes") {
        result = await moveNodes(command);
      } else if (command.type === "canvas.updateNodeText") {
        result = await updateNodeText(command);
      } else if (command.type === "canvas.deleteElements") {
        result = await deleteElements(command);
      } else if (command.type === "canvas.getDetail") {
        result = await postJson("/canvas/getCanvasDetail", { id: SITE_POLICY.parseCanvas(location.href).canvasId }, command.maxChars);
      } else if (command.type === "canvas.workflowList") {
        result = await postJson("/canvas/workflow/list", { canvasId: SITE_POLICY.parseCanvas(location.href).canvasId }, command.maxChars);
      } else if (command.type === "api.post") {
        result = await postJson(command.endpoint, command.body || {}, command.maxChars);
      } else if (command.type === "page.eval") {
        const fn = new Function("arg", command.code);
        result = await fn(command.arg);
      } else {
        throw new Error(`Unknown command type: ${command.type}`);
      }
      postEvent({ kind: "command.result", commandId: command.id, ok: true, result: safeJson(result) });
    } catch (error) {
      postEvent({
        kind: "command.result",
        commandId: command.id,
        ok: false,
        errorCode: errorCodeFromError(error),
        error: error && error.stack ? error.stack : String(error)
      });
    } finally {
      activeCommandAccess = null;
      activeCommand = null;
    }
  };

  const pollCommands = async () => {
    try {
      const versionResponse = await fetch(`${BRIDGE}/runtime-version`, { mode: "cors", cache: "no-store" });
      if (versionResponse.ok) {
        const version = await versionResponse.json();
        if (version.version && version.version !== RUNTIME_VERSION) {
          postEvent({ kind: "bridge.runtime.stale", currentVersion: RUNTIME_VERSION, nextVersion: version.version });
          const runtimeResponse = await fetch(`${BRIDGE}/bridge-runtime.js?ts=${Date.now()}`, { mode: "cors", cache: "no-store" });
          if (!runtimeResponse.ok) throw new Error(`Failed to reload runtime: ${runtimeResponse.status}`);
          const code = await runtimeResponse.text();
          new Function(`${code}\n//# sourceURL=runninghub-canvas-bridge-runtime.js`)();
          return;
        }
      }
      const response = await fetch(`${BRIDGE}/commands?clientId=${encodeURIComponent(CLIENT_ID)}&href=${encodeURIComponent(location.href)}`, {
        mode: "cors"
      });
      if (response.ok) {
        const commands = await response.json();
        for (const command of commands) await executeCommand(command);
      } else if (response.status === 403) {
        // The local service may have restarted while this page stayed open.
        await postEvent({ kind: "bridge.installed", graph: summarizeGraph() });
      }
    } catch {}
    pollTimer = setTimeout(pollCommands, 700);
  };

  window.__RUNNINGHUB_CANVAS_BRIDGE__ = {
    clientId: CLIENT_ID,
    version: RUNTIME_VERSION,
    graph: summarizeGraph,
    capabilities: canvasCapabilities,
    commands: COMMAND_CAPABILITIES.filter((item) => SITE_POLICY.commandMode(item) !== "blocked").map((capability) => capability.type)
  };

  window.__RUNNINGHUB_CANVAS_BRIDGE_CLEANUP__ = () => {
    if (pollTimer) clearTimeout(pollTimer);
    if (originalFetch) window.fetch = originalFetch;
    if (OriginalXHR) window.XMLHttpRequest = OriginalXHR;
    if (OriginalWebSocket) {
      window.WebSocket = OriginalWebSocket;
      window.WebSocket.prototype = OriginalWebSocket.prototype;
    }
    window.__RUNNINGHUB_CANVAS_BRIDGE_INSTALLED__ = false;
  };

  postEvent({ kind: "bridge.installed", graph: summarizeGraph() });
  pollCommands();
})();
