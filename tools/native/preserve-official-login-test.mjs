import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createServer as createSecureServer } from 'node:https';
import { existsSync, unlinkSync } from 'node:fs';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, realpath, mkdir, readFile, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'smol-toml';
import { WebSocketServer } from 'ws';
import { startNativeRpc } from './rpc-test-session.mjs';

const root = await mkdtemp(join(await realpath(tmpdir()), 'xwx-official-login-'));
const home = join(root, 'codex'), workspace = join(root, 'workspace');
const checks = [], requests = [];
const keyA = 'synthetic-key-a', keyB = 'synthetic-key-b';
const jwt = 'e30.' + Buffer.from(JSON.stringify({
  email: 'fixture@example.test', exp: 2000000000,
  'https://api.openai.com/auth': { chatgpt_account_id: 'fixture-account', chatgpt_plan_type: 'plus' },
})).toString('base64url') + '.fixture';
const realRead = process.argv.includes('--real-read-only');
const sourceAuth = realRead ? join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'auth.json') : null;
const originalAuth = sourceAuth ? await readFile(sourceAuth) : null;
const auth = sourceAuth ? JSON.parse(originalAuth) : {
  auth_mode: 'chatgpt', tokens: { id_token: jwt, access_token: jwt, refresh_token: 'synthetic-refresh', account_id: 'fixture-account' },
  last_refresh: new Date().toISOString(),
};
// Actual account inspection uses an access-only copy; the source remains untouched.
if (realRead) auth.tokens = { ...auth.tokens, refresh_token: '' };
const authBytes = JSON.stringify(auth);
const cli = process.env.XWX_DECK_INSTALLED_CODEX
  || (process.platform === 'win32' ? join(homedir(), 'AppData/Roaming/npm/node_modules/@openai/codex/bin/codex.js') : join(homedir(), '.local/bin/codex'));
const hasCli = cli && await access(cli).then(() => true, () => false);
if (realRead && !hasCli) throw Error('An installed Codex CLI is required for real account inspection');
const command = hasCli && cli.endsWith('.js') ? process.execPath : cli;
const cliPrefix = hasCli && cli.endsWith('.js') ? [cli] : [];
let app, passed = false, count = 0;
const handleRequest = async (req, res) => {
  if(req.url === '/official/api/codex/accounts/check'){res.setHeader('content-type','application/json');res.end(JSON.stringify({accounts:[{id:auth.tokens?.account_id??'fixture-account',workspace_backend_origin:'NO_CONSTRAINT',account_routing_override:'NO_CONSTRAINT',plan_type:'plus',name:'Synthetic workspace'}]}));return;}
  let raw = ''; for await (const chunk of req) raw += chunk;
  if (req.url.endsWith('/models')) {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ data: [{ id: 'fixture-model', context_window: 32768, tool_calling: false }] }));
    return;
  }
  if (!raw) { res.setHeader('content-type','application/json'); res.end('{}'); return; }
  if (!req.url.includes('/responses')) { res.writeHead(403); res.end('Unsupported fixture route'); return; }
  const body = JSON.parse(raw);
  requests.push({ path: req.url, auth: req.headers.authorization, body });
  const id = 'fixture-response-' + ++count;
  const item = { id: 'message-' + count, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'official-login-preserved', annotations: [] }] };
  const response = { id, object: 'response', status: 'completed', model: body.model, output: [item], usage: { input_tokens: 2, output_tokens: 2, total_tokens: 4 } };
  if (!body.stream) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(response)); return; }
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const event of [
    { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
    { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } },
    { type: 'response.content_part.added', item_id: item.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
    { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: 'official-login-preserved' },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response },
  ]) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  res.end();
};
const server = createServer(handleRequest);
const sockets = new WebSocketServer({ noServer: true });
server.on('connect', (_req, socket) => socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'));
server.on('upgrade', (req, socket, head) => {
  if (!req.url.includes('/responses')) { socket.destroy(); return; }
  sockets.handleUpgrade(req, socket, head, ws => ws.on('message', bytes => {
    const body = JSON.parse(bytes.toString());
    requests.push({ path: req.url, auth: req.headers.authorization, body });
    const id = 'fixture-response-' + ++count;
    const item = { id: 'message-' + count, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'official-login-preserved', annotations: [] }] };
    const response = { id, object: 'response', status: 'completed', model: body.model, output: [item], usage: { input_tokens: 2, output_tokens: 2, total_tokens: 4 } };
    for (const event of [
      { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
      { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } },
      { type: 'response.content_part.added', item_id: item.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
      { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: 'official-login-preserved' },
      { type: 'response.output_item.done', output_index: 0, item },
      { type: 'response.completed', response },
    ]) ws.send(JSON.stringify(event));
  }));
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}`;

// Current app-server account/read requires HTTPS workspace discovery.
// This ephemeral CA is trusted only by the spawned CLI, never by the OS.
const tls=await mkdtemp(join(await realpath(tmpdir()),'xwx-official-login-tls-'));
const caKey=join(tls,'ca.key'),serverKey=join(tls,'server.key');
const cleanTLS=()=>{for(const file of [caKey,serverKey])if(existsSync(file))unlinkSync(file);};
process.once('exit',cleanTLS);
await writeFile(join(tls,'ca.cnf'),'[req]\ndistinguished_name=dn\nx509_extensions=ca\nprompt=no\n[dn]\nCN=XwX isolated CLI fixture\n[ca]\nbasicConstraints=critical,CA:TRUE,pathlen:0\nkeyUsage=critical,keyCertSign,cRLSign\n');
await writeFile(join(tls,'tls.cnf'),'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=IP:127.0.0.1\n');
function openssl(args){const result=spawnSync(process.platform==='darwin'?'/usr/bin/openssl':'openssl',args,{stdio:'ignore'});assert.equal(result.status,0,'ephemeral TLS fixture generation failed');}
openssl(['req','-x509','-newkey','rsa:2048','-nodes','-keyout',caKey,'-out',join(tls,'ca.pem'),'-days','1','-config',join(tls,'ca.cnf')]);
openssl(['req','-new','-newkey','rsa:2048','-nodes','-keyout',serverKey,'-out',join(tls,'server.csr'),'-subj','/CN=127.0.0.1']);
openssl(['x509','-req','-in',join(tls,'server.csr'),'-CA',join(tls,'ca.pem'),'-CAkey',caKey,'-CAcreateserial','-out',join(tls,'server.pem'),'-days','1','-extfile',join(tls,'tls.cnf')]);
const controlServer=createSecureServer({key:await readFile(serverKey),cert:await readFile(join(tls,'server.pem'))},handleRequest);cleanTLS();
controlServer.listen(0,'127.0.0.1');await once(controlServer,'listening');
const controlBase=`https://127.0.0.1:${controlServer.address().port}`;

const cliEnv = { ...process.env, CODEX_HOME: home, HOME: workspace, USERPROFILE: workspace, OPENAI_API_KEY: '', CODEX_API_KEY: '',
  HTTP_PROXY: base, HTTPS_PROXY: base, ALL_PROXY: base, NO_PROXY: '127.0.0.1,localhost',
  http_proxy: base, https_proxy: base, all_proxy: base, no_proxy: '127.0.0.1,localhost',
  DISABLE_TELEMETRY: '1' };
for (const key of Object.keys(cliEnv)) {
  if (/^(?:CODEX_|OPENAI_)/.test(key) && key !== 'CODEX_HOME') delete cliEnv[key];
}
cliEnv.CODEX_CA_CERTIFICATE=join(tls,'ca.pem');
const config = async () => parse(await readFile(join(home, 'config.toml'), 'utf8'));
const pass = message => { checks.push(message); console.log('PASS ' + message); };
async function account() {
  if (!hasCli) return;
  const child = spawn(command, [...cliPrefix, 'app-server', '-c', 'cli_auth_credentials_store="file"'], { cwd: workspace, env: cliEnv, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = ''; child.stderr.on('data', bytes => { stderr = (stderr + bytes).slice(-4000); });
  let sequence = 0; const pending = new Map();
  createInterface({ input: child.stdout }).on('line', line => {
    const value = JSON.parse(line); pending.get(value.id)?.(value); pending.delete(value.id);
  });
  const call = (method, params) => new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => reject(Error(method + ' timeout: '+stderr.slice(-1500))), 15000);
    pending.set(id, value => { clearTimeout(timer); resolve(value); });
    child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  });
  try {
    await call('initialize', { clientInfo: { name: 'xwx-official-login-test', version: '1' } });
    child.stdin.write(JSON.stringify({method:'initialized'}) + '\n');
    const loaded = await call('config/read', { includeLayers: false, cwd: workspace });
    assert.equal(loaded.error, undefined, loaded.error?.message);
    assert.equal(loaded.result.config.model_provider, (await config()).model_provider);
    const result = await call('account/read', { refreshToken: false });
    assert.equal(result.error, undefined);
    return result.result;
  } finally { child.kill(); await once(child, 'exit'); }
}
async function cliReply(args) {
  const child = spawn(command, [...cliPrefix, ...args], { cwd: workspace, env: cliEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', errors = '';
  child.stdout.on('data', bytes => output += bytes); child.stderr.on('data', bytes => errors += bytes);
  const timer = setTimeout(() => child.kill(), 30000);
  try { const [code] = await once(child, 'exit'); assert.equal(code, 0, errors.slice(-1000)); assert.ok(output.includes('official-login-preserved'), output.slice(-1000)); return output; }
  finally { clearTimeout(timer); }
}
try {
  app = startNativeRpc(root); await app.rpc('getState'); await app.stop(); await mkdir(workspace);
  await mkdir(home, { recursive: true });
  await writeFile(join(home, 'auth.json'), authBytes);
  await writeFile(join(home, 'config.toml'), `model_provider="openai"\nmodel="fixture-model"\nopenai_base_url="${base}/official"\nchatgpt_base_url="${controlBase}/official"\n[analytics]\nenabled=false\n`);
  app = startNativeRpc(root); await app.rpc('getState');
  for (const [id, key] of [['relay-a', keyA], ['relay-b', keyB]]) {
    await app.rpc('saveProvider', { id, displayName: id, baseUrl: base + '/' + id, bearerToken: key, adapter: 'responses', codexModel: 'fixture-model' });
  }
  for (const preserve of [true, false]) for (const unify of [false, true]) {
    await app.rpc('updateCodexEnhancements', { preserveOfficialLogin: preserve, unifySessionHistory: unify });
    const selected = await app.rpc('switchClientProvider', { client: 'codex', providerId: 'relay-a' });
    let saved = await config();
    assert.equal(saved.model_provider, preserve ? 'openai' : unify ? 'xwx_deck' : 'relay-a');
    if (preserve) {
      assert.equal(saved.model_providers?.openai, undefined);
      assert.equal(saved.openai_base_url, base + '/official');
      assert.equal(selected.traceRequired, true);
    } else {
      assert.equal(saved.model_providers[saved.model_provider].base_url, base + '/relay-a');
    }
    if (hasCli) {
      const login = await account();
      assert.equal(login.requiresOpenaiAuth, preserve);
      assert.equal(login.account?.type ?? null, preserve ? 'chatgpt' : null);
    }
    const runtime = await app.rpc('toggleTracing', true);
    saved = await config(); assert.equal(saved.model_provider, preserve ? 'openai' : 'xwx_deck');
    if (preserve) assert.equal(saved.openai_base_url, runtime.localBaseUrl + '/v1');
    await app.rpc('switchClientProvider', { client: 'codex', providerId: 'relay-b' });
    assert.equal((await config()).model_provider, preserve ? 'openai' : 'xwx_deck');
    const response = await fetch(runtime.localBaseUrl + '/v1/responses', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + jwt, 'x-codex-thread-id': 'fixture-thread' },
      body: JSON.stringify({ model: 'fixture-model', input: 'continue the same test thread' }),
    });
    assert.equal(response.status, 200); await response.text();
    assert.equal(requests.at(-1).path, '/relay-b/responses'); assert.equal(requests.at(-1).auth, 'Bearer ' + keyB);
    if (hasCli) {
      const login = await account(); assert.equal(login.account?.type ?? null, preserve ? 'chatgpt' : null);
    }
    await app.rpc('toggleTracing', false);
    assert.equal((await config()).model_provider, preserve ? 'openai' : unify ? 'xwx_deck' : 'relay-b');
    assert.equal(await readFile(join(home, 'auth.json'), 'utf8'), authBytes);
    pass(`preserve=${preserve}, history=${unify}: direct, Trace, service switch and stop agree${hasCli ? ' with actual account state' : '; actual account inspection remains untested'}`);
  }
  await app.rpc('updateCodexEnhancements', { preserveOfficialLogin: true, unifySessionHistory: false });
  if (hasCli && !realRead) {
    await app.rpc('switchClientProvider', { client: 'codex', providerId: 'relay-a' });
    await app.rpc('toggleTracing', true);
    const marker = 'xwx-login-context-' + Date.now();
    const output = await cliReply(['exec', '--skip-git-repo-check', '--sandbox', 'read-only', '--json', '-c', 'features.responses_websockets=false', `Remember ${marker}. Reply briefly without tools.`]);
    assert.equal(requests.at(-1).auth, 'Bearer ' + keyA);
    const thread = output.split('\n').filter(Boolean).map(line => JSON.parse(line)).find(event => event.type === 'thread.started')?.thread_id;
    assert.ok(thread);
    await app.rpc('switchClientProvider', { client: 'codex', providerId: 'relay-b' });
    await cliReply(['exec', 'resume', '--skip-git-repo-check', '--json', thread, 'Continue the original conversation without tools.']);
    assert.equal(requests.at(-1).auth, 'Bearer ' + keyB);
    assert.ok(JSON.stringify(requests.at(-1).body).includes(marker));
    assert.equal((await account()).account?.type, 'chatgpt');
    await app.rpc('toggleTracing', false);
    pass('actual installed Codex resumes the same native thread after a service switch, retains context and official login, and sends only the selected service key upstream');
  }
  const running = await app.rpc('toggleTracing', true);
  await app.rpc('updateCodexEnhancements', { preserveOfficialLogin: false });
  assert.equal((await config()).model_provider, 'xwx_deck');
  if (hasCli) assert.equal((await account()).account, null);
  await app.rpc('updateCodexEnhancements', { preserveOfficialLogin: true });
  assert.equal((await config()).model_provider, 'openai');
  assert.equal((await app.rpc('getState')).localBaseUrl, running.localBaseUrl);
  if (hasCli) assert.equal((await account()).account?.type, 'chatgpt');
  const managed = await readFile(join(home, 'config.toml'), 'utf8');
  const external = managed.replace(/^openai_base_url[ \t]*=[^\r\n]*/m, `openai_base_url = "${base}/external-choice"`);
  assert.notEqual(external, managed);
  await writeFile(join(home, 'config.toml'), external);
  await assert.rejects(app.rpc('toggleTracing', false), /外部配置变化/);
  assert.equal((await app.rpc('getState')).backgroundGatewayActive, true);
  await writeFile(join(home, 'config.toml'), managed);
  await app.rpc('toggleTracing', false);
  assert.equal(await readFile(join(home, 'auth.json'), 'utf8'), authBytes);
  pass('toggling preservation while Trace runs keeps the listener and selection; external URL changes block restoration without changing login');
  if (hasCli && !realRead) {
    await app.rpc('updateCodexEnhancements', { preserveOfficialLogin: false });
    await cliReply(['exec', '--skip-git-repo-check', '--sandbox', 'read-only', '--json', '--ephemeral', 'Reply briefly without tools.']);
    assert.equal(requests.at(-1).auth, 'Bearer ' + keyB);
    assert.equal(requests.at(-1).path, '/relay-b/responses');
    assert.equal((await account()).account, null);
    await app.rpc('updateCodexEnhancements', { preserveOfficialLogin: true });
    assert.equal((await account()).account?.type, 'chatgpt');
    pass('disabling preservation retains actual native direct service calls; enabling it again restores the same official account');
  }
  await app.stop(); app = startNativeRpc(root); await app.rpc('getState');
  assert.equal((await config()).model_provider, 'openai');
  if (hasCli) assert.equal((await account()).account?.type, 'chatgpt');
  assert.equal(await readFile(join(home, 'auth.json'), 'utf8'), authBytes);
  await app.rpc('switchClientProvider', { client: 'codex', providerId: null });
  assert.equal((await config()).model_provider, 'openai');
  assert.equal((await config()).openai_base_url, base + '/official');
  if (sourceAuth) assert.deepEqual(await readFile(sourceAuth), originalAuth);
  pass('restart and explicit return to official preserve the account, original official URL and exact source credentials');
  passed = true;
  console.log(JSON.stringify({ passed, checks, installedCodex: !!hasCli, accountReadStatus: hasCli ? 'passed' : 'not-run', realAccountReadOnly: realRead, scope: 'isolated native backend; local upstream only; account/read never refreshes credentials' }));
} finally {
  await app?.stop();
  controlServer.closeAllConnections();await new Promise(resolve=>controlServer.close(resolve));cleanTLS();await rm(tls,{recursive:true,force:true});
  for (const socket of sockets.clients) socket.terminate();
  await new Promise(resolve => sockets.close(resolve));
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  if (passed) await rm(root, { recursive: true, force: true });
  else console.error('Failed fixture retained: ' + root);
}
