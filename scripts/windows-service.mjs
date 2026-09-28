// Per-user Windows background service, without administrator privileges.
import {mkdir,readFile,writeFile,unlink,access} from 'node:fs/promises';
import {join,dirname,resolve} from 'node:path';
import {homedir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
export const vbsQuote = value => '"' + String(value).replaceAll('"','""') + '"';
export const commandLineQuote = value => '"' + String(value).replace(/(\\*)"/g,'$1$1\\"').replace(/(\\+)$/,'$1$1') + '"';
export function launcherSource(node,runner,config) {
  const command=[node,runner,config].map(commandLineQuote).join(' ');
  return 'Set shell = CreateObject("WScript.Shell")\r\nshell.Run '+vbsQuote(command)+', 0, False\r\n';
}
const delay=ms=>new Promise(r=>setTimeout(r,ms));
export async function windowsService(action,{root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),home=homedir(),env=process.env}={}) {
  if(!env.APPDATA) throw new Error('APPDATA is required for per-user startup');
  const dir=join(home,'.runninghub-canvas-bridge'),configPath=join(dir,'service.json'),launcher=join(dir,'start-bridge.vbs');
  const startup=join(env.APPDATA,'Microsoft','Windows','Start Menu','Programs','Startup','RunningHub Canvas Bridge.vbs');
  const lock=join(dir,'service.pid'),stop=join(dir,'service.stop');
  const exists=async path=>{try{await access(path);return true;}catch{return false;}};
  const status=async()=>{
    let health=null;try{health=await (await fetch('http://127.0.0.1:18765/health',{signal:AbortSignal.timeout(1500)})).json();}catch{}
    let pid=null;try{pid=JSON.parse(await readFile(lock,'utf8')).pid;}catch{}
    let running=false;try{if(pid){process.kill(pid,0);running=true;}}catch{}
    let instance=null;try{instance=JSON.parse(await readFile(configPath,'utf8')).env.RH_BRIDGE_INSTANCE_ID;}catch{}
    return {ok:running && health?.product==='runninghub-canvas-bridge' && !!instance && health.instanceId===instance,installed:await exists(startup),running,pid,bridgeHealth:health,logs:join(dir,'logs'),startup};
  };
  const halt=async()=>{
    if(!await exists(lock)) return;
    await writeFile(stop,'stop');
    for(let i=0;i<80;i++){if(!await exists(lock))return;await delay(250);}
    const state=await status();
    if(state.running) throw new Error('SERVICE_STOP_TIMEOUT: inspect the service logs before restarting');
    await unlink(lock).catch(()=>{});
  };
  const launch=async()=>{
    const current=await status();if(current.ok)return current;
    if(!await exists(launcher))throw new Error('SERVICE_NOT_INSTALLED: run service:install first');
    await unlink(stop).catch(()=>{});
    const child=spawnSync('wscript.exe',[launcher],{windowsHide:true,stdio:'ignore',timeout:15000});
    if(child.error || child.status!==0)throw new Error('Cannot start Windows Script Host: '+(child.error?.message || child.stderr));
    for(let i=0;i<40;i++){const state=await status();if(state.ok)return state;await delay(250);}
    throw new Error('SERVICE_START_TIMEOUT: inspect '+join(dir,'logs'));
  };
  if(action==='status') return status();
  if(action==='stop') {await halt();return status();}
  if(action==='uninstall') {await halt();await unlink(startup).catch(e=>{if(e.code!=='ENOENT')throw e;});return {ok:true,installed:false,retainedData:dir};}
  if(action==='install') {
    await halt();await mkdir(dir,{recursive:true});await mkdir(dirname(startup),{recursive:true});
    const config={root,node:process.execPath,server:join(root,'server','server.mjs'),env:{NODE_ENV:'production',RH_BRIDGE_INSTANCE_ID:randomUUID(),RH_BRIDGE_ACCESS_FILE:join(dir,'access.json'),RH_BRIDGE_ALLOW_GENERATION:env.RH_BRIDGE_ALLOW_GENERATION==='1'?'1':'0',...Object.fromEntries(['RH_FFPROBE','RH_LUMEN_MCP_CONFIG','RH_ARCHIVE_DIR'].filter(k=>env[k]).map(k=>[k,env[k]]))}};
    await writeFile(configPath,JSON.stringify(config,null,2));
    const source=launcherSource(process.execPath,join(root,'scripts','service-runner.mjs'),configPath);
    // UTF-16LE is understood by Windows Script Host for non-ASCII usernames/paths.
    const bytes=Buffer.from('\ufeff'+source,'utf16le');
    await writeFile(launcher,bytes);await writeFile(startup,bytes);
    return launch();
  }
  if(action==='restart'){await halt();return launch();}
  if(action==='start')return launch();
  throw new Error('Unknown Windows service action: '+action);
}
