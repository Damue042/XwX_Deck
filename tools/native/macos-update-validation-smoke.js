(async()=>{
 const checks=[],negativeResults=[];const sleep=ms=>new Promise(r=>setTimeout(r,ms));
 const rpc=(method,...args)=>window.__TAURI__.core.invoke('pilot_rpc',{method,args});
 const checkpoint=(phase,extra={})=>rpc('updateValidationCheckpoint',{phase,checks,negativeResults,...extra});
 const check=(name,value)=>{if(!value)throw Error(name);checks.push(name);};
 async function wait(fn,label){for(let n=0;n<900;n++){const v=await fn();if(v)return v;await sleep(100);}throw Error('timeout '+label);}
 try{
  await wait(()=>window.xwxDeck,'bridge');
  const state=await window.xwxDeck.getState();
  check('backend starts without a preference worker error',state.lastError===null);
  if(location.search.includes('updateRestarted=1')){
   check('restarted backend retains theme',state.theme==='night');
   check('restarted backend retains language',state.language==='en');
   check('restarted client reports target version',(await window.xwxDeck.getUpdateState()).currentVersion==='1.0.0');
   const history=await rpc('updateValidationHistory',false);check('restarted backend loads the retained Trace session',history.sessions.some(s=>s.traceCount===1));
   await checkpoint('restarted',{passed:true,state:{theme:state.theme,language:state.language},pidMarker:true});return;
  }
  check('baseline uses isolated automatic installer',(await window.xwxDeck.getUpdateState()).installMode==='automatic');
  check('baseline version is distinct',(await window.xwxDeck.getUpdateState()).currentVersion==='0.9.9');
  await window.xwxDeck.setTheme('night');await window.xwxDeck.setLanguage('en');
  const history=await rpc('updateValidationHistory',true);check('baseline writes the Trace through production storage',history.sessions.some(s=>s.traceCount===1));
  for(const mode of ['bad-signature','network-failure']){
   await rpc('updateValidationControl',mode);const s=await window.xwxDeck.checkForUpdates();check(mode+' rejected at check',s.status==='error');negativeResults.push({mode,status:s.status,error:s.error});await checkpoint(mode,{update:s});
  }
  for(const mode of ['corrupt-download','interrupted-download']){
   await rpc('updateValidationControl',mode);await window.xwxDeck.checkForUpdates();await window.xwxDeck.downloadUpdate();
   const s=await wait(async()=>{const x=await window.xwxDeck.getUpdateState();return x.status!=='downloading'?x:null;},mode);
   check(mode+' never reaches ready',s.status==='error');negativeResults.push({mode,status:s.status,error:s.error});await checkpoint(mode,{update:s});
  }
  await rpc('updateValidationControl','invalid-platform-signature');await window.xwxDeck.checkForUpdates();await window.xwxDeck.downloadUpdate();
  await wait(async()=>{const x=await window.xwxDeck.getUpdateState();return x.status==='ready';},'platform fixture download');
  let rejected=false,rejection='';try{await window.xwxDeck.restartAndInstall();}catch(error){rejected=true;rejection=String(error);}
  check('invalid Apple package is rejected before replacement',rejected && /codesign|签名|spctl/.test(rejection));negativeResults.push({mode:'invalid-platform-signature',error:rejection});await checkpoint('platform-rejected');
  await rpc('updateValidationControl','good');await window.xwxDeck.checkForUpdates();await window.xwxDeck.downloadUpdate();
  await wait(async()=>{const x=await window.xwxDeck.getUpdateState();return x.status==='ready';},'good package download');
  check('network failure and corrupt retries recover to ready',true);
  await checkpoint('install-requested',{passed:true});
  await window.xwxDeck.restartAndInstall();
 }catch(error){await checkpoint('error',{passed:false,error:String(error)});}
})();
