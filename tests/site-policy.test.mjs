import test from "node:test";
import assert from "node:assert/strict";
import "../extension/site-policy.js";
const policy = globalThis.RHCanvasSitePolicy;

test("international and legacy URLs resolve without crossing account regions", () => {
  for (const [href, expected] of [
    ["https://www.runninghub.ai/project/canvas/123?canvas_debug=1", "wss://www.runninghub.ai/canvas/ws"],
    ["https://rhtv.runninghub.ai/project/canvas/123", "wss://www.runninghub.ai/canvas/ws"],
    ["https://rhtv.runninghub.cn/projects/canvas/123", "wss://rhtv.runninghub.cn/canvas/ws"],
    ["https://www.runninghub.cn/project/canvas/123", "wss://www.runninghub.cn/canvas/ws"]
  ]) assert.equal(policy.parseCanvas(href).websocketUrl, expected);
  assert.notEqual(policy.parseCanvas("https://www.runninghub.ai/project/canvas/123").key,
    policy.parseCanvas("https://rhtv.runninghub.cn/projects/canvas/123").key);
});

test("reject non-canvas routes and lookalike hosts", () => {
  for (const href of ["https://www.runninghub.ai.evil.test/project/canvas/123",
    "https://evil.test/?next=https://www.runninghub.ai/project/canvas/123",
    "http://www.runninghub.ai/project/canvas/123", "https://www.runninghub.ai/projects/canvas",
    "https://www.runninghub.ai/project/canvas/123/sketchboard",
    "https://user:pass@www.runninghub.ai/project/canvas/123"])
    assert.equal(policy.parseCanvas(href), null, href);
});

test("writes need both the exact canvas and origin; generation follows explicit scope", () => {
  const canvas = policy.parseCanvas("https://www.runninghub.ai/project/canvas/123");
  const access = { allowWrites: true, canvasId: "123", origin: canvas.origin };
  const edit = { type: "canvas.updateNodeText" };
  assert.equal(policy.authorizeCommand(edit, {}, canvas), "READ_ONLY");
  assert.equal(policy.authorizeCommand(edit, access, canvas), null);
  assert.equal(policy.authorizeCommand(edit, { ...access, canvasId: "124" }, canvas), "CANVAS_NOT_ALLOWED");
  assert.equal(policy.authorizeCommand(edit, { ...access, origin: "https://www.runninghub.cn" }, canvas), "SITE_NOT_ALLOWED");
  for (const type of ["page.eval", "api.post", "canvas.restoreSnapshot"])
    assert.equal(policy.authorizeCommand({ type, dryRun: true }, access, canvas), "COMMAND_DISABLED");
  assert.equal(policy.authorizeCommand({ ...edit, dryRun: true }, {}, canvas), null);
  assert.equal(policy.authorizeCommand({ type: "canvas.summary", broadcast: true }, access, canvas), "BROADCAST_DISABLED");
});

test("repeating preparation preserves complete existing dialogue without appending it again", () => {
  const existing = "Original directions\n\n完整台词，不能缩句。";
  const once = policy.mergePromptParts([existing, "完整台词，不能缩句。", "New instruction"]).join("\n\n");
  assert.equal(once, existing + "\n\nNew instruction");
  assert.equal(policy.mergePromptParts([once, "完整台词，不能缩句。", "New instruction"]).join("\n\n"), once);
});


test("enabled generation and uploads still require the selected writable canvas", () => {
 const canvas = policy.parseCanvas("https://rhtv.runninghub.ai/project/canvas/123");
 const access = {allowWrites: true, generationEnabled: true, canvasId: "123", origin: canvas.origin};
 assert.equal(policy.authorizeCommand({type:"canvas.runNode"}, access, canvas), null);
 assert.equal(policy.authorizeCommand({type:"canvas.runNode"}, {...access,generationEnabled:false},canvas),"GENERATION_DISABLED");
 assert.equal(policy.authorizeCommand({type:"canvas.uploadLocalReferenceImage",dryRun:true},{},canvas),"READ_ONLY");
 assert.equal(policy.authorizeCommand({type:"canvas.runNode",dryRun:true},{},canvas),null);
});
