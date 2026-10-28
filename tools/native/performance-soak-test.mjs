// Full native process-tree soak. A short run can validate the harness but never passes the release gate.
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {createServer} from 'node:http';
import {readFile,writeFile,mkdtemp,mkdir,cp,readdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {verifyCandidate} from './source-fingerprint.mjs';
assert.equal(process.platform,'win32','Windows native process-tree sampler required');
const binary=resolve(process.env.XWX_NATIVE_TEST_BINARY||'release/XwX Deck.exe');
const build=JSON.parse(await readFile(process.env.XWX_NATIVE_TEST_BUILD_REPORT||'release/native-build-report.json','utf8'));
const provenance=await verifyCandidate({root:resolve('.'),report:build,binary,allowManualAcceptance:true});
const duration=Number(process.env.XWX_SOAK_DURATION_MS||3600000);
assert.ok(Number.isFinite(duration)&&duration>=60000);
const output=resolve(process.env.XWX_SOAK_OUTPUT||join(tmpdir(),'xwx-performance-'+Date.now()));await mkdir(output,{recursive:true});
const root=await mkdtemp(join(tmpdir(),'xwx-soak-'));await writeFile(join(root,'.xwx-rust-pilot'),'isolated-rust-pilot-v1\n');
const history=process.env.XWX_SOAK_HISTORY;
if(history){
  await cp(history,join(root,'traces'),{recursive:true});
  const file=join(root,'traces/index.json');const index=JSON.parse(await readFile(file,'utf8'));
  for(const session of index.sessions||[])if(session.jsonlPath)session.jsonlPath=join(root,'traces',session.jsonlPath.split(/[\\/]/).at(-1));
  await writeFile(file,JSON.stringify(index));
}
const installations=join(root,'installations');await mkdir(join(installations,'.local/bin'),{recursive:true});
for(const name of ['codex','claude'])await writeFile(join(installations,'.local/bin',name+'.cmd'),'isolated installed-client fixture');
let requests=0,requestBytes=0,child,sampler,stderr='';
const responseText='Synthetic performance response. '.repeat(35000);
const upstream=createServer(async(req,res)=>{
  if(req.url==='/v1/models'){res.setHeader('content-type','application/json');res.end('{"data":[{"id":"pilot-model"}]}');return;}
  for await(const bytes of req)requestBytes+=bytes.length;
  requests++;res.writeHead(200,{'content-type':'text/event-stream'});
  res.end('event: response.completed\ndata: '+JSON.stringify({type:'response.completed',response:{id:'soak-'+requests,object:'response',status:'completed',model:'pilot-model',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:responseText}]}],usage:{input_tokens:100,output_tokens:5,total_tokens:105,input_tokens_details:{cached_tokens:60,cache_write_tokens:20}}}})+'\n\n');
});
upstream.listen(0,'127.0.0.1');await once(upstream,'listening');
const env={...process.env,XWX_SYSTEM_LANGUAGE_TEST:'zh-CN',XWX_CLIENT_INSTALLATIONS_TEST_HOME:installations,XWX_DECK_TEST_SECURE_STORE:'1'};
try{
  for(const [method,args]of [
    ['saveProvider',[{displayName:'Soak_Fixture',baseUrl:'http://127.0.0.1:'+upstream.address().port+'/v1',bearerToken:'isolated-soak-key',adapter:'responses',codexModel:'pilot-model'}]],
    ['switchClientProvider',[{client:'codex',providerId:'Soak_Fixture'}]]
  ]){
    const result=spawnSync(binary,['--rpc','--pilot-root',root],{env,encoding:'utf8',input:JSON.stringify({method,args})+'\n',timeout:120000});
    assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout.trim()).ok,true,result.stdout);
  }
  const copiedSessions=history?JSON.parse(await readFile(join(root,'traces/index.json'),'utf8')).sessions.length:0;
  await writeFile(join(output,'run.json'),JSON.stringify({root,binary,duration,startedAt:new Date().toISOString(),copiedSessions,...provenance},null,2));
  child=spawn(binary,['--pilot-root',root,'--smoke','--smoke-performance','--smoke-duration-ms',String(duration),'--smoke-exit'],{env,stdio:['ignore','ignore','pipe']});
  child.stderr.on('data',bytes=>{stderr=(stderr+bytes).slice(-20000);});
  sampler=spawn('pwsh',['-NoProfile','-File',resolve('tools/native/performance-sample.ps1'),'-TaskProcessId',String(child.pid),'-Root',root,'-OutputPath',join(output,'samples.jsonl')],{windowsHide:true,stdio:['ignore','ignore','pipe']});
  let sampleError='';sampler.stderr.on('data',bytes=>sampleError+=bytes);
  let report;const deadline=Date.now()+duration+180000;
  while(Date.now()<deadline){
    report=await readFile(join(root,'native-smoke.json'),'utf8').then(JSON.parse,()=>null);
    if(report)break;
    if(child.exitCode!==null)throw Error('Native host exited: '+stderr);
    await new Promise(resolve=>setTimeout(resolve,1000));
  }
  assert.ok(report,'soak report timeout');await writeFile(join(output,'native.json'),JSON.stringify(report,null,2));
  await writeFile(join(output,'stderr.log'),stderr);
  assert.equal(report.passed,true,JSON.stringify(report));
  if(child.exitCode===null){const exit=await Promise.race([once(child,'exit'),new Promise(resolve=>setTimeout(()=>resolve(null),20000))]);assert.ok(exit,'native host did not exit');}
  if(sampler.exitCode===null)await Promise.race([once(sampler,'exit'),new Promise(resolve=>setTimeout(resolve,25000))]);
  assert.equal(sampler.exitCode,0,sampleError);assert.equal(child.exitCode,0,stderr);
  const samples=(await readFile(join(output,'samples.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line.replace(/^\uFEFF/,'')));
  const native=sample=>sample.processes.find(process=>process.native);
  const live=samples.filter(sample=>native(sample));
  const median=values=>values.toSorted((a,b)=>a-b)[Math.floor(values.length/2)]||0;
  const baseline=live.filter(sample=>sample.phase==='baseline-idle').slice(-6);
  const final=live.filter(sample=>sample.phase==='final-idle').slice(-12);
  const tray=live.filter(sample=>sample.phase==='final-tray').slice(-12);
  assert.ok(baseline.length>=2&&final.length>=2,'both full idle windows were sampled');
  assert.ok(tray.length>=2,'tray idle was sampled');
  const cpu=[];for(let n=1;n<final.length;n++)cpu.push((final[n].tree.cpuSeconds-final[n-1].tree.cpuSeconds)/(final[n].elapsedSeconds-final[n-1].elapsedSeconds)*100);
  const trayCpu=tray.slice(1).map((sample,n)=>(sample.tree.cpuSeconds-tray[n].tree.cpuSeconds)/(sample.elapsedSeconds-tray[n].elapsedSeconds)*100);
  const groups=rows=>Object.fromEntries(['native','renderer','gpu','browser','utility'].map(kind=>[kind,median(rows.map(sample=>sample.processes.filter(process=>process.kind===kind).reduce((sum,process)=>sum+process.privateBytes,0)))]));
  const metrics={samples:samples.length,liveSeconds:live.at(-1).elapsedSeconds-live[0].elapsedSeconds,requests,requestBytes,responseBytes:Buffer.byteLength(responseText),
    peakTreePrivate:Math.max(...live.map(sample=>sample.tree.privateBytes)),peakNativePrivate:Math.max(...live.map(sample=>native(sample).privateBytes)),
    baselineTreePrivate:median(baseline.map(sample=>sample.tree.privateBytes)),finalTreePrivate:median(final.map(sample=>sample.tree.privateBytes)),
    finalTrayPrivate:median(tray.map(sample=>sample.tree.privateBytes)),finalTrayWorking:median(tray.map(sample=>sample.tree.workingBytes)),
    finalIdleGroups:groups(final),finalTrayGroups:groups(tray),finalTrayCpuOneCorePercent:trayCpu.reduce((sum,value)=>sum+value,0)/trayCpu.length,
    nativePrivateGrowth:median(final.map(sample=>native(sample).privateBytes))-median(baseline.map(sample=>native(sample).privateBytes)),
    treeHandleGrowth:median(final.map(sample=>sample.tree.handles))-median(baseline.map(sample=>sample.tree.handles)),
    nativeHandleGrowth:median(final.map(sample=>native(sample).handles))-median(baseline.map(sample=>native(sample).handles)),
    nativeThreadGrowth:median(final.map(sample=>native(sample).threads))-median(baseline.map(sample=>native(sample).threads)),
    finalIdleCpuOneCorePercent:cpu.reduce((sum,value)=>sum+value,0)/cpu.length,
    remainingProcessesAfterExit:samples.at(-1).processes.length};
  const latency=Object.fromEntries(Object.entries(report.timings||{}).map(([name,values])=>{const sorted=values.toSorted((a,b)=>a-b);return [name,{count:sorted.length,medianMs:median(sorted),p95Ms:sorted[Math.floor(sorted.length*.95)],maxMs:sorted.at(-1)}];}));
  const viewerTimes=report.timings.viewerMs, segment=Math.max(1,Math.floor(viewerTimes.length/3));
  metrics.viewerEarlyMedianMs=median(viewerTimes.slice(0,segment));
  metrics.viewerLateMedianMs=median(viewerTimes.slice(-segment));
  const gates={nativeScenario:report.passed===true,longDuration:report.elapsedMs>=3600000&&metrics.liveSeconds>=3590,
    exercised:report.operations.cycles>=200&&report.operations.detailReads>=800&&report.operations.comparisons>=200&&requests===report.operations.requests,
    memoryPeak:metrics.peakTreePrivate<1024**3,memoryReleased:metrics.finalTreePrivate-metrics.baselineTreePrivate<=128*1024**2&&metrics.nativePrivateGrowth<=64*1024**2,
    handlesReleased:metrics.treeHandleGrowth<=500&&metrics.nativeHandleGrowth<=150,threadsReleased:metrics.nativeThreadGrowth<=32,
    idleCpu:metrics.finalIdleCpuOneCorePercent<=5,trayIdle:metrics.finalTrayCpuOneCorePercent<=5&&metrics.finalTrayPrivate-metrics.baselineTreePrivate<=128*1024**2,noOrphans:metrics.remainingProcessesAfterExit===0,
    operationLatency:latency.requestMs.p95Ms<=500&&latency.viewerMs.p95Ms<=8000&&latency.reopenMs.p95Ms<=150,
    viewerScaling:metrics.viewerLateMedianMs<=metrics.viewerEarlyMedianMs*1.5+500};
  const result={passed:Object.values(gates).every(Boolean),gates,metrics,latency,operations:report.operations,provenance,scope:'Windows native host plus all descendant WebView/GPU processes; isolated configuration and synthetic 1 MiB responses; real upstream and other platforms separate'};
  await writeFile(join(output,'summary.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({output,root,...result},null,2));assert.equal(result.passed,true,'performance release gate failed');
}finally{
  if(child?.exitCode===null){child.kill();await once(child,'exit');}
  if(sampler?.exitCode===null)sampler.kill();
  upstream.closeAllConnections();await new Promise(resolve=>upstream.close(resolve));
}
