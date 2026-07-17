// scripts/smoke-runner-smoke.mjs — offline smoke for the CI smoke-runner itself.
//
// The runner (scripts/smoke-runner.mjs) is what CI calls via `npm run smoke`. Its whole
// job is: discover every offline suite and FAIL THE PROCESS if any one of them fails. If
// that exit-code contract ever breaks, CI would go green over a red suite — the exact
// regression F24 exists to prevent — so the contract itself needs coverage. No network,
// no database, no child processes: runSuites takes an injected `run`, so we test the
// aggregation/exit logic directly.
//
//   node scripts/smoke-runner-smoke.mjs

import { runSuites, discoverSuites } from './smoke-runner.mjs';

let passed = 0;
function check(name, cond, detail) {
  if (!cond) throw new Error(`FAIL: ${name}${detail ? ` — ${detail}` : ''}`);
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const silent = () => {};

console.log('smoke-runner smoke — no DB, no network, no child processes\n');

console.log('exit-code contract (a failing suite must fail the run):');
{
  // All suites pass → nothing failed.
  const allPass = await runSuites(['a-smoke.mjs', 'b-smoke.mjs'], {
    run: async () => true,
    log: silent,
  });
  check('every suite green → failed list is empty', allPass.failed.length === 0);
  check('every suite green → all results ok', allPass.results.every((r) => r.ok === true));

  // One suite fails → it surfaces in `failed` (the process exits 1 on this).
  const oneFails = await runSuites(['ok-smoke.mjs', 'broken-smoke.mjs', 'ok2-smoke.mjs'], {
    run: async (file) => file !== 'broken-smoke.mjs',
    log: silent,
  });
  check('one red suite → failed list is non-empty', oneFails.failed.length === 1);
  check('one red suite → failed names exactly the broken suite', oneFails.failed[0] === 'broken-smoke.mjs');
  check('a red suite does not stop the others from running', oneFails.results.length === 3);
}

console.log('\nevery suite runs (no silent truncation — F24 exists because suites went unrun):');
{
  const seen = [];
  await runSuites(['1-smoke.mjs', '2-smoke.mjs', '3-smoke.mjs'], {
    run: async (file) => {
      seen.push(file);
      return true;
    },
    log: silent,
  });
  check('runSuites invokes run() once per file, in order', seen.join(',') === '1-smoke.mjs,2-smoke.mjs,3-smoke.mjs');
}

console.log('\ndiscovery (auto-find suites so a new one is never forgotten):');
{
  const suites = discoverSuites().map((p) => p.replace(/\\/g, '/'));
  const bases = suites.map((p) => p.split('/').pop());
  check('discovers a non-empty set of suites', suites.length > 0);
  check('every discovered file is a *-smoke.mjs', bases.every((b) => b.endsWith('-smoke.mjs')));
  check('includes a known existing suite', bases.includes('podium-rbac-smoke.mjs'));
  check('includes a second known suite', bases.includes('podium-leads-smoke.mjs'));
  // Recursion guard: the runner ends in "-runner.mjs", not "-smoke.mjs", so it must never
  // discover (and re-spawn) itself.
  check('does NOT discover the runner itself', !bases.includes('smoke-runner.mjs'));
  // The live Podium webhook REGISTER script needs creds + network — it is not a smoke and
  // must never be pulled into the offline CI run.
  check('does NOT discover the live webhook-register script', !bases.includes('podium-webhook-register.mjs'));
}

console.log(`\n✅ smoke-runner smoke: ${passed} checks passed`);
