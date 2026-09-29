import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
const execute=promisify(execFile);
export async function diagnose(bridge) {
  const checks=[];
  const add=(name,status,detail,fix)=>checks.push({name,status,detail,...(fix?{fix}:{})});
  add('node',(Number(process.versions.node.split('.')[0])>20 || (Number(process.versions.node.split('.')[0])===20 && Number(process.versions.node.split('.')[1])>=19))?'pass':'fail',process.version,'Install Node.js 20.19 or newer.');
  let clients=[],health;
  try {
    [health,clients]=await Promise.all([bridge.request('/health'),bridge.request('/clients')]);
    const pkg=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8'));
    add('bridge',health.version===pkg.version?'pass':'warning',`Bridge ${health.version}; client ${pkg.version}`,health.version===pkg.version?null:'Restart the bridge from the current installation.');
    add('browser',clients.length?'pass':'fail',`${clients.length} connected canvas tab(s)`,clients.length?null:'Enable the extension in the logged-in Chrome/Edge profile and open the target canvas.');
    const stale=clients.filter(c=>c.runtimeFreshness!=='fresh');
    add('runtime',!clients.length?'unknown':stale.length?'warning':'pass',`${stale.length} stale runtime(s)`,stale.length?'Refresh the canvas tab.':null);
    const expected=JSON.parse(await readFile(new URL('../extension/manifest.json',import.meta.url),'utf8')).version;
    const versions=clients.map(c=>c.loaderVersion).filter(Boolean);
    add('extension',!clients.length || versions.length!==clients.length?'unknown':versions.every(v=>v===expected)?'pass':'warning',`Expected ${expected}; observed ${[...new Set(versions)].join(', ') || 'not reported'}`,'Reload the unpacked extension from the current extension folder, then refresh the canvas.');
  } catch {add('bridge','fail','Local bridge is unavailable','Run npm run service:start or npm start in the installed project.');}
  let probe=false;
  for(const file of [process.env.RH_FFPROBE,join(homedir(),'.local','bin',process.platform==='win32'?'ffprobe.exe':'ffprobe'),...(process.platform==='win32'?['ffprobe.exe']:['/opt/homebrew/bin/ffprobe','/usr/local/bin/ffprobe','ffprobe'])].filter(Boolean)) {
    try {const {stdout}=await execute(file,['-version'],{windowsHide:true,timeout:5000,maxBuffer:65536});add('ffprobe','pass',stdout.split(/\r?\n/)[0]);probe=true;break;}catch{}
  }
  if(!probe)add('ffprobe','fail','Media metadata component unavailable','Install FFmpeg and set RH_FFPROBE to the absolute ffprobe executable path; restart the service.');
  const root=process.env.RH_ARCHIVE_DIR || join(homedir(),'.runninghub-canvas-bridge','archives');
  try {await access(root,constants.W_OK);add('archive-directory','pass','Archive directory is writable');} catch {add('archive-directory','warning','Archive directory is absent or not writable','Start the bridge once; if this persists, set RH_ARCHIVE_DIR to a writable directory.');}
  const config=process.env.RH_LUMEN_MCP_CONFIG || (process.platform==='darwin'?join(homedir(),'Library/Application Support/Lumen/mcp-client.json'):null);
  if(!config)add('lumen','optional','Lumen archive integration is not configured','If needed, set RH_LUMEN_MCP_CONFIG to the exported MCP client configuration.');
  else try {const value=JSON.parse(await readFile(config,'utf8')).mcpServers?.lumen;add('lumen',value?.command && Array.isArray(value.args)?'pass':'warning','Configuration structure checked; server connection not tested',value?.command?null:'Export the Lumen MCP configuration again.');}catch{add('lumen','warning','Lumen configuration could not be read','Check RH_LUMEN_MCP_CONFIG and export the configuration again.');}
  return {ok:!checks.some(c=>c.status==='fail'),platform:process.platform,checks,nextActions:[...new Set(checks.filter(c=>['fail','warning','unknown'].includes(c.status)).map(c=>c.fix).filter(Boolean))]};
}

export async function diagnoseConnection(bridge) {
  try {return await bridge.request('/diagnostics',undefined,45000);}
  catch {return {...await diagnose(bridge),diagnosticContext:'client-process; bridge diagnostics unavailable'};}
}
