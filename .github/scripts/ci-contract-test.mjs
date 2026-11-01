import assert from 'node:assert/strict';
import {mkdtemp, readFile, rmdir, unlink} from 'node:fs/promises';
import {execFileSync, spawnSync} from 'node:child_process';
import {resolve, join} from 'node:path';
import {tmpdir} from 'node:os';
import test from 'node:test';
import {parse} from 'yaml';
import {cacheIdentity, dependencyManifest} from './ci-cache-identity.mjs';
import {ciWorkflowFailures, statusFunctionContextFailures} from './ci-contract.mjs';

const root = resolve(import.meta.dirname, '../..');
const workflow = parse(await readFile(resolve(root, '.github/workflows/ci.yml'), 'utf8'));
const bash = process.platform === 'win32'
  ? resolve(execFileSync('git', ['--exec-path'], {encoding:'utf8'}).trim(), '../../../bin/bash.exe')
  : '/bin/bash';
const runShell = (script, env) => {
  const run = spawnSync(bash, ['-c', script], {encoding:'utf8', env:{...process.env,...env}, windowsHide:true});
  assert.ifError(run.error);
  return run;
};
const base = {
  os:'Windows', arch:'X64', mode:'isolated-release',
  rustc:'rustc 1.92.0 (abc 2026-10-29)\ncommit-hash: abc\nhost: x86_64-pc-windows-msvc\n',
  manifest:'[package]\nname = "test-app"\nversion = "1.0.1"\n[features]\ndefault = ["custom-protocol"]\nmanual-acceptance = []\n',
  lock:'version = 4\n[[package]]\nname = "test-app"\nversion = "1.0.1"\n',
};

test('cache isolates OS, architecture, exact toolchain, mode, manifest/features and compiler flags', () => {
  const identity = cacheIdentity(base);
  for (const changed of [
    {os:'macOS'}, {arch:'ARM64'}, {mode:'quality-debug'},
    {rustc:base.rustc.replace('commit-hash: abc','commit-hash: def')},
    {manifest:base.manifest.replace('default = ["custom-protocol"]','default = ["manual-acceptance"]')},
    {flags:'--cfg other_mode'}, {target:'aarch64-apple-darwin'},
  ]) {
    const other = cacheIdentity({...base, ...changed});
    assert.notEqual(other.key, identity.key);
    assert.notEqual(other.restoreKey, identity.restoreKey);
  }
});

test('lock changes only share a dependency-compatible fallback, never the exact key', () => {
  const old = cacheIdentity(base);
  const updated = cacheIdentity({...base, lock:base.lock+'checksum = "different"\n'});
  assert.notEqual(updated.key, old.key);
  assert.equal(updated.restoreKey, old.restoreKey);
  assert.ok(updated.key.startsWith(updated.restoreKey));
  const newVersion = cacheIdentity({...base, manifest:base.manifest.replace('1.0.1','1.0.2'), lock:base.lock.replace('1.0.1','1.0.2')});
  assert.notEqual(newVersion.key, old.key);
  assert.equal(newVersion.restoreKey, old.restoreKey);
  assert.equal(cacheIdentity({...base, manifest:base.manifest.replace(/\n/g,'\r\n'), lock:base.lock.replace(/\n/g,'\r\n')}).key, old.key);
});

test('unrecognized identity inputs fail closed', () => {
  for (const changed of [{os:''}, {arch:'X64\nkey=injected'}, {mode:'manual-acceptance'}, {rustc:''}, {lock:''}]) {
    assert.throws(() => cacheIdentity({...base, ...changed}));
  }
  assert.throws(() => dependencyManifest('[package]\nname="missing-version"\n'));
  assert.throws(() => dependencyManifest('[package]\nversion.workspace=true\n'));
});

test('workflow keeps full coverage on every path and guards existing required job names', () => {
  assert.deepEqual(ciWorkflowFailures(workflow), []);
  assert.equal(workflow.jobs.validate.name, 'Validate source');
  assert.equal(workflow.jobs['platform-compile'].name, 'Compile on ${{ matrix.os }}');
  for (const event of ['push', 'pull_request']) {
    assert.equal(workflow.on[event].paths, undefined);
    assert.equal(workflow.on[event]['paths-ignore'], undefined);
  }
});

test('status functions are accepted only in GitHub-supported job/step if contexts', () => {
  assert.deepEqual(statusFunctionContextFailures(workflow), []);
  for (const fn of ['cancelled','always','success','failure']) {
    const expression = `\${{ ${fn}() }}`;
    assert.deepEqual(statusFunctionContextFailures({jobs:{check:{if:expression,steps:[{if:expression}]}}}), []);
    for (const location of ['env','run','with','name','job-env','job-name','outputs','workflow-env']) {
      const step = {run:'echo checked'};
      const value = {jobs:{check:{steps:[step]}}};
      if (location === 'job-env') value.jobs.check.env = {INVALID:expression};
      else if (location === 'job-name') value.jobs.check.name = expression;
      else if (location === 'outputs') value.jobs.check.outputs = {invalid:expression};
      else if (location === 'workflow-env') value.env = {INVALID:expression};
      else step[location] = ['env','with'].includes(location) ? {INVALID:expression} : expression;
      assert.equal(statusFunctionContextFailures(value).length, 1, `${fn}/${location}`);
    }
  }
  assert.deepEqual(statusFunctionContextFailures({jobs:{check:{steps:[{env:{JOB_STATUS:'${{ job.status }}',LABEL:"${{ format('cancelled()') }}"},run:'echo cancelled()'}]}}}), []);
  const invalidOriginal = structuredClone(workflow);
  invalidOriginal.jobs.validate.steps[0].env.JOB_STATUS = '${{ cancelled() }}';
  assert.ok(ciWorkflowFailures(invalidOriginal).some(message=>message.includes('status functions are only supported')));
});

test('upstream failure/cancel/skip/unknown does not start expensive work or pass required guards', () => {
  for (const name of ['validate','platform-compile']) {
    assert.equal(workflow.jobs[name].if, '${{ always() }}');
    const gate = workflow.jobs[name].steps[0];
    for (const result of ['success','failure','cancelled','skipped','','unexpected']) {
      for (const status of ['success','failure','cancelled','','unknown']) {
        const run = runShell(gate.run, {PREFLIGHT_RESULT:result,JOB_STATUS:status});
        assert.equal(run.status, result === 'success' && status === 'success' ? 0 : 1, `${name}: ${result}/${status}`);
      }
    }
  }
});

test('completion guards reject cancellation after the first guard and every missing mandatory step', () => {
  for (const [name, extra] of [['validate',{QUALITY_RESULT:'success',DOCS_RESULT:'success'}], ['platform-compile',{BUILD_RESULT:'success',BACKEND_RESULT:'success',WINDOWS_REPEAT_RESULT:'success',MAC_WEBVIEW_RESULT:'success'}]]) {
    const final = workflow.jobs[name].steps.at(-1);
    const baseEnv = {PREFLIGHT_RESULT:'success',JOB_STATUS:'success',RUNNER_OS:'Windows',...extra};
    assert.equal(runShell(final.run, baseEnv).status, 0);
    assert.equal(runShell(final.run, {...baseEnv,JOB_STATUS:'failure'}).status, 1);
    assert.equal(runShell(final.run, {...baseEnv,JOB_STATUS:'cancelled'}).status, 1);
    assert.equal(runShell(final.run, {...baseEnv,JOB_STATUS:''}).status, 1);
    assert.equal(runShell(final.run, {...baseEnv,JOB_STATUS:'unknown'}).status, 1);
    for (const key of ['PREFLIGHT_RESULT',...Object.keys(extra)]) {
      // Windows does not run Mac WebView; Mac does not repeat Windows-only suites.
      const os = key === 'MAC_WEBVIEW_RESULT' ? 'macOS' : 'Windows';
      for (const result of ['failure','cancelled','skipped','','unknown']) {
        assert.equal(runShell(final.run, {...baseEnv,RUNNER_OS:os,[key]:result}).status, 1, `${name}/${key}/${result}`);
      }
    }
    if (name === 'platform-compile') {
      assert.equal(runShell(final.run, {...baseEnv,RUNNER_OS:'macOS',WINDOWS_REPEAT_RESULT:'skipped'}).status, 0);
      assert.equal(runShell(final.run, {...baseEnv,MAC_WEBVIEW_RESULT:'skipped'}).status, 0);
      assert.equal(runShell(final.run, {...baseEnv,RUNNER_OS:'unknown'}).status, 1);
    }
  }
});

test('workflow regressions cannot bypass builds, native checks, cache identity or status reporting', () => {
  const mutations = [
    w => { delete w.jobs.validate.needs; },
    w => { w.jobs.validate.if = '${{ success() }}'; },
    w => { w.jobs.validate.steps[0].run = 'exit 0'; },
    w => { w.jobs['platform-compile'].steps.find(s=>s.id==='native-build').if = "steps.native-cache.outputs.cache-hit != 'true'"; },
    w => { w.jobs['platform-compile'].strategy.matrix.os = ['windows-latest']; },
    w => { w.jobs['platform-compile'].steps = w.jobs['platform-compile'].steps.filter(s=>s.run !== 'node tools/native/native-test.mjs'); },
    w => { w.jobs['platform-compile'].if = 'contains(changed, "src/")'; },
    w => { w.permissions.contents = 'write'; },
    w => { w.jobs.validate.steps.find(s=>s.uses?.startsWith('actions/cache/restore@')).with.path += '\n~/.codex'; },
    w => { w.jobs.validate.steps.find(s=>s.uses?.startsWith('actions/cache/restore@')).with['restore-keys'] = 'legacy-cache-'; },
    w => { w.jobs.summary.steps.at(-1).run = 'echo passed'; },
    w => { delete w.jobs.summary.steps.at(-1).if; },
    w => { w.jobs.summary.steps.shift(); },
    w => { w.jobs.validate['continue-on-error'] = true; },
    w => { w.jobs['platform-compile'].steps.find(s=>s.id==='backend').if = false; },
    w => { w.jobs['platform-compile'].steps.find(s=>s.id==='windows-regressions').if = false; },
    w => { w.jobs.validate['timeout-minutes'] = 1; },
    w => { w.jobs['platform-compile']['timeout-minutes'] = 1; },
    w => { w.jobs['platform-compile'].steps.find(s=>s.uses?.startsWith('actions/checkout@')).if = '${{ always() }}'; },
    w => { w.jobs['platform-compile'].steps.at(-1).if = '${{ !cancelled() }}'; },
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(workflow); mutate(changed);
    assert.ok(ciWorkflowFailures(changed).length > 0);
  }
});

test('always-run summary reports actual fail/cancel/not-run/unknown and cannot go green on cancellation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'xwx-ci-status-'));
  const file = join(directory, 'summary.md');
  const cancellation = workflow.jobs.summary.steps[0];
  const summary = workflow.jobs.summary.steps.at(-1);
  assert.equal(workflow.jobs.summary.if, '${{ always() }}');
  assert.equal(workflow.jobs.summary.steps.length, 2, 'Cancellation reporting must not fetch sources or install tools');
  assert.equal(cancellation.if, '${{ cancelled() }}');
  assert.equal(runShell(cancellation.run, {}).status, 1, 'The legal cancelled() sentinel must fail if it is selected');
  const baseEnv = {PREFLIGHT_RESULT:'success',SOURCE_RESULT:'success',PLATFORM_RESULT:'success',JOB_STATUS:'success',CANCELLATION_GUARD_RESULT:'skipped',GITHUB_STEP_SUMMARY:file.replaceAll('\\','/')};
  const labels = {success:'pass',failure:'fail',cancelled:'cancel',skipped:'not-run',waived:'unknown','':'unknown'};
  try {
    for (const [result,label] of Object.entries(labels)) for (const key of ['PREFLIGHT_RESULT','SOURCE_RESULT','PLATFORM_RESULT']) {
      const run = runShell(summary.run, {...baseEnv,[key]:result});
      assert.equal(run.status, result === 'success' ? 0 : 1);
      assert.ok((await readFile(file,'utf8')).includes(`| ${label} |`));
      await unlink(file);
    }
    for (const status of ['failure','cancelled','','unknown']) {
      assert.equal(runShell(summary.run, {...baseEnv,JOB_STATUS:status}).status, 1);
      assert.ok((await readFile(file,'utf8')).includes(`| summary job | ${status === 'cancelled' ? 'cancel' : status === 'failure' ? 'fail' : 'unknown'} |`));
      await unlink(file);
    }
    // Every upstream job and the local job status can still be successful when
    // workflow cancellation selects the explicit cancelled() sentinel.
    for (const outcome of ['failure','cancelled','success','','unknown']) {
      assert.equal(runShell(summary.run, {...baseEnv,CANCELLATION_GUARD_RESULT:outcome}).status, 1);
      assert.ok((await readFile(file,'utf8')).includes(`| cancellation guard | ${['failure','cancelled'].includes(outcome) ? 'cancel' : 'unknown'} |`));
      await unlink(file);
    }
  } finally { await unlink(file).catch(error=>{if(error.code!=='ENOENT')throw error;});await rmdir(directory); }
});
