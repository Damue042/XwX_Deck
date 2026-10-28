import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, realpath, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { verifyCandidate } from './source-fingerprint.mjs';

const binary = resolve(process.env.XWX_NATIVE_TEST_BINARY ?? (process.platform === 'win32' ? 'test-results/native-package/XwX Deck.exe' : 'test-results/rust-pilot-package/XwXDeck Rust Validation.app/Contents/MacOS/xwxdeck-native'));
const build = JSON.parse(await readFile(resolve(process.env.XWX_NATIVE_TEST_BUILD_REPORT ?? (process.platform === 'win32' ? 'test-results/native-package/native-build-report.json' : 'test-results/rust-pilot-package/native-build-report.json')), 'utf8'));
const provenance = await verifyCandidate({ root: resolve('.'), report: build, binary, allowManualAcceptance: Boolean(process.env.XWX_NATIVE_TEST_BINARY && process.env.XWX_NATIVE_TEST_BUILD_REPORT) });
const root = await mkdtemp(join(await realpath(tmpdir()), 'xwx-window-lifecycle-'));
await writeFile(join(root,'.xwx-rust-pilot'),'isolated-rust-pilot-v1\n');
const coldStart=process.env.XWX_WINDOW_COLD_START==='1';
if(coldStart){
  const {build}=await import('esbuild');
  const compiled=await build({stdin:{contents:"export {storageKeys} from './src/shared/edition.ts'",resolveDir:resolve('.')},bundle:true,platform:'node',format:'esm',write:false});
  const {storageKeys}=await import('data:text/javascript;base64,'+Buffer.from(compiled.outputFiles[0].text).toString('base64'));
  await writeFile(join(root,'renderer-preferences-legacy-v1.json'),JSON.stringify({version:1,status:'absent',values:{[storageKeys.onboarding]:'true','xwx-deck:settings:trace:expanded:v1':'false'}}));
}
const installations=join(root,'installations');
await mkdir(join(installations,'.local/bin'),{recursive:true});
for(const name of ['claude','codex'])await writeFile(join(installations,'.local/bin',process.platform==='win32'?name+'.cmd':name),'isolated installed-client fixture',{mode:0o755});
const fixtureEnv={...process.env,XWX_CLIENT_INSTALLATIONS_TEST_HOME:installations};
let child, passed = false;
try {
  // An isolated, uncontacted loopback provider permits Trace lifecycle checks.
  for (const [method, args] of [
    ['addModelClient', ['claude']],
    ['addModelClient', ['codex']],
    ['saveProvider', [{ displayName: 'Window_Fixture', baseUrl: 'http://127.0.0.1:9/v1', bearerToken: 'isolated-window-key', adapter: 'responses', codexModel: 'window-model' }]],
    ['switchClientProvider', [{ client: 'codex', providerId: 'Window_Fixture' }]]
  ]) {
    const result = spawnSync(binary, ['--rpc', '--pilot-root', root], { input: JSON.stringify({ method, args }) + '\n', encoding: 'utf8', env: fixtureEnv });
    assert.equal(result.status, 0, result.stderr);
    const reply = JSON.parse(result.stdout.trim());
    assert.ok(reply.ok, JSON.stringify(reply));
  }
  child = spawn(binary, ['--pilot-root', root, '--smoke', '--smoke-window-lifecycle', ...(coldStart?['--smoke-renderer-preferences']:[]), '--smoke-exit'], {
    env: { ...process.env, XWX_SYSTEM_LANGUAGE_TEST: 'zh-CN', XWX_CLIENT_INSTALLATIONS_TEST_HOME: installations },
    stdio: ['ignore', 'ignore', 'inherit']
  });
  let report;
  let activated = false;
  for (let i = 0; i < 900; i++) {
    const progress = await readFile(join(root, 'native-smoke-progress.json'), 'utf8').then(JSON.parse, () => null);
    if (!activated && progress?.pending === 'activate-existing-window') {
      const missing = spawnSync(binary, ['--pilot-root', join(root, 'missing-host'), '--activate-existing'], { encoding: 'utf8', timeout: 5000 });
      assert.equal(missing.status, 2, 'another data root cannot activate this host');
      const sessionFile = join(root, 'native-auth-session.json');
      const session = await readFile(sessionFile, 'utf8');
      try {
        const invalid = { ...JSON.parse(session), secret: 'invalid-fixture-proof' };
        await writeFile(sessionFile, JSON.stringify(invalid));
        const denied = spawnSync(binary, ['--pilot-root', root, '--activate-existing'], { encoding: 'utf8', timeout: 5000 });
        assert.equal(denied.status, 2, 'invalid local proof cannot activate this host');
      } finally { await writeFile(sessionFile, session); }
      const second = spawnSync(binary, ['--pilot-root', root, '--activate-existing'], { encoding: 'utf8', timeout: 5000 });
      assert.equal(second.status, 0, second.stderr);
      assert.equal(child.exitCode, null, 'original host remains alive');
      activated = true;
    }
    report = await readFile(join(root, 'native-smoke.json'), 'utf8').then(JSON.parse, () => undefined);
    if (report) break;
    if (child.exitCode !== null || child.signalCode !== null) throw Error('Native host exited before reporting');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(report, 'Native window lifecycle test timed out');
  assert.equal(activated, true, 'test launched a second real process');
  const binarySha256 = createHash('sha256').update(await readFile(binary)).digest('hex');
  const startupTimings = JSON.parse(await readFile(join(root, 'startup-timings.json'), 'utf8'));
  assert.equal(startupTimings.pid, child.pid);
  assert.ok(startupTimings.pageLoadMs >= startupTimings.backendReadyMs);
  assert.ok(startupTimings.backendReadyMs >= startupTimings.backendOpenMs);
  const result = { ...report, ...provenance, binarySha256, startupTimings };
  if (process.env.XWX_WINDOW_TEST_REPORT) await writeFile(process.env.XWX_WINDOW_TEST_REPORT, JSON.stringify(result, null, 2) + '\n');
  assert.equal(report.passed, true, JSON.stringify(report));
  if (child.exitCode === null) {
    const ended = once(child, 'exit');
    const timeout = setTimeout(() => child.kill('SIGTERM'), 10_000);
    const [code] = await ended;
    clearTimeout(timeout);
    assert.equal(code, 0, 'Native host must exit cleanly after stopping Trace');
  }
  const restarted = spawnSync(binary, ['--rpc', '--pilot-root', root], { input: JSON.stringify({ method: 'getModelClients', args: [] }) + '\n', encoding: 'utf8', env: fixtureEnv });
  assert.equal(restarted.status, 0, restarted.stderr);
  assert.deepEqual(JSON.parse(restarted.stdout.trim()).result, ['codex']);
  result.checks.push('removed Claude remains absent after native process restart');
  if (process.env.XWX_WINDOW_TEST_REPORT) await writeFile(process.env.XWX_WINDOW_TEST_REPORT, JSON.stringify(result, null, 2) + '\n');
  passed = true;
  console.log(JSON.stringify(result, null, 2));
} finally {
  if (child && child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); }
  if (passed) await rm(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 });
  else console.error('Failed window fixture retained at ' + root);

}
