import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CommandJournal } from '../server/command-journal.mjs';
import { BridgeClient } from '../server/bridge-client.mjs';
test('durable receipts distinguish never-dispatched requests from uncertain ones across repeated restarts',async t=>{
  const root=await mkdtemp(join(tmpdir(),'rh-回执 with spaces-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const journal=new CommandJournal(root);
  journal.save('queued',{state:'queued'});
  journal.save('sent',{state:'dispatched',nodeId:'node'});
  journal.save('done',{state:'completed'},{ok:true,result:{task:{taskId:'task-1'}}});
  let entries=new CommandJournal(root).load();
  assert.equal(entries.find(e=>e.id==='queued').result.errorCode,'COMMAND_NOT_DISPATCHED');
  assert.equal(entries.find(e=>e.id==='sent').record.state,'unknown');
  assert.equal(entries.find(e=>e.id==='done').result.result.task.taskId,'task-1');
  entries=new CommandJournal(root).load();assert.equal(entries.find(e=>e.id==='sent').record.state,'unknown');
});
test('logical IDs are stable across reconnects and scoped to exact canvas origin',()=>{
  const a=new BridgeClient(),b=new BridgeClient();
  a.canvasUrl=b.canvasUrl='https://www.runninghub.ai/project/canvas/a';a.sessionId='old';b.sessionId='new';
  assert.equal(a.wireId('same-request'),b.wireId('same-request'));
  b.canvasUrl='https://rhtv.runninghub.ai/project/canvas/a';assert.notEqual(a.wireId('same-request'),b.wireId('same-request'));
  assert.equal(b.wireId(a.wireId('same-request')),a.wireId('same-request'));
});
