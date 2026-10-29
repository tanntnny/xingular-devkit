import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { analyzeRun, main, refusalCode, renderMarkdown } from '../skills/xingular-run-forensics/scripts/run-digest.mjs'

const newRoot = () => {
  const root = mkdtempSync(join(tmpdir(), 'xdiag-'))
  mkdirSync(join(root, 'runs'))
  return root
}

let clock = Date.parse('2026-10-01T10:00:00Z')
function writeRun(root, overrides, steps) {
  const id = overrides.id ?? `run-${Math.random().toString(16).slice(2, 10)}`
  const startedAt = new Date(clock += 60_000).toISOString()
  const record = { id, sessionId: overrides.sessionId ?? id, parentRunId: null, resumedFromRunId: null, relation: null, terminalReason: null, mode: 'code', trigger: null, goal: 'do the thing', startedAt, endedAt: new Date(clock + 30_000).toISOString(), status: 'completed', model: 'test/model', ...overrides }
  const events = steps.map(([type, payload], index) => ({ id: `e${index}`, runId: id, sessionId: record.sessionId, sequence: index + 1, timestamp: new Date(clock + index * 1000).toISOString(), type, payload }))
  mkdirSync(join(root, 'runs', id))
  writeFileSync(join(root, 'runs', id, 'run.json'), JSON.stringify(record))
  writeFileSync(join(root, 'runs', id, 'events.jsonl'), events.map((event) => JSON.stringify(event)).join('\n') + '\n')
  return record
}

const user = (text) => ['message.completed', { messageId: 'u', role: 'user', text }]
const assistant = (text) => ['message.completed', { messageId: 'a', role: 'assistant', text }]
const tool = (id, name, ok = true, output = 'fine', input = '{}') => [
  ['tool.started', { toolCallId: id, name, summary: input, input }],
  ['tool.completed', { toolCallId: id, name, ok, output }]
]
const primary = (digest) => digest.findings.primary.map((item) => `${item.class}/${item.code}`)
const contributing = (digest) => digest.findings.contributing.map((item) => `${item.class}/${item.code}`)

test('refusal text maps to a stable code', () => {
  assert.equal(refusalCode('Plan mode is research-only: write is not permitted for this call.'), 'plan_mode')
  assert.equal(refusalCode('Plan mode Bash is read-only: rm is not permitted while planning.'), 'plan_mode')
  assert.equal(refusalCode('Write target /x is outside the active project workspace /y.'), 'workspace')
  assert.equal(refusalCode('Outside the approved work scope.'), 'scope')
  assert.equal(refusalCode('Tool unavailable in the app settings.'), 'policy')
  assert.equal(refusalCode('The user denied this action. Ask how they would like to proceed.'), 'approval_denied')
  assert.equal(refusalCode('Refused in a reflection run: this call needs a person to approve it.'), 'unattended')
  assert.equal(refusalCode('This reply reached its work-slice limit (320 tool calls; step 321). Write a checkpoint.'), 'work_slice')
  assert.equal(refusalCode('The terminal controller is unavailable: socket closed'), 'controller_unavailable')
  assert.equal(refusalCode('ENOENT: no such file'), null)
})

test('a provider quota failure is a provider finding', () => {
  const root = newRoot()
  const record = writeRun(root, { status: 'failed', terminalReason: 'The ChatGPT user has reached their Subscription Sharing usage limit.' }, [
    ['started', {}], user('fix it'),
    ['failed', { code: 'terminal_attention', message: 'The ChatGPT user has reached their Subscription Sharing usage limit.' }]
  ])
  const digest = analyzeRun(root, record)
  assert.deepEqual(primary(digest), ['provider/provider_error'])
  assert.match(digest.findings.primary[0].detail, /quota/)
})

test('generic failures remain unknown while explicit provider failures are identified', () => {
  const root = newRoot()
  const generic = writeRun(root, { status: 'failed' }, [['failed', { code: 'failed', message: 'Unexpected internal failure' }]])
  const provider = writeRun(root, { status: 'failed' }, [['failed', { code: 'provider_error', message: 'Unexpected failure' }]])
  const attention = writeRun(root, { status: 'failed' }, [['failed', { code: 'terminal_attention', message: 'Terminal disconnected' }]])
  assert.deepEqual(primary(analyzeRun(root, generic)), ['unknown/failed'])
  assert.deepEqual(primary(analyzeRun(root, provider)), ['provider/provider_error'])
  assert.deepEqual(primary(analyzeRun(root, attention)), ['lifecycle/terminal_attention'])
})

test('a plan-mode refusal just before the end of a completed run is the primary cause', () => {
  const root = newRoot()
  const record = writeRun(root, {}, [
    ['started', {}], user('write the file'),
    ...tool('t1', 'write', false, 'Plan mode is research-only: write is not permitted for this call. Use an approved research operation, or finish with a <plan> block.'),
    assistant('I could not write the file while planning.'),
    ['completed', {}]
  ])
  const digest = analyzeRun(root, record)
  assert.ok(primary(digest).includes('guardrail/plan_mode'))
  const guardrail = digest.findings.primary.find((item) => item.code === 'plan_mode')
  assert.equal(guardrail.intended, true)
  assert.deepEqual(guardrail.evidence, [4])
  assert.equal(digest.evidence.refusals[0].inferred, true)
})

test('structured refusal events and stop codes are read directly', () => {
  const root = newRoot()
  const record = writeRun(root, { status: 'interrupted', terminalCode: 'slice_budget', terminalReason: 'slice_complete' }, [
    ['started', {}], user('big job'),
    ['tool.started', { toolCallId: 't1', name: 'bash', summary: 'ls' }],
    ['tool.refused', { toolCallId: 't1', name: 'bash', code: 'work_slice', reason: 'This reply reached its work-slice limit (320 tool calls; step 321).' }],
    ['tool.completed', { toolCallId: 't1', name: 'bash', ok: false, output: 'This reply reached its work-slice limit (320 tool calls; step 321).' }],
    ['checkpoint', { summary: 'half done', done: [], next: 'finish the rest', files: [], checks: [], decisions: [], slice: 1, reason: 'budget' }],
    ['status.changed', { status: 'interrupted', reason: 'slice_complete', code: 'slice_budget' }]
  ])
  const digest = analyzeRun(root, record)
  assert.deepEqual(primary(digest), ['lifecycle/slice_budget'])
  assert.ok(contributing(digest).includes('guardrail/work_slice'))
  assert.equal(digest.evidence.refusals.length, 1)
  assert.equal(digest.evidence.refusals[0].inferred, false)
  assert.equal(digest.outcome.terminalCode, 'slice_budget')
})

test('a completed run with open todo items is flagged as unfinished', () => {
  const root = newRoot()
  const record = writeRun(root, {}, [
    ['started', {}], user('do three things'),
    ['todo.updated', { items: [{ text: 'one', status: 'completed' }, { text: 'two', status: 'in_progress' }, { text: 'three', status: 'pending' }] }],
    assistant('Done with the first part. Next steps: two and three.'),
    ['completed', {}]
  ])
  const digest = analyzeRun(root, record)
  assert.deepEqual(primary(digest), ['model/model_behaviour'])
  assert.match(digest.findings.primary[0].detail, /2\/3 todo item/)
})

test('a checkpoint next step signals unfinished work only when nonempty', () => {
  const root = newRoot()
  const unfinished = writeRun(root, {}, [['checkpoint', { next: 'Run the tests' }], assistant('Stopped here.'), ['completed', {}]])
  const clean = writeRun(root, {}, [['checkpoint', { next: '  ' }], assistant('Done.'), ['completed', {}]])
  const digest = analyzeRun(root, unfinished)
  assert.deepEqual(primary(digest), ['model/model_behaviour'])
  assert.match(digest.findings.primary[0].detail, /checkpoint has next work: Run the tests/)
  assert.deepEqual(primary(analyzeRun(root, clean)), ['none/completed'])
})

test('an invalid plan outcome signals unfinished work', () => {
  const root = newRoot()
  const record = writeRun(root, {}, [['extension.notice', { level: 'warning', text: 'The plan reply did not include a valid plan or blocked block.' }], assistant('Here is some research.'), ['completed', {}]])
  const digest = analyzeRun(root, record)
  assert.deepEqual(primary(digest), ['model/model_behaviour'])
  assert.match(digest.findings.primary[0].detail, /plan outcome was invalid/)
})

test('a clean completed run has no unfinished signal', () => {
  const root = newRoot()
  const record = writeRun(root, {}, [['started', {}], user('hi'), assistant('All done: the tests pass.'), ['completed', {}]])
  assert.deepEqual(primary(analyzeRun(root, record)), ['none/completed'])
})

test('a model that says it lacks a tool is a capability finding', () => {
  const root = newRoot()
  const record = writeRun(root, {}, [['started', {}], user('read my LINE messages'), assistant("I don't have access to desktop apps in this session, so I can't read LINE."), ['completed', {}]])
  assert.ok(primary(analyzeRun(root, record)).includes('capability/capability_gap'))
})

test('stop reasons: stalled, restart and a bare interrupt', () => {
  const root = newRoot()
  const stalled = writeRun(root, { status: 'interrupted', terminalReason: 'stalled' }, [['started', {}], ['status.changed', { status: 'interrupted', reason: 'stalled' }]])
  const restart = writeRun(root, { status: 'interrupted', terminalReason: 'Xingular Harness stopped before the run settled.' }, [['started', {}], ['status.changed', { status: 'interrupted', reason: 'Xingular Harness stopped before the run settled.' }]])
  const aborted = writeRun(root, { status: 'interrupted' }, [['started', {}], ['status.changed', { status: 'interrupted' }]])
  assert.deepEqual(primary(analyzeRun(root, stalled)), ['lifecycle/stalled'])
  assert.deepEqual(primary(analyzeRun(root, restart)), ['lifecycle/harness_restart'])
  assert.deepEqual(primary(analyzeRun(root, aborted)), ['user/user_abort'])
})

test('a stopped parent is not mistaken for a user abort', () => {
  const root = newRoot()
  const record = writeRun(root, { status: 'interrupted', terminalCode: 'parent_stopped' }, [['status.changed', { status: 'interrupted', code: 'parent_stopped' }]])
  assert.deepEqual(primary(analyzeRun(root, record)), ['lifecycle/parent_stopped'])
})

test('refused calls break error streaks by tool call id, not event sequence', () => {
  const root = newRoot()
  const errors = (prefix) => [1, 2, 3].flatMap((n) => tool(`${prefix}${n}`, 'read', false, 'ENOENT'))
  const record = writeRun(root, {}, [
    ...errors('a'),
    ['tool.started', { toolCallId: 'refused', name: 'write' }],
    ['tool.refused', { toolCallId: 'refused', name: 'write', code: 'scope', reason: 'Outside the approved work scope.' }],
    ['tool.completed', { toolCallId: 'refused', name: 'write', ok: false, output: 'Outside the approved work scope.' }],
    ...errors('b'), ['completed', {}]
  ])
  assert.deepEqual(analyzeRun(root, record).evidence.behaviour.errorStreaks.map((item) => item.length), [3, 3])
})

test('a run left waiting with no owner never settled', () => {
  const root = newRoot()
  const record = writeRun(root, { status: 'waiting_for_input', endedAt: null }, [
    ['started', {}], user('ask me'),
    ['question.requested', { questionId: 'q1', question: 'Which one?', options: [] }]
  ])
  assert.deepEqual(primary(analyzeRun(root, record)), ['lifecycle/never_settled', 'user/awaiting_person'])
})

test('loops, compaction failures and context pressure are contributing findings', () => {
  const root = newRoot()
  const repeated = [1, 2, 3, 4].flatMap((n) => tool(`l${n}`, 'bash', true, 'same', '{"command":"npm test"}'))
  const record = writeRun(root, { status: 'interrupted', terminalCode: 'compaction_thrash', terminalReason: 'slice_complete' }, [
    ['started', {}], user('fix tests'), ...repeated,
    ['usage.updated', { contextTokens: 190_000, contextWindow: 200_000 }],
    ['compaction.started', { reason: 'threshold' }],
    ['compaction.ended', { reason: 'threshold', aborted: true, error: 'summary failed' }],
    ['status.changed', { status: 'interrupted', reason: 'slice_complete', code: 'compaction_thrash' }]
  ])
  const digest = analyzeRun(root, record)
  assert.deepEqual(primary(digest), ['lifecycle/compaction_thrash'])
  const extra = contributing(digest)
  assert.ok(extra.includes('model/model_behaviour'), 'loop')
  assert.ok(extra.includes('lifecycle/context_pressure'), 'context peak')
  assert.equal(digest.evidence.behaviour.loops[0].times, 4)
})

test('the command line lists, picks latest, and renders cited Markdown', () => {
  const root = newRoot()
  writeRun(root, { trigger: 'reflection' }, [['started', {}], ['completed', {}]])
  const target = writeRun(root, { status: 'failed' }, [['started', {}], user('go'), ['failed', { code: 'provider_error', message: '429 rate limit' }]])
  writeRun(root, { trigger: 'reflection' }, [['started', {}], ['completed', {}]])
  const lines = []
  assert.equal(main(['--list', '5', '--data', root], (text) => lines.push(text)), 0)
  assert.equal(lines.filter((line) => line.startsWith('run-')).length, 1, 'system runs are hidden')
  const out = []
  assert.equal(main(['latest', '--data', root, '--workspace', root], (text) => out.push(text)), 0)
  const text = out.join('\n')
  assert.match(text, new RegExp(`# Run ${target.id}`))
  assert.match(text, /provider \/ provider_error\*\* \(high · seq 3\)/)
  assert.match(text, /rate_limited/)
  const around = []
  main([target.id, '--data', root, '--around', '2', '--span', '0'], (line) => around.push(line))
  assert.equal(JSON.parse(around[0]).sequence, 2)
})

test('latest-unfinished searches beyond sixty newer finished runs', () => {
  const root = newRoot()
  const target = writeRun(root, { status: 'failed' }, [['failed', { code: 'failed', message: 'failure' }]])
  for (let n = 0; n < 61; n += 1) writeRun(root, {}, [assistant('Done.'), ['completed', {}]])
  const output = []
  assert.equal(main(['latest-unfinished', '--data', root, '--workspace', root, '--json'], (text) => output.push(text)), 0)
  assert.equal(JSON.parse(output[0]).run.id, target.id)
})

test('children recursively include descendants once and preserve missing evidence', () => {
  const root = newRoot()
  const parent = writeRun(root, { id: 'parent' }, [['completed', {}]])
  const child = writeRun(root, { id: 'child', parentRunId: parent.id }, [['completed', {}]])
  const grandchild = writeRun(root, { id: 'grandchild', parentRunId: child.id }, [['completed', {}]])
  const link = (id, children) => writeFileSync(join(root, 'runs', id, 'subagents.json'), JSON.stringify(children))
  link(parent.id, ['child', 'missing', 'child', '../outside'])
  link(child.id, { runIds: ['grandchild', 'missing'] })
  link(grandchild.id, ['parent', 'child'])
  const json = []
  main([parent.id, '--data', root, '--workspace', root, '--children', '--json'], (line) => json.push(line))
  const digest = JSON.parse(json[0])
  assert.deepEqual(digest.childDigests.map((item) => item.run.id), ['child', 'grandchild'])
  assert.equal(digest.evidence.children.find((item) => item.id === 'missing').status, 'missing')
  assert.equal(digest.evidence.children.some((item) => item.id === '../outside'), false)
  assert.equal(digest.childDigests[0].evidence.children.find((item) => item.id === 'missing').status, 'missing')
  const markdown = []
  main([parent.id, '--data', root, '--workspace', root, '--children'], (line) => markdown.push(line))
  assert.deepEqual(markdown.map((item) => item.match(/# Run (\w+)/)?.[1]), ['parent', 'child', 'grandchild'])
})

test('timeline pairs interleaved tools, retains outputs, and shows unmatched events', () => {
  const root = newRoot()
  const record = writeRun(root, {}, [
    ['tool.started', { toolCallId: 'a', name: 'read', summary: 'first file' }],
    ['tool.started', { toolCallId: 'b', name: 'bash', input: 'npm test' }],
    ['tool.completed', { toolCallId: 'b', name: 'bash', ok: true, durationMs: 34, output: 'tests passed' }],
    ['tool.completed', { toolCallId: 'a', name: 'read', ok: false, durationMs: 99, output: 'file missing' }],
    ['tool.completed', { toolCallId: 'orphan', name: 'write', ok: true, output: 'saved' }],
    ['tool.started', { toolCallId: 'open', name: 'read', summary: 'unfinished' }],
    ['completed', {}]
  ])
  const rows = analyzeRun(root, record).timeline.rows
  assert.match(rows[0].text, /read started: first file/)
  assert.match(rows[2].text, /bash ok \(started seq 2\) 34ms: tests passed/)
  assert.match(rows[3].text, /read FAILED \(started seq 1\) 99ms: file missing/)
  assert.match(rows[4].text, /write ok \(start not recorded\): saved/)
  assert.match(rows[5].text, /read started: unfinished/)
  assert.match(renderMarkdown(analyzeRun(root, record)), /tests passed/)
})

test('renderMarkdown survives a run with no events', () => {
  const root = newRoot()
  const record = writeRun(root, { status: 'interrupted' }, [])
  assert.match(renderMarkdown(analyzeRun(root, record)), /## Timeline/)
})


test('current-session selects latest prior regardless of status and bounds neighbors', () => {
  const root = newRoot()
  const otherRoot = newRoot()
  const common = { sessionId: 'session', nativeSessionId: 'branch' }
  const older = writeRun(root, common, [['completed', {}]])
  const stuck = writeRun(root, { ...common, status: 'running', endedAt: null }, [])
  writeFileSync(join(root, 'runs', stuck.id, 'owner.json'), JSON.stringify({ pid: process.pid }))
  writeRun(root, { sessionId: 'other', nativeSessionId: 'branch' }, [])
  writeRun(root, { sessionId: 'session', nativeSessionId: 'other-branch' }, [])
  writeRun(otherRoot, common, [])
  const current = writeRun(root, { ...common, status: 'running' }, [])
  writeRun(root, common, [])
  const out = []
  main(['current-session', '--current-run', current.id, '--data', root, '--data', otherRoot, '--workspace', root, '--json'], text => out.push(text))
  const digest = JSON.parse(out[0])
  assert.equal(digest.run.id, stuck.id)
  assert.deepEqual(digest.session.map(item => item.id), [older.id, stuck.id])
  const completed = writeRun(root, common, [['completed', {}]])
  const next = writeRun(root, common, [])
  const out2 = []
  main(['current-session', '--current-run', next.id, '--data', root, '--workspace', root, '--json'], text => out2.push(text))
  assert.equal(JSON.parse(out2[0]).run.id, completed.id)
})

test('current-session rejects missing identity, no prior, and ambiguous ordering', () => {
  const root = newRoot()
  const current = writeRun(root, { sessionId: 's', nativeSessionId: 'n' }, [])
  const run = (id = current.id) => main(['current-session', '--current-run', id, '--data', root, '--workspace', root], () => {})
  assert.throws(() => run('missing'), /not found exactly/)
  assert.throws(() => run(current.id.slice(0, 6)), /not found exactly/)
  assert.throws(() => run(), /No prior run/)
  const missing = writeRun(root, { sessionId: null }, [])
  assert.throws(() => run(missing.id), /missing session identity/)
  const earlier = writeRun(root, { sessionId: 's', nativeSessionId: null, startedAt: '2020-01-01T00:00:00Z' }, [])
  assert.throws(() => run(), /missing native session identity/)
  writeFileSync(join(root, 'runs', earlier.id, 'run.json'), JSON.stringify({ ...earlier, nativeSessionId: 'n', startedAt: current.startedAt }))
  assert.throws(() => run(), /ambiguous ordering/)
  writeFileSync(join(root, 'runs', earlier.id, 'run.json'), JSON.stringify({ ...earlier, nativeSessionId: 'n', startedAt: 'invalid' }))
  assert.throws(() => run(), /ambiguous ordering/)
})

test('current-session rejects duplicate roots and tied prior runs', () => {
  const root = newRoot()
  const other = newRoot()
  const first = writeRun(root, { sessionId: 's', startedAt: '2020-01-01T00:00:00Z' }, [])
  writeRun(root, { sessionId: 's', startedAt: first.startedAt }, [])
  const current = writeRun(root, { sessionId: 's' }, [])
  const args = ['current-session', '--current-run', current.id, '--data', root, '--workspace', root]
  assert.throws(() => main(args, () => {}), /ambiguous ordering/)
  writeRun(other, { id: current.id, sessionId: 's' }, [])
  assert.throws(() => main([...args, '--data', other], () => {}), /ambiguous across data roots/)
})
