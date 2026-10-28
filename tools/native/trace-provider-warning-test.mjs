import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startNativeRpc } from './rpc-test-session.mjs';

const root = await mkdtemp(join(tmpdir(), 'xwx-trace-provider-warning-'));
const app = startNativeRpc(root);
try {
  await app.rpc('saveProvider', {
    id: 'trace-required', displayName: 'Trace prerequisite fixture',
    baseUrl: 'http://127.0.0.1:9/v1', adapter: 'chat-completions',
    bearerToken: 'synthetic', codexModel: 'fixture-model'
  });
  for (const client of ['codex', 'claude']) {
    const saved = await app.rpc('switchClientProvider', { client, providerId: 'trace-required' });
    assert.match(saved.warning, /需要开启 Trace/);
  }
  await app.rpc('updateClaudeModels', { sonnet: 'fixture-model' });
  const started = await app.rpc('toggleTracing', true);
  for (let repeat = 0; repeat < 2; repeat++) {
    for (const client of ['codex', 'claude']) {
      for (const providerId of [null, 'trace-required']) {
        const saved = await app.rpc('switchClientProvider', { client, providerId });
        assert.doesNotMatch(saved.warning ?? '', /需要开启 Trace/, `${client}: active Trace must resolve its prerequisite`);
        assert.equal(saved.selected[client], providerId);
        const state = await app.rpc('getState');
        assert.equal(state.tracingEnabled, true);
        assert.equal(state.localBaseUrl, started.localBaseUrl, 'keep the live Gateway listener');
      }
    }
  }
  await app.rpc('toggleTracing', false);
  assert.match((await app.rpc('switchClientProvider', { client: 'claude', providerId: 'trace-required' })).warning, /需要开启 Trace/);
  console.log('PASS active provider switches clear the temporary Trace prerequisite; disabled Trace still offers it');
} finally {
  await app.stop();
  await rm(root, { recursive: true, force: true });
}
