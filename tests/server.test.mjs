import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test("local HTTP bridge restricts origins, commands, and stale/incorrect client routing", async (t) => {
  const reservation = createServer();
  await new Promise((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const archiveRoot=await mkdtemp(join(tmpdir(),'rh-http-test-'));
  t.after(()=>rm(archiveRoot,{recursive:true,force:true}));
  const child = spawn(process.execPath, ["server/server.mjs"], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, RH_ARCHIVE_DIR:archiveRoot, RH_BRIDGE_PORT: String(port), RH_BRIDGE_ALLOW_WRITES: "0", RH_BRIDGE_ALLOW_GENERATION: "0", RH_BRIDGE_ACCESS_FILE: "" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  t.after(async () => { if (child.exitCode === null) { child.kill(); await once(child, "exit"); } });
  await Promise.race([once(child.stdout, "data"), once(child, "exit").then(() => { throw new Error("Bridge exited before ready"); })]);
  const base = `http://127.0.0.1:${port}`;
  const origin = "https://www.runninghub.ai";
  const post = (path, value, headers = {}) => fetch(base + path, {
    method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(value)
  });
  assert.equal((await fetch(base + "/health", { headers: { Origin: "https://evil.test" } })).status, 403);
  const invalidHostStatus = await new Promise((resolve, reject) => {
    const req = httpRequest(base + "/health", { headers: { Host: "evil.test" } }, (response) => {
      response.resume(); resolve(response.statusCode);
    });
    req.on("error", reject); req.end();
  });
  assert.equal(invalidHostStatus, 403);
  const health = await fetch(base + "/health", { headers: { Origin: origin } });
  assert.equal(health.headers.get("access-control-allow-origin"), origin);
  assert.equal((await health.json()).access.generationEnabled, false);
  assert.equal((await post("/command", { type: "canvas.summary" }, { Origin: origin })).status, 403);
  assert.equal((await fetch(base + "/events", { headers: { Origin: origin } })).status, 403);
  const runtime = await (await fetch(base + "/runtime-version")).json();
  const href = origin + "/project/canvas/fixture";
  assert.equal((await post("/events", { kind: "bridge.installed", clientId: "fixture-client", href, runtimeVersion: runtime.version }, { Origin: origin })).status, 200);
  assert.equal((await post("/events", { clientId: "foreign", href: "https://evil.test/project/canvas/fixture" })).status, 400);
  const denied = await post("/command", { type: "canvas.updateNodeText" });
  assert.equal((await denied.json()).errorCode, "READ_ONLY");
  assert.equal((await (await post("/command", { type: "canvas.runNode" })).json()).errorCode, "GENERATION_DISABLED");
  assert.equal((await (await post("/command", { type: "canvas.summary", clientId: "missing-client" })).json()).errorCode, "NO_PAGE_CLIENT");
  const command = { id: "unique-request-1", type: "canvas.summary", clientId: "fixture-client" };
  const queued = await (await post("/command", command)).json();
  assert.equal(queued.clientId, "fixture-client");
  assert.equal((await (await post("/command", command)).json()).duplicate, true);
  assert.equal((await (await post("/command", { ...command, type: "canvas.getElement" })).json()).errorCode, "REQUEST_ID_CONFLICT");
  const commands = await (await fetch(base + "/commands?clientId=fixture-client&href=" + encodeURIComponent(href), { headers: { Origin: origin } })).json();
  assert.equal(commands.length, 1);
  assert.equal(commands[0].type, "canvas.summary");
  assert.equal((await (await fetch(base + "/commands?clientId=fixture-client&href=" + encodeURIComponent(href), { headers: { Origin: origin } })).json()).length, 0);
  assert.equal((await fetch(base + "/commands?clientId=fixture-client&href=" + encodeURIComponent("https://rhtv.runninghub.cn/projects/canvas/fixture"), { headers: { Origin: origin } })).status, 403);
  assert.equal((await post("/access", { canvasUrl: href, allowWrites: true }, { Origin: origin })).status, 403);
  assert.equal((await post("/access", { canvasUrl: origin + "/project/canvas/other", allowWrites: true })).status, 409);
  const access = await (await post("/access", { canvasUrl: href, allowWrites: true })).json();
  assert.equal(access.access.allowWrites, true);
  assert.equal(access.access.canvasId, "fixture");
  const result = { href, clientId: "fixture-client", kind: "command.result", commandId: queued.id, ok: true, result: { counts: { nodes: 2 } } };
  assert.equal((await post("/events", result, { Origin: origin })).status, 200);
  assert.equal((await (await fetch(base + "/result?id=" + queued.id)).json()).result.counts.nodes, 2);
  const session=async allowWrites=>(await (await post('/sessions',{canvasUrl:href,allowWrites})).json()).sessionId;
  const writer=await session(true),reader=await session(false);
  assert.ok(writer);assert.notEqual(writer,reader);
  assert.equal((await (await fetch(base+'/sessions?id='+writer)).json()).access.allowWrites,true);
  assert.equal((await (await fetch(base+'/sessions?id='+reader)).json()).access.allowWrites,false);
  assert.equal((await (await fetch(base+'/runtime-version')).json()).version,runtime.version,'scope changes must not reload every page');
  const edit={id:'edit-one',type:'canvas.updateNodeParams',clientId:'fixture-client',sessionId:writer};
  assert.equal((await post('/command',edit)).status,200);
  assert.equal((await (await post('/command',{...edit,id:'denied',sessionId:reader})).json()).errorCode,'READ_ONLY');
  // Legacy access changes cannot revoke a selected session's writes.
  await post('/access',{canvasUrl:href,allowWrites:false});
  await post('/command',{...edit,id:'edit-two'});
  const poll=async()=>(await (await fetch(base+'/commands?clientId=fixture-client&href='+encodeURIComponent(href),{headers:{Origin:origin}})).json());
  const first=await poll();assert.equal(first.length,1);assert.equal(first[0].id,'edit-one');assert.equal(first[0].access.allowWrites,true);
  assert.equal((await poll()).length,0);
  assert.equal((await post('/events',{...result,commandId:'edit-one',clientId:'intruder'},{Origin:origin})).status,409);
  assert.equal((await poll()).length,0);
  await post('/events',{...result,commandId:'edit-one'},{Origin:origin});
  assert.equal((await poll())[0].id,'edit-two');
  await post('/events',{...result,commandId:'edit-two'},{Origin:origin});
  assert.equal((await (await post('/command',{...edit,id:'expired-session',sessionId:'missing'})).json()).errorCode,'SESSION_EXPIRED');

  // Two tabs on the same canvas must share the mutation lock.
  await post('/events',{href,kind:'bridge.installed',clientId:'second-tab',runtimeVersion:runtime.version},{Origin:origin});
  await post('/command',{...edit,id:'tab-one'});
  await post('/command',{...edit,id:'tab-two',clientId:'second-tab'});
  assert.equal((await poll())[0].id,'tab-one');
  const secondPoll=async()=>(await (await fetch(base+'/commands?clientId=second-tab&href='+encodeURIComponent(href),{headers:{Origin:origin}})).json());
  assert.equal((await secondPoll()).length,0);
  await post('/events',{...result,commandId:'tab-one'},{Origin:origin});
  assert.equal((await secondPoll())[0].id,'tab-two');
  await post('/events',{...result,clientId:'second-tab',commandId:'tab-two'},{Origin:origin});
  await post('/command',{...edit,id:'revoked-before-dispatch'});
  await post('/sessions',{sessionId:writer,canvasUrl:href,allowWrites:false});
  assert.equal((await poll()).length,0);
  assert.equal((await (await fetch(base+'/result?id=revoked-before-dispatch')).json()).errorCode,'READ_ONLY');

});
