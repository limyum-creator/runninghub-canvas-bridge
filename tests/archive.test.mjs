import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile,copyFile,realpath,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ArchiveManager,selectTaskOutputs,checkOutputUrl,downloadOutput} from '../server/archive.mjs';
import {inspectMedia,MediaTickets} from '../server/media.mjs';
function wav() {
 const data=Buffer.alloc(44+1600);data.write('RIFF');data.writeUInt32LE(data.length-8,4);data.write('WAVEfmt ',8);data.writeUInt32LE(16,16);data.writeUInt16LE(1,20);data.writeUInt16LE(1,22);data.writeUInt32LE(8000,24);data.writeUInt32LE(16000,28);data.writeUInt16LE(2,32);data.writeUInt16LE(16,34);data.write('data',36);data.writeUInt32LE(1600,40);return data;
}
async function fixture(t) {const root=await realpath(await mkdtemp(join(tmpdir(),'rh-archive-test-')));t.after(()=>rm(root,{recursive:true,force:true}));return root;}
test('media inspection trusts contents and rejects symlinks; ticket matches one origin',async t=>{
 const root=await fixture(t),path=join(root,'actually-audio.bin');await writeFile(path,wav());
 const media=await inspectMedia(path);assert.equal(media.kind,'audio');assert.equal(media.extension,'.wav');assert.equal(media.duration,0.1);
 const link=join(root,'link.wav');await symlink(path,link);await assert.rejects(inspectMedia(link),/regular/);
 const tickets=new MediaTickets(),item=await tickets.create(path,'https://www.runninghub.ai');
 await assert.rejects(tickets.serve(item.ticket,'https://www.runninghub.cn',{}),/TICKET/);
 await writeFile(path,Buffer.from('changed'));await assert.rejects(tickets.serve(item.ticket,'https://www.runninghub.ai',{}),/SOURCE_CHANGED/);
});
test('output selection cannot mistake old results or a newer task for requested outputs',()=>{
 const node={data:{taskId:'new',status:'running',output:[{taskId:'old',url:'old.mp4'},{taskId:'new',url:'new.mp4',jobId:'job-1'}]}};
 assert.equal(selectTaskOutputs(node,'requested',1).ready,false);
 assert.deepEqual(selectTaskOutputs(node,'new',1).outputs.map(o=>o.url),['new.mp4']);
 node.data.status='finished';assert.throws(()=>selectTaskOutputs(node,'new',2),/INCOMPLETE/);
 assert.throws(()=>checkOutputUrl('https://127.0.0.1/a'),/HOST/);
 assert.throws(()=>checkOutputUrl('https://xiaoyaoyou.com.evil.test/a'),/HOST/);
});
test('download rejects redirects off platform and oversized streams; writes verified media',async t=>{
 const root=await fixture(t),path=join(root,'output');
 const url='https://rh-hk-canvas-files.xiaoyaoyou.com/test.wav';
 await assert.rejects(downloadOutput(url,path,{fetcher:async()=>new Response(null,{status:302,headers:{location:'http://127.0.0.1/'}})}),/HOST/);
 await assert.rejects(downloadOutput(url,path,{maxBytes:10,fetcher:async()=>new Response(wav())}),/LIMIT/);
 const media=await downloadOutput(url,path,{fetcher:async()=>new Response(wav())});assert.equal(media.kind,'audio');assert.equal((await readFile(path)).length,wav().length);
});
test('archive survives restart and replays exact Lumen import request after an interrupted response',async t=>{
 const root=await fixture(t),source=join(root,'source.wav');await writeFile(source,wav());
 let imported,failed=false,downloads=0;const imports=[];
 const lumen=async fn=>fn(async(name,args)=>{
  if(name==='lumen_read_asset')return {work:{id:'work',kind:'reference'},library_works:[{kind:'reference'}],revisions:imported?[{id:'revision',asset_sha256:imported.sha256,present:1}]:[]};
  if(name==='lumen_preview_import'){const m=await inspectMedia(args.source_path);return {plan:{token:'fixed-token',source:{sha256:m.sha256,path:args.source_path},target:{workID:'work'}}};}
  if(name==='lumen_import_asset'){
   imports.push(structuredClone(args));const m=await inspectMedia(args.source_path);
   imported={ok:true,workID:'work',revisionID:'revision',sha256:m.sha256};
   if(!failed){failed=true;throw new Error('Reply interrupted after successful import');}return imported;
  }
  throw new Error(name);
 });
 const bridgeFactory=()=>({command:async()=>({result:{element:{data:{status:'finished',taskId:'task',output:[{taskId:'task',jobId:'output-1',url:'https://rh-hk-canvas-files.xiaoyaoyou.com/test.wav'}]}}}})});
 const download=async(url,path)=>{downloads++;await copyFile(source,path);return inspectMedia(path);};
 const options={root:join(root,'journal'),lumen,bridgeFactory,download};
 const input={archiveId:'stable-archive-id',canvasUrl:'https://www.runninghub.ai/project/canvas/test',nodeId:'node',taskId:'task',expectedOutputs:1,target:{kind:'reference',work_id:'work'}};
 const first=new ArchiveManager(options);await first.init();await first.add(input);await first.tick();assert.equal(first.status(input.archiveId).state,'attention');
 const second=new ArchiveManager(options);await second.init();await second.retry(input.archiveId);await second.tick();
 assert.equal(second.status(input.archiveId).state,'complete');assert.equal(downloads,1);assert.deepEqual(imports[0],imports[1]);
 await second.add(input);await second.tick();assert.equal(imports.length,2);
 await assert.rejects(second.add({...input,taskId:'different-task'}),/CONFLICT/);
});

test('all outputs are retained when Lumen cannot yet import a registered empty Work',async t=>{
 const root=await fixture(t),source=join(root,'source.wav');await writeFile(source,wav());
 const lumen=async fn=>fn(async name=>{
  if(name==='lumen_read_asset')return {work:{id:'empty-work',kind:'reference'},library_works:[{kind:'reference'}],revisions:[]};
  if(name==='lumen_preview_import')throw new Error('First revision not yet supported');
  throw new Error(name);
 });
 let downloads=0;
 const bridgeFactory=()=>({command:async()=>({result:{element:{data:{taskId:'task',status:'finished',output:[1,2].map(n=>({taskId:'task',jobId:String(n),url:`https://rh-hk-canvas-files.xiaoyaoyou.com/${n}.wav`}))}}}})});
 const download=async(url,path)=>{downloads++;await copyFile(source,path);return inspectMedia(path);};
 const manager=new ArchiveManager({root:join(root,'journal'),lumen,bridgeFactory,download});await manager.init();
 await manager.add({archiveId:'empty-work-archive',canvasUrl:'https://www.runninghub.ai/project/canvas/test',nodeId:'node',taskId:'task',expectedOutputs:2,target:{kind:'reference',work_id:'empty-work'}});
 await manager.tick();const job=manager.status('empty-work-archive');assert.equal(job.state,'attention');assert.equal(downloads,2);
 for(const file of job.files)assert.equal((await inspectMedia(file.localPath)).sha256,file.media.sha256);
 await manager.retry(job.archiveId);await manager.tick();assert.equal(downloads,2);
});
