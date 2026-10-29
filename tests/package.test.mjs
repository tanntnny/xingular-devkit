import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { test } from 'node:test'

const root = new URL('../', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')

test('package declares the prefixed prompt contract and only its three prompts', () => {
  const manifest = JSON.parse(read('package.json'))
  assert.equal(manifest.version, '0.2.0')
  assert.equal(manifest.harness.commandPrefix, 'xdiag')
  assert.equal(manifest.harness.defaultPrompt, 'diagnose')
  assert.deepEqual(manifest.pi.prompts, ['./prompts'])
  assert.deepEqual(readdirSync(new URL('prompts/', root)).sort(), ['diagnose.md', 'propose.md', 'sweep.md'])
  for (const name of ['diagnose', 'propose', 'sweep']) {
    assert.match(read(`prompts/${name}.md`), /^---\ndescription: /)
  }
})

test('documentation uses only the new user-facing routes', () => {
  const docs = read('README.md') + read('skills/xingular-run-forensics/SKILL.md')
  for (const route of ['/xdiag:', '/xdiag:sweep', '/xdiag:propose']) assert.ok(docs.includes(route))
  assert.doesNotMatch(docs, /\/xdiag(?:-sweep|-propose|(?=[\s`]))/)
})
