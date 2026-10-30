import assert from 'node:assert/strict';
import {mkdtemp,mkdir,copyFile,readFile,writeFile,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawn,spawnSync,execFileSync} from 'node:child_process';
import {once} from 'node:events';
import {createHash} from 'node:crypto';
import {nativeTestBinary} from './test-support.mjs';
import {rustToolchain} from './toolchain.mjs';
if(process.platform!=='win32'){console.log('SKIP physical Windows update');process.exit(0);}
const root=await mkdtemp(join(tmpdir(),'xwx-physical-startup-'));
const {rustc,env}=rustToolchain(resolve(import.meta.dirname,'../..'));
const old=join(root,'old.exe'),newer=join(root,'new.exe');
for(const [file,args]of [[old,[]],[newer,['--cfg','fixture_new']]])execFileSync(rustc,['--edition=2021','-O',...args,join(import.meta.dirname,'portable-update-fixture.rs'),'-o',file],{env,windowsHide:true});
const hash=async p=>createHash('sha256').update(await readFile(p)).digest('hex');
const oldHash=await hash(old),newHash=await hash(newer),checks=[];
const delay=ms=>new Promise(r=>setTimeout(r,ms));const absent=async p=>access(p).then(()=>false,()=>true);
async function ownedStop(pid,target){
 if(!pid)return;
 const r=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',"$p=Get-CimInstance Win32_Process -Filter ('ProcessId='+$env:XWX_OWNED_PID);if($p -and $p.ExecutablePath -ieq $env:XWX_OWNED_EXE){Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop}"],{env:{...process.env,XWX_OWNED_PID:String(pid),XWX_OWNED_EXE:target},windowsHide:true,encoding:'utf8'});
 assert.equal(r.status,0,r.stderr);
}
async function test(name,run){
 const folder=join(root,name),updates=join(folder,'updates');await mkdir(updates,{recursive:true});
 const target=join(folder,'Deck.exe'),source=join(updates,'download.exe'),worker=join(updates,'worker.exe'),receipt=join(folder,'receipt.json');
 const backup=target+'.previous-'+oldHash.slice(0,16);
 await copyFile(old,target);await copyFile(newer,source);await copyFile(nativeTestBinary,worker);
 const data=join(folder,'user-data.json'),trace=join(folder,'trace.jsonl');
 await writeFile(data,'{"selected":"keep-user-choice","language":"en"}\n');await writeFile(trace,'{"id":"preserved-trace","tokens":123}\n');
 const before=[await hash(data),await hash(trace)];let parent;
 const startOld=async()=>{parent=spawn(target,[],{env:{...process.env,XWX_UPDATE_TEST_RECEIPT:receipt},stdio:['pipe','ignore','ignore'],windowsHide:true});for(let n=0;n<100;n++){if(!await absent(receipt))return;await delay(50);}throw Error('old fixture did not start');};
 const stopOld=async()=>{const ended=once(parent,'exit');parent.stdin.end();assert.equal((await ended)[0],0);};
 const runWorker=async(expected=newHash,mode='')=>{
  const child=spawn(worker,['--install-update',source,'--replace-executable',target,'--expected-sha256',expected,'--parent-pid',String(parent?.pid??process.pid)],{env:{...process.env,XWX_UPDATE_TEST_RECEIPT:receipt,XWX_UPDATE_TEST_MODE:mode},stdio:'ignore',windowsHide:true});
  const timer=setTimeout(()=>child.kill(),70000);try{return(await once(child,'exit'))[0];}finally{clearTimeout(timer);}
 };
 try{
  await run({target,source,worker,backup,receipt,updates,startOld,stopOld,runWorker});
  assert.deepEqual([await hash(data),await hash(trace)],before,'user settings and trace bytes must remain unchanged');
  checks.push(name);console.log('PASS physical startup '+name);
 }finally{
  if(parent?.exitCode===null)parent.kill();
  const last=await readFile(receipt,'utf8').then(JSON.parse,()=>null);if(last?.version==='fixture-new')await ownedStop(last.pid,target);
 }
}
await test('wait-replace-restart-with-handshake',async f=>{
 await f.startOld();const result=f.runWorker(newHash,'delayed-ready');await delay(1000);assert.equal(await hash(f.target),oldHash);assert.equal(await absent(f.backup),true);
 await f.stopOld();const at=Date.now();assert.equal(await result,0);assert.ok(Date.now()-at>=2000,'must wait for delayed readiness and grace period');assert.equal(await hash(f.target),newHash);assert.equal(await hash(f.backup),oldHash);
});
await test('reject-wrong-hash',async f=>{assert.equal(await f.runWorker('0'.repeat(64)),1);assert.equal(await hash(f.target),oldHash);assert.equal(await absent(f.backup),true);});
await test('reject-changed-download',async f=>{await f.startOld();const result=f.runWorker();await delay(1000);await writeFile(f.source,'changed while waiting');await f.stopOld();assert.equal(await result,1);assert.equal(await hash(f.target),oldHash);});
await test('keep-both-on-invalid-executable',async f=>{await writeFile(f.source,'not a Windows PE');const bad=await hash(f.source);await f.startOld();await f.stopOld();assert.equal(await f.runWorker(bad),1);assert.equal(await hash(f.target),bad);assert.equal(await hash(f.backup),oldHash);});
for(const mode of ['exit','ready-then-exit','wrong-nonce','silent'])await test('reject-'+mode,async f=>{
 await f.startOld();await f.stopOld();assert.equal(await f.runWorker(newHash,mode),1);assert.equal(await hash(f.target),newHash);assert.equal(await hash(f.backup),oldHash);
 const message=await readFile(f.worker.replace(/\.exe$/,'.error.txt'),'utf8');assert.ok(message.length>0);
 const value=JSON.parse(await readFile(f.receipt,'utf8'));assert.equal(value.version,'fixture-new','never silently relaunch the old version');
});
await test('preserve-existing-recovery-copy',async f=>{await writeFile(f.backup,'existing recovery bytes');await f.startOld();await f.stopOld();assert.equal(await f.runWorker(),1);assert.equal(await hash(f.target),oldHash);assert.equal(await readFile(f.backup,'utf8'),'existing recovery bytes');});
const report={root,passed:true,checks,oldHash,newHash,binarySha256:await hash(nativeTestBinary),scope:'Real Windows worker and synthetic PE lifecycle/handshake; every case retains settings and Trace sentinel bytes. Native application readiness is tested separately.'};
await writeFile(join(root,'verification.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
