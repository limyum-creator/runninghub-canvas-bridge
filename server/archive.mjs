// Persistent output collection. Only Lumen's MCP imports media; never generates or writes its database.
import { mkdir, readFile, writeFile, rename, readdir, lstat, unlink, open } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import { inspectMedia } from './media.mjs';
import { withLumen, validateTarget } from './lumen.mjs';
import { BridgeClient } from './bridge-client.mjs';
import '../extension/site-policy.js';
export const archiveTarget=z.object({kind:z.enum(['asset','ai','reference','photo']),project_id:z.string().min(1).optional(),work_id:z.string().min(1).optional(),category:z.string().optional(),title:z.string().optional()}).strict().superRefine((t,ctx)=>{
  if (t.kind==='asset' && !t.project_id) ctx.addIssue({code:'custom',message:'Asset target requires project_id'});
  if (t.work_id && (t.title || t.category)) ctx.addIssue({code:'custom',message:'Existing Work keeps its title and category'});
});
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const idSchema=z.string().min(8).max(128).regex(/^[\w.:-]+$/);
const inputSchema=z.object({archiveId:idSchema,canvasUrl:z.string().url(),nodeId:z.string().min(1),taskId:z.string().min(1).optional(),submissionRequestId:idSchema.optional(),target:archiveTarget,expectedOutputs:z.number().int().min(1).max(100)}).strict();
const terminal=new Set(['finished','failed','error','cancelled','canceled']);
export function selectTaskOutputs(node,taskId,expectedOutputs) {
  const outputs=(node.data?.output || []).filter(o=>o.success!==false && String(o.taskId || '')===taskId && typeof o.url==='string' && o.url);
  const unique=[...new Map(outputs.map(o=>[o.jobId || o.url,o])).values()];
  const current=String(node.data?.taskId || '')===taskId;
  if (unique.length>=expectedOutputs) return {ready:true,outputs:unique};
  if (current && terminal.has(String(node.data?.status).toLowerCase())) throw new Error(`TASK_OUTPUTS_INCOMPLETE: ${unique.length}/${expectedOutputs}; current task ${node.data.status}`);
  return {ready:false,outputs:unique};
}
const downloadHosts=['runninghub.ai','runninghub.cn','xiaoyaoyou.com','hubimgs.com'];
export function checkOutputUrl(value) {
  const u=new URL(value);
  if (u.protocol!=='https:' || u.username || u.password || (u.port && u.port!=='443') || !downloadHosts.some(h=>u.hostname===h || u.hostname.endsWith('.'+h))) throw new Error('UNSUPPORTED_OUTPUT_HOST');
  return u;
}
export async function downloadOutput(url,path,{fetcher=fetch,maxBytes=256*1024**2}={}) {
  let current=String(checkOutputUrl(url)),response;
  for(let redirects=0;redirects<5;redirects++) {
    response=await fetcher(current,{redirect:'manual',signal:AbortSignal.timeout(180000)});
    if ([301,302,303,307,308].includes(response.status)) { current=String(checkOutputUrl(new URL(response.headers.get('location'),current)));await response.body?.cancel();continue; }
    break;
  }
  if (!response?.ok || !response.body) throw new Error(`OUTPUT_DOWNLOAD_FAILED: ${response?.status}`);
  if (Number(response.headers.get('content-length'))>maxBytes) {await response.body.cancel();throw new Error('ARCHIVE_FILE_LIMIT_256_MIB');}
  let size=0;const digest=createHash('sha256');
  const counter=new Transform({transform(chunk,encoding,next){size+=chunk.length;if(size>maxBytes)return next(new Error('ARCHIVE_FILE_LIMIT_256_MIB'));digest.update(chunk);next(null,chunk);}});
  const temporary=path+'.part-'+randomUUID();
  try {
    await pipeline(Readable.fromWeb(response.body),counter,createWriteStream(temporary,{flags:'wx',mode:0o600}));
    if (!size) throw new Error('EMPTY_OUTPUT');
    const media=await inspectMedia(temporary);
    if (media.sha256!==digest.digest('hex')) throw new Error('OUTPUT_SHA_MISMATCH');
    const fd=await open(temporary,'r+');try{await fd.sync();}finally{await fd.close();}
    await rename(temporary,path);
    return media;
  } catch(error) {await unlink(temporary).catch(()=>{});throw error;}
}
async function atomic(path,value) {
  const temp=path+'.tmp-'+randomUUID();
  const fd=await open(temp,'wx',0o600);
  try {await fd.writeFile(JSON.stringify(value,null,2)+'\n');await fd.sync();}finally{await fd.close();}
  await rename(temp,path);
}
export class ArchiveManager {
  constructor({root=process.env.RH_ARCHIVE_DIR || join(homedir(),'.runninghub-canvas-bridge/archives'),lumen=withLumen,bridgeFactory=()=>new BridgeClient(),download=downloadOutput}={}) {
    Object.assign(this,{root,lumen,bridgeFactory,download});this.jobs=new Map();this.bindings={};this.running=false;
  }
  async init() {
    await mkdir(this.root,{recursive:true,mode:0o700});
    if ((await lstat(this.root)).isSymbolicLink()) throw new Error('UNSAFE_ARCHIVE_ROOT');
    for(const file of await readdir(this.root)) if (/^job-[a-f0-9]{64}\.json$/.test(file)) {
      const job=JSON.parse(await readFile(join(this.root,file),'utf8'));this.jobs.set(job.archiveId,job);
    }
    try {this.bindings=JSON.parse(await readFile(join(this.root,'bindings.json'),'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
  }
  async save(job) {job.updatedAt=new Date().toISOString();await atomic(join(this.root,'job-'+hash(job.archiveId)+'.json'),job);this.jobs.set(job.archiveId,job);}
  bindingKey(canvasUrl,nodeId) {const canvas=globalThis.RHCanvasSitePolicy.parseCanvas(canvasUrl);if(!canvas)throw new Error('INVALID_CANVAS_URL');return hash([canvas.key,nodeId]);}
  async bind({canvasUrl,nodeId,target}) {
    if(target===null) {delete this.bindings[this.bindingKey(canvasUrl,nodeId)];await atomic(join(this.root,'bindings.json'),this.bindings);return {ok:true,canvasUrl,nodeId,target:null};}
    target=archiveTarget.parse(target);await this.lumen(call=>validateTarget(call,target));
    this.bindings[this.bindingKey(canvasUrl,nodeId)]={canvasUrl,nodeId,target};
    await atomic(join(this.root,'bindings.json'),this.bindings);
    return {ok:true,canvasUrl,nodeId,target};
  }
  binding(canvasUrl,nodeId) {return this.bindings[this.bindingKey(canvasUrl,nodeId)] || null;}
  async add(raw) {
    const input=inputSchema.parse(raw);
    this.bindingKey(input.canvasUrl,input.nodeId);
    if (!!input.taskId===!!input.submissionRequestId) throw new Error('Exactly one taskId or submissionRequestId is required');
    const fingerprint=hash(input),existing=this.jobs.get(input.archiveId);
    if(existing){if(existing.fingerprint!==fingerprint)throw new Error('ARCHIVE_ID_CONFLICT');return existing;}
    await this.lumen(call=>validateTarget(call,input.target));
    const job={...input,fingerprint,state:input.taskId?'waiting_outputs':'waiting_submission',createdAt:new Date().toISOString(),files:[]};
    await this.save(job);return job;
  }
  status(id) {return id ? this.jobs.get(id) || null : [...this.jobs.values()].map(({archiveId,canvasUrl,nodeId,taskId,state,error,files,target,updatedAt})=>({archiveId,canvasUrl,nodeId,taskId,state,error,archived:files.filter(f=>f.receipt).length,total:files.length,target,updatedAt}));}
  async retry(id,taskId) {const job=this.jobs.get(id);if(!job)throw new Error('ARCHIVE_NOT_FOUND');if(taskId && job.taskId && job.taskId!==taskId)throw new Error('ARCHIVE_TASK_CONFLICT');if(job.state==='complete')return job;if(taskId)job.taskId=taskId;job.state=job.taskId?'waiting_outputs':'waiting_submission';delete job.error;delete job.retryAfter;await this.save(job);return job;}
  async step(job) {
    const bridge=this.bridgeFactory();bridge.canvasUrl=job.canvasUrl;
    if(!job.taskId) {
      const event=await bridge.request('/result?id='+encodeURIComponent(job.submissionRequestId));
      if(!event)return;
      if(!event.ok)throw new Error('GENERATION_REQUEST_FAILED: '+(event.errorCode || event.error || 'unknown'));
      const task=event.result?.task;
      if(!task?.taskId)return;
      job.taskId=String(task.taskId);job.state='waiting_outputs';await this.save(job);
    }
    if(!job.files.length) {
      const snapshot=await bridge.command('canvas.getElement',{elementId:job.nodeId});
      if(snapshot.ok===false)throw new Error('CANVAS_READ_INCOMPLETE');
      const selected=selectTaskOutputs(snapshot.result.element,job.taskId,job.expectedOutputs);
      if(!selected.ready)return;
      job.files=selected.outputs.map((output,index)=>({index,url:output.url,taskId:String(output.taskId),jobId:output.jobId,mediaCategory:output.mediaCategory}));
      job.state='collecting';await this.save(job);
    }
    const folder=join(this.root,'media',hash(job.archiveId));await mkdir(folder,{recursive:true,mode:0o700});
    for(const file of job.files) {
      if(file.receipt)continue;
      if(!file.localPath) {
        const path=join(folder,`output-${file.index}`);
        const media=await this.download(file.url,path);
        const final=path+media.extension;await rename(path,final);
        file.localPath=final;file.media=media;await this.save(job);
      } else {
        const media=await inspectMedia(file.localPath);if(media.sha256!==file.media.sha256)throw new Error('ARCHIVE_LOCAL_FILE_CHANGED');
      }
    }
    // Preserve every completed output even if Lumen cannot currently import the first file.
    job.state='importing';await this.save(job);
    for(const file of job.files) {
      if(file.receipt)continue;
      await this.lumen(async call=>{
        const target=job.resolvedTarget || job.target;
        await validateTarget(call,target);
        if(!file.importArgs) {
          const preview=await call('lumen_preview_import',{source_path:file.localPath,target});
          const plan=preview.plan;
          if(plan.source.sha256!==file.media.sha256 || plan.source.path!==file.localPath)throw new Error('LUMEN_PREVIEW_SOURCE_MISMATCH');
          if(target.work_id && plan.target.workID!==target.work_id)throw new Error('LUMEN_PREVIEW_WORK_MISMATCH');
          file.importArgs={source_path:file.localPath,target,expected_token:plan.token,request_id:'rh-'+hash([job.archiveId,file.index,file.media.sha256])};
          await this.save(job);
        }
        const receipt=await call('lumen_import_asset',file.importArgs);
        if(!receipt.ok || receipt.sha256!==file.media.sha256 || (target.work_id && receipt.workID!==target.work_id) || (receipt.projectID || null)!==(target.project_id || null))throw new Error('LUMEN_IMPORT_RECEIPT_MISMATCH');
        const stored=await call('lumen_read_asset',{work_id:receipt.workID});
        if(!stored.revisions?.some(r=>r.id===receipt.revisionID && r.asset_sha256===receipt.sha256 && Number(r.present)===1))throw new Error('LUMEN_IMPORT_READBACK_FAILED');
        file.receipt=receipt;
        if(!job.target.work_id)job.resolvedTarget={kind:target.kind,...(target.project_id?{project_id:target.project_id}:{}),work_id:receipt.workID};
        await this.save(job);
      });
    }
    job.state='complete';delete job.error;await this.save(job);
  }
  async tick() {
    if(this.running)return;this.running=true;
    try {for(const job of this.jobs.values()) {
      if(['complete','attention'].includes(job.state) || job.retryAfter>Date.now())continue;
      try {await this.step(job);} catch(error) {
        const transient=/CANVAS_NOT_CONNECTED|fetch failed|ECONNREFUSED|AbortError|TimeoutError/.test(String(error));
        if(!transient)job.state='attention';
        job.retryAfter=transient?Date.now()+30000:null;
        job.error=String(error.message).replace(/Bearer\s+\S+/gi,'Bearer [REDACTED]').slice(0,1400);await this.save(job);
      }
    }}finally{this.running=false;}
  }
  start() {this.timer=setInterval(()=>this.tick().catch(()=>{}),10000);this.timer.unref();}
  stop() {clearInterval(this.timer);}
}
