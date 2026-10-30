import{editionBuild}from'./edition/build.mjs';
import assert from 'node:assert/strict';
import {runNightlyCases,runManualRecovery} from './macos-nightly-recovery-cases.mjs';
import{readFile,writeFile,mkdir,readdir,stat,realpath,copyFile}from'node:fs/promises';
import{spawn,spawnSync,execFileSync}from'node:child_process';
import{createHash}from'node:crypto';import{resolve,join}from'node:path';import{createWriteStream}from'node:fs';
if(process.platform!=='darwin')throw Error('Native macOS acceptance host required');
if(!process.argv[2])throw Error('Explicit temporary fixture directory required');
const base=await realpath(resolve(process.argv[2]));
const binaryName=editionBuild.nativeBinary;
if(!base.startsWith('/private/tmp/'))throw Error('Runtime App and data must use /private/tmp to avoid broad Documents TCC permissions');
const fixture=JSON.parse(await readFile(join(base,'fixture.json'),'utf8'));
assert.equal(fixture.root,base);assert.equal(new URL(fixture.base).hostname,'127.0.0.1');
const env={...process.env,CARGO_NET_OFFLINE:'true',XWX_UPDATE_VALIDATION_ID:fixture.id,XWX_UPDATE_VALIDATION_FEED:fixture.base,XWX_UPDATE_VALIDATION_TRUST:JSON.stringify(fixture.trust),XWX_UPDATE_VALIDATION_CA:await readFile(join(base,'ca.pem'),'utf8')};
const report={startedAt:new Date().toISOString(),fixture:{base:fixture.base,id:fixture.id,caSha256:fixture.caSha256,productionKeyUsed:false,systemTrustChanged:false},builds:[],cases:[],passed:false};
const save=()=>writeFile(join(base,'acceptance.json'),JSON.stringify(report,null,2)+'\n');
const hash=b=>createHash('sha256').update(b).digest('hex');const sha=async p=>hash(await readFile(p));
const normalApp='/Applications/XwX Deck.app';const normalName=execFileSync('/usr/libexec/PlistBuddy',['-c','Print :CFBundleExecutable',normalApp+'/Contents/Info.plist'],{encoding:'utf8'}).trim();const normal=join(normalApp,'Contents/MacOS',normalName);report.normalBefore=await sha(normal);await save();
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function wait(fn,label,timeout=180000){const began=Date.now();while(Date.now()-began<timeout){const v=await fn();if(v)return v;await pause(200);}throw Error('Timed out: '+label);}
function alive(pid){try{process.kill(pid,0);return true;}catch{return false;}}
async function command(cmd,args,logName){
 const out=createWriteStream(join(base,logName));console.log(JSON.stringify({stage:logName,at:new Date().toISOString()}));
 await new Promise((res,rej)=>{const p=spawn(cmd,args,{env,stdio:['ignore','pipe','pipe']});let line='';p.stdout.on('data',d=>{out.write(d);line+=d;const lines=line.split('\n');line=lines.pop();for(const s of lines)if(/Submitting to Apple|Apple upload complete|Native app:|Native disk image:|Finished|Error:|error:/.test(s))console.log(s.slice(0,500));});p.stderr.on('data',d=>out.write(d));p.on('error',rej);p.on('exit',(code,signal)=>{out.end();code===0?res():rej(Error(logName+' failed: '+code+'/'+signal));});});
}
async function tree(directory){const entries=[];async function walk(p,rel=''){for(const name of(await readdir(p)).sort()){const path=join(p,name),r=rel?rel+'/'+name:name;const m=await stat(path);if(m.isDirectory())await walk(path,r);else if(!r.endsWith('-shm')&&!r.endsWith('-wal'))entries.push({path:r,bytes:m.size,sha256:await sha(path)});}}await walk(directory);return entries;}
try{
 const buildsFrom=process.argv.find(a=>a.startsWith('--builds-from='))?.slice(14);
 for(const version of ['0.9.9','1.0.0']){
  const output=join(buildsFrom?resolve(buildsFrom):base,'apps','build-'+version);
  if(!buildsFrom){await mkdir(output,{recursive:true});await command(process.execPath,['tools/native/build.mjs','--pilot','--signed','--update-validation','--validation-version='+version,'--output-directory='+output], 'build-'+version+'.log');}
  else console.log(JSON.stringify({stage:'reuse-exact-signed-build',version,source:output}));
  const build=JSON.parse(await readFile(join(output,'native-build-report.json'),'utf8'));assert.equal(build.version,version);assert.equal(build.validationOnly,true);assert.equal(build.notarized,true);assert.equal(build.candidate.signatureVerified,true);assert.equal(await sha(build.candidate.binary),build.candidate.binarySha256);assert.equal(await sha(build.candidate.dmg),build.candidate.dmgSha256);
  report.builds.push(build);await save();
 }
 const [baseline,target]=report.builds;
 const good=target.candidate.dmg,invalid=join(base,'invalid-platform-signature.dmg');await copyFile(good,invalid);const bytes=await readFile(invalid);bytes[bytes.length-100]^=1;await writeFile(invalid,bytes);
 await writeFile(join(buildsFrom?resolve(buildsFrom):base,'artifacts.json'),JSON.stringify({good:{path:good,bytes:(await stat(good)).size,sha256:await sha(good)},invalid:{path:invalid,bytes:bytes.length,sha256:hash(bytes)}},null,2));
 // A signed validation executable must reject a data directory outside its task
 // before loading settings, credentials, Trace or the native GUI.
 const escape=join(base,'rejected-data');await mkdir(escape,{recursive:true});const rejected=spawnSync(baseline.candidate.app+'/Contents/MacOS/'+binaryName,['--pilot-root',escape],{env,encoding:'utf8',timeout:15000});assert.equal(rejected.status,2);assert.deepEqual(await readdir(escape),[]);report.escapeGuardPassed=true;await save();
 for(const name of ['success','health-timeout']){
  const directory=join(base,'apps',name),data=join(base,'data',name);await mkdir(directory,{recursive:true});await mkdir(data,{recursive:true});
  const app=join(directory,'XwXDeck Rust Validation.app');await command('/usr/bin/ditto',[baseline.candidate.app,app],'stage-'+name+'.log');
  await writeFile(join(data,'.xwx-rust-pilot'),'isolated-rust-pilot-v1\n');await writeFile(join(data,'retained-document.txt'),'Synthetic update data 正文😀\n'.repeat(256));
  const sentinel=await sha(join(data,'retained-document.txt'));if(name==='health-timeout')await writeFile(join(data,'fail-new-startup'),'withhold-ready');
  const log=createWriteStream(join(base,'app-'+name+'.log'));const child=spawn(app+'/Contents/MacOS/'+binaryName,['--pilot-root',data,'--smoke','--smoke-macos-update'],{env,stdio:['ignore','pipe','pipe']});child.stdout.pipe(log,{end:false});child.stderr.pipe(log,{end:false});
  let newPid;try{
   console.log(JSON.stringify({stage:'real-client-'+name,pid:child.pid,app,data}));
   const checkpoint=await wait(async()=>{let x;try{x=JSON.parse(await readFile(join(data,'update-validation-checkpoint.json'),'utf8'));}catch{return null;}if(x.phase==='error')throw Error(JSON.stringify(x));return x.phase==='install-requested'?x:null;},'client checks/download/install request');
   const historyBefore=await tree(join(data,'traces'));assert.ok(historyBefore.length>0);
   await wait(()=>child.exitCode!==null,'original App exit');assert.equal(child.exitCode,0);
   const result=await wait(async()=>{try{return JSON.parse(await readFile(join(data,'updates/macos-install-result.json'),'utf8'));}catch{return null;}},'signed helper completion',180000);
   if(name==='success' && result.status!=='completed')throw Error('Actual helper failed: '+result.error);
   const marker=JSON.parse(await readFile(join(data,'macos-update-restarted.json'),'utf8'));newPid=marker.pid;
   const restarted=await wait(async()=>{try{const x=JSON.parse(await readFile(join(data,'update-validation-checkpoint.json'),'utf8'));if(x.phase==='error')throw Error(JSON.stringify(x));return x.phase==='restarted'?x:null;}catch(e){if(e.code==='ENOENT')return null;throw e;}},'target actual renderer and data state');
   assert.equal(restarted.passed,true);assert.equal(await sha(app+'/Contents/MacOS/'+binaryName),target.candidate.binarySha256);
   assert.equal(await sha(join(data,'retained-document.txt')),sentinel);assert.deepEqual(await tree(join(data,'traces')),historyBefore);
   assert.equal(await sha(result.backupApplication+'/Contents/MacOS/'+binaryName),baseline.candidate.binarySha256);assert.equal(result.backupRetained,true);assert.equal(result.rollbackPerformed,false);assert.ok(alive(newPid));
   if(name==='success'){assert.equal(result.status,'completed');assert.equal(result.startupVerified,true);assert.equal(result.startupPid,newPid);}else{assert.equal(result.status,'error');assert.equal(result.startupVerified,false);assert.equal(result.dataAccessGranted,true);assert.equal(result.manualRecoveryRequired,true);assert.match(result.error,/超时|timed out|Resource temporarily unavailable/);}
   report.cases.push({name,passed:true,clientChecks:checkpoint.checks,negativeResults:checkpoint.negativeResults,restartedChecks:restarted.checks,result,originalPid:child.pid,restartedPid:newPid,actualTargetSha256:await sha(app+'/Contents/MacOS/'+binaryName),sentinelSha256:sentinel,historyFiles:historyBefore});await save();console.log(JSON.stringify({case:name,passed:true,checks:checkpoint.checks.length,resultStatus:result.status,startupVerified:result.startupVerified}));
  }finally{
   // Cleanup only PIDs created by this test and still running the exact isolated
   // executable. This occurs after the no-forced-exit product assertion.
   const owned=new Set([child.pid,newPid].filter(Boolean));
   // LaunchServices re-parents a new process; discover only this exact owned
   // test executable if startup failed before it could write its PID marker.
   for(const line of execFileSync('/bin/ps',['-axo','pid=,comm='],{encoding:'utf8'}).split('\n')){const match=line.trim().match(/^(\d+)\s+(.*)$/);if(match?.[2]===app+'/Contents/MacOS/'+binaryName)owned.add(Number(match[1]));}
   for(const pid of owned)if(pid&&alive(pid)){
    const path=execFileSync('/bin/ps',['-p',String(pid),'-o','comm='],{encoding:'utf8'}).trim();
    assert.equal(path,app+'/Contents/MacOS/'+binaryName);process.kill(pid,'SIGTERM');
   }
   log.end();
  }
 }
 report.nightly=await runNightlyCases({base,baseline,target,env,fixture,command,wait,sha,tree,binaryName});await save();
 report.manualRecovery=await runManualRecovery({base,baseline,target,env,report,command,wait,sha,tree,binaryName});await save();
 report.normalAfter=await sha(normal);assert.equal(report.normalAfter,report.normalBefore);report.normalInstallUnchanged=true;report.passed=true;report.finishedAt=new Date().toISOString();await save();console.log(JSON.stringify({passed:true,report:join(base,'acceptance.json'),cases:report.cases.length,normalInstallUnchanged:true}));
}catch(error){report.error=String(error);report.failedAt=new Date().toISOString();await save();console.error(String(error));process.exitCode=1;}
