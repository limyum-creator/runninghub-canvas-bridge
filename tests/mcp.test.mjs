import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createMcpServer, BridgeClient } from '../server/mcp.mjs';
import { fileURLToPath } from 'node:url';

test('MCP handshake, typed tools, prompts and request IDs survive transport', async t => {
  const calls=[];
  const bridge={status:async()=>({ok:true}),select:async()=>({ok:true}),command:async(type,args,options)=>{ calls.push({type,args,options});return {result:{ok:true}};}};
  const server=createMcpServer(bridge);
  const client=new Client({name:'test',version:'1'});
  const [a,b]=InMemoryTransport.createLinkedPair();
  await server.connect(a);await client.connect(b);
  t.after(async()=>{await client.close();await server.close();});
  assert.match(client.getInstructions(),/Lumen/);
  const {tools}=await client.listTools();
  assert.equal(tools.length,35);
  assert.equal(tools.some(t=>/eval|api_post/.test(t.name)),false);
  assert.equal(tools.find(t=>t.name==='rh_run_node').annotations.readOnlyHint,false);
  const prompt='角色甲……请完整保留这句测试文本，包括停顿，只要——';
  const result=await client.callTool({name:'rh_update_params',arguments:{nodeId:'example-node',params:{prompt},dryRun:true}});
  assert.equal(result.isError,undefined);
  assert.equal(calls[0].args.params.prompt,prompt);
  await client.callTool({name:'rh_run_node',arguments:{nodeId:'example-node',requestId:'same-request-001',dryRun:true}});
  assert.equal(calls[1].options.id,'same-request-001');
  assert.equal(calls[1].args.dryRun,true);
  const invalid=await client.callTool({name:'rh_move_nodes',arguments:{positions:[{nodeId:'A',x:'bad',y:0}]}});
  assert.equal(invalid.isError,true);
  assert.equal(calls.length,2);
});

test('real stdio process initializes and lists tools without bridge availability',async t=>{
  const client=new Client({name:'stdio-check',version:'1'});
  const transport=new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../server/mcp.mjs',import.meta.url))],stderr:'pipe'});
  t.after(()=>client.close());
  await client.connect(transport);
  assert.equal((await client.listTools()).tools.length,35);
});

test('MCP requires exact canvas selection and loopback bridge',async()=>{
  assert.throws(()=>new BridgeClient('https://example.com'),/loopback/);
  await assert.rejects(new BridgeClient().command('canvas.summary'),/SELECT_CANVAS_FIRST/);
});

test('generation persists its archive binding before submission and stops when registration fails',async t=>{
  const calls=[];
  let registrationFails=false;
  const destination={kind:'asset',project_id:'project',work_id:'registered-work'};
  const bridge={canvasUrl:'https://www.runninghub.ai/project/canvas/test',target:async()=>{},
    request:async(path,args)=>{
      calls.push({path,args});
      if(path.startsWith('/archives/binding'))return {target:destination};
      if(registrationFails)throw new Error('Lumen unavailable');
      return {archiveId:args.archiveId};
    },
    command:async(type,args,options)=>{
      calls.push({type,args,options});
      return type==='canvas.getElement'?{result:{element:{data:{generateNum:2}}}}:{ok:true,result:{task:{taskId:'new-task'}}};
    }};
  const server=createMcpServer(bridge),client=new Client({name:'archive-hook-test',version:'1'});
  const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(a);await client.connect(b);
  t.after(async()=>{await client.close();await server.close();});
  const invoke=args=>client.callTool({name:'rh_run_node',arguments:{nodeId:'node',requestId:'stable-generation-id',...args}});
  assert.equal((await invoke({})).isError,undefined);
  assert.deepEqual(calls.map(c=>c.type || c.path.split('?')[0]),['/archives/binding','canvas.getElement','/archives','canvas.runNode']);
  assert.equal(calls[2].args.expectedOutputs,2);
  assert.deepEqual(calls[2].args.target,destination);
  assert.equal(calls[2].args.submissionRequestId,calls[3].options.id);
  calls.length=0;registrationFails=true;
  assert.equal((await invoke({archiveTarget:destination})).isError,true);
  assert.equal(calls.some(c=>c.type==='canvas.runNode'),false);
  calls.length=0;
  assert.equal((await invoke({archiveTarget:{kind:'asset',project_id:'project'}})).isError,true);
  assert.equal(calls.length,0);
  assert.equal((await invoke({dryRun:true})).isError,undefined);
  assert.deepEqual(calls.map(c=>c.type),['canvas.runNode']);
});
