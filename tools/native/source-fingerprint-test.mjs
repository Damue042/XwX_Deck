import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, realpath, mkdir, writeFile, readFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sourceFingerprint, verifyCandidate } from './source-fingerprint.mjs';

const root = await mkdtemp(join(await realpath(tmpdir()), 'xwxdeck-source-'));
try {
  execFileSync('git', ['init', '-q'], { cwd: root });
  await mkdir(join(root, 'src-native')); await mkdir(join(root, 'docs')); await mkdir(join(root, 'test-results'));
  const source = join(root, 'src-native/含空格 source.rs'); await writeFile(source, 'first input');
  const readinessPath = join(root, 'src-native/migration-status.json');
  const readySource = JSON.stringify({ version: 1, productionReady: true, blockers: [] }) + '\n';
  await writeFile(readinessPath, readySource);
  await writeFile(join(root, '.gitignore'), 'test-results/\n');
  execFileSync('git', ['add', '.'], { cwd: root });
  const first = await sourceFingerprint(root);
  const binary = join(root, 'test-results/binary'); await writeFile(binary, 'synthetic candidate');
  const report = { productionReady: false, commit: 'isolated-test-commit', sourceFingerprint: first.sha256, candidate: { bundleId: 'app.xwxdeck.validation', binarySha256: createHash('sha256').update(await readFile(binary)).digest('hex') } };
  assert.equal((await verifyCandidate({ root, report, binary })).isolated, true);
  const production = { ...report, platform:'darwin', arch:'arm64', buildMode:'production-candidate', candidateOnly:true,
    signed:'developer-id', notarized:true, validationOnly:false, cargoDefaultFeatures:true, cargoRequestedFeatures:[],
    candidate:{...report.candidate,bundleId:'app.xwxdeck.desktop',signatureVerified:true} };
  await assert.rejects(verifyCandidate({root,report:production,binary}),/不会启动或替换正式应用/);
  assert.equal((await verifyCandidate({root,report:production,binary,allowProductionCandidate:true})).buildMode,'production-candidate');
  for(const changes of [{candidateOnly:false},{buildMode:'production'},{notarized:false},{signed:'adhoc'},{platform:'win32'},{cargoRequestedFeatures:['manual-acceptance']},{cargoRequestedFeatures:['update-validation']}]){
    await assert.rejects(verifyCandidate({root,report:{...production,...changes},binary,allowProductionCandidate:true}),/不会启动或替换正式应用/);
  }
  const windows = { ...report, platform:'win32', arch:'x64', buildMode:'production-candidate', candidateOnly:true,
    validationOnly:false, cargoDefaultFeatures:true, cargoRequestedFeatures:[],
    candidate:{...report.candidate,bundleId:'app.xwxdeck.desktop',architecture:'x86_64',integrityLabel:'medium',signature:'NotSigned'} };
  await assert.rejects(verifyCandidate({root,report:windows,binary}));
  assert.equal((await verifyCandidate({root,report:windows,binary,allowProductionCandidate:true})).buildMode,'production-candidate');
  for(const changes of [{validationOnly:true},{candidateOnly:false},{cargoRequestedFeatures:['manual-acceptance']},{platform:'linux'},{arch:'arm64'},
    {candidate:{...windows.candidate,integrityLabel:'high'}},{candidate:{...windows.candidate,signature:'HashMismatch'}}]){
    await assert.rejects(verifyCandidate({root,report:{...windows,...changes},binary,allowProductionCandidate:true}));
  }
  let productionChecks = 0;
  const finalMac = { ...production, buildMode: 'production', productionReady: true, dirty: false, candidateOnly: false };
  const finalWindows = { ...windows, buildMode: 'production', productionReady: true, dirty: false, candidateOnly: false };
  const rejectProduction = async (report, options = {}, pattern) => {
    await assert.rejects(verifyCandidate({ root, report, binary, allowProduction: true, ...options }), pattern);
    productionChecks++;
  };
  for (const final of [finalMac, finalWindows]) {
    await assert.rejects(verifyCandidate({ root, report: final, binary }));
    productionChecks++;
    await rejectProduction(final, { allowProduction: false });
    await rejectProduction(final, { allowProduction: 'true' });
    await rejectProduction(final, { allowProduction: false, allowProductionCandidate: true, allowManualAcceptance: true });
    const verified = await verifyCandidate({ root, report: final, binary, allowProduction: true });
    assert.equal(verified.buildMode, 'production');
    assert.equal(verified.isolated, true);
    productionChecks++;
    for (const changes of [
      { productionReady: false }, { productionReady: undefined }, { productionReady: 'true' },
      { dirty: true }, { dirty: undefined }, { dirty: 'false' },
      { candidateOnly: true }, { candidateOnly: undefined },
      { validationOnly: true }, { validationOnly: undefined },
      { cargoDefaultFeatures: false }, { cargoDefaultFeatures: undefined },
      { cargoRequestedFeatures: ['manual-acceptance'] }, { cargoRequestedFeatures: ['update-validation'] },
      { cargoRequestedFeatures: undefined }, { cargoRequestedFeatures: {} },
      { buildMode: 'production-candidate' }, { buildMode: undefined }, { platform: 'linux' },
      { candidate: { ...final.candidate, bundleId: 'app.xwxdeck.validation' } },
      { candidate: { ...final.candidate, bundleId: 'other.application' } }, { candidate: undefined }
    ]) await rejectProduction({ ...final, ...changes });
  }
  for (const changes of [{ signed: 'adhoc' }, { notarized: false },
    { candidate: { ...finalMac.candidate, signatureVerified: false } }]) {
    await rejectProduction({ ...finalMac, ...changes });
  }
  for (const changes of [{ arch: 'arm64' },
    { candidate: { ...finalWindows.candidate, architecture: 'aarch64' } },
    { candidate: { ...finalWindows.candidate, integrityLabel: 'high' } },
    { candidate: { ...finalWindows.candidate, signature: 'HashMismatch' } }]) {
    await rejectProduction({ ...finalWindows, ...changes });
  }
  for (const value of [false, 'true', 1, null, undefined]) {
    await writeFile(readinessPath, JSON.stringify({ productionReady: value }));
    // Match the changed source fingerprint so this rejection specifically tests Ready.
    await rejectProduction({ ...finalMac, sourceFingerprint: (await sourceFingerprint(root)).sha256 });
  }
  await rm(readinessPath);
  const withoutReadyFingerprint = (await sourceFingerprint(root)).sha256;
  await rejectProduction({ ...finalMac, sourceFingerprint: withoutReadyFingerprint });
  // Existing isolated/manual/candidate paths still work without a Ready file.
  for (const [legacyReport, options] of [
    [report, {}], [production, { allowProductionCandidate: true }],
    [windows, { allowProductionCandidate: true }],
    [{ ...report, buildMode: 'manual-acceptance', candidate: { ...report.candidate, bundleId: 'app.xwxdeck.desktop' } }, { allowManualAcceptance: true }]
  ]) {
    assert.equal((await verifyCandidate({ root, report: { ...legacyReport, sourceFingerprint: withoutReadyFingerprint }, binary, ...options })).isolated, true);
    productionChecks++;
  }
  await writeFile(readinessPath, '{invalid json');
  await rejectProduction({ ...finalMac, sourceFingerprint: (await sourceFingerprint(root)).sha256 });
  await writeFile(readinessPath, readySource);
  await rejectProduction({ ...finalMac, sourceFingerprint: undefined }, {}, /缺少源码指纹/);
  await rejectProduction({ ...finalMac, sourceFingerprint: '0'.repeat(64) }, {}, /当前本地源码不一致/);
  await rejectProduction({ ...finalMac, candidate: { ...finalMac.candidate, binarySha256: '0'.repeat(64) } }, {}, /可执行文件与构建清单不一致/);
  await writeFile(join(root, 'docs/progress.md'), 'Documentation-only checkpoint');
  assert.equal((await sourceFingerprint(root)).sha256, first.sha256);
  await writeFile(join(root, 'test-results/other-output'), 'ignored build output');
  assert.equal((await sourceFingerprint(root)).sha256, first.sha256);
  await writeFile(source, 'uncommitted latest input');
  await assert.rejects(verifyCandidate({ root, report, binary }), /当前本地源码不一致/);
  await writeFile(source, 'first input');
  const latest = join(root, 'src-native/untracked.rs'); await writeFile(latest, 'new source');
  await assert.rejects(verifyCandidate({ root, report, binary }), /当前本地源码不一致/); await rm(latest);
  await rm(source); assert.notEqual((await sourceFingerprint(root)).sha256, first.sha256);
  await writeFile(source, 'first input');
  await writeFile(binary, 'modified executable');
  await assert.rejects(verifyCandidate({ root, report, binary }), /可执行文件与构建清单不一致/);
  await rejectProduction(finalMac, {}, /可执行文件与构建清单不一致/);
  await assert.rejects(verifyCandidate({ root, report: { ...report, sourceFingerprint: undefined }, binary }), /缺少源码指纹/);
  await assert.rejects(verifyCandidate({ root, report: { ...report, candidate: { bundleId: 'app.xwxdeck.desktop' } }, binary }), /不会启动或替换正式应用/);
  if (process.platform === 'win32') {
    // Junctions need no Developer Mode or administrator privilege. Git can
    // traverse them, so this also exercises ancestor-link rejection.
    await symlink(join(root, 'test-results'), join(root, 'src-native/linked'), 'junction');
  } else await symlink(binary, join(root, 'src-native/linked.rs'));
  await assert.rejects(sourceFingerprint(root), /不是普通文件/);
  console.log(JSON.stringify({ passed: true, checks: 28 + productionChecks, productionChecks, scope: 'isolated temporary Git repository, synthetic artifact bytes and platform trust reports; no app launch, OS signing verification or installed files touched' }));
} finally { await rm(root, { recursive: true, force: true }); }
