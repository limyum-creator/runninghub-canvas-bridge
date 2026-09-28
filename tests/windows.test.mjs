import test from 'node:test';
import assert from 'node:assert/strict';
import {launcherSource} from '../scripts/windows-service.mjs';
import {zipFiles} from '../scripts/zip.mjs';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
test('Windows launcher quotes executable and Unicode/space paths independently',()=>{
  const source=launcherSource('C:\\Program Files\\nodejs\\node.exe','C:\\项目 空格\\runner.mjs',"C:\\Users\\O'Brien\\service.json");
  assert.ok(source.includes('""C:\\Program Files\\nodejs\\node.exe""'));
  assert.ok(source.includes('""C:\\项目 空格\\runner.mjs""'));assert.ok(source.endsWith(', 0, False\r\n'));
});
test('portable ZIP has valid header, entries and end record',()=>{
  const zip=zipFiles([{name:'manifest.json',bytes:Buffer.from('{"version":"test"}')}]);
  assert.equal(zip.readUInt32LE(),0x04034b50);assert.equal(zip.readUInt32LE(zip.length-22),0x06054b50);assert.equal(zip.readUInt16LE(zip.length-12),1);
});
test('Windows Script Host launches Node from Unicode paths without a console',{skip:process.platform!=='win32'},async()=>{
  const dir=await mkdtemp(join(tmpdir(),'rh-路径 spaces-'));
  try {
    const runner=join(dir,'runner.mjs'),out=join(dir,'result.json'),vbs=join(dir,'start.vbs');
    await writeFile(runner,"import {writeFileSync} from 'node:fs';writeFileSync(process.argv[2],JSON.stringify({ok:true}));");
    await writeFile(vbs,Buffer.from('\ufeff'+launcherSource(process.execPath,runner,out),'utf16le'));
    const result=spawnSync('cscript.exe',['//Nologo',vbs],{windowsHide:true,encoding:'utf8'});assert.equal(result.status,0,result.stderr);
    for(let i=0;i<40;i++){try{assert.equal(JSON.parse(await readFile(out,'utf8')).ok,true);return;}catch{await new Promise(r=>setTimeout(r,100));}}
    assert.fail('Windows launcher did not produce output');
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('Windows service installs, restarts and uninstalls in an isolated user directory',{skip:process.platform!=='win32',timeout:60000},async()=>{
  const {windowsService}=await import('../scripts/windows-service.mjs');
  const home=await mkdtemp(join(tmpdir(),'rh-service-用户 '));
  const options={home,env:{...process.env,APPDATA:join(home,'AppData','Roaming'),RH_ARCHIVE_DIR:join(home,'archives'),RH_BRIDGE_ALLOW_GENERATION:'0'}};
  try {
    const installed=await windowsService('install',options);assert.equal(installed.ok,true);assert.equal(installed.installed,true);
    const originalPid=installed.pid;
    const restarted=await windowsService('restart',options);assert.equal(restarted.ok,true);assert.notEqual(restarted.pid,originalPid);
    assert.equal(restarted.bridgeHealth.access.generationEnabled,false);
    assert.equal((await windowsService('uninstall',options)).installed,false);
    assert.equal((await windowsService('status',options)).running,false);
  }finally{await windowsService('uninstall',options).catch(()=>{});await rm(home,{recursive:true,force:true});}
});
