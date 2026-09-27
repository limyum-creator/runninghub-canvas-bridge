// International routing and command policy, added 2026-09-27. Apache-2.0.
(() => {
  const origins = Object.freeze([
    "https://www.runninghub.ai",
    "https://rhtv.runninghub.ai",
    "https://www.runninghub.cn",
    "https://rhtv.runninghub.cn"
  ]);
  const parseCanvas = (href) => {
    try {
      const url = new URL(href);
      if (!origins.includes(url.origin) || url.username || url.password) return null;
      const match = url.pathname.match(/^\/projects?\/canvas\/([A-Za-z0-9_-]+)\/?$/);
      if (!match) return null;
      const international = url.hostname.endsWith(".runninghub.ai");
      const apiOrigin = international ? "https://www.runninghub.ai" : url.origin;
      return {
        origin: url.origin,
        apiOrigin,
        canvasId: match[1],
        key: `${url.origin}/${match[1]}`,
        websocketUrl: `${apiOrigin.replace(/^https:/, "wss:")}/canvas/ws`,
        international
      };
    } catch { return null; }
  };
  const readCommands = new Set([
    "graph.snapshot", "canvas.exportWorkflow", "canvas.yjsSnapshot", "canvas.summary",
    "canvas.capabilities", "canvas.rollbackList", "canvas.findElements",
    "canvas.findReferenceCandidates", "canvas.describeImageNode", "canvas.suggestEmptyRegion",
    "canvas.getElement", "canvas.inspectNodeTemplate", "canvas.inspectModelOptions",
    "canvas.resolveModelAlias", "canvas.getConnections", "canvas.validateNodeRun",
    "canvas.validateVideoRun", "canvas.pollNodeResult", "canvas.pollTaskResult",
    "canvas.getDetail", "canvas.workflowList"
  ]);
  const editCommands = new Set([
    "canvas.createTextNode", "canvas.createTextNodes", "canvas.groupElements",
    "canvas.createNode", "canvas.createVideoNode", "canvas.createImageNode",
    "canvas.prepareImageWorkflow", "canvas.createReferenceImageNode",
    "canvas.createReferenceFromUrl", "canvas.prepareVideoNode", "canvas.connectNodes",
    "canvas.updateNodeModel", "canvas.updateNodeParams", "canvas.updateNode",
    "canvas.updateNodePosition", "canvas.moveNodes", "canvas.updateNodeText",
    "canvas.deleteElements", "canvas.rollback", "canvas.cloneTemplate",
    "canvas.uploadReferenceImage", "canvas.uploadLocalReferenceImage", "canvas.uploadLocalMedia"
  ]);
  const generationCommands = new Set(["canvas.runNode", "canvas.generateVideoNode"]);
  // Arbitrary page evaluation/API calls and snapshot replacement are not tools.
  const commandMode = (command) => readCommands.has(command?.type) ? "read"
    : editCommands.has(command?.type) ? (command.dryRun === true && !command.type.startsWith("canvas.upload") ? "preview" : "edit")
    : generationCommands.has(command?.type) ? (command.dryRun === true ? "preview" : "generate")
    : "blocked";
  const authorizeCommand = (command, policy = {}, canvas) => {
    const mode = commandMode(command);
    if (mode === "blocked") return "COMMAND_DISABLED";
    if (command.broadcast) return "BROADCAST_DISABLED";
    if (command.canvasId && canvas && command.canvasId !== canvas.canvasId) return "CANVAS_MISMATCH";
    if (command.canvasOrigin && canvas && command.canvasOrigin !== canvas.origin) return "SITE_MISMATCH";
    if (mode === "generate" && !policy.generationEnabled) return "GENERATION_DISABLED";
    if (mode === "edit" || mode === "generate") {
      if (!policy.allowWrites) return "READ_ONLY";
      if (!policy.canvasId || policy.canvasId !== canvas?.canvasId) return "CANVAS_NOT_ALLOWED";
      if (!policy.origin || policy.origin !== canvas?.origin) return "SITE_NOT_ALLOWED";
    }
    return null;
  };
  const mergePromptParts = (parts) => {
    const retained = [];
    for (const value of parts) {
      const text = String(value || "").trim();
      if (!text || retained.some((part) => part === text || part.includes(text))) continue;
      retained.push(text);
    }
    return retained;
  };
  globalThis.RHCanvasSitePolicy = Object.freeze({
    origins, parseCanvas, commandMode, authorizeCommand, mergePromptParts
  });
})();
