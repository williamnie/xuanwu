import assert from 'node:assert/strict';
import test from 'node:test';
import { saveAndApplyGitHub, githubOwnVersionApplied } from './githubSaveApply.js';

const settings = {enabled:true,auth:{mode:'gh-cli'},repositories:[]};
const saved={revision:'own',settings};
const pending={...saved,application:{status:'pending',active_settings:{...settings,enabled:false}}};
const applied={...saved,application:{status:'applied',active_settings:settings}};
const fail=(code,status)=>Object.assign(new Error(code),{status});
async function scenario({save=async()=>saved,reload=async()=>applied,get=async()=>pending,retry=false}={}){
  const events=[],calls=[];
  await saveAndApplyGitHub({api:{save:async(...args)=>{calls.push(['save',...args]);return save(...args);},reload:async rev=>{calls.push(['reload',rev]);return reload(rev);},get},revision:'before',draft:settings,savedSnapshot:retry?saved:null,retry,emit:event=>events.push(event)});
  return {events,calls};
}
test('save and apply uses only the exact revision returned by this save',async()=>{
  const {calls,events}=await scenario();assert.equal(calls[1][1],'own');assert.equal(events[0].type,'saved');assert.equal(events[0].keepBusy,true);assert.equal(events.at(-1).type,'applied');
});
test('polling reload failure preserves own saved version and permits an explicit retry',async()=>{
  const {events}=await scenario({reload:async()=>{throw fail('reload_failed',409)}});assert.equal(events.at(-1).type,'apply-pending');assert.equal(events.at(-1).saved.revision,'own');
  const retry=await scenario({retry:true});assert.deepEqual(retry.calls,[['reload','own']]);
});
test('same HTTP409 configuration conflict never applies another window draft',async()=>{
  const latest={revision:'other',settings:{...settings,enabled:false},application:{status:'applied',active_settings:{...settings,enabled:false}}};
  const {calls,events}=await scenario({reload:async()=>{throw fail('config_conflict',409)},get:async()=>latest});assert.equal(calls.filter(call=>call[0]==='reload').length,1);assert.equal(events.at(-1).code,'config_conflict');assert.equal(events.at(-1).remote.revision,'other');
});
test('runtime unavailability is saved but remains pending',async()=>{
  const {events}=await scenario({reload:async()=>{throw fail('runtime_unavailable',503)}});assert.equal(events.at(-1).type,'apply-pending');assert.equal(events.at(-1).code,'runtime_unavailable');
});
test('timeout reconciliation proves both own saved revision and active configuration',async()=>{
  const {events}=await scenario({reload:async()=>{throw new Error('timeout')},get:async()=>applied});assert.equal(events.at(-1).type,'applied');
  assert.equal(githubOwnVersionApplied({...applied,revision:'other'},saved),false);
  assert.equal(githubOwnVersionApplied({...applied,application:{status:'applied',active_settings:{...settings,enabled:false}}},saved),false);
});
test('unknown save outcome never reloads a freshly read server revision',async()=>{
  const {calls,events}=await scenario({save:async()=>{throw new Error('timeout')},get:async()=>applied});assert.equal(calls.some(call=>call[0]==='reload'),false);assert.equal(events.at(-1).code,'uncertain');
});
