(async () => {
  const openedAt = Date.now(), checks = [], errors = [];
  window.addEventListener('error',event=>errors.push(event.message));
  window.addEventListener('unhandledrejection',event=>errors.push(String(event.reason)));
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const wait = async (test, label) => { for(let n=0;n<300;n++){ if(await test()) return; await delay(50); } throw Error(label); };
  let report;
  let details=0,comparisons=0;
  const progress = phase => fetch('/__native-viewer-smoke',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({passed:false,complete:false,openedAt,phase,checks})});
  try {
    await progress('loading-dashboard');
    await wait(() => liveConnected && document.querySelector('.dash-table tbody tr[data-sid]'), 'live dashboard');
    document.querySelector('.dash-table tbody tr[data-sid]').click();
    await progress('loading-first-detail');
    await wait(() => currentTrace() && !currentTrace().summaryOnly && !document.querySelector('#detail .detail-loading'), 'initial full detail');
    for(let n=0;n<4;n++) {
      const rows = [...document.querySelectorAll('#traceList .row[data-id]')];
      const row = rows[Math.max(0, rows.length-1-n)];
      if(!row) break;
      row.click();
      await progress('loading-detail-'+n);
      await wait(() => currentTrace()?.id === row.dataset.id && !currentTrace().summaryOnly && !document.querySelector('#detail .detail-loading'), 'selected full detail');
      const answer = document.querySelector('[data-sec="response"] .resp-text');
      if(!answer?.textContent.includes('Synthetic performance response.') || !answer.querySelector('.scroll-detail-next') || answer.textContent.length > 33000) throw Error('large response must be readable with bounded initial layout');
      document.querySelector('[data-mode="raw"]').click();
      await delay(30);
      document.querySelector('[data-mode="read"]').click();
      details++;
      if(stableTraceOrdinal(currentTrace(),0)>1){
        document.querySelector('[data-mode="compare"]').click();
        await progress('loading-comparison-'+n);
        await wait(() => !document.querySelector('#diffBody .detail-loading') && diffTraceLoading.size===0, 'comparison settled');
        document.querySelector('[data-mode="read"]').click();
        comparisons++;
      }
      if(rawTraces().some(trace => !trace.summaryOnly)) throw Error('rail retained full bodies');
      if(diffTraceCache.size>1) throw Error('comparison retained extra bodies');
      checks.push('detail-read-log-'+n);
    }
    gotoDashboard();
    if(restoredDetailTrace || deferredDetailBodies.length || detailScrollBodies.length || logFieldCache.entries.length || diffTraceCache.size || document.querySelector('#detail').childElementCount) throw Error('dashboard retained detail resources');
    checks.push('dashboard releases detail bodies, deferred renderers, comparison and DOM');
    if(errors.length) throw Error(errors.join('\n'));
    report = {passed:true,openedAt,checks,details,comparisons,errors,heap:performance.memory?.usedJSHeapSize ?? null,rows:rawTraces().length,nativeWebView:true};
  } catch(error) {
    // IDs, states and timings only: never copy captured request/response text
    // into acceptance diagnostics, including when a historical row was chosen.
    const current=currentTrace();
    const context={sessionId:selectedSessionId,selectedId,currentId:current?.id,summaryOnly:current?.summaryOnly,
      loadState:sessionLoadState[selectedSessionId],loadError:sessionLoadErrors[selectedSessionId],
      pendingDetail:requestDetailKey,detailAborted:requestDetailController?.signal.aborted,
      detailErrors:[...requestDetailErrors.entries()].slice(-4),
      railRows:document.querySelectorAll('#traceList .row[data-id]').length,
      detailLoading:!!document.querySelector('#detail .detail-loading'),
      resourceTimings:performance.getEntriesByType('resource').filter(entry=>entry.name.includes('/api/session/')).slice(-8)
        .map(entry=>({path:new URL(entry.name).pathname,query:new URL(entry.name).search,duration:entry.duration,responseStatus:entry.responseStatus,bytes:entry.decodedBodySize}))};
    report = {passed:false,openedAt,checks,error:String(error),context,nativeWebView:true};
  }
  await fetch('/__native-viewer-smoke',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...report,complete:true})});
})();
