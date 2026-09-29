import test from 'node:test';
import assert from 'node:assert/strict';
import { diagnoseConnection } from '../server/diagnostics.mjs';
test('diagnostics prefer actual service environment over client environment',async()=>{
  const result=await diagnoseConnection({request:async(path)=>{assert.equal(path,'/diagnostics');return {ok:true,diagnosticContext:'bridge-service',checks:[{name:'ffprobe',status:'pass'}]};}});
  assert.equal(result.diagnosticContext,'bridge-service');assert.equal(result.checks[0].status,'pass');
});
test('offline diagnostics are actionable and do not expose credentials',async()=>{
  const result=await diagnoseConnection({request:async()=>{throw new Error('secret-cookie');}});
  assert.equal(result.ok,false);assert.ok(result.nextActions.some(s=>s.includes('service:start')));assert.equal(JSON.stringify(result).includes('secret-cookie'),false);
});
