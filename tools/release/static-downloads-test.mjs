import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash, generateKeyPairSync} from 'node:crypto';
import {mkdtemp, mkdir, readFile, writeFile, readdir, rm, symlink, lstat, realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve, dirname, basename} from 'node:path';
import {signManifest} from './update-signature.mjs';
import {validateStaticDownloads, prepareStaticDownloads, publishStaticDownloads} from './static-downloads.mjs';

// All packages, signing keys, acceptance receipts and HTTP responses in this
// file are synthetic. Nothing imports the production trust file or uses fetch.
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const clone = value => structuredClone(value);
const definitions = [
  ['windows', 'windows', 'x64', 'installer', 'XwX-Deck-windows-x64-setup.exe'],
  ['portable', 'windows', 'x64', 'portable', 'XwX-Deck-windows-x64.exe'],
  ['mac', 'darwin', 'arm64', 'disk-image', 'XwX-Deck-mac-arm64.dmg']
];

async function fixture(t) {
  const base = await realpath(resolve(process.env.XWX_STATIC_DOWNLOAD_TEST_TMPDIR ?? tmpdir()));
  const root = await mkdtemp(join(base, 'xwx-static-download-test-'));
  const resolvedRoot = await realpath(root);
  assert.equal(dirname(resolvedRoot), base);
  assert.ok(basename(resolvedRoot).startsWith('xwx-static-download-test-'));
  t.after(async () => {
    assert.equal(await realpath(root), resolvedRoot, 'Temporary cleanup target changed');
    assert.equal(dirname(resolvedRoot), base, 'Cleanup must remain inside its test parent');
    await rm(resolvedRoot, {recursive: true, force: true});
  });
  const sourceDirectory = join(root, 'candidate'), directory = join(root, 'static');
  await mkdir(sourceDirectory);
  const sourceCommit = 'a'.repeat(40), fingerprint = 'b'.repeat(64);
  const payloads = new Map(definitions.map(([, , , , name], index) => [name, Buffer.from(`synthetic package ${index}: ${name}\n`)]));
  const files = definitions.map(([target, platform, arch, kind, name]) => ({
    target, platform, arch, kind, name,
    size: payloads.get(name).length, sha256: hash(payloads.get(name)), sourceFingerprint: fingerprint
  }));
  const manifest = {
    schemaVersion: 1, channel: 'release', releaseSeries: 'native-v1', version: '1.0.0', tag: 'v1.0.0',
    candidate: {schemaVersion: 1, only: true, commit: sourceCommit, sourceFingerprint: fingerprint},
    files: files.map(({target, sourceFingerprint, ...file}) => ({...file, url: `https://download.xwxdeck.com/candidates/${sourceCommit}/${file.name}`}))
  };
  const pair = generateKeyPairSync('ed25519');
  const trust = {keys: [{id: 'ephemeral-test-only', publicKey: pair.publicKey.export({format: 'der', type: 'spki'}).subarray(-32).toString('base64')}]};
  const envelope = signManifest(manifest, pair.privateKey, 'ephemeral-test-only', {candidateId: sourceCommit});
  const envelopeBytes = Buffer.from(JSON.stringify(envelope) + '\n');
  const config = {schemaVersion: 1, version: '1.0.0', sourceCommit, candidateEnvelopeSha256: hash(envelopeBytes), files};
  const candidateAcceptance = {
    passed: true, candidateOnly: true, commit: sourceCommit, sourceFingerprint: fingerprint,
    files: files.map(file => ({...file, passed: true, commit: sourceCommit, buildMode: 'production',
      cargoDefaultFeatures: true, cargoRequestedFeatures: [], signed: 'developer-id', notarized: true}))
  };
  const acceptance = {passed: true, version: config.version, sourceCommit,
    files: files.map(file => ({...file, passed: true})),
    windowsNormalGui: {passed: true, binarySha256: files.find(file => file.target === 'portable').sha256,
      receiptSha256: hash(Buffer.from('synthetic GUI receipt, not actual platform acceptance'))}};
  for (const [name, bytes] of payloads) await writeFile(join(sourceDirectory, name), bytes);
  await writeFile(join(sourceDirectory, 'release.json'), envelopeBytes);
  await writeFile(join(sourceDirectory, 'candidate-acceptance.json'), JSON.stringify(candidateAcceptance));
  const options = {config, sourceDirectory, directory, trust};
  return {root, payloads, manifest, pair, envelope, config, trust, candidateAcceptance, acceptance,
    sourceDirectory, directory,
    async prepare() {return prepareStaticDownloads(options);},
    async publish(remote, overrides = {}) {
      return publishStaticDownloads({config, directory, trust, acceptance, upload: true, singleWriter: true, ...remote, ...overrides});
    }};
}

function fakeRemote(hooks = {}) {
  const bytes = new Map(), calls = [], puts = [], counts = new Map();
  const remote = {bytes, calls, puts, counts,
    fetchPublic: async (url, options = {}) => {
      const method = options.method ?? 'GET';
      assert.equal(options.redirect, 'error');
      assert.equal(options.cache, 'no-store');
      assert.match(url, /^https:\/\/download\.xwxdeck\.com\/releases\/v1\.0\.0\//);
      const countKey = `${method} ${url}`, count = (counts.get(countKey) ?? 0) + 1;
      counts.set(countKey, count); calls.push({method, url, count});
      await hooks.fetch?.({url, method, count, remote});
      const value = bytes.get(url);
      // Deliberately unhelpful metadata: acceptance must hash the full GET body.
      return value === undefined ? new Response(null, {status: 404})
        : new Response(method === 'HEAD' ? null : value, {status: 200, headers: {'content-length': '999999'}});
    },
    uploader: {async put(object) {
      puts.push(object.key);
      const value = object.bytes ?? await readFile(object.path);
      await hooks.put?.({object, value, remote});
      if (!hooks.replacePut) bytes.set(object.url, Buffer.from(value));
    }}
  };
  return remote;
}

async function seedRemote(f, remote, plan) {
  for (const object of plan.objects) remote.bytes.set(object.url, await readFile(object.path));
}
async function noRemoteOnReject(f, overrides) {
  const remote = fakeRemote();
  await assert.rejects(f.publish(remote, overrides));
  assert.equal(remote.calls.length, 0, 'rejected local evidence must not even probe the remote');
  assert.equal(remote.puts.length, 0);
}

test('static names preserve all 64 hash digits and exactly the three supported targets', async t => {
  const f = await fixture(t), actual = validateStaticDownloads(f.config);
  for (const file of actual.files) {
    assert.ok(file.staticName.includes(file.sha256));
    assert.equal(file.staticName.match(/[a-f0-9]{64}/g)?.length, 1);
    assert.equal(file.checksumName, `${file.staticName}.sha256`);
    assert.equal(file.url, `https://download.xwxdeck.com/releases/v1.0.0/${file.staticName}`);
    assert.equal(actual.downloads[file.target], file.url);
  }
  for (const mutate of [
    c => {c.files[2].arch = 'x64';},
    c => {c.files[2].target = 'intel';},
    c => {c.files[0].name = '../escape.exe';},
    c => {c.files[0].target = c.files[1].target;},
    c => {c.files[0].sha256 = 'a'.repeat(12);},
    c => {c.version = '../1.0.0';},
    c => {c.sourceCommit = '../' + 'a'.repeat(37);}
  ]) {const bad = clone(f.config); mutate(bad); assert.throws(() => validateStaticDownloads(bad));}
});

test('preparation preserves source, creates seven exact objects, and is byte-idempotent', async t => {
  const f = await fixture(t), sourceBefore = new Map();
  for (const name of await readdir(f.sourceDirectory)) sourceBefore.set(name, hash(await readFile(join(f.sourceDirectory, name))));
  const plan = await f.prepare();
  assert.equal(plan.objects.length, 7);
  assert.equal(plan.staticDownloadsOnly, true);
  assert.equal(plan.standardUpdaterNamesWritten, false);
  assert.equal(plan.stableTouched, false);
  assert.equal(plan.cas, false);
  assert.equal(plan.conditionalPut, false);
  for (const object of plan.objects) {
    const bytes = await readFile(object.path);
    assert.equal(bytes.length, object.size); assert.equal(hash(bytes), object.sha256);
    assert.ok(!object.key.endsWith('/release.json'));
    assert.ok(!object.key.includes('/updates/'));
  }
  for (const file of validateStaticDownloads(f.config).files) {
    assert.equal(await readFile(join(f.directory, file.checksumName), 'utf8'), `${file.sha256}  ${file.name}\n`);
    await assert.rejects(lstat(join(f.directory, file.name)), {code: 'ENOENT'});
  }
  const before = new Map();
  for (const name of await readdir(f.directory)) before.set(name, hash(await readFile(join(f.directory, name))));
  assert.deepEqual(await f.prepare(), plan);
  for (const [name, expected] of before) assert.equal(hash(await readFile(join(f.directory, name))), expected);
  for (const [name, expected] of sourceBefore) assert.equal(hash(await readFile(join(f.sourceDirectory, name))), expected);
  assert.equal(hash(await readFile(join(f.directory, 'static-candidate-envelope.json'))), f.config.candidateEnvelopeSha256);
  assert.deepEqual(JSON.parse(await readFile(join(f.directory, 'static-candidate-acceptance.json'), 'utf8')), f.candidateAcceptance);
  const pending = JSON.parse(await readFile(join(f.directory, 'static-downloads-acceptance.pending.json'), 'utf8'));
  assert.equal(pending.passed, false); assert.equal(pending.windowsNormalGui.passed, false);
  assert.equal(pending.windowsNormalGui.receiptSha256, null);
  assert.equal(pending.files.length, 3);
  await noRemoteOnReject(f, {acceptance: pending});
});

test('a signed package version cannot be relabeled by changing the static configuration', async t => {
  const f = await fixture(t);
  await assert.rejects(prepareStaticDownloads({config: {...f.config, version: '1.0.1'}, sourceDirectory: f.sourceDirectory, directory: f.directory, trust: f.trust}));
  await assert.rejects(lstat(f.directory), {code: 'ENOENT'});
});

test('invalid signatures and wrong production provenance fail before any stage write', async t => {
  const f = await fixture(t), originalRaw = await readFile(join(f.sourceDirectory, 'release.json'));
  const forged = clone(f.envelope); forged.signature = Buffer.alloc(64, 7).toString('base64');
  const badBytes = Buffer.from(JSON.stringify(forged));
  await writeFile(join(f.sourceDirectory, 'release.json'), badBytes);
  await assert.rejects(prepareStaticDownloads({config: {...f.config, candidateEnvelopeSha256: hash(badBytes)}, sourceDirectory: f.sourceDirectory, directory: f.directory, trust: f.trust}), /signature/i);
  await assert.rejects(lstat(f.directory), {code: 'ENOENT'});
  await writeFile(join(f.sourceDirectory, 'release.json'), originalRaw);
  for (const mutate of [
    a => {a.passed = false;},
    a => {a.files[0].buildMode = 'manual-acceptance';},
    a => {a.files[0].buildMode = 'production-candidate';},
    a => {a.files[1].cargoRequestedFeatures = ['manual-acceptance'];},
    a => {a.files[1].cargoDefaultFeatures = false;},
    a => {a.files[2].notarized = false;},
    a => {a.files[0].sourceFingerprint = 'c'.repeat(64);}
  ]) {
    const bad = clone(f.candidateAcceptance); mutate(bad);
    await writeFile(join(f.sourceDirectory, 'candidate-acceptance.json'), JSON.stringify(bad));
    await assert.rejects(f.prepare());
    await assert.rejects(lstat(f.directory), {code: 'ENOENT'});
  }
  await writeFile(join(f.sourceDirectory, 'candidate-acceptance.json'), JSON.stringify(f.candidateAcceptance));
  await writeFile(join(f.sourceDirectory, f.config.files[0].name), 'different package bytes');
  await assert.rejects(f.prepare(), /integrity/i);
  await assert.rejects(lstat(f.directory), {code: 'ENOENT'});
});

test('different staged bytes and a symlinked stage are preserved without overwrite', async t => {
  const f = await fixture(t), validated = validateStaticDownloads(f.config);
  await mkdir(f.directory);
  const last = join(f.directory, validated.files.at(-1).staticName);
  await writeFile(last, 'unrelated existing bytes');
  await assert.rejects(f.prepare(), /differs/i);
  assert.equal(await readFile(last, 'utf8'), 'unrelated existing bytes');
  assert.deepEqual(await readdir(f.directory), [validated.files.at(-1).staticName]);
  const outside = join(f.root, 'unrelated-stage'); await mkdir(outside);
  const linked = join(f.root, 'linked-stage');
  await symlink(outside, linked, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(prepareStaticDownloads({config: f.config, sourceDirectory: f.sourceDirectory, directory: linked, trust: f.trust}), /real directory/i);
  assert.deepEqual(await readdir(outside), []);
});

test('pre-existing metadata conflicts prevent all package writes', async t => {
  const f = await fixture(t); await mkdir(f.directory);
  const path = join(f.directory, 'static-downloads-plan.json');
  await writeFile(path, 'existing unrelated metadata');
  await assert.rejects(f.prepare(), /metadata differs/i);
  assert.deepEqual(await readdir(f.directory), ['static-downloads-plan.json']);
  assert.equal(await readFile(path, 'utf8'), 'existing unrelated metadata');
});

test('Windows case aliases cannot turn the candidate source into its own destination', {skip: process.platform !== 'win32'}, async t => {
  const f = await fixture(t), before = (await readdir(f.sourceDirectory)).sort();
  await assert.rejects(prepareStaticDownloads({config: f.config, sourceDirectory: f.sourceDirectory, directory: f.sourceDirectory.toUpperCase(), trust: f.trust}));
  assert.deepEqual((await readdir(f.sourceDirectory)).sort(), before);
});

test('dry-run is local-only and GUI/source/package gates reject before any network operation', async t => {
  const f = await fixture(t); await f.prepare(); const remote = fakeRemote();
  const dry = await f.publish(remote, {upload: false, acceptance: undefined, singleWriter: false});
  assert.equal(dry.uploaded, false); assert.equal(remote.calls.length, 0); assert.equal(remote.puts.length, 0);
  const rejected = [undefined,
    {...f.acceptance, passed: false},
    {...f.acceptance, sourceCommit: 'c'.repeat(40)},
    {...f.acceptance, windowsNormalGui: undefined},
    {...f.acceptance, windowsNormalGui: {...f.acceptance.windowsNormalGui, passed: false}},
    {...f.acceptance, windowsNormalGui: {...f.acceptance.windowsNormalGui, binarySha256: 'd'.repeat(64)}},
    {...f.acceptance, windowsNormalGui: {...f.acceptance.windowsNormalGui, receiptSha256: undefined}},
    {...f.acceptance, files: f.acceptance.files.slice(1)},
    {...f.acceptance, files: f.acceptance.files.map((file, i) => i ? file : {...file, sourceFingerprint: 'e'.repeat(64)})}
  ];
  for (const acceptance of rejected) await noRemoteOnReject(f, {acceptance});
  await noRemoteOnReject(f, {singleWriter: false});
});

test('a truthy nonboolean upload argument cannot become permission for remote writes', async t => {
  const f = await fixture(t); await f.prepare();
  for (const upload of ['false', 'true', 1]) {
    const remote = fakeRemote();
    try {await f.publish(remote, {upload});} catch { /* Invalid flag types may fail closed. */ }
    assert.equal(remote.calls.length, 0, 'only upload === true authorizes remote activity');
    assert.equal(remote.puts.length, 0);
  }
});

test('publish revalidates saved signed provenance instead of trusting a mutable static plan', async t => {
  const f = await fixture(t); await f.prepare();
  const path = join(f.directory, 'static-candidate-envelope.json');
  const original = await readFile(path); await writeFile(path, '{"schemaVersion":1}');
  await noRemoteOnReject(f, {}); await writeFile(path, original);
  const acceptancePath = join(f.directory, 'static-candidate-acceptance.json');
  const originalAcceptance = await readFile(acceptancePath), bad = JSON.parse(originalAcceptance);
  bad.files[0].buildMode = 'manual-acceptance'; await writeFile(acceptancePath, JSON.stringify(bad));
  await noRemoteOnReject(f, {}); await writeFile(acceptancePath, originalAcceptance);
  await noRemoteOnReject(f, {trust: {keys: []}});
  await rm(acceptancePath); await noRemoteOnReject(f, {});
});

test('foreign or corrupt recovery journal entries are rejected before probing the remote', async t => {
  const f = await fixture(t), plan = await f.prepare(), first = plan.objects[0];
  const path = join(f.directory, 'static-downloads-publish-journal.json');
  for (const [key, value] of [
    ['updates/stable/release.json', {phase: 'verified', sha256: first.sha256, size: first.size}],
    [first.key, {phase: 'verified', sha256: '0'.repeat(64), size: first.size}],
    [first.key, {phase: 'verified', sha256: first.sha256, size: first.size + 1}],
    [first.key, {phase: 'completed-without-verification', sha256: first.sha256, size: first.size}]
  ]) {
    const journal = {schemaVersion: 1, sourceCommit: f.config.sourceCommit, version: f.config.version, objects: {[key]: value}};
    const raw = JSON.stringify(journal); await writeFile(path, raw);
    await noRemoteOnReject(f, {});
    assert.equal(await readFile(path, 'utf8'), raw, 'invalid prior journal must be retained for diagnosis');
  }
});

test('full preflight GET hashes every existing object and a last-object conflict causes zero PUTs', async t => {
  const f = await fixture(t), plan = await f.prepare(), remote = fakeRemote();
  await seedRemote(f, remote, plan);
  const last = plan.objects.at(-1), changed = Buffer.from(remote.bytes.get(last.url)); changed[0] ^= 1;
  remote.bytes.set(last.url, changed);
  await assert.rejects(f.publish(remote), /different bytes/i);
  assert.equal(remote.puts.length, 0);
  assert.equal(remote.calls.filter(call => call.method === 'GET').length, 7);
  assert.deepEqual(remote.bytes.get(last.url), changed);
});

test('identical existing objects are fully read and skipped without writing', async t => {
  const f = await fixture(t), plan = await f.prepare(), remote = fakeRemote();
  await seedRemote(f, remote, plan);
  const result = await f.publish(remote);
  assert.equal(result.objectsWritten, 0); assert.equal(result.publicBytesVerified, true);
  assert.equal(remote.puts.length, 0);
  for (const object of plan.objects) assert.ok((remote.counts.get(`GET ${object.url}`) ?? 0) >= 2);
});

for (const sameBytes of [true, false]) test(`object appearing between preflight and PUT is ${sameBytes ? 'read and reused' : 'preserved as a conflict'}`, async t => {
  const f = await fixture(t), plan = await f.prepare(), first = plan.objects[0];
  const original = await readFile(first.path), raced = sameBytes ? original : Buffer.from('concurrent different object');
  const remote = fakeRemote({fetch({url, method, count, remote}) {
    if (url === first.url && method === 'HEAD' && count === 2) remote.bytes.set(url, raced);
  }});
  if (sameBytes) {
    const result = await f.publish(remote); assert.equal(result.objectsWritten, 6);
    assert.ok(!remote.puts.includes(first.key));
  } else {
    await assert.rejects(f.publish(remote), /different bytes/i); assert.equal(remote.puts.length, 0);
  }
  assert.deepEqual(remote.bytes.get(first.url), raced);
});

test('successful upload writes only seven immutable static objects and verifies every public byte', async t => {
  const f = await fixture(t), plan = await f.prepare(), remote = fakeRemote();
  const result = await f.publish(remote);
  assert.equal(result.objectsWritten, 7); assert.equal(result.publicBytesVerified, true);
  assert.equal(result.stableTouched, false); assert.equal(result.cas, false);
  assert.equal(remote.puts.length, 7);
  for (const object of plan.objects) {
    assert.ok(object.key.startsWith('releases/v1.0.0/'));
    assert.equal(hash(remote.bytes.get(object.url)), object.sha256);
    assert.ok(remote.calls.some(call => call.url === object.url && call.method === 'GET'));
  }
  assert.equal((await f.publish(remote)).objectsWritten, 0);
  assert.equal(remote.puts.length, 7, 'a verified retry cannot duplicate immutable PUTs');
});

test('a PUT that succeeded remotely then threw leaves a journal and resumes without duplicate PUT', async t => {
  const f = await fixture(t), plan = await f.prepare(), first = plan.objects[0]; let failed = false;
  const remote = fakeRemote({put({object, value, remote}) {
    if (!failed) {failed = true; remote.bytes.set(object.url, Buffer.from(value)); throw Error('synthetic lost upload response');}
  }});
  await assert.rejects(f.publish(remote), /lost upload response/);
  const journal = JSON.parse(await readFile(join(f.directory, 'static-downloads-publish-journal.json'), 'utf8'));
  assert.equal(journal.objects[first.key].phase, 'uncertain');
  const result = await f.publish(remote); assert.equal(result.objectsWritten, 6);
  assert.equal(remote.puts.filter(key => key === first.key).length, 1);
  assert.equal(remote.puts.length, 7);
});

test('an invisible or uncertain prior PUT is not blindly retried on a later invocation', async t => {
  for (const throws of [false, true]) {
    const f = await fixture(t), plan = await f.prepare(), first = plan.objects[0];
    const remote = fakeRemote({replacePut: true, put() {if (throws) throw Error('synthetic transport uncertainty');}});
    await assert.rejects(f.publish(remote));
    const journal = JSON.parse(await readFile(join(f.directory, 'static-downloads-publish-journal.json'), 'utf8'));
    assert.ok(['uploading', 'uncertain'].includes(journal.objects[first.key].phase));
    const previousPuts = remote.puts.length;
    await assert.rejects(f.publish(remote), /uncertain|reconcile/i);
    assert.equal(remote.puts.length, previousPuts, '404 visibility is not proof that the original PUT cannot still finish');
    // A later complete GET proving the exact bytes permits safe recovery.
    for (const object of plan.objects) remote.bytes.set(object.url, await readFile(object.path));
    assert.equal((await f.publish(remote)).objectsWritten, 0);
    assert.equal(remote.puts.length, previousPuts);
  }
});

test('local mutation after remote preflight is rejected before PUT', async t => {
  const f = await fixture(t), plan = await f.prepare(), first = plan.objects[0];
  const remote = fakeRemote({async fetch({url, method, count}) {
    if (url === first.url && method === 'HEAD' && count === 2) await writeFile(first.path, 'changed during preflight');
  }});
  await assert.rejects(f.publish(remote), /changed before PUT/i);
  assert.equal(remote.puts.length, 0);
});

test('the local lock rejects a concurrent caller but does not claim a remote CAS', {timeout: 15000}, async t => {
  const f = await fixture(t); await f.prepare();
  let release, announce;
  const gate = new Promise(resolve => {release = resolve;}), entered = new Promise(resolve => {announce = resolve;});
  let held = false;
  const remote = fakeRemote({async fetch() {if (!held) {held = true; announce(); await gate;}}});
  const first = f.publish(remote);
  try {await entered; await assert.rejects(f.publish(remote), {code: 'EEXIST'});}
  finally {release();}
  const result = await first;
  assert.equal(result.objectsWritten, 7);
  assert.equal(result.cas, false); assert.equal(result.conditionalPut, false); assert.equal(result.singleWriterRequired, true);
  await assert.rejects(lstat(join(f.directory, '.static-downloads-publish.lock')), {code: 'ENOENT'});
});

function syntheticOwnerWaiver(f) {
  const acceptance = clone(f.acceptance);
  acceptance.passed = false;
  acceptance.releaseApproved = true;
  acceptance.functionalEvidencePassed = true;
  acceptance.windowsNormalGui = {
    status: 'waived', performed: false, passed: false, receiptSha256: null,
    binarySha256: f.config.files.find(file => file.target === 'portable').sha256,
    waiver: {
      authority: 'product-owner', scope: 'static-manual-downloads',
      version: f.config.version, sourceCommit: f.config.sourceCommit,
      reason: 'Synthetic scope-decision fixture; no actual GUI run or permission grant.',
      decisionEvidenceSha256: hash(Buffer.from('synthetic owner decision')),
      substituteEvidenceSha256: [hash(Buffer.from('synthetic exact-source functional evidence'))]
    }
  };
  return acceptance;
}

test('an exact owner waiver approves seven static objects while retaining GUI not-performed status', async t => {
  const f = await fixture(t); await f.prepare();
  const acceptance = syntheticOwnerWaiver(f), remote = fakeRemote();
  const dry = await f.publish(remote, {acceptance, upload: false});
  assert.equal(remote.calls.length, 0); assert.equal(remote.puts.length, 0);
  assert.equal(dry.normalWindowsGuiStatus, 'waived'); assert.equal(dry.normalWindowsGuiPassed, false);
  assert.equal(dry.manualDownloadReleaseApproved, true);
  const result = await f.publish(remote, {acceptance});
  assert.equal(result.objectsWritten, 7); assert.equal(remote.puts.length, 7);
  assert.equal(result.normalWindowsGuiStatus, 'waived'); assert.equal(result.normalWindowsGuiPassed, false);
  assert.equal(result.manualDownloadReleaseApproved, true);
  assert.equal(result.stableTouched, false); assert.equal(result.updateManifestWritten, false);
  assert.equal(acceptance.passed, false); assert.equal(acceptance.windowsNormalGui.performed, false);
  assert.equal(acceptance.windowsNormalGui.passed, false); assert.equal(acceptance.windowsNormalGui.receiptSha256, null);
  const journal = JSON.parse(await readFile(join(f.directory, 'static-downloads-publish-journal.json'), 'utf8'));
  assert.equal(journal.normalWindowsGuiStatus, 'waived');
});

test('wrong waiver scope/source or missing owner evidence rejects before any remote request', async t => {
  const f = await fixture(t); await f.prepare();
  for (const mutate of [
    a => {a.windowsNormalGui.waiver.scope = 'automatic-updates';},
    a => {a.windowsNormalGui.waiver.sourceCommit = 'c'.repeat(40);},
    a => {delete a.windowsNormalGui.waiver.decisionEvidenceSha256;},
    a => {a.windowsNormalGui.binarySha256 = 'd'.repeat(64);}
  ]) {
    const acceptance = syntheticOwnerWaiver(f); mutate(acceptance);
    await noRemoteOnReject(f, {acceptance});
  }
});

test('a waived GUI cannot be relabeled as a successful performed or overall test', async t => {
  const f = await fixture(t); await f.prepare();
  for (const mutate of [
    a => {a.windowsNormalGui.passed = true;},
    a => {a.passed = true;},
    a => {a.passed = true; a.windowsNormalGui.passed = true; a.windowsNormalGui.receiptSha256 = hash(Buffer.from('synthetic fake performed receipt'));}
  ]) {
    const acceptance = syntheticOwnerWaiver(f); mutate(acceptance);
    await noRemoteOnReject(f, {acceptance});
  }
});
