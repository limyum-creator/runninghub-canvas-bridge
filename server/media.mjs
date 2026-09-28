// Added 2026-09-27: verified local media and bounded streaming upload tickets.
import { createReadStream } from 'node:fs';
import { lstat, realpath, open } from 'node:fs/promises';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execute = promisify(execFile);
export const limits = { image: 30 * 1024 ** 2, audio: 50 * 1024 ** 2, video: 500 * 1024 ** 2 };
export async function sha256(path) {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest('hex');
}
export async function inspectMedia(path) {
  if (!isAbsolute(path)) throw new Error('Use an absolute local media path');
  path = resolve(path);
  const info = await lstat(path);
  const actual = await realpath(path);
  const samePath = process.platform === 'win32' ? actual.toLowerCase() === path.toLowerCase() : actual === path;
  if (!info.isFile() || !samePath || info.size === 0 || info.size > limits.video) throw new Error('Media must be a regular nonempty file, at most 500 MiB, without symlinks');
  const fd = await open(path, 'r');
  const head = Buffer.alloc(32);
  try { await fd.read(head, 0, 32, 0); } finally { await fd.close(); }
  let mime, extension, kind;
  if (head.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) [mime,extension,kind]=['image/png','.png','image'];
  else if (head[0]===255 && head[1]===216) [mime,extension,kind]=['image/jpeg','.jpg','image'];
  else if (head.toString('ascii',0,4)==='RIFF' && head.toString('ascii',8,12)==='WEBP') [mime,extension,kind]=['image/webp','.webp','image'];
  const candidates = [process.env.RH_FFPROBE, ...(process.platform === 'win32' ? [join(homedir(),'.local','bin','ffprobe.exe'),'ffprobe.exe'] : [join(homedir(),'.local/bin/ffprobe'), '/opt/homebrew/bin/ffprobe','/usr/local/bin/ffprobe','ffprobe'])].filter(Boolean);
  let probe;
  for (const command of candidates) {
    try {
      const { stdout } = await execute(command, ['-v','error','-show_format','-show_streams','-of','json',path], { windowsHide: true, timeout: 20000, maxBuffer: 1024 ** 2 });
      probe=JSON.parse(stdout); break;
    } catch (error) { if (error.code !== 'ENOENT') throw new Error('MEDIA_UNREADABLE: ffprobe could not decode media metadata'); }
  }
  if (!probe) throw new Error('FFPROBE_REQUIRED: install ffmpeg or set RH_FFPROBE');
  const video=probe.streams?.find(s=>s.codec_type==='video' && !s.disposition?.attached_pic);
  const audio=probe.streams?.find(s=>s.codec_type==='audio');
  const format=probe.format?.format_name || '';
  if (!kind) {
    if (video && /mov|mp4/.test(format)) [kind,mime,extension]=['video',probe.format?.tags?.major_brand?.trim()==='qt'?'video/quicktime':'video/mp4',probe.format?.tags?.major_brand?.trim()==='qt'?'.mov':'.mp4'];
    else if (video && /webm/.test(format)) [kind,mime,extension]=['video','video/webm','.webm'];
    else if (!video && audio) {
      const types=[[/wav/, 'audio/wav','.wav'],[/mp3/,'audio/mpeg','.mp3'],[/flac/,'audio/flac','.flac'],[/ogg/,'audio/ogg','.ogg'],[/aac/,'audio/aac','.aac'],[/mov|mp4/,'audio/mp4','.m4a']];
      const type=types.find(([pattern])=>pattern.test(format));
      if (type) [kind,mime,extension]=['audio',type[1],type[2]];
    }
  }
  if (!kind || (kind==='image' && !video)) throw new Error('UNSUPPORTED_MEDIA: PNG/JPEG/WebP, MP4/MOV/WebM, MP3/WAV/M4A/AAC/FLAC/OGG');
  if (info.size > limits[kind]) throw new Error(`File exceeds ${limits[kind]/1024**2} MiB ${kind} limit`);
  const duration=Number(probe.format?.duration || video?.duration || audio?.duration || 0);
  if (kind!=='image' && (!Number.isFinite(duration) || duration<=0)) throw new Error('Media duration is missing or invalid');
  const digest=await sha256(path), after=await lstat(path);
  if (after.ino!==info.ino || after.size!==info.size || after.mtimeMs!==info.mtimeMs) throw new Error('SOURCE_CHANGED');
  return { name:basename(path), type:mime, kind, extension, size:info.size, sha256:digest, duration,
    width:video?.width || 0, height:video?.height || 0, sampleRate:Number(audio?.sample_rate || 0), channels:audio?.channels || 0,
    identity:{ino:info.ino,mtimeMs:info.mtimeMs,size:info.size} };
}
export class MediaTickets {
  constructor() { this.items=new Map(); }
  async create(path, origin) {
    const media=await inspectMedia(path);
    const ticket=randomUUID();
    for (const [id,value] of this.items) if (value.expires<Date.now()) this.items.delete(id);
    this.items.set(ticket,{path,origin,media,expires:Date.now()+15*60*1000});
    return { ticket, media };
  }
  async serve(ticket,origin,res) {
    const item=this.items.get(ticket);
    if (!item || item.expires<Date.now() || origin!==item.origin) throw new Error('MEDIA_TICKET_UNAVAILABLE');
    const fd=await open(item.path,'r');
    const stat=await fd.stat(), expected=item.media.identity;
    if (stat.ino!==expected.ino || stat.size!==expected.size || stat.mtimeMs!==expected.mtimeMs) { await fd.close(); throw new Error('SOURCE_CHANGED'); }
    res.writeHead(200,{'Content-Type':item.media.type,'Content-Length':stat.size,'Access-Control-Allow-Origin':origin,'Cache-Control':'no-store'});
    const stream=fd.createReadStream();
    stream.on('error',()=>res.destroy());res.on('close',()=>stream.destroy());stream.pipe(res);
  }
}
