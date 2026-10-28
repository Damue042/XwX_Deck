/* Landing-page copy stays separate from product settings and example data. */
(() => {
  const messages = {
    title: ['XwX Deck', 'XwX Deck'],
    modelsShort: ['模型', 'Models'],
    settingsShort: ['服务', 'Services'],
    requestsShort: ['请求记录', 'Requests'],
    playDemo: ['播放操作演示', 'Play guided demo'],
    stopDemo: ['停止演示', 'Stop demo'],
    demoHint: ['可以直接操作，也可以播放演示。', 'Try the interface yourself, or play the demo.'],
    demoModels: ['为这个客户端选一份已保存的服务。', 'Choose a saved service for this client.'],
    demoModel: ['选好模型，Deck 会写好客户端配置。', 'Pick a model. Deck writes the client configuration.'],
    demoSettings: ['查看已有配置', 'Inspect saved configurations'],
    demoTrace: ['查看请求追踪', 'Inspect Trace'],
    demoDashboard: ['也可以看看一条真实请求的记录。', 'You can also explore a real request.'],
    demoRequest: ['展开一条请求，看看响应、工具调用和用量。', 'Open a request to see its response, tool calls and usage.'],
    demoResult: ['这一条记录里，可以查看请求、响应和用量。', 'See the request, response and usage in one record.'],
    explainModels: ['选好服务和模型，Deck 会写好客户端配置。', 'Pick a service and model. Deck writes the client configuration.'],
    explainSettings: ['API 服务和订阅账号集中管理，地址与密钥不用反复填写。', 'Manage API services and subscription accounts in one place, without re-entering endpoints and keys.'],
    explainSignal: ['按需开启 Trace，在本机记录请求。', 'Enable Trace when you want to record requests locally.'],
    explainDashboard: ['按需查看请求、响应、工具调用和用量。', 'Explore requests, responses, tool calls and usage when you need them.'],
    demoRaw: ['查看原始日志', 'Inspect the original log'],
    demoDone: ['演示结束，可以自己试试。', 'Demo complete. Try it yourself.'],
    demoStopped: ['可以自己操作，随时再播放演示。', 'Explore at your own pace, or replay the demo.'],
    demoFailed: ['演示暂未就绪，可以重试或直接操作。', 'The demo is not ready. Retry or explore directly.'],
    description: ['更简单的 AI 管理工具。交互体验更流畅、使用更方便的配置管理与日志查看工具。', 'A simpler AI management tool. Manage configurations and explore logs with smoother interactions and less effort.'],
    skip: ['跳到正文', 'Skip to content'],
    navigation: ['主导航', 'Main navigation'],
    docs: ['文档', 'Docs'],
    language: ['选择语言', 'Choose language'],
    heroTitleLead: ['更简单的 ', 'A simpler '],
    heroTitleEnd: ['AI 管理工具', 'AI management tool'],
    heroDescription: ['交互体验更流畅、使用更方便的配置管理与日志查看工具。', 'Manage configurations and explore logs with smoother interactions and less effort.'],
    chooseDownload: ['选择下载版本', 'Choose a download'],
    downloadMac: ['下载 Mac 版', 'Download for Mac'],
    downloadWindows: ['下载 Windows 版', 'Download for Windows'],
    otherVersions: ['其他版本', 'Other versions'],
    chipHelp: ['如何查看 Mac 芯片', 'Find your Mac chip'],
    chipDescription: ['打开苹果菜单 → 关于本机。Apple M 系列请选择 Apple Silicon；Intel 处理器请选择 Intel。', 'Open the Apple menu → About This Mac. Choose Apple Silicon for Apple M-series chips, or Intel for Intel processors.'],
    releases: ['历史版本', 'All releases'],
    missingDownload: ['当前未配置下载地址，请查看已发布版本。', 'No download is configured. Please check the published releases.'],
    windowsArm: ['当前提供 Windows x64 下载，尚无原生 ARM64 版。', 'Windows x64 is available. A native ARM64 version is not available yet.'],
    featuresTitle: ['配置一次，切换更省事', 'Set up once. Switch with less effort.'],
    features: ['功能', 'Features'],
    models: ['切换模型服务', 'Switch models'],
    settings: ['集中管理服务', 'Manage services'],
    signal: ['查看 Trace', 'Explore Trace'],
    dashboard: ['查看仪表盘', 'View dashboard'],
    modelsCopy: ['选好服务和模型，Deck 会写好客户端配置。', 'Pick a service and model. Deck writes the client configuration.'],
    settingsCopy: ['地址和密钥集中管理，不同客户端直接选用。也可从 CC Switch、Magpie 导入已有配置。', 'Keep endpoints and keys together, then select them for each client. You can also import from CC Switch or Magpie.'],
    signalCopy: ['按需开启请求追踪（Trace），在本机记录已接入客户端的模型请求与响应。', 'Enable Trace when you need it to record connected clients’ model requests and responses locally.'],
    dashboardCopy: ['查看脱敏的真实对话，了解各次请求的上下文、工具调用和用量。', 'Explore a real conversation with private information removed, including context, tool calls and usage for each request.'],
    appPreview: ['XwX Deck 功能演示', 'XwX Deck interactive preview'],
    dashboardPreview: ['XwX Deck 仪表盘真实对话', 'XwX Deck dashboard: a real conversation'],
    loading: ['正在加载交互预览', 'Loading interactive preview'],
    safetyTitle: ['配置集中管理，记录按需查看', 'Keep your setup together. Explore requests when you need to.'],
    localTitle: ['配置留在本机', 'Your setup stays local'],
    localCopy: ['配置和日志保存在本机。模型请求发往你选择的服务商，不经过 Deck 的云端中转。', 'Configurations and logs stay on your machine. Model requests go to your chosen provider, without a Deck cloud relay.'],
    switchingTitle: ['一份配置，分别选用', 'One setup, different clients'],
    switchingCopy: ['保存一份地址和密钥，再为不同客户端选服务与模型。相关配置由 Deck 写入。', 'Save an endpoint and key, then choose a service and model for each supported client. Deck writes the configuration.'],
    traceTitle: ['需要时，再看请求', 'Look inside a request'],
    traceCopy: ['按需开启 Trace，在本机查看已接入客户端的请求、响应、工具调用与用量。', 'Enable Trace when you need to inspect connected clients’ requests, responses, tool calls and usage locally.'],
    updatesTitle: ['模型资料自动更新', 'Model information stays current'],
    updatesCopy: ['价格和上下文容量等公开资料自动刷新。历史请求保留当时的参考费用。', 'Public pricing and context limits refresh automatically. Past requests keep their original reference costs.'],
    supportTitle: ['客户端与模型服务', 'Clients and model services'],
    clients: ['客户端', 'Clients'],
    services: ['模型服务', 'Model services'],
    qwen: ['千问', 'Qwen'],
    ark: ['火山方舟', 'Volcengine Ark'],
    zhipu: ['智谱 GLM', 'Zhipu GLM'],
    tencent: ['腾讯 TokenHub', 'Tencent TokenHub'],
    siliconflow: ['硅基流动', 'SiliconFlow'],
    stepfun: ['阶跃星辰', 'StepFun'],
    openaiCompatible: ['OpenAI 兼容接口', 'OpenAI-compatible APIs'],
    anthropicCompatible: ['Anthropic 兼容接口', 'Anthropic-compatible APIs'],
    customServices: ['自定义服务', 'Custom services'],
    communityTitle: ['你的建议，让 Deck 更好用', 'Your ideas make Deck better'],
    communityCopy: ['欢迎交流使用体验', 'Tell us how it works for you'],
    qq: ['QQ 群聊', 'QQ group'],
  };
  const storageKey = 'xwx-deck.site.language';
  const supported = value => value === 'zh-CN' || value === 'en';
  let language = 'zh-CN';
  for (const locale of navigator.languages || [navigator.language]) {
    if (/^zh\b/i.test(locale)) { language = 'zh-CN'; break; }
    if (/^en\b/i.test(locale)) { language = 'en'; break; }
  }
  try {
    const saved = localStorage.getItem(storageKey);
    if (supported(saved)) language = saved;
  } catch { /* Switching remains usable when storage is unavailable. */ }
  const text = key => messages[key]?.[language === 'en' ? 1 : 0] ?? key;
  function apply(next) {
    if (!supported(next)) return;
    language = next;
    document.documentElement.lang = next;
    document.title = text('title');
    for (const node of document.querySelectorAll('[data-i18n]')) node.textContent = text(node.dataset.i18n);
    for (const attribute of ['aria-label', 'title', 'content', 'data-copy']) {
      for (const node of document.querySelectorAll(`[data-i18n-${attribute}]`)) {
        node.setAttribute(attribute, text(node.getAttribute(`data-i18n-${attribute}`)));
      }
    }
    for (const option of document.querySelectorAll('[data-language]')) {
      option.setAttribute('aria-checked', String(option.dataset.language === next));
    }
    dispatchEvent(new CustomEvent('site-language', { detail: next }));
  }
  window.siteLanguage = { text, get current() { return language; } };
  apply(language);

  const picker = document.querySelector('.language-picker');
  const trigger = document.getElementById('language-trigger');
  const menu = document.getElementById('language-menu');
  const options = [...menu.querySelectorAll('[data-language]')];
  picker.hidden = false;
  function close(restoreFocus = false) {
    menu.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    if (restoreFocus) trigger.focus({ preventScroll: true });
  }
  function open(index = options.findIndex(option => option.dataset.language === language)) {
    menu.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    options[index].focus({ preventScroll: true });
  }
  trigger.addEventListener('click', () => menu.hidden ? open() : close());
  trigger.addEventListener('keydown', event => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      event.stopPropagation();
      open(event.key === 'ArrowDown' ? 0 : options.length - 1);
    }
  });
  options.forEach(option => option.addEventListener('click', () => {
    try { localStorage.setItem(storageKey, option.dataset.language); } catch { /* Keep the current choice in memory. */ }
    apply(option.dataset.language);
    close(true);
  }));
  picker.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !menu.hidden) { event.preventDefault(); close(true); }
    if (menu.hidden || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const index = options.indexOf(document.activeElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1
      : (index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
    options[next].focus({ preventScroll: true });
  });
  document.addEventListener('pointerdown', event => { if (!picker.contains(event.target)) close(); });
  picker.addEventListener('focusout', event => { if (!picker.contains(event.relatedTarget)) close(); });
})();
