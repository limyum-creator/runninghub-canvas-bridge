// Reusable canvas tools. Platform payloads are data, never executable code.
(() => {
  const object = value => {
    if (typeof value === 'string') { try { value = JSON.parse(value); } catch { return {}; } }
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  };
  const canonical = value => JSON.stringify(value, (_, v) => v && typeof v === 'object' && !Array.isArray(v)
    ? Object.fromEntries(Object.keys(v).sort().map(k => [k,v[k]])) : v);
  const cleanNode = node => { const { selected, dragging, ...value } = node || {}; return value; };
  const nodeState = (snapshot, id) => ({ node:cleanNode(snapshot.nodes.find(n => n.id === id)), edges:snapshot.edges.filter(e => e.source === id || e.target === id).map(cleanNode).sort((a,b)=>String(a.id).localeCompare(String(b.id))) });
  const revision = async (snapshot,id) => {
    const bytes = await crypto.subtle.digest('SHA-256',new TextEncoder().encode(canonical(nodeState(snapshot,id))));
    return Array.from(new Uint8Array(bytes),n=>n.toString(16).padStart(2,'0')).join('');
  };
  const checkRevisions = async (snapshot, expected = {}) => {
    for (const [id, wanted] of Object.entries(expected)) {
      if (!snapshot.nodes.some(n=>n.id===id) || await revision(snapshot,id) !== wanted) throw new Error(`EDIT_CONFLICT: reread node ${id}`);
    }
  };
  const mediaUrls = (node,kind) => {
    const data = node?.data || {}, urls=[];
    for (const item of data.output || []) {
      const category=String(item.mediaCategory || '').toLowerCase();
      if (item.success !== false && item.url && (category === kind || (!category && node.type === `rh-${kind}`))) urls.push(item.url);
    }
    if (node?.type === `rh-${kind}`) {
      urls.push(...(data.sourceObjects || []).filter(u=>typeof u==='string'));
      const direct=data[`${kind}Url`]; if (direct) urls.push(direct);
    }
    return [...new Set(urls)].filter(u=>typeof u==='string' && /^https:\/\//.test(u));
  };
  const DEFAULT_TYPES = ['TEXT_IMAGE','IMAGE_IMAGE','TEXT_VIDEO','IMAGE_VIDEO','MULTIMODAL_VIDEO','START_END_VIDEO','START_VIDEO','VIDEO_VIDEO','VIDEO_EDIT','VIDEO_EXTEND','TEXT_AUDIO','TEXT_MUSIC','AUDIO_AUDIO','VIDEO_AUDIO','TEXT_TEXT','MULTIMODAL_TEXT','IMAGE_TEXT','VIDEO_TEXT'];
  globalThis.RHCanvasFeatures = {revision,checkRevisions,canonical,nodeState,mediaUrls,
    create({api,withMutation,readSnapshot,toYValue,getTitle}) {
      const assets = new Map();
      const listModels = async ({types=DEFAULT_TYPES,query='',modelCode,includeSchema=false}={}) => {
        const response = await api('/canvas/model/list',{types});
        const groups = Array.isArray(response) ? response : response?.data;
        if (!Array.isArray(groups)) throw new Error('MODEL_SCHEMA_UNSUPPORTED');
        const models=groups.flatMap(g=>(g.modelList || []).map(m=>({...m,modelType:g.type})))
          .filter(m=>(!modelCode || m.modelCode===modelCode) && (!query || canonical(m).toLowerCase().includes(query.toLowerCase())));
        return {source:'live-platform-api',fetchedAt:new Date().toISOString(),types,models:includeSchema?models:models.map(m=>({modelCode:m.modelCode,modelType:m.modelType,name:m.name,modelName:m.modelName,nameEn:m.nameEn,parameterCount:m.config?.length || 0}))};
      };
      const modelSchema = async ({modelCode,types}={}) => {
        const result=await listModels({modelCode,types,includeSchema:true});
        if (!result.models.length) throw new Error('MODEL_NOT_FOUND: use rh_list_models and its modelType');
        return {...result,models:result.models.map(m=>({...m,parameters:(m.config || []).filter(c=>c.paramName).map(c=>({name:c.paramName,type:c.type,dataType:c.paramDataType,default:c.paramValue,options:c.optionValue,min:c.min,max:c.max,required:c.required,conditions:c.paramExt,raw:c}))}))};
      };
      const searchAssets = async ({view='search',keyword='',page=1,size=30,groupId,code,nodeTypes}={}) => {
        const endpoints={search:'folder/item/search',groups:'group/list',items:'group/item/list',folders:'folder/first-level/list',children:'folder/second-level/list',folderItems:'folder/second-level/item/list'};
        if (!endpoints[view] || (['items','children','folderItems'].includes(view) && !groupId)) throw new Error('ASSET_QUERY_INVALID');
        if(view==='search' && !keyword.trim()) throw new Error('ASSET_KEYWORD_REQUIRED: use groups or folders to browse without a keyword');
        const body={keyword,page,size,...(code?{code}:{}),...(groupId?{[view==='children'?'parentGroupId':'groupId']:groupId}:{}),...(nodeTypes?.length?{nodeTypes}:{})};
        const data=await api('/canvas/asset/user/'+endpoints[view],body);
        if (!Array.isArray(data?.records)) throw new Error('ASSET_RESPONSE_UNSUPPORTED');
        const records=data.records.map(row=>{
          const content=object(row.content), nested=object(content.data);
          const url=row.url || row.assetUrl || row.resultUrl || content.url || nested.imageUrl || nested.videoUrl || nested.audioUrl;
          const type=String(row.nodeType || row.node_type || row.mediaType || row.assetType || content.nodeType || '').toLowerCase().replace(/^rh-/,'');
          const kind=['image','video','audio'].includes(type)?type:null;
          const asset={id:String(row.id ?? row.itemId ?? ''),title:row.title || row.itemName || row.assetName || row.name || '',kind,url,thumbnail:row.thumbnail,groupId:row.groupId,folder:row.isFolder===true || type==='folder',itemCount:row.itemCount,raw:row};
          if (kind && url && /^https:\/\//.test(url) && !asset.folder) {
            const key=crypto.randomUUID(); assets.set(key,{...asset,expires:Date.now()+15*60*1000}); asset.assetToken=key;
          }
          return asset;
        });
        for(const [k,v] of assets) if(v.expires<Date.now()) assets.delete(k);
        return {source:'live-platform-api',view,page,pages:data.pages,total:data.total,hasNext:data.hasNext,records};
      };
      const addAsset = async command => {
        const asset=assets.get(command.assetToken);
        if (!asset || asset.expires<Date.now()) throw new Error('ASSET_TOKEN_EXPIRED: search again on the selected canvas');
        return withMutation(command,({Y,doc,nodes})=>{
          const existing=nodes.toJSON().find(n=>mediaUrls(n,asset.kind).includes(asset.url));
          if(existing) return {reused:true,nodeId:existing.id,mediaKind:asset.kind};
          const id=command.nodeId || 'asset-'+crypto.randomUUID();
          if(nodes.toJSON().some(n=>n.id===id)) throw new Error('NODE_ID_EXISTS');
          const title=command.title || asset.title || asset.id;
          const node={id,type:`rh-${asset.kind}`,position:{x:command.x,y:command.y},data:{title,label:title,status:'idle',sourceObjects:[asset.url],[`${asset.kind}Url`]:asset.url,assetId:asset.id,subType:`text-${asset.kind}`,width:380,height:asset.kind==='audio'?160:280,from:'bridge'}};
          doc.transact(()=>nodes.push([toYValue(Y,node)]));
          return {reused:false,nodeId:id,mediaKind:asset.kind,node,generationTriggered:false};
        });
      };
      const inspectReferences = async ({nodeId}) => {
        const snapshot=await readSnapshot(),node=snapshot.nodes.find(n=>n.id===nodeId);
        if(!node) throw new Error(`Node not found: ${nodeId}`);
        return {nodeId,revision:await revision(snapshot,nodeId),title:getTitle(node),image:mediaUrls(node,'image'),video:mediaUrls(node,'video'),audio:mediaUrls(node,'audio')};
      };
      const fieldsFor = async node => {
        if(!node?.data?.modelCode || !node.data.subType) throw new Error('MODEL_NOT_CONFIGURED');
        const schema=await modelSchema({modelCode:node.data.modelCode,types:[node.data.subType.replaceAll('-','_').toUpperCase()]});
        if(schema.models.length!==1) throw new Error('MODEL_SCHEMA_AMBIGUOUS');
        return schema.models[0].parameters;
      };
      const mediaKind = field => ['image','video','audio'].find(k=>field.type===k || (String(field.type).toLowerCase().includes(k) && /url|upload/i.test(field.type)));
      const referencePlan = (node, all, edges, fields, references, mode='merge') => {
        const params={...node.data.params},seen=new Set(),sources=new Set();
        const mediaFields=fields.filter(mediaKind), oldUrls=new Set(mediaFields.flatMap(f=>[params[f.name]].flat()).filter(Boolean));
        if(mode==='replace') for(const field of mediaFields) delete params[field.name];
        for(const reference of references) {
          const field=fields.find(f=>f.name===reference.parameter);
          if(!field) throw new Error(`REFERENCE_PARAMETER_UNKNOWN: ${reference.parameter}`);
          if(mediaKind(field)!==reference.kind) throw new Error(`REFERENCE_PARAMETER_KIND_MISMATCH: ${reference.parameter}`);
          const arrayField=String(field.dataType).toLowerCase()==='array' || /array|multiple/i.test(field.type) || Array.isArray(field.default);
          if(reference.array && field.dataType==='string') throw new Error('REFERENCE_PARAMETER_REQUIRES_STRING');
          const asArray=arrayField || reference.array===true;
          if(seen.has(field.name) && !asArray) throw new Error('DUPLICATE_REFERENCE_PARAMETER');
          const previous=seen.has(field.name)?params[field.name]:[];
          seen.add(field.name);
          const source=all.find(n=>n.id===reference.sourceNodeId);
          if(!source || source.id===node.id) throw new Error('REFERENCE_SOURCE_INVALID');
          const urls=mediaUrls(source,reference.kind),url=reference.url || (urls.length===1?urls[0]:null);
          if(!url || !urls.includes(url)) throw new Error(`REFERENCE_OUTPUT_AMBIGUOUS: ${reference.sourceNodeId}; specify one inspected output URL`);
          params[field.name]=asArray?[...new Set([...previous,url])]:url;
          sources.add(source.id);
        }
        // Only remove edges proven to feed old media parameters. Text/control edges stay intact.
        const removed=mode==='replace'?edges.filter(e=>e.target===node.id && !sources.has(e.source) && ['image','video','audio'].some(k=>mediaUrls(all.find(n=>n.id===e.source),k).some(u=>oldUrls.has(u)))):[];
        const kept=edges.filter(e=>!removed.includes(e));
        const added=[...sources].filter(source=>!kept.some(e=>e.source===source && e.target===node.id)).map(source=>({id:`e-${source}-${node.id}`,source,target:node.id,sourceHandle:'output',targetHandle:'input',type:'default',animated:false}));
        return {node:{...node,data:{...node.data,params}},edges:[...kept,...added],removedEdges:removed.map(e=>e.id),addedEdges:added.map(e=>e.id),parameters:[...seen]};
      };
      const pin = async (snapshot, ids, expected={}) => {
        const result={...expected};
        for(const id of new Set(ids)) result[id] ||= await revision(snapshot,id);
        return result;
      };
      const bindReferences = async command => {
        const snapshot=await readSnapshot(),target=snapshot.nodes.find(n=>n.id===command.nodeId),fields=await fieldsFor(target);
        const expectedRevisions=await pin(snapshot,[command.nodeId,...command.references.map(r=>r.sourceNodeId),...snapshot.edges.filter(e=>e.target===command.nodeId).map(e=>e.source)],command.expectedRevisions);
        return withMutation({...command,expectedRevisions},({Y,doc,nodes,edges})=>{
          const all=nodes.toJSON(),index=all.findIndex(n=>n.id===command.nodeId);
          const plan=referencePlan(all[index],all,edges.toJSON(),fields,command.references,command.mode);
          doc.transact(()=>{nodes.delete(index,1);nodes.insert(index,[toYValue(Y,plan.node)]);edges.delete(0,edges.length);edges.push(plan.edges.map(e=>toYValue(Y,e)));});
          return {nodeId:command.nodeId,parameters:plan.parameters,addedEdges:plan.addedEdges,removedEdges:plan.removedEdges,generationTriggered:false};
        });
      };
      const validateParameters = (params, fields, keys=Object.keys(params), full=false) => {
        const errors=[],warnings=[];
        for(const key of keys) {
          const field=fields.find(f=>f.name===key),value=params[key];
          if(!field) { errors.push(`${key}: unknown parameter`);continue; }
          if(value===undefined || value===null || value==='') continue;
          const type=String(field.dataType || '').toLowerCase();
          if((type==='string' && typeof value!=='string') || (['number','integer','int','float','double'].includes(type) && (typeof value!=='number' || !Number.isFinite(value))) || (['int','integer'].includes(type) && !Number.isInteger(value)) || (type==='boolean' && typeof value!=='boolean') || (type==='array' && !Array.isArray(value))) errors.push(`${key}: expected ${type}`);
          const numeric=typeof value==='number'?value:typeof value==='string' && value.trim()!==''?Number(value):NaN;
          if(!Number.isFinite(numeric) && (field.min!==undefined || field.max!==undefined)) errors.push(`${key}: expected a finite numeric value`);
          if(Number.isFinite(numeric)) for(const bound of ['min','max']) if(field[bound]!==undefined && field[bound]!==null && field[bound]!=='' && Number.isFinite(Number(field[bound])) && (bound==='min'?numeric<Number(field[bound]):numeric>Number(field[bound]))) errors.push(`${key}: ${bound} ${field[bound]}`);
          let options=field.options;
          if(typeof options==='string') {try {options=JSON.parse(options);} catch {options=null;}}
          if(Array.isArray(options) && options.length) {
            const values=options.map(o=>typeof o==='object' && o!==null?Object.hasOwn(o,'value')?o.value:o.paramValue:o);
            if(values.every(v=>v!==undefined && (typeof v!=='object' || v===null)) && !values.some(v=>canonical(v)===canonical(value))) errors.push(`${key}: unsupported option`);
          }
          if(field.conditions && Object.keys(object(field.conditions)).some(k=>!['allowManualModify'].includes(k))) warnings.push(`${key}: conditional platform rules require review`);
        }
        if(full) for(const f of fields) if(f.required===true && (params[f.name]===undefined || params[f.name]===null || params[f.name]==='')) errors.push(`${f.name}: required`);
        return {ok:errors.length===0,errors,warnings:[...new Set(warnings)]};
      };
      const validatePatch = async command => {
        const snapshot=await readSnapshot(),node=snapshot.nodes.find(n=>n.id===command.nodeId);
        const modelNode={...node,data:{...node?.data,...(command.modelCode?{modelCode:command.modelCode}:{}),...(command.subType?{subType:command.subType}:{})}};
        const fields=await fieldsFor(modelNode),params={...node.data.params,...command.params};
        const check=validateParameters(params,fields,Object.keys(command.params || {}));
        if(!check.ok) throw new Error('PARAMETER_INVALID: '+check.errors.join('; '));
        return {expectedRevisions:await pin(snapshot,[node.id],command.expectedRevisions),warnings:check.warnings};
      };
      const preflightSnapshot = async (snapshot, command, fields) => {
        const node=snapshot.nodes.find(n=>n.id===command.nodeId);
        if(!node) throw new Error('NODE_NOT_FOUND');
        fields ||= await fieldsFor(node);
        const check=validateParameters(node.data.params || {},fields,fields.filter(f=>Object.hasOwn(node.data.params || {},f.name)).map(f=>f.name),true);
        const refs=[];
        for(const field of fields.filter(mediaKind)) for(const url of [node.data.params?.[field.name]].flat().filter(Boolean)) {
          const source=snapshot.nodes.find(n=>mediaUrls(n,mediaKind(field)).includes(url) && snapshot.edges.some(e=>e.source===n.id && e.target===node.id));
          if(!source) check.errors.push(`${field.name}: no matching connected source`);
          refs.push({parameter:field.name,url,sourceNodeId:source?.id});
        }
        const expected=command.expected || {};
        if(expected.prompt!==undefined && node.data.params?.prompt!==expected.prompt) check.errors.push('prompt: differs from expected text');
        for(const [key,value] of Object.entries(expected.params || {})) if(canonical(node.data.params?.[key])!==canonical(value)) check.errors.push(`${key}: differs from expected value`);
        if(expected.references && canonical([...refs].sort((a,b)=>canonical(a).localeCompare(canonical(b))))!==canonical([...expected.references].sort((a,b)=>canonical(a).localeCompare(canonical(b))))) check.errors.push('references: differ from expected complete mapping');
        const ids=new Set([node.id]);
        for(let i=0;i<snapshot.nodes.length;i++) {const size=ids.size;for(const e of snapshot.edges) if(ids.has(e.target)) ids.add(e.source);if(ids.size===size)break;}
        const graph={nodes:snapshot.nodes.filter(n=>ids.has(n.id)).map(cleanNode).sort((a,b)=>a.id.localeCompare(b.id)),edges:snapshot.edges.filter(e=>ids.has(e.source)&&ids.has(e.target)).map(cleanNode).sort((a,b)=>a.id.localeCompare(b.id))};
        const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(canonical(graph)))),n=>n.toString(16).padStart(2,'0')).join('');
        return {...check,ok:check.errors.length===0,nodeId:node.id,digest,references:refs,generationTriggered:false};
      };
      const preflight = async command => preflightSnapshot(await readSnapshot(),command);
      const batchUpdate = async command => withMutation(command,({Y,doc,nodes})=>{
        const all=nodes.toJSON();
        const updates=command.updates.map(update=>{
          const index=all.findIndex(n=>n.id===update.nodeId);
          if(index<0) throw new Error(`Node not found: ${update.nodeId}`);
          const node=all[index], data={...node.data};
          if(update.title!==undefined) {data.title=update.title;data.label=update.title;}
          if(update.params) data.params={...data.params,...update.params};
          return {index,node:{...node,data,...(update.position?{position:update.position}:{})}};
        });
        if(new Set(updates.map(u=>u.index)).size!==updates.length) throw new Error('DUPLICATE_NODE_UPDATE');
        doc.transact(()=>{for(const {index,node} of updates){nodes.delete(index,1);nodes.insert(index,[toYValue(Y,node)]);}});
        return {updated:updates.map(u=>u.node.id)};
      });
      const rectangle = n => ({x:Number(n.position?.x || 0),y:Number(n.position?.y || 0),width:Math.max(100,Number(n.measured?.width || n.width || n.data?.width || 420)),height:Math.max(100,Number(n.measured?.height || n.height || n.data?.height || 380))});
      const overlaps = (a,b,gap) => a.x < b.x+b.width+gap && a.x+a.width+gap > b.x && a.y < b.y+b.height+gap && a.y+a.height+gap > b.y;
      const layoutPlan = (snapshot,ids,{x=0,y=0,gap=100,columns=3}={}) => {
        if(new Set(ids).size!==ids.length) throw new Error('DUPLICATE_NODE_ID');
        if(snapshot.nodes.some(n=>n.parentId || n.parentNode)) throw new Error('GROUPED_LAYOUT_UNSUPPORTED: ungroup before automatic layout');
        const obstacles=snapshot.nodes.filter(n=>!ids.includes(n.id)).map(rectangle),positions=[];
        let rowY=y,rowHeight=0,cursorX=x;
        for(const [index,id] of ids.entries()) {
          const node=snapshot.nodes.find(n=>n.id===id);if(!node)throw new Error(`NODE_NOT_FOUND: ${id}`);
          if(index && index%columns===0) {rowY+=rowHeight+gap;rowHeight=0;cursorX=x;}
          const rect={...rectangle(node),x:cursorX,y:rowY};
          let attempts=0;
          while(obstacles.some(o=>overlaps(rect,o,gap))) {
            const blockers=obstacles.filter(o=>overlaps(rect,o,gap));
            rect.y=Math.max(...blockers.map(o=>o.y+o.height+gap));
            if(++attempts>snapshot.nodes.length+ids.length+1) throw new Error('LAYOUT_NO_SPACE');
          }
          obstacles.push(rect);positions.push({nodeId:id,x:rect.x,y:rect.y});
          rowHeight=Math.max(rowHeight,rect.y-rowY+rect.height);cursorX+=rect.width+gap;
        }
        return positions;
      };
      const autoLayout = async command => {
        const before=await readSnapshot(),positions=layoutPlan(before,command.nodeIds,command);
        const expectedRevisions=await pin(before,before.nodes.map(n=>n.id),command.expectedRevisions);
        return withMutation({...command,expectedRevisions},({Y,doc,nodes,edges})=>{
          const all=nodes.toJSON();
          if(all.length!==before.nodes.length) throw new Error('EDIT_CONFLICT: layout obstacles changed');
          doc.transact(()=>{for(const p of positions){const i=all.findIndex(n=>n.id===p.nodeId);nodes.delete(i,1);nodes.insert(i,[toYValue(Y,{...all[i],position:{x:p.x,y:p.y}})]);}});
          return {positions,generationTriggered:false};
        });
      };
      const prepareShots = async command => {
        const before=await readSnapshot(),planned=JSON.parse(JSON.stringify(before)),ids=[],reports=[],schemas=new Map();
        for(const shot of command.shots) {
          if(planned.nodes.some(n=>n.id===shot.nodeId)) throw new Error(`NODE_ID_EXISTS: ${shot.nodeId}`);
          const template=before.nodes.find(n=>n.id===shot.templateNodeId);
          if(!template) throw new Error(`TEMPLATE_NOT_FOUND: ${shot.templateNodeId}`);
          if(!schemas.has(template.id)) schemas.set(template.id,await fieldsFor(template));
          const fields=schemas.get(template.id);
          if((template.data.output || []).length || template.data.params?.prompt || template.data.text || template.data.content || (template.data.sourceObjects || []).length || fields.filter(mediaKind).some(f=>[template.data.params?.[f.name]].flat().some(Boolean)) || before.edges.some(e=>e.target===template.id) || /running|queued|processing/i.test(template.data.status || '')) throw new Error(`TEMPLATE_NOT_EMPTY: ${template.id}`);
          let node=JSON.parse(JSON.stringify(template));
          Object.assign(node,{id:shot.nodeId,position:{x:0,y:0},selected:false});
          for(const key of ['parentNode','parentId','extent','positionAbsolute','dragging','measured']) delete node[key];
          for(const key of ['output','taskId','jobId','progress','error','errorMsg','queuePosition']) delete node.data[key];
          Object.assign(node.data,{title:shot.title,label:shot.title,status:'idle',params:{...node.data.params,...shot.params,prompt:shot.prompt}});
          const check=validateParameters(node.data.params,fields,Object.keys(shot.params || {}).concat('prompt'),false);
          if(!check.ok) throw new Error(`PARAMETER_INVALID: ${shot.nodeId}: ${check.errors.join('; ')}`);
          const plan=referencePlan(node,planned.nodes,planned.edges,fields,shot.references || [],'replace');
          planned.nodes.push(plan.node);planned.edges=plan.edges;ids.push(node.id);
          const pre=await preflightSnapshot(planned,{nodeId:node.id,expected:shot.expected},fields);
          if(!pre.ok) throw new Error(`PREFLIGHT_FAILED: ${node.id}: ${pre.errors.join('; ')}`);
          reports.push({nodeId:node.id,warnings:pre.warnings});
        }
        const positions=layoutPlan(planned,ids,command.layout);
        for(const p of positions) planned.nodes.find(n=>n.id===p.nodeId).position={x:p.x,y:p.y};
        const expectedRevisions=await pin(before,before.nodes.map(n=>n.id),command.expectedRevisions);
        return withMutation({...command,expectedRevisions},({Y,doc,nodes,edges})=>{
          if(nodes.length!==before.nodes.length || canonical(edges.toJSON())!==canonical(before.edges)) throw new Error('EDIT_CONFLICT: canvas changed during preparation');
          doc.transact(()=>{nodes.push(planned.nodes.filter(n=>ids.includes(n.id)).map(n=>toYValue(Y,n)));const old=new Set(before.edges.map(e=>e.id));edges.push(planned.edges.filter(e=>!old.has(e.id)).map(e=>toYValue(Y,e)));});
          return {shots:reports,positions,generationTriggered:false};
        });
      };
      return {listModels,modelSchema,searchAssets,addAsset,inspectReferences,bindReferences,batchUpdate,prepareShots,autoLayout,validatePatch,preflight,preflightSnapshot,fieldsFor,validateParameters,referencePlan,pin};
    }
  };
})();
