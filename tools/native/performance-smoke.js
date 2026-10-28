(async () => {
  const rpc = (method,...args) => window.__TAURI__.core.invoke('pilot_rpc',{method,args});
  const delay = ms => new Promise(resolve => setTimeout(resolve,ms));
  const wait = async (test,label,attempts=600) => { for(let n=0;n<attempts;n++){ if(await test()) return; await delay(50); } throw Error(label); };
  const startedAt=Date.now(), phases=[], errors=[], operations={cycles:0,requests:0,viewerChecks:0,detailReads:0,comparisons:0,navigation:0,managerHides:0};
  const timings={requestMs:[],viewerMs:[],cycleMs:[],reopenMs:[]};
  const progress = async phase => {
    const resources=await rpc('smokeResources');
    const canvas=document.querySelector('#page-signal canvas');
    const surface={page:document.querySelector('.page.current')?.id,documentFocused:document.hasFocus(),nativeActive:document.documentElement.dataset.nativeWindowActive,nativeVisible:document.documentElement.dataset.nativeWindowVisible,field:canvas?.dataset.rendering,canvasPixels:canvas?canvas.width*canvas.height:0,domNodes:document.querySelectorAll('*').length,jsHeapBytes:performance.memory?.usedJSHeapSize};
    await window.__TAURI__.core.invoke('pilot_smoke_progress',{checks:[JSON.stringify({elapsedMs:Date.now()-startedAt,operations,resources,surface})],pending:phase});
    return resources;
  };
  try {
    await wait(() => document.querySelector('.tour-skip') || document.querySelector('#page-models.current'), 'manager ready');
    document.querySelector('.tour-skip')?.click();
    await wait(() => !document.querySelector('.tour-root,#onboarding-setup'), 'onboarding closes');
    await wait(async()=>!(await rpc('smokeResources')).historyRunning,'background history completes',3600);
    const context=await rpc('smokeContext');
    const duration=context.performanceDurationMs || 3600000;
    const idleMs=Math.min(300000,duration/10), baselineMs=Math.min(60000,duration/10);
    const cycle = async () => {
      const cycleStart=performance.now();
      for(const page of ['signal','models','settings']) {
        const entry=document.querySelector('[data-page="'+page+'"]');
        if(entry){ entry.click();operations.navigation++;await delay(80); }
      }
      document.querySelector('[data-page="models"]').click();
      const requestStart=performance.now();
      const response=await rpc('smokeRequest');
      timings.requestMs.push(performance.now()-requestStart);
      if(response.status!==200) throw Error('actual Gateway request failed');
      operations.requests++;
      const previous=(await rpc('smokeViewerReport'))?.openedAt;
      const viewerStart=performance.now();
      await window.xwxDeck.openDashboard();
      await wait(async()=>{const next=await rpc('smokeViewerReport');return next?.complete && next.openedAt!==previous;},'fresh Viewer report');
      const viewer=await rpc('smokeViewerReport');
      if(!viewer.passed) throw Error('Viewer: '+viewer.error);
      timings.viewerMs.push(performance.now()-viewerStart);
      operations.viewerChecks+=viewer.checks.length;
      operations.detailReads+=viewer.details;
      operations.comparisons+=viewer.comparisons;
      await rpc('smokeDashboardWindow','close');
      await wait(async()=>!(await rpc('smokeDashboardWindow')),'Viewer destroyed');
      await wait(async()=>(await rpc('smokeResources')).eventReceivers===baselineReceivers,'Viewer SSE subscription released');
      if(operations.cycles%5===0){await rpc('smokeManagerWindow','close');await delay(100);const reopenStart=performance.now();await rpc('smokeManagerWindow','show');await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));timings.reopenMs.push(performance.now()-reopenStart);operations.managerHides++;}
      operations.cycles++;
      timings.cycleMs.push(performance.now()-cycleStart);
      const resources=await progress('active');
      if(resources.recordingSessions || resources.pageCacheFiles>8 || resources.pageCacheBytes>8388608) throw Error('native resource budget exceeded');
      if(window.__pilotErrors.length) throw Error(window.__pilotErrors.join('\n'));
    };
    await window.xwxDeck.toggleTracing(true);
    for(let n=0;n<16;n++){
      if((await rpc('smokeRequest')).status!==200) throw Error('priming request failed');
      operations.requests++;
    }
    const baselineReceivers=(await rpc('smokeResources')).eventReceivers;
    await cycle();
    phases.push({phase:'baseline-idle',at:Date.now()});await progress('baseline-idle');await delay(baselineMs);
    const activeUntil=startedAt+duration-idleMs;
    phases.push({phase:'active',at:Date.now()});
    while(Date.now()<activeUntil){ await cycle();await delay(6000); }
    await window.xwxDeck.toggleTracing(false);
    document.querySelector('[data-page="models"]').click();
    phases.push({phase:'final-idle',at:Date.now()});await progress('final-idle');
    const trayAt=startedAt+duration-idleMs/2;
    while(Date.now()<trayAt){await delay(Math.min(10000,trayAt-Date.now()));await progress('final-idle');}
    await rpc('smokeManagerWindow','close');
    if((await rpc('smokeManagerWindow')).visible) throw Error('tray idle must hide the manager');
    phases.push({phase:'final-tray',at:Date.now()});await progress('final-tray');
    while(Date.now()<startedAt+duration){await delay(Math.min(10000,startedAt+duration-Date.now()));await progress('final-tray');}
    const reopenStart=performance.now();await rpc('smokeManagerWindow','show');
    await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    timings.reopenMs.push(performance.now()-reopenStart);
    if(!(await rpc('smokeManagerWindow')).visible) throw Error('manager reopens after tray idle');
    const resources=await rpc('smokeResources');
    if(resources.eventReceivers!==baselineReceivers || resources.windows.includes('dashboard') || resources.recordingSessions) throw Error('final resource release failed');
    await window.__TAURI__.core.invoke('pilot_smoke_report',{report:{suite:'performance-soak',passed:true,startedAt,finishedAt:Date.now(),elapsedMs:Date.now()-startedAt,phases,operations,timings,resources,errors,nativeWebView:true,syntheticUpstream:true}});
  } catch(error) {
    await rpc('smokeCloseViewer').catch(()=>{});await window.xwxDeck.toggleTracing(false).catch(()=>{});
    await window.__TAURI__.core.invoke('pilot_smoke_report',{report:{suite:'performance-soak',passed:false,startedAt,finishedAt:Date.now(),phases,operations,timings,viewer:await rpc('smokeViewerReport').catch(()=>null),error:String(error),errors:window.__pilotErrors}});
  }
})();
