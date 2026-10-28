/* Operate the shipped renderer and Viewer controls; never draw replacement UI. */
(() => {
  const button = document.getElementById('demo-play');
  const progress = document.getElementById('demo-progress');
  const app = document.getElementById('app-demo');
  const viewer = document.getElementById('dashboard-demo');
  const panel = document.getElementById('demo-panel');
  const cursor = document.getElementById('demo-cursor');
  const ring = cursor.querySelector('.demo-click-ring');
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  let cursorPosition = { x: 38, y: 55 };
  let movement = null;
  let clickEffect = null;
  let controller = null;
  let interacted = false;
  let status = 'demoHint';
  const text = key => window.siteLanguage.text(key);
  function caption() {
    if (controller) return text(status);
    if (status === 'demoDone' && !viewer.hidden && viewer.contentDocument?.querySelector('#appRoot[data-view="session"]')) return text('demoResult');
    if (status === 'demoFailed') return text(status);
    const page = !viewer.hidden ? 'dashboard'
      : app.contentDocument?.querySelector('.page.current')?.id.replace('page-', '')
        || document.querySelector('.seg [aria-selected="true"]').dataset.page;
    return text({ models: 'explainModels', settings: 'explainSettings', signal: 'explainSignal', dashboard: 'explainDashboard' }[page] || 'explainModels');
  }
  function hideCursor() {
    movement?.cancel();
    clickEffect?.cancel();
    cursor.hidden = true;
    delete cursor.dataset.phase;
  }

  function update() {
    const label = text(controller ? 'stopDemo' : 'playDemo');
    button.setAttribute('aria-label', label);
    button.title = label;
    button.innerHTML = controller
      ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 6v12M16 6v12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>'
      : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 5 10 7-10 7z" fill="currentColor"/></svg>';
    button.setAttribute('aria-pressed', String(!!controller));
    button.dataset.state = controller ? 'playing' : status === 'demoDone' ? 'done' : status === 'demoStopped' ? 'stopped' : status === 'demoFailed' ? 'failed' : 'idle';
    const sentence = caption();
    if (progress.textContent !== sentence) progress.textContent = sentence;
  }
  function stop(key = 'demoStopped') {
    controller?.abort();
    controller = null;
    hideCursor();
    status = key;
    update();
  }
  async function click(element, signal) {
    if (signal.aborted) throw signal.reason;
    const doc = element.ownerDocument;
    const frame = doc === app.contentDocument ? app : viewer;
    // Reveal targets inside their own scrolling pane, never scroll the website.
    for (let parent = element.parentElement; parent && parent !== doc.body; parent = parent.parentElement) {
      if (parent.scrollHeight <= parent.clientHeight || !/(auto|scroll)/.test(doc.defaultView.getComputedStyle(parent).overflowY)) continue;
      const targetBox = element.getBoundingClientRect();
      const paneBox = parent.getBoundingClientRect();
      if (targetBox.top < paneBox.top) parent.scrollTop -= paneBox.top - targetBox.top + 6;
      else if (targetBox.bottom > paneBox.bottom) parent.scrollTop += targetBox.bottom - paneBox.bottom + 6;
      break;
    }
    const target = element.getBoundingClientRect();
    const frameBox = frame.getBoundingClientRect();
    const panelBox = panel.getBoundingClientRect();
    const scaleX = frameBox.width / frame.contentWindow.innerWidth;
    const scaleY = frameBox.height / frame.contentWindow.innerHeight;
    const point = {
      x: frameBox.left - panelBox.left + (target.left + target.width / 2) * scaleX,
      y: frameBox.top - panelBox.top + (target.top + target.height / 2) * scaleY
    };
    const from = 'translate3d(' + cursorPosition.x + 'px,' + cursorPosition.y + 'px,0)';
    const to = 'translate3d(' + point.x + 'px,' + point.y + 'px,0)';
    cursor.hidden = false;
    cursor.dataset.phase = 'moving';
    cursor.dataset.target = element.id || element.getAttribute('aria-label') || element.textContent.trim().slice(0, 60);
    cursor.style.transform = from;
    if (!reducedMotion.matches) {
      const distance = Math.hypot(point.x - cursorPosition.x, point.y - cursorPosition.y);
      movement = cursor.animate([{ transform: from }, { transform: to }], {
        duration: Math.min(1000, Math.max(500, distance * 1.1)),
        easing: 'cubic-bezier(.22,1,.36,1)', fill: 'forwards'
      });
      const cancel = () => movement?.cancel();
      signal.addEventListener('abort', cancel, { once: true });
      try { await movement.finished; }
      finally { signal.removeEventListener('abort', cancel); }
    }
    if (signal.aborted) throw signal.reason;
    cursor.style.transform = to;
    movement?.cancel();
    movement = null;
    cursorPosition = point;
    cursor.dataset.phase = 'hover';
    await pause(signal, 400);
    cursor.dataset.phase = 'click';
    if (!reducedMotion.matches) clickEffect = ring.animate([
      { transform: 'scale(.45)', opacity: .9 },
      { transform: 'scale(1.5)', opacity: 0 }
    ], { duration: 500, easing: 'ease-out' });
    element.click();
    await pause(signal, 450);
    cursor.dataset.phase = 'idle';
  }
  function pause(signal, duration = 1400) {
    return new Promise((resolve, reject) => {
      const abort = () => { clearTimeout(timer); reject(signal.reason); };
      const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, duration);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
  }
  function waitFor(doc, find, signal) {
    return new Promise((resolve, reject) => {
      let timer;
      const observer = new MutationObserver(check);
      function finish(error, value) {
        observer.disconnect();
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        if (error) reject(error); else resolve(value);
      }
      function abort() { finish(signal.reason); }
      function check() {
        if (signal.aborted) { abort(); return; }
        const element = find();
        if (element) finish(null, element);
      }
      observer.observe(doc.documentElement, { childList: true, subtree: true, attributes: true });
      signal.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => finish(new Error('Demo control was not ready')), 12000);
      check();
    });
  }
  async function page(name, signal) {
    document.getElementById('tab-' + name).click();
    const frame = name === 'dashboard' ? viewer : app;
    await waitFor(document, () => frame.dataset.ready === 'true' && frame.contentDocument?.body, signal);
    const doc = frame.contentDocument;
    const selector = name === 'dashboard' ? '#dashboard' : '#page-' + name + '.current';
    await waitFor(doc, () => doc.querySelector(selector), signal);
    return doc;
  }
  const visible = node => node.getClientRects().length > 0 && !node.disabled;
  async function choose(doc, trigger, label, signal) {
    const control = await waitFor(doc, () => [...doc.querySelectorAll(trigger)].find(visible), signal);
    await click(control, signal);
    await pause(signal, 450);
    const option = await waitFor(doc, () => [...doc.querySelectorAll('[role="option"]')].find(node => visible(node) && node.textContent.trim() === label), signal);
    await click(option, signal);
  }
  function say(key) { status = key; update(); }
  async function play() {
    const run = new AbortController();
    controller = run;
    cursorPosition = { x: 38, y: 55 };
    const { signal } = run;
    update();
    try {
      say('demoModels');
      const doc = await page('models', signal);
      doc.querySelectorAll('[role="combobox"][aria-expanded="true"]').forEach(control => control.click());
      const client = await waitFor(doc, () => doc.querySelector('#client-tab-codex'), signal);
      await click(client, signal);
      await pause(signal, 650);
      await choose(doc, '#client-panel-codex .field-row:first-child [role="combobox"]', 'DeepSeek', signal);
      await pause(signal, 1900);
      say('demoModel');
      await choose(doc, '#client-panel-codex [role="combobox"][aria-label="选择模型"], #client-panel-codex [role="combobox"][aria-label="Choose model"]', 'deepseek-v4-flash', signal);
      await pause(signal, 1900);
      say('demoDashboard');
      const dashboardButton = await waitFor(doc, () => doc.querySelector('#dashBtn'), signal);
      await click(dashboardButton, signal);
      cursor.hidden = true;
      await waitFor(document, () => viewer.hidden === false && viewer.dataset.ready === 'true', signal);
      const logs = viewer.contentDocument;
      const home = await waitFor(logs, () => logs.querySelector('#brandHome'), signal);
      if (logs.querySelector('#appRoot[data-view="session"]')) await click(home, signal);
      await pause(signal, 1600);
      const session = await waitFor(logs, () => logs.querySelector('tr[data-sid]'), signal);
      await click(session, signal);
      say('demoRequest');
      const latest = await waitFor(logs, () => [...logs.querySelectorAll('#traceList .row[data-id]')].at(-1), signal);
      await click(latest, signal);
      await waitFor(logs, () => {
        const detail = logs.querySelector('#detail:not([data-loading-trace])');
        return detail?.dataset.traceId === latest.dataset.id && detail;
      }, signal);
      await pause(signal, 2400);
      if (controller === run) { controller = null; status = 'demoDone'; hideCursor(); update(); }
    } catch (error) {
      if (controller === run) stop(signal.aborted ? 'demoStopped' : 'demoFailed');
    }
  }
  button.addEventListener('click', () => { if (controller) stop(); else void play(); });
  function takeOver(event) {
    if (!event.isTrusted) return;
    interacted = true;
    if (controller && !event.target.closest('#demo-play')) stop();
  }
  for (const type of ['pointerdown', 'keydown']) document.addEventListener(type, takeOver, { capture: true });
  const observedDocuments = new WeakSet();
  function bindFrame(frame) {
    const doc = frame.contentDocument;
    if (!doc?.body || observedDocuments.has(doc)) return;
    observedDocuments.add(doc);
    for (const type of ['pointerdown', 'keydown']) doc.addEventListener(type, takeOver, { capture: true });
    new MutationObserver(() => { if (!controller) update(); }).observe(doc.body, { attributes: true, attributeFilter: ['class'], subtree: true });
    update();
  }
  for (const frame of [app, viewer]) {
    frame.addEventListener('load', () => bindFrame(frame));
    bindFrame(frame);
  }
  document.addEventListener('visibilitychange', () => { if (document.hidden && controller) stop(); });
  addEventListener('site-language', () => { if (controller) stop(); update(); });
  addEventListener('site-demo-view', update);
  addEventListener('resize', () => { if (controller) stop(); });
  // Play one short sequence when the product is in view. Never restart it after
  // someone has interacted, and leave reduced-motion visitors in control.
  const visibility = new IntersectionObserver(entries => {
    if (!entries.some(entry => entry.intersectionRatio >= .65)) return;
    visibility.disconnect();
    if (!interacted && !new URLSearchParams(location.search).has('demo') && !matchMedia('(prefers-reduced-motion: reduce)').matches) void play();
  }, { threshold: .65 });
  visibility.observe(document.getElementById('demo-panel'));
  update();
})();
