import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import {webcrypto} from "node:crypto";
const featureSource=await readFile(new URL("../server/canvas-features.js",import.meta.url),"utf8");
import * as Y from "yjs";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import { messageYjsSyncStep1 } from "y-protocols/sync";

const siteSource = await readFile(new URL("../extension/site-policy.js", import.meta.url), "utf8");
const runtimeSource = (await readFile(new URL("../server/bridge-runtime.js", import.meta.url), "utf8"))
  .replace('import(`${BRIDGE}/vendor/yjs.js`)', "Promise.resolve(globalThis.testDependencies)")
  .replace("  pollCommands();\n})();", "  window.testHooks = { withCanvasYjs, executeCommand, getNodeTitle };\n})();");

function fixture({ emptySchema = false, allowWrites = false, canvasId = "fixture", generationEnabled = false, apiData = {} } = {}) {
  const remoteDoc = new Y.Doc();
  if (!emptySchema) {
    const content = new Y.Map();
    content.set("nodes", new Y.Array()); content.set("edges", new Y.Array());
    remoteDoc.getMap("canvas").set("canvas_content", content);
  }
  const writes = [], providers = [], events = [], requests = [];
  class Provider {
    constructor(url, room, doc, options) {
      this.url = url; this.room = room; this.doc = doc; this.options = options;
      this.handlers = new Map(); this.messageHandlers = [() => { this.syncReply = true; }];
      this._updateHandler = (update, origin) => { if (origin !== this) { writes.push(update); Y.applyUpdate(remoteDoc, update); } };
      doc.on("update", this._updateHandler); providers.push(this);
    }
    on(name, callback) { this.handlers.set(name, callback); }
    connect() { Y.applyUpdate(this.doc, Y.encodeStateAsUpdate(remoteDoc), this); this.handlers.get("sync")?.(true); }
    destroy() { this.destroyed = true; }
  }
  const token = "test." + Buffer.from(JSON.stringify({ sub: "current-user", exp: 9999999999 })).toString("base64url") + ".synthetic";
  const sandbox = {
    URL, Headers, console, atob, crypto:webcrypto, TextEncoder, setTimeout: (fn, ms) => setTimeout(fn, ms === 1200 ? 1 : ms), clearTimeout,
    location: new URL(`https://www.runninghub.ai/project/canvas/${canvasId}`),
    document: { cookie: "Rh-Accesstoken=" + token, title: "Fixture", querySelectorAll: () => [] },
    localStorage: { getItem: () => null },
    testDependencies: { Y, WebsocketProvider: Provider, decoding, messageYjsSyncStep1 },
    __RUNNINGHUB_CANVAS_BRIDGE_ACCESS__: { allowWrites, generationEnabled, canvasId: "fixture", origin: "https://www.runninghub.ai" },
    fetch: async (url, options) => {
      if (String(url).endsWith("/events")) { events.push(JSON.parse(options.body)); return { ok: true }; }
      requests.push(String(url));
      assert.equal(options.headers.Authorization, "Bearer " + token);
      const data = apiData[new URL(url).pathname] ?? (String(url).endsWith("/canvas/task/run") ? {taskId: "fixture-task", status: "RUNNING"} : String(url).endsWith("/canvas/getCanvasDetail")
        ? { user_id: "canvas-owner-not-the-current-user" }
        : { yjsGeneration: 5, yjsGenerationRequired: true });
      return { ok: true, status: 200, json: async () => ({ code: 0, data }), text: async () => JSON.stringify({ code: 0, data }) };
    }
  };
  sandbox.window = sandbox;
  vm.runInNewContext(siteSource + "\n" + featureSource + "\n" + runtimeSource, sandbox);
  return { sandbox, writes, providers, events, remoteDoc, requests };
}

test("read session uses current account, international socket and generation without updates", async () => {
  const f = fixture();
  await f.sandbox.testHooks.withCanvasYjs(({ nodes }) => assert.equal(nodes.length, 0));
  const p = f.providers[0];
  assert.equal(p.url, "wss://www.runninghub.ai/canvas/ws");
  assert.equal(p.options.params.userId, "current-user");
  assert.equal(p.options.params.generation, "5");
  assert.equal(p.options.params.readOnly, "1");
  assert.equal(p.options.disableBc, true);
  assert.equal(f.writes.length, 0);
  const input = encoding.createEncoder();
  encoding.writeVarUint(input, messageYjsSyncStep1);
  encoding.writeVarUint8Array(input, new Uint8Array([0]));
  p.messageHandlers[0](encoding.createEncoder(), decoding.createDecoder(encoding.toUint8Array(input)));
  assert.equal(p.syncReply, undefined);
  assert.equal(p.destroyed, true);
  f.remoteDoc.destroy();
});

test("schema mismatch cannot initialize or overwrite remote canvas data", async () => {
  const f = fixture({ emptySchema: true });
  await assert.rejects(f.sandbox.testHooks.withCanvasYjs(() => {}), /CANVAS_SCHEMA_UNSUPPORTED/);
  assert.equal(f.writes.length, 0);
  assert.equal(f.providers[0].destroyed, true);
  f.remoteDoc.destroy();
});

test("writes are refused before connecting unless this exact canvas is enabled", async () => {
  const f = fixture();
  await assert.rejects(f.sandbox.testHooks.withCanvasYjs(() => {}, { write: true }), /READ_ONLY/);
  assert.equal(f.providers.length, 0);
  const other = fixture({ allowWrites: true, canvasId: "different" });
  await assert.rejects(other.sandbox.testHooks.withCanvasYjs(() => {}, { write: true }), /CANVAS_NOT_ALLOWED/);
  assert.equal(other.providers.length, 0);
  f.remoteDoc.destroy(); other.remoteDoc.destroy();
});

test("generation is refused inside the page even if the HTTP guard were bypassed", async () => {
  const f = fixture({ allowWrites: true });
  await f.sandbox.testHooks.executeCommand({ id: "generation-attempt", type: "canvas.runNode" });
  const result = f.events.find((event) => event.commandId === "generation-attempt");
  assert.equal(result.ok, false);
  assert.match(result.error, /GENERATION_DISABLED/);
  assert.equal(f.providers.length, 0);
  assert.equal(f.sandbox.testHooks.getNodeTitle({ data: { label: "User label", title: "Upload" } }), "User label");
  f.remoteDoc.destroy();
});

test("dry-run previews nodes without sending any update to the shared canvas", async () => {
  const f = fixture();
  await f.sandbox.testHooks.executeCommand({ id: "preview", type: "canvas.createTextNode", dryRun: true, config: { id: "draft", text: "草稿", x: 0, y: 0 } });
  const event = f.events.find(e => e.commandId === "preview");
  assert.equal(event.ok, true);
  assert.equal(event.result.applied, false);
  assert.equal(event.result.result.node.position.x, 0);
  assert.equal(event.result.result.node.position.y, 0);
  assert.equal(f.writes.length, 0);
  assert.equal(f.remoteDoc.getMap("canvas").get("canvas_content").get("nodes").length, 0);
  f.remoteDoc.destroy();
});

test("text edits update the visible label as well as the legacy title", async () => {
  const f = fixture({ allowWrites: true });
  await f.sandbox.testHooks.executeCommand({ id: "create", type: "canvas.createTextNode", config: { id: "text-test", title: "原名", text: "保留完整对白。", x: 0, y: 0 } });
  await f.sandbox.testHooks.executeCommand({ id: "edit", type: "canvas.updateNodeText", nodeId: "text-test", title: "新名", text: "保留完整对白。" });
  assert.equal(f.events.find(e => e.commandId === "edit").ok, true);
  const node = f.remoteDoc.getMap("canvas").get("canvas_content").get("nodes").get(0).toJSON();
  assert.equal(node.data.title, "新名");
  assert.equal(node.data.label, "新名");
  assert.equal(node.data.text, "保留完整对白。");
  assert.equal(f.providers.every(p => p.options.params.readOnly === "0"), true);
  f.remoteDoc.destroy();
});

test("generation preview never submits; enabled real run preserves node payload", async () => {
  const f = fixture({ allowWrites: true, generationEnabled: true });
  await f.sandbox.testHooks.executeCommand({id:"create",type:"canvas.createTextNode",config:{id:"run-test",text:"完整对白。"}});
  await f.sandbox.testHooks.executeCommand({id:"preview-run",type:"canvas.runNode",nodeId:"run-test",dryRun:true});
  assert.equal(f.events.find(e=>e.commandId==="preview-run").result.submitted,false);
  assert.equal(f.requests.some(url=>url.endsWith('/canvas/task/run')),false);
  await f.sandbox.testHooks.executeCommand({id:"real-run",type:"canvas.runNode",nodeId:"run-test"});
  assert.equal(f.events.find(e=>e.commandId==="real-run").result.task.taskId,"fixture-task");
  assert.equal(f.requests.filter(url=>url.endsWith('/canvas/task/run')).length,1);
  f.remoteDoc.destroy();
});

test("get-element command ID is separate from the target node ID",async()=>{
 const f=fixture({allowWrites:true});
 await f.sandbox.testHooks.executeCommand({id:'create',type:'canvas.createTextNode',config:{id:'node-a',text:'第一版'}});
 await f.sandbox.testHooks.executeCommand({id:'read-1',type:'canvas.getElement',elementId:'node-a'});
 await f.sandbox.testHooks.executeCommand({id:'edit',type:'canvas.updateNodeText',nodeId:'node-a',text:'第二版'});
 await f.sandbox.testHooks.executeCommand({id:'read-2',type:'canvas.getElement',elementId:'node-a'});
 assert.equal(f.events.find(e=>e.commandId==='read-1').result.element.data.text,'第一版');
 assert.equal(f.events.find(e=>e.commandId==='read-2').result.element.data.text,'第二版');
 f.remoteDoc.destroy();
});

test("native H3 validates reference slots and preview retains the graph without submitting", async () => {
  const f = fixture({ allowWrites: true, generationEnabled: true });
  const execute = command => f.sandbox.testHooks.executeCommand(command);
  const result = id => f.events.find(event => event.commandId === id);
  await execute({ id: "image", type: "canvas.createNode", config: { id: "reference", type: "rh-image", data: { sourceObjects: ["https://example.com/reference.png"] } } });
  await execute({ id: "video", type: "canvas.createNode", config: { id: "h3", type: "rh-video", data: {
    modelCode: "multimodal-video-rhart-video-minimax-h3-rh-enhanced-ref2va-app", subType: "multimodal-video", generateNum: 2,
    params: { prompt: "角色说：完整保留这句测试对白。", refImage1: "https://example.com/reference.png", duration: "6", aspectRatio: "16:9", resolution: "1080p" }
  } } });
  await execute({ id: "wire", type: "canvas.connectNodes", source: "reference", target: "h3" });
  await execute({ id: "preview", type: "canvas.runNode", nodeId: "h3", validateReferences: true, dryRun: true });
  assert.equal(result("preview").ok, true);
  assert.equal(result("preview").result.submitted, false);
  const graph = result("preview").result.request.canvas;
  assert.equal(graph.nodes.length, 2);
  assert.equal(graph.edges.length, 1);
  assert.equal(graph.nodes.find(node => node.id === "h3").data.params.prompt, "角色说：完整保留这句测试对白。");
  await execute({ id: "bad-reference", type: "canvas.updateNodeParams", nodeId: "h3", params: { refImage1: "https://example.com/wrong.png" } });
  await execute({ id: "blocked", type: "canvas.runNode", nodeId: "h3", validateReferences: true });
  assert.equal(result("blocked").ok, false);
  assert.match(result("blocked").error, /without matching direct upstream/);
  await execute({ id: "clear-prompt", type: "canvas.updateNodeParams", nodeId: "h3", params: { prompt: "" } });
  await execute({ id: "empty-prompt", type: "canvas.runNode", nodeId: "h3" });
  assert.equal(result("empty-prompt").ok, false);
  assert.match(result("empty-prompt").error, /Video prompt is empty/);
  assert.equal(f.requests.some(url => url.endsWith("/canvas/task/run")), false);
  f.remoteDoc.destroy();
});

test("template clone preserves model settings, previews without mutation, and refuses native reference slots", async () => {
  const f = fixture({ allowWrites: true });
  const execute = command => f.sandbox.testHooks.executeCommand(command);
  await execute({ id: "template", type: "canvas.createNode", config: { id: "blank", type: "rh-video", data: {
    modelCode: "text-video-rhart-video-minimax-h3-rh-enhanced-t2va-app", subType: "text-video", generateNum: 2,
    params: { prompt: "", aspectRatio: "16:9", resolution: "1080p", duration: "6" }
  } } });
  const options = { type: "canvas.cloneTemplate", sourceNodeId: "blank", nodeId: "copy", title: "示例镜头草稿", x: 720, y: 300 };
  await execute({ ...options, id: "preview", dryRun: true });
  assert.equal(f.events.find(e => e.commandId === "preview").result.applied, false);
  assert.equal(f.remoteDoc.getMap("canvas").get("canvas_content").get("nodes").length, 1);
  await execute({ ...options, id: "clone" });
  const nodes = f.remoteDoc.getMap("canvas").get("canvas_content").get("nodes").toJSON();
  const copy = nodes.find(node => node.id === "copy");
  assert.equal(copy.data.generateNum, 2);
  assert.equal(copy.data.params.resolution, "1080p");
  assert.equal(copy.position.x, 720);
  assert.equal(copy.data.output, undefined);
  await execute({ id: "add-ref", type: "canvas.updateNodeParams", nodeId: "blank", params: { refAudio1: "https://example.com/dialogue.wav" } });
  await execute({ ...options, id: "reject", nodeId: "copy2" });
  assert.match(f.events.find(e => e.commandId === "reject").error, /TEMPLATE_NOT_EMPTY/);
  f.remoteDoc.destroy();
});

test('live models, output recognition and reference binding retain unrelated parameters',async()=>{
  const f=fixture({allowWrites:true,apiData:{'/canvas/model/list':[{type:'MULTIMODAL_VIDEO',modelList:[{modelCode:'test-h3',config:[{paramName:'refImage1',type:'image',paramValue:''},{paramName:'duration',type:'number',min:1,max:15,paramValue:6}]}]}]}});
  const run=async(type,args={})=>{const id='test-'+f.events.length;await f.sandbox.testHooks.executeCommand({id,type,...args});const event=f.events.find(e=>e.commandId===id);assert.equal(event.ok,true,event.error);return event.result;};
  await run('canvas.createNode',{config:{id:'source',type:'rh-ai',data:{output:[{url:'https://example.test/ref.png',mediaCategory:'image',success:true}]}}});
  await run('canvas.createNode',{config:{id:'target',type:'rh-video',data:{modelCode:'test-h3',subType:'multimodal-video',params:{prompt:'Exact full dialogue.',duration:6}}}});
  const refs=await run('canvas.inspectReferences',{nodeId:'source'});assert.equal(refs.image.length,1);assert.equal(refs.video.length,0);
  const schema=await run('canvas.modelSchema',{modelCode:'test-h3'});assert.equal(schema.models[0].parameters[1].max,15);
  await run('canvas.bindReferences',{nodeId:'target',references:[{sourceNodeId:'source',kind:'image',parameter:'refImage1'}]});
  const node=(await run('canvas.getElement',{elementId:'target'})).element;
  assert.equal(node.data.params.refImage1,'https://example.test/ref.png');assert.equal(node.data.params.duration,6);assert.equal(node.data.params.prompt,'Exact full dialogue.');
  assert.equal(f.remoteDoc.getMap('canvas').get('canvas_content').get('edges').length,1);
  assert.equal(f.requests.some(url=>url.endsWith('/task/run')),false);f.remoteDoc.destroy();
});

test('batch edit rejects stale revisions without partially changing nodes',async()=>{
  const f=fixture({allowWrites:true});
  const run=async(id,type,args={})=>{await f.sandbox.testHooks.executeCommand({id,type,...args});return f.events.find(e=>e.commandId===id);};
  for(const id of ['one','two'])await run(id,'canvas.createTextNode',{config:{id,title:id,text:'original'}});
  const a=(await run('read-a','canvas.getElement',{elementId:'one'})).result;
  const b=(await run('read-b','canvas.getElement',{elementId:'two'})).result;
  await run('concurrent','canvas.updateNodeParams',{nodeId:'two',params:{prompt:'newer edit'}});
  const event=await run('batch','canvas.batchUpdate',{updates:[{nodeId:'one',title:'changed'},{nodeId:'two',title:'changed'}],expectedRevisions:{one:a.revision,two:b.revision}});
  assert.equal(event.ok,false);assert.match(event.error,/EDIT_CONFLICT/);
  assert.equal((await run('reread','canvas.getElement',{elementId:'one'})).result.element.data.title,'one');f.remoteDoc.destroy();
});

test('asset reuse creates once, preserves kind and rejects expired/unknown selection',async()=>{
  const f=fixture({allowWrites:true,apiData:{'/canvas/asset/user/folder/item/search':{records:[{id:'asset-1',nodeType:'AUDIO',url:'https://example.test/voice.wav',itemName:'Voice'}],pages:1}}});
  const run=async(id,type,args={})=>{await f.sandbox.testHooks.executeCommand({id,type,...args});return f.events.find(e=>e.commandId===id);};
  const search=await run('search','canvas.searchAssets',{keyword:'Voice'});assert.equal(search.ok,true);
  const token=search.result.records[0].assetToken;
  const added=await run('add','canvas.addAsset',{assetToken:token,x:10,y:20});assert.equal(added.ok,true,added.error);assert.equal(added.result.result.mediaKind,'audio');
  const reused=await run('again','canvas.addAsset',{assetToken:token,x:30,y:40});assert.equal(reused.result.result.reused,true);
  assert.equal(f.remoteDoc.getMap('canvas').get('canvas_content').get('nodes').length,1);
  assert.equal((await run('bad','canvas.addAsset',{assetToken:'unknown'})).ok,false);f.remoteDoc.destroy();
});
