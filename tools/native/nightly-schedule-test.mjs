import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {mkdtemp,mkdir,writeFile,readFile,rename} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {startNativeRpc} from './rpc-test-session.mjs';
import {nativeTestBinary} from './test-support.mjs';
const root=await mkdtemp(join(tmpdir(),'xwx-nightly-clock-'));
const payload=Buffer.from('isolated update fixture, never executed'.repeat(4096));
const sha=createHash('sha256').update(payload).digest('hex');
let fixture,base;const held=[],heldFeeds=[];
const server=createServer(async(req,res)=>{
 if(req.url==='/release.json'){
  fixture.feeds++;res.writeHead(fixture.offline?503:200,{'content-type':'application/json'});
  const body=JSON.stringify(fixture.offline?{}:{schemaVersion:1,channel:'release',releaseSeries:'native-v1',version:fixture.version,tag:'v'+fixture.version,publishedAt:'2026-10-30T00:00:00Z',files:[{platform:'windows',arch:'x64',kind:'portable',name:'fixture.exe',url:base+'/artifact.exe',size:payload.length,sha256:fixture.badHash?'0'.repeat(64):sha}]});
  if(fixture.holdFeed){heldFeeds.push(()=>res.end(body));return;}res.end(body);return;
 }
 if(req.url==='/artifact.exe'){fixture.artifacts++;res.end(payload);return;}
 if(req.url==='/v1/responses'){
  for await(const _ of req){}
  if(fixture.hold){res.writeHead(200,{'content-type':'text/event-stream'});res.write('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"pending"}\n\n');held.push(res);return;}
  res.setHeader('content-type','application/json');res.end(JSON.stringify({id:'nightly',object:'response',status:'completed',output:[],usage:{input_tokens:1,output_tokens:1}}));return;
 }
 res.writeHead(404);res.end();
});server.listen(0,'127.0.0.1');await once(server,'listening');base='http://127.0.0.1:'+server.address().port;
process.env.XWX_DECK_UPDATE_SERVER_URL=base;process.env.XWX_DECK_TEST_UPDATE_FEED_URL=base;
const checks=[];const delay=ms=>new Promise(r=>setTimeout(r,ms));
const wait=async(fn,label)=>{for(let n=0;n<160;n++){if(await fn())return;await delay(50);}throw Error(label);};
const events=async dir=>{const raw=await readFile(join(dir,'nightly-test-events.jsonl'),'utf8').catch(()=> '');return raw.split('\n').filter(Boolean).flatMap(line=>{try{return[JSON.parse(line)];}catch{return[];}});};
const handoffs=async dir=>(await events(dir)).filter(x=>x.handoff);
async function scenario(name,run){
 const dir=join(root,name);await mkdir(dir);await writeFile(join(dir,'.xwx-rust-pilot'),'isolated-rust-pilot-v1\n');
 let clock={elapsedMs:0,hour:1,idleMs:0};const file=join(dir,'update-test-clock.json');await writeFile(file,JSON.stringify(clock));
 const setClock=async patch=>{clock={...clock,...patch};await writeFile(file+'.tmp',JSON.stringify(clock));await rename(file+'.tmp',file);};
 fixture={feeds:0,artifacts:0,version:'0.0.0',offline:false,badHash:false,hold:false};
 let app=startNativeRpc(dir,['--test-nightly-clock',file]);const current=(await app.rpc('getUpdateState')).currentVersion;
 const parts=current.split('.').map(Number);fixture.version=[parts[0],parts[1],parts[2]+1].join('.');
 const nextVersion=()=>fixture.version=[parts[0],parts[1],parts[2]+2].join('.');
 const discover=async patch=>{await setClock({elapsedMs:6000,...patch});await wait(async()=>fixture.feeds>0,'scheduled feed check');};
 const blocked=async()=>{await delay(400);assert.equal(fixture.artifacts,0);assert.equal((await handoffs(dir)).length,0);};
 const plan=async()=>{await wait(async()=>(await handoffs(dir)).length===1,'scheduled update handoff');assert.equal(fixture.artifacts,1);const e=(await handoffs(dir))[0];assert.equal(e.handoff.targetVersion,fixture.version);assert.equal(e.handoff.status,'ready');};
 try{await run({dir,get app(){return app;},setClock,discover,blocked,plan,current,nextVersion,restart:async()=>{await app.stop();app=startNativeRpc(dir,['--test-nightly-clock',file]);await app.rpc('getUpdateState');}});checks.push(name);console.log('PASS nightly '+name);}
 finally{for(const finish of heldFeeds.splice(0))finish();for(const res of held.splice(0))res.end('event: response.completed\ndata: {"type":"response.completed","response":{"id":"done","status":"completed","output":[]}}\n\n');await app.stop();}
}
try{
 await scenario('startup-delay-and-02-hour-boundary',async t=>{await t.setClock({elapsedMs:5999,hour:2,idleMs:900000});await delay(400);assert.equal(fixture.feeds,0);await t.discover({hour:1,idleMs:900000});await t.blocked();await t.setClock({hour:2});await t.plan();});
 await scenario('05-hour-is-outside-window',async t=>{await t.discover({hour:5,idleMs:900000});await t.blocked();await t.setClock({hour:4});await t.plan();});
 await scenario('15-minute-idle-threshold',async t=>{await t.discover({hour:2,idleMs:899999});await t.blocked();await t.setClock({idleMs:900000});await t.plan();});
 await scenario('automatic-opt-out-then-explicit-enable',async t=>{await t.app.rpc('setAutomaticUpdates',false);await t.discover({hour:2,idleMs:900000});await t.blocked();await t.app.rpc('setAutomaticUpdates',true);await t.plan();});
 await scenario('cancelled-version-persists-across-restart',async t=>{await t.discover({hour:1,idleMs:900000});await t.app.rpc('cancelUpdate');await t.setClock({hour:2});await t.blocked();await t.restart();await t.blocked();assert.equal(JSON.parse(await readFile(join(t.dir,'declined-update.json'),'utf8')).version,fixture.version);t.nextVersion();await t.setClock({elapsedMs:1806000});await t.plan();});
 await scenario('active-trace-and-inflight-request-block-handoff',async t=>{await t.app.rpc('updateCodexEnhancements',{preserveOfficialLogin:false});const p=await t.app.rpc('saveProvider',{displayName:'Nightly_Fixture',baseUrl:base+'/v1',bearerToken:'synthetic-nightly-key',adapter:'responses',codexModel:'fixture'});await t.app.rpc('switchClientProvider',{client:'codex',providerId:p.connections.at(-1).id});const tracing=await t.app.rpc('toggleTracing',true);fixture.hold=true;const response=await fetch(tracing.localBaseUrl+'/v1/responses',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:'fixture',input:'isolated busy test',stream:true})});const reader=response.body.getReader();await reader.read();assert.equal((await t.app.rpc('getState')).activeRequests,1);await t.discover({hour:2,idleMs:900000});await t.blocked();for(const res of held.splice(0))res.end('event: response.completed\ndata: {"type":"response.completed","response":{"id":"done","status":"completed","output":[]}}\n\n');while(!(await reader.read()).done){}await t.app.rpc('toggleTracing',false);await t.plan();});
 await scenario('manual-ready-download-is-retained-before-window',async t=>{await t.discover({hour:1,idleMs:900000});await t.app.rpc('downloadUpdate');await wait(async()=>(await t.app.rpc('getUpdateState')).status==='ready','manual ready');const ready=await t.app.rpc('getUpdateState');const count=fixture.feeds;await t.setClock({elapsedMs:1806000});await delay(400);assert.equal((await t.app.rpc('getUpdateState')).downloadPath,ready.downloadPath);assert.equal(fixture.feeds,count);assert.equal((await handoffs(t.dir)).length,0);await t.setClock({hour:2});await t.plan();});
 await scenario('periodic-refresh-after-up-to-date',async t=>{fixture.version=t.current;await t.discover({hour:2,idleMs:900000});await wait(async()=>(await t.app.rpc('getUpdateState')).status==='up-to-date','initial current version');const count=fixture.feeds;t.nextVersion();await t.setClock({elapsedMs:1805999});await delay(400);assert.equal(fixture.feeds,count);await t.setClock({elapsedMs:1806000});await t.plan();});
 await scenario('periodic-recovery-after-network-failure',async t=>{fixture.offline=true;await t.discover({hour:2,idleMs:900000});await wait(async()=>(await t.app.rpc('getUpdateState')).status==='error','network error');await t.blocked();fixture.offline=false;await t.setClock({elapsedMs:1806000});await t.plan();});
 await scenario('bad-checksum-never-hands-off',async t=>{fixture.badHash=true;await t.discover({hour:2,idleMs:900000});await wait(async()=>(await t.app.rpc('getUpdateState')).status==='error','checksum rejection');assert.equal((await handoffs(t.dir)).length,0);assert.equal(fixture.artifacts,1);});
 await scenario('cancelled-check-does-not-commit-a-late-manifest',async t=>{fixture.holdFeed=true;await t.discover({hour:2,idleMs:900000});await wait(async()=>(await t.app.rpc('getUpdateState')).status==='checking','held check');await t.app.rpc('cancelUpdate');const choice=await t.app.rpc('getUpdateState');fixture.holdFeed=false;for(const finish of heldFeeds.splice(0))finish();await delay(500);assert.deepEqual(await t.app.rpc('getUpdateState'),choice);await t.blocked();});
 const missing=spawnSync(nativeTestBinary,['--rpc','--test-nightly-clock',join(root,'outside.json')],{encoding:'utf8',windowsHide:true});assert.equal(missing.status,2);checks.push('clock-hook-cannot-run-without-isolated-root');
 const result={passed:true,checks,root,binarySha256:createHash('sha256').update(await readFile(nativeTestBinary)).digest('hex'),systemClockChanged:false,foregroundUsed:false,scope:'Production scheduling function runs on an isolated RPC timer with controlled elapsed time, local hour and idle duration. Actual installer execution is replaced only at the isolated test handoff; physical replacement and main-window readiness are covered separately.'};
 await writeFile(join(root,'summary.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
