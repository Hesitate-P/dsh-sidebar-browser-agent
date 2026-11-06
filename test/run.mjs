/**
 * Dependency-free regression runner.
 *
 * Each suite runs in its own Node process so a crash in one cannot hide the
 * other's report. Exit code is non-zero when any suite fails.
 */
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const suites = ['host-harness.mjs', 'client-harness.mjs']

let failed = 0
for (const suite of suites) {
  console.log(`\n=== ${suite} ===`)
  const result = spawnSync(process.execPath, [join(here, suite)], { stdio: 'inherit' })
  if (result.status !== 0) failed += 1
}

console.log(failed === 0 ? '\nAll suites passed.' : `\n${failed} suite(s) failed.`)
process.exitCode = failed === 0 ? 0 : 1
