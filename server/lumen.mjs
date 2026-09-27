// Lumen access uses its configured MCP, never direct library writes.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
export async function withLumen(fn) {
  const configPath=process.env.RH_LUMEN_MCP_CONFIG || join(homedir(),'Library/Application Support/Lumen/mcp-client.json');
  const settings=JSON.parse(await readFile(configPath,'utf8')).mcpServers?.lumen;
  if (!settings?.command || !Array.isArray(settings.args)) throw new Error('LUMEN_MCP_NOT_CONFIGURED');
  const client=new Client({name:'runninghub-archive',version:'0.4.0'});
  const transport=new StdioClientTransport({...settings,stderr:'pipe'});
  const call=async(name,args)=>{
    const result=await client.callTool({name,arguments:args},undefined,{timeout:180000});
    if (result.isError) throw new Error(result.content?.filter(c=>c.type==='text').map(c=>c.text).join('\n') || 'LUMEN_ERROR');
    const data=result.structuredContent || JSON.parse(result.content.find(c=>c.type==='text').text);
    if (data.ok===false || data.error) throw new Error(data.error || JSON.stringify(data));
    return data;
  };
  try { await client.connect(transport);return await fn(call); } finally { await client.close(); }
}
export async function validateTarget(call,target) {
  if (target.project_id) {
    const project=await call('lumen_read_project',{project_id:target.project_id});
    if (!project.project || project.project.archived_at) throw new Error('LUMEN_PROJECT_UNAVAILABLE');
  }
  if (target.work_id) {
    const asset=await call('lumen_read_asset',{work_id:target.work_id});
    const kind=asset.library_works?.[0]?.kind || asset.work?.kind;
    if (asset.work?.id!==target.work_id || (asset.work.project_id || null)!==(target.project_id || null) || kind!==target.kind || asset.work.archived_at) throw new Error('LUMEN_TARGET_MISMATCH');
    return asset;
  }
  if (target.kind==='asset' && !target.project_id) throw new Error('Project required for project assets');
  return null;
}
