// Verify metadata at its consumers, with a failed provider directory and closed UI.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';import {once} from 'node:events';
import {mkdtemp,realpath,readFile,writeFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {startNativeRpc} from './rpc-test-session.mjs';
const root=await mkdtemp(join(await realpath(tmpdir()),'xwx-consumption-'));
let stage=0,failDirectory=false,failReference=false,controls=0,heldDirectory=null,observeDirectory=null;const directoryCalls=[],checks=[];
const server=createServer(async(req,res)=>{
 res.setHeader('content-type','application/json');
 if(req.url==='/events'){res.writeHead(200,{'content-type':'text/event-stream'});res.write(': fixture\n\n');return;}
 if(req.url==='/models-dev'){if(failReference){res.statusCode=503;res.end('{}');return;}res.end(JSON.stringify({openai:{models:{'gpt-audit':{reasoning:true,limit:{context:1050000}}}},deepseek:{models:{'audit-model':{limit:{context:stage?768000:1000000},modalities:{input:stage?['text']:['text','image']}}}}}));return;}
 directoryCalls.push(req.url);if(heldDirectory){const gate=heldDirectory;heldDirectory=null;observeDirectory();await gate;}res.statusCode=failDirectory?503:200;res.end(JSON.stringify({data:[{id:'gpt-audit',...(controls===0?{supports_search_tool:true,support_verbosity:true,default_verbosity:'high',auto_compact_token_limit:410000,effective_context_window_percent:93}:controls===1?{supports_search_tool:false,support_verbosity:false}:controls===2?{native_endpoints:['chat-completions'],supports_search_tool:true,support_verbosity:true,context_window:128000,auto_compact_token_limit:200000}:controls===3?{supports_search_tool:'true',support_verbosity:'true',effective_context_window_percent:101}:{} )},{id:'audit-model'}]}));
});server.listen(0,'127.0.0.1');await once(server,'listening');const base=`http://127.0.0.1:${server.address().port}`;
let app=startNativeRpc(root,['--metadata-test-endpoint',base]);let passed=false;
try{
 await app.rpc('getState');
 const native={models:[{slug:'gpt-audit',context_window:500000,auto_compact_token_limit:390000,effective_context_window_percent:91,supports_search_tool:true,support_verbosity:true,default_verbosity:'low',supported_reasoning_levels:[{effort:'low'},{effort:'high'}],default_reasoning_level:'high',default_reasoning_summary:'auto',base_instructions:'Synthetic audit instructions.'}]};
 await writeFile(join(root,'codex/models_cache.json'),JSON.stringify(native));
 await app.rpc('saveProvider',{id:'audit',displayName:'Audit fixture',adapter:'responses',baseUrl:base+'/v1',bearerToken:'synthetic-only',codexModel:'gpt-audit'});await app.rpc('switchClientProvider',{client:'codex',providerId:'audit'});
 await app.rpc('refreshMetadata',{topics:['capabilities'],revision:100});await app.rpc('fetchProviderModels',{providerId:'audit',refresh:true});
 const file=join(root,'codex/xwx-deck-model-catalog.json');const menu=async()=>JSON.parse(await readFile(file,'utf8')).models;
 let models=await menu(),gpt=models.find(m=>m.slug==='gpt-audit');
 assert.deepEqual(gpt.supported_reasoning_levels,native.models[0].supported_reasoning_levels,'reasoning=true with no declared levels must preserve exact native choices');assert.equal(gpt.default_reasoning_level,'high');checks.push('unspecified reasoning levels preserve current native options; a boolean is not an empty effort list');
 assert.equal(gpt.supports_search_tool,false);assert.equal(gpt.support_verbosity,false);assert.equal(gpt.default_verbosity,'low');assert.equal(gpt.auto_compact_token_limit,390000);assert.equal(gpt.effective_context_window_percent,91);assert.ok(!Object.hasOwn(models.find(m=>m.slug==='audit-model'),'auto_compact_token_limit'),'unknown compaction defaults must be derived by the client after user window overrides');assert.equal(gpt.supports_parallel_tool_calls,false,'older Codex catalogs require the field; custom models default to no claimed parallel support');assert.equal(gpt.supports_reasoning_summaries,false,'older Codex catalogs require the field; custom models default to no claimed summary support');
 const rows=await app.rpc('fetchProviderModels',{providerId:'audit',refresh:false});assert.equal(rows.find(m=>m.id==='gpt-audit').codexCompatibility.sources.support_verbosity,'fallback');
 checks.push('relay controls cannot override exact native runtime defaults; custom models publish conservative parallel and summary defaults required by older Codex catalogs');
 stage=1;failDirectory=true;const result=await app.rpc('refreshMetadata',{topics:['capabilities'],revision:101});models=await menu();
 assert.equal(models.find(m=>m.slug==='audit-model').context_window,768000,'new source data must reach the generated client catalog even when provider enumeration fails');assert.deepEqual(models.find(m=>m.slug==='audit-model').input_modalities,['text']);assert.equal(result.status,'partial');assert.ok(result.errors.some(e=>e.includes('503')));checks.push('with the model page closed, source refresh updates an existing validated catalog while preserving the provider-directory error');
 assert.equal((await app.rpc('getProviders')).connections.find(p=>p.id==='audit').codexModel,'gpt-audit');checks.push('source refresh preserves the selected model and provider');
 failDirectory=false;controls=1;await app.rpc('fetchProviderModels',{providerId:'audit',refresh:true});gpt=(await menu()).find(m=>m.slug==='gpt-audit');assert.equal(gpt.supports_search_tool,false);assert.equal(gpt.support_verbosity,false);assert.equal(gpt.auto_compact_token_limit,390000);assert.equal(gpt.effective_context_window_percent,91);
 controls=2;await app.rpc('fetchProviderModels',{providerId:'audit',refresh:true});gpt=(await menu()).find(m=>m.slug==='gpt-audit');assert.equal(gpt.context_window,500000);assert.equal(gpt.auto_compact_token_limit,390000);assert.equal(gpt.supports_search_tool,false);assert.equal(gpt.support_verbosity,false);
 const converted=await app.rpc('fetchProviderModels',{providerId:'audit',refresh:false});assert.equal(converted.find(m=>m.id==='gpt-audit').codexCompatibility.sources.supports_search_tool,'fallback');
 controls=3;await app.rpc('fetchProviderModels',{providerId:'audit',refresh:true});gpt=(await menu()).find(m=>m.slug==='gpt-audit');assert.equal(gpt.supports_search_tool,false);assert.equal(gpt.support_verbosity,false);assert.equal(gpt.effective_context_window_percent,91);
 checks.push('relay capability changes do not alter reference capacity or native thresholds; explicit endpoint changes remain effective');
 const config=join(root,'codex/config.toml');await writeFile(config,'model_auto_compact_token_limit = 250000\nmodel_verbosity = "high"\n'+await readFile(config,'utf8'));
 await app.rpc('fetchProviderModels',{providerId:'audit',refresh:true});const text=await readFile(config,'utf8');assert.match(text,/model_auto_compact_token_limit = 250000/);assert.match(text,/model_verbosity = "high"/);
  const assertUserOverrides=async phase=>{const current=await readFile(config,'utf8');assert.match(current,/model_auto_compact_token_limit = 250000/,`${phase}: preserve explicit compaction`);assert.match(current,/model_verbosity = "high"/,`${phase}: preserve explicit verbosity`);};
 checks.push('catalog refresh preserves explicit user compaction and verbosity configuration');
 let release;heldDirectory=new Promise(resolve=>release=resolve);const observed=new Promise(resolve=>observeDirectory=resolve);
 stage=0;const overlapping=app.rpc('fetchProviderModels',{providerId:'audit',refresh:true});await observed;
 stage=1;await app.rpc('refreshMetadata',{topics:['capabilities'],revision:102});release();const reconciled=await overlapping;
 assert.equal(reconciled.find(m=>m.id==='audit-model').contextWindow,768000);assert.equal((await menu()).find(m=>m.slug==='audit-model').context_window,768000);
  await assertUserOverrides('completed overlapping revision 102 refresh');
 checks.push('a directory fetch overlapping reference refresh consumes current facts instead of reporting a fictitious cache repair');
 failReference=true;const failed=await app.rpc('refreshMetadata',{topics:['capabilities'],revision:103});assert.equal(failed.status,'partial');assert.ok(failed.errors.some(e=>e.includes('503')));assert.equal((await menu()).find(m=>m.slug==='audit-model').context_window,768000);
  await assertUserOverrides('completed failed-source revision 103 refresh');
 await app.stop();app=startNativeRpc(root,['--metadata-test-endpoint',base]);await app.rpc('getState');const offline=await app.rpc('fetchProviderModels',{providerId:'audit',refresh:false});assert.equal(offline.find(m=>m.id==='audit-model').contextWindow,768000);assert.equal(offline.find(m=>m.id==='audit-model').vision,false);assert.equal(offline.find(m=>m.id==='audit-model').capabilitySources.vision,'models.dev');
  await assertUserOverrides('restart and completed offline catalog read');
  const stableConfig=await readFile(config,'utf8');const externalProvider=stableConfig.replace(/^model_provider\s*=.*$/m,'model_provider = "outside"');assert.notEqual(externalProvider,stableConfig);
  await writeFile(config,externalProvider);await assert.rejects(app.rpc('fetchProviderModels',{providerId:'audit',refresh:false}));assert.equal(await readFile(config,'utf8'),externalProvider,'rejected external provider changes retain exact bytes');await writeFile(config,stableConfig);
  checks.push('repeated completed refreshes and restart preserve user overrides; external provider conflicts remain rejected without writes');
 checks.push('failed reference refresh and restart retain the last successful reference instead of falling back to relay capabilities');passed=true;
 console.log(JSON.stringify({passed,checks,directoryCalls,scope:'isolated native RPC and synthetic sources; no real credentials or generation'}));
}finally{await app.stop();server.closeAllConnections();await new Promise(r=>server.close(r));if(passed)await rm(root,{recursive:true,force:true});else console.error('Retained failed fixture: '+root)}
