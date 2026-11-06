#!/usr/bin/env node
/**
 * Set the plugin version everywhere it is declared: package.json plus the
 * PLUGIN_VERSION constant in both halves (the regression suite enforces that
 * they stay in sync).
 *
 * Usage: node scripts/set-version.mjs 0.2.1
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..')
const next = process.argv[2]
if (next === undefined || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(next)) {
  console.error('usage: node scripts/set-version.mjs <semver>')
  process.exit(1)
}

const manifestPath = path.join(root, 'package.json')
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
const previous = manifest.version
manifest.version = next
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8')

for (const file of ['lib/index.js', 'lib/client.js']) {
  const target = path.join(root, file)
  const source = fs.readFileSync(target, 'utf8')
  if (!source.includes('PLUGIN_VERSION')) throw new Error(`${file} declares no PLUGIN_VERSION constant`)
  fs.writeFileSync(target, source.replace(/PLUGIN_VERSION = '[^']*'/, `PLUGIN_VERSION = '${next}'`), 'utf8')
}

console.log(`version ${previous} -> ${next}`)
console.log('next steps:')
console.log('  node test/run.mjs')
console.log('  git commit -am "release v' + next + '"')
console.log('  git tag v' + next)
console.log('  git push --follow-tags')
