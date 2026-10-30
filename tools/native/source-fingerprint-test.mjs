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
  await assert.rejects(verifyCandidate({ root, report: { ...report, sourceFingerprint: undefined }, binary }), /缺少源码指纹/);
  await assert.rejects(verifyCandidate({ root, report: { ...report, candidate: { bundleId: 'app.xwxdeck.desktop' } }, binary }), /不会启动或替换正式应用/);
  if (process.platform === 'win32') {
    // Junctions need no Developer Mode or administrator privilege. Git can
    // traverse them, so this also exercises ancestor-link rejection.
    await symlink(join(root, 'test-results'), join(root, 'src-native/linked'), 'junction');
  } else await symlink(binary, join(root, 'src-native/linked.rs'));
  await assert.rejects(sourceFingerprint(root), /不是普通文件/);
  console.log(JSON.stringify({ passed: true, checks: 28, scope: 'isolated temporary Git repository, synthetic artifact bytes; no app launch or installed files touched' }));
} finally { await rm(root, { recursive: true, force: true }); }
