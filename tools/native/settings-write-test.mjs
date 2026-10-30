import assert from 'node:assert/strict';
import { mkdtemp, realpath, mkdir, readFile, writeFile, rm, readdir, symlink, lstat, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startNativeRpc } from './rpc-test-session.mjs';

const fixture = await mkdtemp(join(await realpath(tmpdir()), 'xwxdeck-settings-write-'));
const root = join(fixture, 'data'), path = join(root, 'settings.json');
let app;
const initial = { nativeMigrationVersion: 1, theme: 'day', connections: [], selected: { codex: null, claude: null }, traceWarningGB: 1, traceAutoCleanup: true, externalPreference: 'keep' };
try {
  await mkdir(root);
  app = startNativeRpc(root); await app.rpc('getState'); await app.stop();
  await writeFile(path, JSON.stringify(initial));
  app = startNativeRpc(root); await app.rpc('getState');
  await app.rpc('setTheme', 'night'); await app.rpc('setLanguage', 'zh-CN');
  assert.equal((await app.rpc('getState')).theme, 'night');
  const ownBytes = await readFile(path);
  const external = JSON.stringify({ ...initial, traceWarningGB: 7, traceAutoCleanup: false, externalPreference: 'newer' });
  await writeFile(path, external);
  const client = join(root, 'codex/config.toml');
  await writeFile(client, '# external client sentinel\nmodel = "keep"\n');
  for (const [method, args] of [
    ['setTheme', ['day']], ['setLanguage', ['en']],
    ['setTraceStoragePolicy', [{ limitGB: 2, autoCleanup: true }]],
    ['saveProvider', [{ displayName: 'Draft retained', baseUrl: 'http://127.0.0.1:9/v1', bearerToken: 'synthetic-only', adapter: 'responses' }]],
    ['updateCodexConfig', [{ officialModel: 'different-model' }]],
  ]) {
    await assert.rejects(app.rpc(method, ...args), /外部修改/);
    assert.equal(await readFile(path, 'utf8'), external, `${method} keeps the external document`);
    assert.equal(await readFile(client, 'utf8'), '# external client sentinel\nmodel = "keep"\n');
    assert.equal((await app.rpc('getState')).theme, 'night', 'failed preflight does not publish a false committed state');
  }
  await assert.rejects(app.rpc('setTheme', 'day'), /外部修改/, 'repeated retry cannot overwrite the conflict');
  await writeFile(path, ownBytes);
  await app.rpc('setTheme', 'day');
  await writeFile(path, external);
  await app.stop(); app = startNativeRpc(root);
  assert.equal((await app.rpc('getState')).traceWarningGB, 7);
  await app.rpc('setTheme', 'night'); await app.stop();
  app = startNativeRpc(root);
  assert.equal((await app.rpc('getState')).traceWarningGB, 7);
  assert.equal((await app.rpc('getState')).traceAutoCleanup, false);
  assert.equal((await app.rpc('getState')).theme, 'night');
  await app.rpc('saveProvider', { id: 'stop-conflict', displayName: 'Stop conflict', baseUrl: 'http://127.0.0.1:9/v1', bearerToken: 'synthetic-only', adapter: 'responses', codexModel: 'synthetic-model' });
  await app.rpc('switchClientProvider', { client: 'codex', providerId: 'stop-conflict' });
  const direct = await readFile(client, 'utf8');
  const running = await app.rpc('toggleTracing', true);
  const activeBytes = await readFile(path);
  await writeFile(path, external);
  await assert.rejects(app.rpc('toggleTracing', false), /外部修改/);
  assert.equal((await app.rpc('getState')).tracingEnabled, false, 'settings conflicts cannot prevent a safety stop');
  assert.equal(await readFile(client, 'utf8'), direct, 'stop restores the direct configuration before reporting the settings conflict');
  assert.equal(await readFile(path, 'utf8'), external);
  await assert.rejects(fetch(running.localBaseUrl + '/v1/responses'), /fetch failed/);
  await writeFile(path, activeBytes);
  await app.rpc('toggleTracing', true); await app.rpc('toggleTracing', false);
  assert.equal((await app.rpc('getState')).tracingEnabled, false, 'a conflict does not leave the toggle locked');
  await app.rpc('setTraceStoragePolicy', { limitGB: 2048, autoCleanup: false });
  await app.stop(); app = startNativeRpc(root);
  assert.equal((await app.rpc('getState')).traceWarningGB, 2048, 'an explicit capacity above 1 TB survives save and restart');
  assert.equal((await app.rpc('getState')).traceAutoCleanup, false);
  await app.stop();
  // Explicit repair uses the current broken document, backs it up, and does not
  // turn an ordinary conflict into a destructive repair.
  await writeFile(path, '{broken-synthetic'); app = startNativeRpc(root);
  await assert.rejects(app.rpc('setTheme', 'night'), /设置文件损坏/);
  const repair = await app.rpc('repairUnreadableSettings');
  assert.ok(repair.backupPath);
  await app.rpc('setTheme', 'night');
  assert.equal((await app.rpc('getState')).theme, 'night');
  console.log('PASS settings conflicts preserve external bytes, client files and committed state; retry, restart, safe Trace stop, unlocked restart and explicit backed-up repair');
  let history = await app.rpc('getBackupHistory');
  assert.ok(history.some(row => row.path === repair.backupPath && !row.canRestore));
  assert.ok(!history.some(row => /desktop-ledger|desktop-recovery|claude-desktop-sync-state/.test(row.path)));
  const archive = join(root, 'backups/settings-backup-history.json');
  await writeFile(archive, JSON.stringify({ ...initial, theme: 'day', externalPreference: 'restored' }));
  history = await app.rpc('getBackupHistory');
  const saved = history.find(row => row.path === archive);
  assert.equal(saved.canRestore, true);
  await app.rpc('setTheme', 'day');
  await assert.rejects(app.rpc('restoreBackup', saved), /已变化/);
  await app.rpc('setTheme', 'night');
  let current = (await app.rpc('getBackupHistory')).find(row => row.id === saved.id);
  await writeFile(archive, JSON.stringify({ ...initial, theme: 'day', externalPreference: 'latest backup' }));
  await assert.rejects(app.rpc('restoreBackup', current), /已变化/);
  current = (await app.rpc('getBackupHistory')).find(row => row.id === saved.id);
  const restore = await app.rpc('restoreBackup', current);
  assert.equal(restore.restored, true);
  const previous = (await app.rpc('getBackupHistory')).find(row => row.path === restore.backupPath);
  assert.equal(previous.sourceDigest, current.targetDigest, 'the backup preserves decoded content even when encrypted for a different document path');
  assert.equal((await app.rpc('getState')).theme, 'day');
  const reverted = await app.rpc('restoreBackup', previous);
  assert.equal(reverted.restored, true);
  assert.equal((await app.rpc('getState')).theme, 'night');
  assert.ok((await readdir(join(root, 'backups'))).some(name => name.startsWith('settings-before-restore-')));
  // Restored settings intentionally have no connection. Trace requires an
  // explicitly selected client route under the current empty-install contract.
  await app.rpc('saveProvider', { id: 'backup-guard', displayName: 'Backup guard fixture', baseUrl: 'http://127.0.0.1:9/v1', bearerToken: 'synthetic-only', adapter: 'responses', codexModel: 'synthetic-model' });
  await app.rpc('switchClientProvider', { client: 'codex', providerId: 'backup-guard' });
  await app.rpc('toggleTracing', true);
  assert.ok((await app.rpc('getBackupHistory')).every(row => !row.canRestore));
  await assert.rejects(app.rpc('restoreBackup', current), /先停止 Trace/);
  await app.rpc('toggleTracing', false);
  await assert.rejects(app.rpc('restoreBackup', { ...current, id: '../../settings.json' }), /已不存在/);
  const clientBefore = await readFile(client);
  await writeFile(join(root, 'backups/config-backup-link.toml'), 'model = "backup-fixture"\n');
  const linked = (await app.rpc('getBackupHistory')).find(row => row.path.endsWith('config-backup-link.toml'));
  await unlink(client);
  try {
    await symlink(join(root, 'missing-link-target'), client, process.platform === 'win32' ? 'junction' : 'file');
    await assert.rejects(app.rpc('restoreBackup', linked), /链接/);
    assert.ok((await lstat(client)).isSymbolicLink(), 'a dangling link cannot be silently replaced during restore');
  } finally { await unlink(client).catch(() => undefined); await writeFile(client, clientBefore); }
  console.log('PASS backup history, malformed archives, unified storage, pre-restore preservation, optimistic conflicts and Trace guard');
} finally { await app?.stop(); await rm(fixture, { recursive: true, force: true }); }
