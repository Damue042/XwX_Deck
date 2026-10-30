(async()=>{
 const checks=[];const api=()=>window.xwxDeck;const sleep=ms=>new Promise(r=>setTimeout(r,ms));
 const rpc=(method,...args)=>window.__TAURI__.core.invoke('pilot_rpc',{method,args});
 const probe=()=>rpc('updateValidationNightProbe');const clock=(hour,idleSeconds,extra={})=>rpc('updateValidationNightClock',{hour,idleSeconds,...extra});
 const checkpoint=(phase,extra={})=>rpc('updateValidationCheckpoint',{phase,checks,...extra});
 const check=(name,value)=>{if(!value)throw Error(name);checks.push(name);};
 async function wait(fn,label){for(let n=0;n<900;n++){const v=await fn();if(v)return v;await sleep(100);}throw Error('timeout '+label);}
 async function observed(label){const count=(await probe()).pollCount;await wait(async()=> (await probe()).pollCount>=count+2,label);check(label,(await api().getUpdateState()).currentVersion==='0.9.9');}
 try{
  await wait(()=>window.xwxDeck,'bridge');const context=(await probe()).scenario;
  await api().setTheme('night');await api().setLanguage('en');await rpc('updateValidationHistory',true);
  if(context.mode.startsWith('periodic-')){
   await api().setAutomaticUpdates(true);
   const initialMode=context.mode==='periodic-current'?'up-to-date':'network-failure';
   await rpc('updateValidationControl',initialMode);
   await clock(12,3600,{elapsedMs:6000});
   const initialStatus=context.mode==='periodic-current'?'up-to-date':'error';
   await wait(async()=> (await api().getUpdateState()).status===initialStatus,'initial scheduled result');
   check('initial periodic check reports '+initialStatus,true);
   await rpc('updateValidationControl','good');
   await clock(12,3600,{elapsedMs:1805999});
   await observed('no early refresh before thirty minute interval');
   check('previous terminal state is retained before interval',(await api().getUpdateState()).status===initialStatus);
   await clock(12,3600,{elapsedMs:1806000});
   await wait(async()=> (await api().getUpdateState()).status==='ready','periodic recovery and automatic prefetch');
   await observed('periodic result remains ready outside installation window');
   await checkpoint('nightly-periodic-passed',{passed:true,probe:await probe()});return;
  }
  await rpc('updateValidationControl','good');await clock(12,3600);
  if(context.mode==='gates'){
   await api().setAutomaticUpdates(false);await api().checkForUpdates();await clock(3,900);await observed('opt-out blocks automatic download and install');check('disabled preference leaves available package',(await api().getUpdateState()).status==='available');
   await clock(12,3600);await api().setAutomaticUpdates(true);
   await wait(async()=> (await api().getUpdateState()).status==='ready','automatic prefetch');
   await observed('daytime ready package is not installed');
   for(const [hour,idle,label] of [[1,3600,'before 02:00'],[4,899,'less than 15 minutes idle'],[5,3600,'at or after 05:00']]){await clock(hour,idle);await observed(label+' blocks install');}
   await clock(12,3600);
   const providers=await api().saveProvider({displayName:'Nightly fixture',baseUrl:context.modelBase,bearerToken:'isolated-nightly-fixture',adapter:'responses',codexModel:'nightly-fixture'});
   const provider=providers.connections.find(p=>p.displayName==='Nightly fixture');check('synthetic provider saved',!!provider);
   await api().switchClientProvider({client:'codex',providerId:provider.id});await api().toggleTracing(true);check('actual Gateway is active',(await api().getState()).backgroundGatewayActive);
   await clock(3,900);await observed('active Gateway blocks nightly install');check('Gateway remains active',(await api().getState()).backgroundGatewayActive);
   await clock(12,3600);await api().toggleTracing(false);
   await api().cancelUpdate();await clock(3,900);await observed('declined version is not automatically downloaded or installed');check('decline makes nightly ineligible',!(await probe()).eligible);
   await checkpoint('nightly-gates-passed',{passed:true,probe:await probe()});return;
  }
  await wait(async()=> (await api().getUpdateState()).status==='ready','scheduler fetches signed package');
  await checkpoint('nightly-armed',{passed:true});
  await clock(3,900,context.mode==='stage-deferral'?{resumeAfterStaging:true}:{});
  if(context.mode==='stage-deferral'){
   await wait(async()=> (await probe()).scenario.stagingInputResumed,'staging race receipt');
   check('resumed input after staging keeps old application',(await api().getUpdateState()).currentVersion==='0.9.9');
   check('deferred package remains ready',(await api().getUpdateState()).status==='ready');
   await checkpoint('nightly-stage-deferred',{passed:true,probe:await probe()});
  }
  // The install scenario makes no restartAndInstall call. The production
  // background loop must trigger staging, safe shutdown and installation.
 }catch(error){await checkpoint('error',{passed:false,error:String(error)});}
})();
