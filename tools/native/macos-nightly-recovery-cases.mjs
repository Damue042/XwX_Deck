import assert from'node:assert/strict';import{spawn,spawnSync,execFileSync}from'node:child_process';import{readFile,writeFile,mkdir,rename,readdir,lstat,copyFile}from'node:fs/promises';import{join}from'node:path';import{createWriteStream}from'node:fs';import{createInterface}from'node:readline';import{once}from'node:events';
export async function runNightlyCases({base,baseline,target,env,fixture,command,wait,sha,tree,binaryName}){
 const results=[];
 const alive=pid=>{try{process.kill(pid,0);return true;}catch{return false;}};
 for(const mode of ['gates','stage-deferral','install','periodic-current','periodic-failure']){
  const app=join(base,'apps','nightly-'+mode,'XwXDeck Rust Validation.app'),data=join(base,'data','nightly-'+mode);await mkdir(join(app,'..'),{recursive:true});await mkdir(data,{recursive:true});await command('/usr/bin/ditto',[baseline.candidate.app,app],'nightly-stage-'+mode+'.log');
  await writeFile(join(data,'.xwx-rust-pilot'),'isolated-rust-pilot-v1\n');await writeFile(join(data,'night-clock.json'),JSON.stringify({hour:12,idleSeconds:3600,...(mode.startsWith('periodic-')?{elapsedMs:0}:{})}));await writeFile(join(data,'night-scenario.json'),JSON.stringify({mode,modelBase:fixture.modelBase}));await writeFile(join(data,'retained-document.txt'),'Nightly retained document 正文😀\n');const sentinel=await sha(join(data,'retained-document.txt'));
  const log=createWriteStream(join(base,'nightly-'+mode+'.log')),child=spawn(app+'/Contents/MacOS/'+binaryName,['--pilot-root',data,'--smoke','--smoke-nightly-update'],{env,stdio:['ignore','pipe','pipe']});child.stdout.pipe(log,{end:false});child.stderr.pipe(log,{end:false});let newPid;
  try{
   console.log(JSON.stringify({stage:'actual-nightly-loop',mode,pid:child.pid}));
   const checkpoint=await wait(async()=>{try{const x=JSON.parse(await readFile(join(data,'update-validation-checkpoint.json'),'utf8'));if(x.phase==='error')throw Error(JSON.stringify(x));return x.phase===(mode.startsWith('periodic-')?'nightly-periodic-passed':{gates:'nightly-gates-passed','stage-deferral':'nightly-stage-deferred',install:'nightly-armed'}[mode])?x:null;}catch(e){if(e.code==='ENOENT')return null;throw e;}},'nightly '+mode,180000);
   const before=await tree(join(data,'traces'));
   let installed;
   if(mode==='install'){
    await wait(()=>child.exitCode!==null,'nightly original exit');assert.equal(child.exitCode,0);
    installed=await wait(async()=>{try{return JSON.parse(await readFile(join(data,'updates/macos-install-result.json'),'utf8'));}catch{return null;}},'nightly helper completion');assert.equal(installed.status,'completed');assert.equal(installed.startupVerified,true);newPid=installed.startupPid;assert.ok(alive(newPid));
    const restarted=await wait(async()=>{try{const x=JSON.parse(await readFile(join(data,'update-validation-checkpoint.json'),'utf8'));if(x.phase==='error')throw Error(JSON.stringify(x));return x.phase==='restarted'?x:null;}catch(e){if(e.code==='ENOENT')return null;throw e;}},'nightly new renderer');assert.equal(restarted.passed,true);assert.equal(await sha(app+'/Contents/MacOS/'+binaryName),target.candidate.binarySha256);assert.deepEqual(await tree(join(data,'traces')),before);
   }else{
    assert.ok(alive(child.pid));assert.equal(await sha(app+'/Contents/MacOS/'+binaryName),baseline.candidate.binarySha256);
    await assert.rejects(readFile(join(data,'updates/macos-install-result.json')),{code:'ENOENT'});
    if(mode==='stage-deferral')assert.equal((await readdir(join(app,'..'))).filter(n=>n.startsWith('.xwx-update-')).length,0);
   }
   assert.equal(await sha(join(data,'retained-document.txt')),sentinel);
   const polls=(await readFile(join(data,'night-polls.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);assert.ok(polls.length>=2);if(mode==='install')assert.ok(polls.some(p=>p.status==='ready'&&p.clock[0]===3&&p.clock[1]===900));
   const result={mode,passed:true,checks:checkpoint.checks,pollCount:polls.length,polls,install:installed??null,systemTimeChanged:false,testClockOnly:true,actualAppSha256:await sha(app+'/Contents/MacOS/'+binaryName),historyFiles:before};results.push(result);await writeFile(join(base,'nightly-results.json'),JSON.stringify(results,null,2));console.log(JSON.stringify({nightlyCase:mode,passed:true,polls:polls.length}));
  }finally{
   const pids=new Set([child.pid,newPid].filter(Boolean));for(const line of execFileSync('/bin/ps',['-axo','pid=,comm='],{encoding:'utf8'}).split('\n')){const m=line.trim().match(/^(\d+)\s+(.*)$/);if(m?.[2]===app+'/Contents/MacOS/'+binaryName)pids.add(Number(m[1]));}
   for(const pid of pids)if(alive(pid)){assert.equal(execFileSync('/bin/ps',['-p',String(pid),'-o','comm='],{encoding:'utf8'}).trim(),app+'/Contents/MacOS/'+binaryName);process.kill(pid,'SIGTERM');}log.end();
  }
 }
 return results;
}
async function regularSnapshot(root,sha){const entries=[];async function walk(dir,rel=''){for(const n of(await readdir(dir)).sort()){const p=join(dir,n),r=rel?rel+'/'+n:n,m=await lstat(p);assert.equal(m.isSymbolicLink(),false,'Data copy must not follow symlinks');if(m.isDirectory())await walk(p,r);else if(m.isFile())entries.push({path:r,sha256:await sha(p)});}}await walk(root);return entries;}
async function copyRegular(source,destination){await mkdir(destination,{recursive:true});for(const n of await readdir(source)){const a=join(source,n),b=join(destination,n),m=await lstat(a);assert.equal(m.isSymbolicLink(),false);if(m.isDirectory())await copyRegular(a,b);else if(m.isFile())await copyFile(a,b);}}
export async function runManualRecovery({base,baseline,target,env,report,command,wait,sha,tree,binaryName}){
 const success=report.cases.find(c=>c.name==='success');const sourceData=join(base,'data','preserved-new-data'),data=join(base,'data','success'),directory=join(base,'apps','manual-recovery'),app=join(directory,'XwXDeck Rust Validation.app'),keptNew=join(directory,'retained-new-1.0.0.app');
 const original=await regularSnapshot(data,sha);await rename(data,sourceData);await copyRegular(sourceData,data);await mkdir(directory,{recursive:true});await command('/usr/bin/ditto',[join(base,'apps/success/XwXDeck Rust Validation.app'),app],'manual-stage-new.log');assert.equal(await sha(app+'/Contents/MacOS/'+binaryName),target.candidate.binarySha256);
 for(const path of [app,success.result.backupApplication]){await command('/usr/bin/codesign',['--verify','--deep','--strict',path],'manual-verify-'+(path===app?'new':'old')+'.log');await command('/usr/sbin/spctl',['--assess','--type','execute',path],'manual-system-'+(path===app?'new':'old')+'.log');}
 await writeFile(join(base,'manual-recovery-plan.json'),JSON.stringify({risk:'Older applications may not understand data migrated by a newer implementation. This fixture uses one storage implementation with different bundle versions; it proves only this format. Never downgrade the original data in place.',originalData:sourceData,recoveryDataCopy:data,copyUsesOriginalPathForAbsoluteIndexReferences:true,preserveNewApplication:keptNew,automaticRollback:false,normalInstallTouched:false},null,2));
 await rename(app,keptNew);await command('/usr/bin/ditto',[success.result.backupApplication,app],'manual-copy-old-to-install-path.log');assert.equal(await sha(app+'/Contents/MacOS/'+binaryName),baseline.candidate.binarySha256);
 const child=spawn(app+'/Contents/MacOS/'+binaryName,['--pilot-root',data,'--acceptance-rpc'],{env,stdio:['pipe','pipe','pipe']});child.stderr.resume();let sequence=0;const pending=new Map();createInterface({input:child.stdout}).on('line',line=>{const value=JSON.parse(line),p=pending.get(value.requestId);if(p){clearTimeout(p.timer);pending.delete(value.requestId);value.ok?p.resolve(value.result):p.reject(Error(value.error));}});
 const rpc=(method,...args)=>new Promise((resolve,reject)=>{const requestId=++sequence,timer=setTimeout(()=>reject(Error('restore RPC timeout '+method)),30000);pending.set(requestId,{resolve,reject,timer});child.stdin.write(JSON.stringify({requestId,method,args})+'\n');});let state,version,bodyHash;
 try{
  state=await wait(async()=>{const s=await rpc('getState');return s.traces===1?s:null;},'restored old storage loads');assert.equal(state.theme,'night');assert.equal(state.language,'en');assert.ok(state.traceRoot.startsWith(data+'/'));assert.equal(state.lastError,null);
  version=(await rpc('getUpdateState')).currentVersion;assert.equal(version,'0.9.9');
  const index=JSON.parse(await readFile(join(data,'traces/index.json'),'utf8')),dashboard=await rpc('getDashboardUrl');const response=await fetch(dashboard+'api/session/'+encodeURIComponent(index.sessions[0].id));assert.equal(response.status,200);const page=await response.json();const body=page.traces[0].response.body.output_text;assert.equal(body,'Retained update response 正文😀'.repeat(2048));bodyHash=(await import('node:crypto')).createHash('sha256').update(body).digest('hex');
 }finally{const ended=once(child,'exit');child.stdin.end();await ended;}
 assert.deepEqual(await regularSnapshot(sourceData,sha),original);assert.deepEqual(await tree(join(data,'traces')),await tree(join(sourceData,'traces')));assert.equal(await sha(keptNew+'/Contents/MacOS/'+binaryName),target.candidate.binarySha256);
 const guiLog=createWriteStream(join(base,'manual-restored-gui.log'));const gui=spawn(app+'/Contents/MacOS/'+binaryName,['--pilot-root',data],{env,stdio:['ignore','pipe','pipe']});gui.stdout.pipe(guiLog,{end:false});gui.stderr.pipe(guiLog,{end:false});
 const startup=await wait(async()=>{try{const x=JSON.parse(await readFile(join(data,'startup-timings.json'),'utf8'));return x.pid===gui.pid?x:null;}catch{return null;}},'restored old GUI loads');
 const result={passed:true,version,bodySha256:bodyHash,originalDataUnchanged:true,newAppPreserved:true,previousBackupPreserved:true,traceFilesUnchanged:true,oldApplication:app,recoveryDataCopy:data,sourceData,guiPid:gui.pid,guiStartup:startup,guiRunning:true,compatibilityScope:'Same frozen storage implementation; arbitrary future schema downgrade is not verified'};await writeFile(join(base,'manual-recovery-result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({manualRecoveryBackendPassed:true,guiPid:gui.pid,app,data,version,bodySha256:bodyHash}));return result;
}
