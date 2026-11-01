// Status functions are special: GitHub permits them only in job/step `if`.
// Step env/run/with support the job context, but not cancelled()/always()/etc.
// https://docs.github.com/en/actions/reference/workflows-and-actions/contexts#context-availability
export function statusFunctionContextFailures(workflow) {
  const failures = [];
  function visit(value, path = []) {
    if (typeof value === 'string') {
      const isIf = path.length === 3 && path[0] === 'jobs' && path[2] === 'if'
        || path.length === 5 && path[0] === 'jobs' && path[2] === 'steps' && path[4] === 'if';
      for (const match of value.matchAll(/\$\{\{([\s\S]*?)\}\}/g)) {
        // Quoted string literals may contain function-like text without calling it.
        const expression = match[1].replace(/'(?:[^']|'')*'/g, "''");
        if (!isIf && /\b(?:always|cancelled|success|failure)\s*\(/i.test(expression)) {
          failures.push(`${path.join('.')}: status functions are only supported in job/step if`);
        }
      }
    } else if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) visit(child, [...path, key]);
    }
  }
  visit(workflow);
  return failures;
}

export function ciWorkflowFailures(workflow) {
  const failures = statusFunctionContextFailures(workflow);
  const check = (ok, message) => { if (!ok) failures.push(message); };
  const job = workflow?.jobs ?? {};
  const runs = value => (value?.steps ?? []).map(step => step.run ?? '').join('\n');
  const steps = name => job[name]?.steps ?? [];
  for (const name of ['preflight','validate','platform-compile']) {
    check(steps(name).some(step => step.uses?.startsWith('actions/setup-node@') && step.with?.['node-version'] === 22), `${name}: use the supported Node.js version`);
  }
  check(JSON.stringify(workflow?.permissions) === JSON.stringify({contents:'read'}), 'CI must retain read-only permissions');
  check(JSON.stringify(Object.keys(workflow?.on ?? {}).sort()) === JSON.stringify(['pull_request','push','workflow_dispatch']), 'CI events must not expand');
  check(workflow?.concurrency?.['cancel-in-progress'] === true && workflow.concurrency.group === 'ci-${{ github.workflow }}-${{ github.ref }}', 'Cancellation must remain scoped to this verification workflow/ref');
  check(!JSON.stringify(workflow).includes('continue-on-error'), 'CI must not hide failing checks');
  check(job.preflight?.if === '${{ !cancelled() }}', 'Preflight must stop when old verification is cancelled');
  check(job.validate?.['timeout-minutes'] === 45 && job['platform-compile']?.['timeout-minutes'] === 30, 'Do not reduce existing source/native timeouts');
  for (const name of ['validate', 'platform-compile']) {
    check(job[name]?.needs === 'preflight' && job[name]?.if === '${{ always() }}', `${name}: required status guards must run after failed or cancelled preflight`);
    const gate = steps(name)[0];
    check(gate?.if === '${{ always() }}' && gate?.shell === 'bash' && gate?.env?.PREFLIGHT_RESULT === '${{ needs.preflight.result }}'
      && gate.env.JOB_STATUS === '${{ job.status }}'
      && gate.run.includes('[ "$PREFLIGHT_RESULT" != "success" ]') && gate.run.includes('[ "$JOB_STATUS" != "success" ]') && gate.run.includes('exit 1'), `${name}: first step must fail on non-successful preflight or cancellation`);
    for (const step of steps(name)) {
      if (step.name === 'Require successful preflight' || step.name.startsWith('Verify ') && step.name.endsWith(' completion state') || step.uses?.startsWith('actions/cache/save@') || step.name === 'Save Windows regression diagnostics') continue;
      const platform = step.id === 'webview' ? " && runner.os == 'macOS'" : step.id === 'windows-regressions' ? " && runner.os == 'Windows'" : '';
      check(step.if === `\${{ success() && !cancelled()${platform} }}`, `${name}/${step.name}: expensive steps must respect both failures and cancellation`);
    }
    const checkout = steps(name).find(step => step.uses?.startsWith('actions/checkout@'));
    check(checkout?.with?.ref === '${{ github.sha }}' && checkout.with['fetch-depth'] === 0, `${name}: checkout must pin the event SHA with complete history`);
    const identity = steps(name).find(step => step.id === 'cache-key');
    check(identity?.run === `node .github/scripts/ci-cache-identity.mjs ${name === 'validate' ? 'quality-debug' : 'isolated-release'}`, `${name}: explicit cache mode is required`);
    const restore = steps(name).find(step => step.uses?.startsWith('actions/cache/restore@'));
    check(restore?.with?.key === '${{ steps.cache-key.outputs.key }}' && restore.with['restore-keys'] === '${{ steps.cache-key.outputs.restore-key }}', `${name}: use only the verified cache identity and its compatible lockfile fallback`);
    check(restore?.with?.path === '~/.cargo/registry\n~/.cargo/git\ntest-results/native-target\n', `${name}: do not expand cache paths to credentials or unrelated files`);
    const build = steps(name).find(step => step.id === (name === 'validate' ? 'quality' : 'native-build'));
    check(build && build.if === '${{ success() && !cancelled() }}', `${name}: cache hits must still execute the current-source build/tests`);
    const save = steps(name).find(step => step.uses?.startsWith('actions/cache/save@'));
    check(save?.with?.key === restore?.with?.key && save?.with?.path === restore?.with?.path
      && save?.if === `\${{ !cancelled() && steps.${name === 'validate' ? 'quality' : 'native-build'}.outcome == 'success' && steps.native-cache.outputs.cache-hit != 'true' }}`, `${name}: cache writes need a successful current build and must stop on cancellation`);
  }
  for (const command of ['npm run check:docs','npm run check:test-plan','npm run check:runtime-boundary','npm run check:public-boundary','npm run check:workflows','node --test .github/scripts/ci-contract-test.mjs']) {
    check(runs(job.preflight).includes(command), `Preflight is missing ${command}`);
  }
  check(runs(job.validate).includes('npm test') && runs(job.validate).includes('npm run check:test-plan') && runs(job.validate).includes('npm run docs:build'), 'Source/Rust/frontend/docs verification remains mandatory');
  check(JSON.stringify(job['platform-compile']?.strategy?.matrix?.os) === JSON.stringify(['windows-latest','macos-15']), 'Do not remove supported platforms');
  for (const command of ['npm run build:rust:pilot','npm run test:rust:backend','node tools/native/native-test.mjs','--suite=credential-private-files-test.mjs --suite=preferences-test.mjs']) {
    check(runs(job['platform-compile']).includes(command), `Platform checks are missing ${command}`);
  }
  const native = steps('platform-compile').find(step => step.run === 'node tools/native/native-test.mjs');
  check(native?.id === 'webview' && native?.if === "${{ success() && !cancelled() && runner.os == 'macOS' }}", 'Retain actual Mac WebView verification and the existing explicit Windows scope');
  check(steps('platform-compile').some(step => step.id === 'backend' && step.run === 'npm run test:rust:backend'), 'Backend outcome must be available to the final guard');
  check(steps('platform-compile').some(step => step.id === 'windows-regressions' && step.run?.includes('foreach ($round in 1..3)')), 'Keep all three Windows private/reset regression rounds');
  for (const [name, fields] of [['validate', {QUALITY_RESULT:'${{ steps.quality.outcome }}',DOCS_RESULT:'${{ steps.docs.outcome }}'}], ['platform-compile', {BUILD_RESULT:'${{ steps.native-build.outcome }}',BACKEND_RESULT:'${{ steps.backend.outcome }}',WINDOWS_REPEAT_RESULT:'${{ steps.windows-regressions.outcome }}',MAC_WEBVIEW_RESULT:'${{ steps.webview.outcome }}'}]]) {
    const final = steps(name).at(-1);
    check(final?.if === '${{ always() }}' && final.shell === 'bash' && final.env?.JOB_STATUS === '${{ job.status }}', `${name}: final completion guard must run even if cancellation happens after the first guard`);
    for (const [field, expression] of Object.entries(fields)) check(final?.env?.[field] === expression && final.run?.includes(`$${field}`), `${name}: completion guard must inspect actual ${field}`);
    check(final?.env?.PREFLIGHT_RESULT === '${{ needs.preflight.result }}' && final.run?.includes('exit 1'), `${name}: incomplete verification must fail`);
  }
  const saveIndex = steps('platform-compile').findIndex(step => step.uses?.startsWith('actions/cache/save@'));
  check(saveIndex > steps('platform-compile').indexOf(native), 'Report functional failures before waiting for cache upload');
  check(steps('platform-compile').find(step => step.uses?.startsWith('actions/upload-artifact@'))?.if === "${{ !cancelled() && runner.os == 'Windows' }}", 'Cancelled old runs must not keep uploading diagnostics');
  check(JSON.stringify(job.summary?.needs) === JSON.stringify(['preflight','validate','platform-compile']) && job.summary?.if === '${{ always() }}', 'Summary must run after every upstream result, including cancellation');
  const cancellation = steps('summary')[0];
  check(cancellation?.id === 'cancellation-guard' && cancellation.if === '${{ cancelled() }}' && cancellation.shell === 'bash' && cancellation.run === 'exit 1', 'Summary must reject workflow cancellation even when every upstream job succeeded');
  const summary = steps('summary').at(-1);
  check(steps('summary').length === 2 && summary?.if === '${{ always() }}' && summary?.shell === 'bash' && !summary.uses && summary.env?.JOB_STATUS === '${{ job.status }}', 'Always-run summary must only guard cancellation and report statuses, without source checkout/setup');
  check(summary?.env?.CANCELLATION_GUARD_RESULT === '${{ steps.cancellation-guard.outcome }}' && summary.run?.includes('[ "$CANCELLATION_GUARD_RESULT" != "skipped" ]'), 'Summary must propagate cancellation guard failure, missing or unexpected results');
  check(summary?.env?.PREFLIGHT_RESULT === '${{ needs.preflight.result }}' && summary.env.SOURCE_RESULT === '${{ needs.validate.result }}' && summary.env.PLATFORM_RESULT === '${{ needs.platform-compile.result }}', 'Summary must inspect every actual upstream result');
  check(summary?.run?.includes('exit "$failed"'), 'Summary must propagate non-successful status');
  return failures;
}
