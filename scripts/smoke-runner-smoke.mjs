// scripts/smoke-runner-smoke.mjs — offline smoke for the CI smoke-runner itself.
//
// The runner (scripts/smoke-runner.mjs) is what CI calls via `npm run smoke`. Its whole
// job is: discover every offline suite and FAIL THE PROCESS if any one of them fails. If
// that exit-code contract ever breaks, CI would go green over a red suite — the exact
// regression F24 exists to prevent — so the contract itself needs coverage.
//
// Most checks are pure (injected `run`, no processes). A few deliberately spawn the real
// runner against fixture suites, because the two links that actually make CI go red — the
// real exit-code → boolean mapping in runOne(), and the process.exit(1) in the main block
// — can only be proven with real child processes, not an injected run().
//
//   node scripts/smoke-runner-smoke.mjs

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runSuites, discoverSuites, runOne } from './smoke-runner.mjs';

const fixture = (rel) => fileURLToPath(new URL(rel, import.meta.url));
const RUNNER = fixture('./smoke-runner.mjs');

let passed = 0;
function check(name, cond, detail) {
  if (!cond) throw new Error(`FAIL: ${name}${detail ? ` — ${detail}` : ''}`);
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const silent = () => {};

console.log('smoke-runner smoke — no DB, no network (a few real child processes for the exit-code path)\n');

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

console.log('\nreal exit-code mapping (runOne spawns a real child — this is what CI trusts):');
{
  // stdio:'ignore' keeps the throwing fixture's stack out of the CI log; real runs inherit.
  check('runOne: a suite that exits 0 → true', (await runOne(fixture('./fixtures/green/ok-smoke.mjs'), { stdio: 'ignore' })) === true);
  check('runOne: a suite that throws (exit 1) → false', (await runOne(fixture('./fixtures/red/broken-smoke.mjs'), { stdio: 'ignore' })) === false);
}

console.log('\nend-to-end (the runner PROCESS exits non-zero when a suite fails):');
{
  const runnerExit = (dir) =>
    new Promise((res) => {
      const c = spawn(process.execPath, [RUNNER, dir], { stdio: 'ignore' });
      c.on('close', (code) => res(code));
    });
  check('an all-green fixture dir → runner exits 0', (await runnerExit(fixture('./fixtures/green'))) === 0);
  check('a fixture dir with one red suite → runner exits non-zero', (await runnerExit(fixture('./fixtures/red'))) !== 0);
}

console.log('\ndiscovery (auto-find suites so a new one is never forgotten):');
{
  const suites = discoverSuites().map((p) => p.replace(/\\/g, '/'));
  const bases = suites.map((p) => p.split('/').pop());
  check('discovers a non-empty set of suites', suites.length > 0);
  // The real suite count is well into double digits; a threshold catches accidental
  // narrowing of the glob without pinning every filename.
  check('discovers the full suite set, not a narrowed subset', suites.length >= 10, `found ${suites.length}`);
  check('every discovered file is a *-smoke.mjs', bases.every((b) => b.endsWith('-smoke.mjs')));
  check('includes a known existing suite', bases.includes('podium-rbac-smoke.mjs'));
  // Recursion guard: the runner ends in "-runner.mjs", not "-smoke.mjs", so it must never
  // discover (and re-spawn) itself.
  check('does NOT discover the runner itself', !bases.includes('smoke-runner.mjs'));
  // The live Podium webhook REGISTER script needs creds + network — it is not a smoke and
  // must never be pulled into the offline CI run.
  check('does NOT discover the live webhook-register script', !bases.includes('podium-webhook-register.mjs'));
}

console.log(`\n✅ smoke-runner smoke: ${passed} checks passed`);
