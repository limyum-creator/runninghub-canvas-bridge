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
      const bindReferences = async command => {
        const initial=await readSnapshot(),target=initial.nodes.find(n=>n.id===command.nodeId);
        if(!target?.data?.modelCode || !target.data.subType) throw new Error('MODEL_NOT_CONFIGURED');
        const schema=await modelSchema({modelCode:target.data.modelCode,types:[target.data.subType.replaceAll('-','_').toUpperCase()]});
        const fields=new Map(schema.models.flatMap(m=>m.parameters).map(f=>[f.name,f]));
        const expected={...(command.expectedRevisions || {})};
        for(const id of new Set([command.nodeId,...command.references.map(r=>r.sourceNodeId)])) expected[id] ||= await revision(initial,id);
        return withMutation({...command,expectedRevisions:expected},({Y,doc,nodes,edges})=>{
          const all=nodes.toJSON(),index=all.findIndex(n=>n.id===command.nodeId),node=all[index];
          if(!node) throw new Error(`Node not found: ${command.nodeId}`);
          const params={...node.data.params},seen=new Set(),sources=new Set();
          for(const reference of command.references) {
            const field=fields.get(reference.parameter);
            if (!field) throw new Error(`REFERENCE_PARAMETER_UNKNOWN: ${reference.parameter}`);
            const type=String(field.type || '').toLowerCase();
            if (!type.includes(reference.kind) && !new RegExp(reference.kind,'i').test(field.name)) throw new Error(`REFERENCE_PARAMETER_KIND_MISMATCH: ${reference.parameter}`);
            if(seen.has(field.name)) throw new Error('DUPLICATE_REFERENCE_PARAMETER');
            seen.add(field.name);
            const source=all.find(n=>n.id===reference.sourceNodeId);
            if(!source || source.id===node.id) throw new Error('REFERENCE_SOURCE_INVALID');
            const urls=mediaUrls(source,reference.kind);
            const url=reference.url || (urls.length===1 ? urls[0] : null);
            if(!url || !urls.includes(url)) throw new Error(`REFERENCE_OUTPUT_AMBIGUOUS: ${reference.sourceNodeId}; specify one inspected output URL`);
            // Array parameters require an explicit array mode; scalar fields preserve platform types.
            params[field.name]=reference.array ? [url] : url;
            sources.add(source.id);
          }
          const next={...node,data:{...node.data,params}};
          const newEdges=[...sources].filter(source=>!edges.toJSON().some(e=>e.source===source && e.target===node.id)).map(source=>({id:`e-${source}-${node.id}`,source,target:node.id,sourceHandle:'output',targetHandle:'input',type:'default',animated:false}));
          doc.transact(()=>{nodes.delete(index,1);nodes.insert(index,[toYValue(Y,next)]);edges.push(newEdges.map(e=>toYValue(Y,e)));});
          return {nodeId:node.id,parameters:[...seen],sources:[...sources],addedEdges:newEdges.map(e=>e.id),generationTriggered:false};
        });
      };
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
      return {listModels,modelSchema,searchAssets,addAsset,inspectReferences,bindReferences,batchUpdate};
    }
  };
})();
