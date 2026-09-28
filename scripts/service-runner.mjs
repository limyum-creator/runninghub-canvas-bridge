// Windows per-user supervisor. Only this process owns its PID/stop files.
import {readFile,mkdir,open,unlink,access} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {dirname,join} from 'node:path';
const configPath=process.argv[2],dir=dirname(configPath),lock=join(dir,'service.pid'),stop=join(dir,'service.stop');
const config=JSON.parse(await readFile(configPath,'utf8'));
await mkdir(join(dir,'logs'),{recursive:true});
let handle;
try {handle=await open(lock,'wx');} catch(error) {
  if(error.code!=='EEXIST')throw error;
  const old=JSON.parse(await readFile(lock,'utf8'));
  let live=true;try{process.kill(old.pid,0);}catch(e){if(e.code==='ESRCH')live=false;}
  if(live)process.exit(0);
  await unlink(lock);handle=await open(lock,'wx');
}
await handle.writeFile(JSON.stringify({pid:process.pid,startedAt:new Date().toISOString()}));await handle.close();
const out=await open(join(dir,'logs','bridge.out.log'),'a'),err=await open(join(dir,'logs','bridge.err.log'),'a');
let quitting=false,child;
const shutdown=()=>{quitting=true;child?.kill();};
process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
const timer=setInterval(async()=>{try{await access(stop);shutdown();}catch{}},250);
try {
  while(!quitting) {
    child=spawn(config.node,[config.server],{cwd:config.root,env:{...process.env,...config.env},windowsHide:true,stdio:['ignore',out.fd,err.fd]});
    await new Promise(resolve=>{child.once('exit',resolve);child.once('error',async e=>{await err.write(e.message+'\n');resolve();});});
    child=null;if(!quitting)await new Promise(r=>setTimeout(r,2000));
  }
} finally {clearInterval(timer);await out.close();await err.close();await unlink(lock).catch(()=>{});await unlink(stop).catch(()=>{});}
