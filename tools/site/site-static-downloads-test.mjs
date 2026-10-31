import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join, extname, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { validateStaticDownloads } from '../release/static-downloads.mjs';

const root = resolve(import.meta.dirname, '../..');
const rawConfig = await readFile(join(root, 'web/site/static-downloads.json'), 'utf8');
const config = validateStaticDownloads(JSON.parse(rawConfig));
const staticSite = join(root, 'test-results/site-static-downloads');
const pendingSite = join(root, 'test-results/site-preview');
const [staticIndex, pendingIndex, sourceIndex] = await Promise.all([
  readFile(join(staticSite, 'index.html'), 'utf8'), readFile(join(pendingSite, 'index.html'), 'utf8'), readFile(join(root, 'web/site/index.html'), 'utf8'),
]);
const emptyDownloads = "const DOWNLOADS = { windows: '', portable: '', mac: '' };";
assert.ok(sourceIndex.includes(emptyDownloads), 'source download map remains unpublished');
assert.ok(pendingIndex.includes(emptyDownloads), 'default build remains unpublished');
assert.deepEqual(JSON.parse(staticIndex.match(/const DOWNLOADS = (\{[^\n]+\});/)[1]), config.downloads);
assert.equal(config.files.length, 3);
assert.deepEqual(config.files.map(file => file.target).sort(), ['mac', 'portable', 'windows']);
for (const file of config.files) {
  assert.ok(file.url.endsWith(file.staticName));
  assert.equal(file.staticName, file.name.replace(/(\.[^.]+)$/, `-${file.sha256}$1`));
  assert.match(file.sha256, /^[a-f0-9]{64}$/);
}
const readOptional = async path => { try { return await readFile(path, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return ''; throw error; } };
for (const name of ['_redirects', '_headers']) {
  const [original, pending, staged] = await Promise.all([
    readFile(join(root, 'web/site', name), 'utf8'), readFile(join(pendingSite, name), 'utf8'), readOptional(join(staticSite, name)),
  ]);
  assert.equal(pending, original, 'default future routing remains unchanged: ' + name);
  assert.doesNotMatch(staged, /\/updates\/stable\/release\.json|^\/updates\/\*/m, 'static build must not activate update-specific routing');
}
assert.doesNotMatch(staticIndex, /https:\/\/download\.xwxdeck\.com\/candidates\//);
const errors = [], unexpectedRequests = [], interceptedDownloads = [], checks = [];
const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost');
  const prefix = url.pathname.startsWith('/pending/') ? '/pending/' : '/static/';
  const base = prefix === '/pending/' ? pendingSite : staticSite;
  const relative = url.pathname.slice(prefix.length) || 'index.html';
  const file = resolve(base, relative);
  if (!url.pathname.startsWith(prefix) || !file.startsWith(base + sep)) { response.writeHead(403); response.end(); return; }
  try {
    const body = await readFile(file);
    response.writeHead(200, { 'content-type': ({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.woff2': 'font/woff2', '.json': 'application/json' }[extname(file)] ?? 'application/octet-stream') });
    response.end(body);
  } catch { response.writeHead(404); response.end(); }
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const origin = `http://127.0.0.1:${server.address().port}`;
const module = process.env.XWX_PLAYWRIGHT_MODULE;
const { chromium } = await import(module ? pathToFileURL(resolve(module)).href : 'playwright');
const browser = await chromium.launch({ ...(process.env.XWX_PLAYWRIGHT_CHANNEL === 'chromium' ? {} : { channel: 'chrome' }), headless: true });
const profiles = [
  { name: 'Windows x64', platform: 'Windows', arch: 'x86', direct: 'windows' },
  { name: 'Apple Silicon', platform: 'macOS', arch: 'arm', direct: 'mac' },
  { name: 'Intel Mac', platform: 'macOS', arch: 'x86', context: '本次不提供 Intel Mac 安装包。' },
  { name: 'Windows ARM64', platform: 'Windows', arch: 'arm', context: '当前提供 Windows x64 下载，尚无原生 ARM64 版。' },
  { name: 'MacIntel without hints', platform: 'MacIntel', hints: false },
  { name: 'iPad desktop mode', platform: 'MacIntel', hints: false, touch: 5 },
  { name: 'Unknown', platform: 'unknown', hints: false },
];
async function context(options = {}, profile = profiles[0]) {
  const result = await browser.newContext({ reducedMotion: 'reduce', locale: 'zh-CN', serviceWorkers: 'block', ...options });
  await result.route('**/*', async route => {
    const requestUrl = route.request().url();
    if (requestUrl.startsWith(origin + '/')) return route.continue();
    const file = config.files.find(file => file.url === requestUrl);
    const checksum = requestUrl === config.checksumsUrl || config.files.some(file => file.checksumUrl === requestUrl);
    if (file || checksum) {
      const name = file?.name ?? (requestUrl === config.checksumsUrl ? 'checksums.txt' : config.files.find(file => file.checksumUrl === requestUrl).name + '.sha256');
      interceptedDownloads.push({ url: requestUrl, suggestedFilename: name });
      return route.fulfill({ status: 200, contentType: file ? 'application/octet-stream' : 'text/plain', headers: { 'content-disposition': `attachment; filename="${name}"` }, body: 'Synthetic local download fixture; package integrity is verified separately.' });
    }
    unexpectedRequests.push(requestUrl);
    return route.abort();
  });
  await result.addInitScript(profile => {
    Object.defineProperty(navigator, 'platform', { value: profile.platform });
    Object.defineProperty(navigator, 'userAgent', { value: profile.platform });
    Object.defineProperty(navigator, 'maxTouchPoints', { value: profile.touch ?? 0 });
    Object.defineProperty(navigator, 'userAgentData', { value: profile.hints === false ? undefined : {
      platform: profile.platform, mobile: false, getHighEntropyValues: async () => ({ architecture: profile.arch, bitness: '64' }),
    } });
  }, profile);
  result.on('page', page => {
    page.on('pageerror', error => errors.push(String(error)));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    page.on('response', response => { if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`); });
  });
  return result;
}
async function assertChoices(page) {
  assert.equal(await page.locator('[data-download]').count(), 3);
  assert.equal(await page.locator('[data-download="macIntel"]').count(), 0);
  for (const file of config.files) {
    const choice = page.locator(`[data-download="${file.target}"]`);
    assert.equal(await choice.getAttribute('href'), file.url);
    assert.equal(await choice.getAttribute('aria-disabled'), null);
    assert.equal(await choice.locator('[data-download-status]').textContent(), file.target === 'mac' ? 'DMG' : 'EXE');
  }
  assert.equal(await page.locator('[data-static-checksums]').getAttribute('href'), config.checksumsUrl);
}
async function openChoices(page) {
  if (await page.locator('#download-options').getAttribute('open') === null) await page.locator('#download-options > summary').click();
}
async function download(page, target, expectedName) {
  await openChoices(page);
  const event = page.waitForEvent('download');
  await page.locator(target).click();
  assert.equal((await event).suggestedFilename(), expectedName);
}
try {
  const normal = await context(), page = await normal.newPage();
  for (const width of [320, 390, 780, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(origin + '/static/', { waitUntil: 'networkidle' });
    assert.equal(await page.title(), 'XwX Deck');
    assert.ok((await page.locator('#title').innerText()).includes('AI'));
    assert.equal(await page.locator('vite-error-overlay, nextjs-portal').count(), 0);
    await assertChoices(page);
    await page.waitForFunction(url => document.querySelector('#recommended-download').href === url, config.downloads.windows);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.equal(await page.locator('.dl-msg').innerText(), '提供手动下载，自动更新渠道尚未启用。');
    await openChoices(page);
    const box = await page.locator('.download-choices').boundingBox();
    assert.ok(box.x >= 0 && box.x + box.width <= width + 1, 'download menu fits at ' + width);
    if (process.env.XWX_SITE_TEST_SCREENSHOT_DIR) {
      await mkdir(process.env.XWX_SITE_TEST_SCREENSHOT_DIR, { recursive: true });
      await page.screenshot({ path: join(process.env.XWX_SITE_TEST_SCREENSHOT_DIR, `static-downloads-${width}.png`) });
    }
  }
  assert.match(await page.locator('body').evaluate(node => getComputedStyle(node).fontFamily), /xVf.*Noto Sans SC/);
  assert.equal(await page.evaluate(async () => { await document.fonts.load('400 16px xVf'); return document.fonts.check('400 16px xVf'); }), true);
  for (const file of config.files) await download(page, `[data-download="${file.target}"]`, file.name);
  await download(page, '[data-static-checksums]', 'checksums.txt');
  await normal.close();
  checks.push('Exact shared configuration, full64-SHA filenames, three JS download links and canonical Content-Disposition filenames; checksum link intercepted locally');
  checks.push('320/390/780/1440px: page identity, real content, no framework overlay, readable original font, no overflow, usable download menu and manual-download notice');
  for (const profile of profiles) {
    const c = await context({}, profile), p = await c.newPage();
    await p.goto(origin + '/static/', { waitUntil: 'networkidle' });
    await assertChoices(p);
    if (profile.direct) {
      try { await p.waitForFunction(url => document.querySelector('#recommended-download').href === url, config.downloads[profile.direct], { timeout: 5000 }); }
      catch (error) {
        const state = await p.evaluate(() => ({ href: document.querySelector('#recommended-download').href, ua: navigator.userAgent, platform: navigator.platform, touch: navigator.maxTouchPoints }));
        throw Error(`${profile.name} recommendation failed: ${JSON.stringify({ ...state, expected: config.downloads[profile.direct], errors })}`, { cause: error });
      }
    }
    else {
      assert.equal(await p.locator('#recommended-download').getAttribute('href'), '#download-choices');
      await p.locator('#recommended-download').click();
      assert.equal(await p.locator('#download-options').getAttribute('open'), '');
    }
    if (profile.context) assert.equal(await p.locator('.download-context:not([data-static-checksums])').innerText(), profile.context);
    await c.close();
  }
  checks.push('Windows x64, Apple Silicon, Intel Mac, Windows ARM64, MacIntel without hints, iPad desktop mode and unknown OS preserve conservative architecture selection');
  const english = await context({ locale: 'en-US' }), en = await english.newPage();
  await en.goto(origin + '/static/', { waitUntil: 'networkidle' });
  assert.match(await en.locator('.dl-msg').innerText(), /Automatic updates are not enabled/);
  await assertChoices(en);
  await en.locator('#language-trigger').click();
  await en.getByRole('menuitemradio', { name: '简体中文', exact: true }).click();
  assert.equal(await en.locator('.dl-msg').innerText(), '提供手动下载，自动更新渠道尚未启用。');
  await english.close();
  checks.push('English/Chinese switching preserves download URLs, file formats and inactive automatic-update notice');
  const noJs = await context({ javaScriptEnabled: false }), fallback = await noJs.newPage();
  for (const width of [320, 390, 780, 1440]) {
    await fallback.setViewportSize({ width, height: 900 });
    await fallback.goto(origin + '/static/', { waitUntil: 'networkidle' });
    await assertChoices(fallback);
    assert.equal(await fallback.locator('[data-download-label]').innerText(), '选择下载版本');
    assert.equal(await fallback.locator('.dl-msg').innerText(), '提供手动下载，自动更新渠道尚未启用。');
    await openChoices(fallback);
    const box = await fallback.locator('.download-choices').boundingBox();
    assert.ok(box.x >= 0 && box.x + box.width <= width + 1);
  }
  for (const file of config.files) await download(fallback, `[data-download="${file.target}"]`, file.name);
  await download(fallback, '[data-static-checksums]', 'checksums.txt');
  await fallback.goto(origin + '/pending/', { waitUntil: 'networkidle' });
  for (const target of ['windows', 'portable', 'mac']) assert.equal(await fallback.locator(`[data-download="${target}"]`).getAttribute('href'), null);
  assert.match(await fallback.locator('.dl-msg').innerText(), /尚未发布/);
  await noJs.close();
  checks.push('No-JavaScript static links, EXE/DMG labels, checksums and downloads work at all4 widths; default preview still has no live links');
  const pending = await context(), pendingPage = await pending.newPage();
  await pendingPage.goto(origin + '/pending/', { waitUntil: 'networkidle' });
  assert.equal(await pendingPage.locator('[data-download-label]').innerText(), '查看发布状态');
  for (const target of ['windows', 'portable', 'mac']) assert.equal(await pendingPage.locator(`[data-download="${target}"]`).getAttribute('href'), null);
  await pending.close();
  assert.deepEqual(errors, []);
  assert.deepEqual(unexpectedRequests, []);
  assert.equal(interceptedDownloads.filter(item => config.files.some(file => file.url === item.url)).length, 6);
  checks.push('Static output excludes stable-only redirect/header rules; default routing/source remain intact; zero console/page/HTTP errors and zero real external requests');
  const report = { passed: true, sourceCommit: config.sourceCommit, configSha256: createHash('sha256').update(rawConfig).digest('hex'), staticOutput: 'test-results/site-static-downloads', defaultOutput: 'test-results/site-preview', checks, consoleErrors: errors, externalNetworkRequests: unexpectedRequests, interceptedDownloads, scope: 'Local browser fixtures verify download selection and Content-Disposition only. This test does not upload or validate real remote package bytes, activate stable, or modify installed applications.' };
  if (process.env.XWX_SITE_STATIC_TEST_REPORT) { await mkdir(resolve(process.env.XWX_SITE_STATIC_TEST_REPORT, '..'), { recursive: true }); await writeFile(process.env.XWX_SITE_STATIC_TEST_REPORT, JSON.stringify(report, null, 2) + '\n'); }
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
