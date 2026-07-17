// scripts/smoke-runner.mjs — runs every offline smoke suite and fails the process if any
// one of them fails. This is what CI (and `npm run smoke`) calls.
//
// Why a runner instead of a chain of npm scripts: the suites are added by hand over time,
// and the point of F24 is that a NEW suite must be covered without anyone remembering to
// wire it up. So discovery is automatic — every scripts/*-smoke.mjs is picked up. The
// runner is deliberately named "*-runner.mjs" (not "*-smoke.mjs") so it never discovers
// and re-spawns itself.
//
// Exit code is the contract: 0 iff every suite exits 0, otherwise 1. A red suite must
// turn CI red — that is the whole reason this exists.

import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, basename, join } from 'node:path';

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
const SELF = basename(fileURLToPath(import.meta.url));

// Every offline smoke suite, discovered by filename so a new one is never forgotten.
// The runner itself ends in "-runner.mjs", so it is excluded naturally; the live
// webhook-register script is not a "*-smoke.mjs", so it is excluded too.
export function discoverSuites(dir = SCRIPTS_DIR) {
  return readdirSync(dir)
    .filter((f) => f.endsWith('-smoke.mjs') && f !== SELF)
    .sort()
    .map((f) => join(dir, f));
}

// Run one suite as a child `node <file>`, inheriting stdio so CI shows its output.
// Resolves true on exit 0, false otherwise. Never rejects — a crashed suite is a failure,
// not a runner error.
function runOne(file) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [file], { stdio: 'inherit' });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
}

// Run each suite in turn; collect results. `run` is injectable so the contract is testable
// without spawning real processes. One failure does not stop the rest — we want the full
// picture of what is red, not just the first thing.
export async function runSuites(files, opts = {}) {
  const run = opts.run || runOne;
  const log = opts.log || console.log;
  const results = [];
  for (const file of files) {
    const ok = await run(file);
    results.push({ file, ok });
    log(`${ok ? 'PASS' : 'FAIL'}  ${basename(file)}`);
  }
  const failed = results.filter((r) => !r.ok).map((r) => r.file);
  return { results, failed };
}

// Run directly (node scripts/smoke-runner.mjs), not when imported by the self-test.
const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  const suites = discoverSuites();
  console.log(`Running ${suites.length} smoke suites…\n`);
  const { failed } = await runSuites(suites);
  console.log(`\n${suites.length - failed.length}/${suites.length} suites passed.`);
  if (failed.length) {
    console.error(`\n❌ ${failed.length} suite(s) failed:`);
    for (const f of failed) console.error(`   - ${basename(f)}`);
    process.exit(1);
  }
  console.log('✅ all smoke suites passed.');
}
