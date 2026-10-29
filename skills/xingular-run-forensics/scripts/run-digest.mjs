#!/usr/bin/env node
// Turns one Xingular Harness run record into compact, cited evidence for a diagnosis.
// Read-only: it opens run.json, events.jsonl and side files, and runs `git log` in local checkouts.
// No dependencies; Node 20 or later.
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const USAGE = `run-digest.mjs — evidence for why a Xingular Harness run stopped

Usage:
  node run-digest.mjs <run-id|run-id-prefix|latest|latest-unfinished|current-session> [options]
  node run-digest.mjs --list [n] [--session <id>] [--all]

Options:
  --data <root>       Search only this data root (repeatable). Default: the profiles, then the usual roots.
  --session <id>      Limit latest/--list to one session.
  --current-run <id>  Full invoking run id (required for current-session).
  --exclude <run-id>  Skip this run for latest (pass the diagnosing run's own id).
  --all               Include system runs (reflection, probe, improver) and subagent runs.
  --around <seq>      Print raw events near one sequence number instead of the digest.
  --span <n>          Events either side for --around (default 6).
  --children          Digest all reachable subagent runs too.
  --timeline <n>      Timeline entries to keep (default 70).
  --workspace <dir>   Folder holding the Xingular repositories (or $XINGULAR_WORKSPACE).
  --json              Print JSON instead of Markdown.
`

const SYSTEM_TRIGGERS = new Set(['reflection', 'probe', 'improver'])
const LIVE_STATUSES = new Set(['running', 'queued'])
const TERMINAL_TYPES = new Set(['failed', 'completed'])

// Refusal text the Harness gate, plan mode, the work slice and the terminal extension return.
// Runs recorded before `tool.refused` existed only carry this text in `tool.completed.output`.
export const REFUSAL_PATTERNS = [
  [/^Plan mode (is research-only|Bash is read-only)|not eligible for plan-mode research|Plan-mode research eligibility/, 'plan_mode'],
  [/is outside the active project workspace|active project workspace could not be (verified|resolved)|native file-write target could not be verified/, 'workspace'],
  [/^Outside the approved work scope\.|^Outside what this session may do\./, 'scope'],
  [/^Tool unavailable in the app settings\.|^Tool was disabled while waiting\./, 'policy'],
  [/^The user denied this action\./, 'approval_denied'],
  [/^Refused in a (refinement|reflection) run:|^This diagnostic call requires a separate per-call approval\./, 'unattended'],
  [/reached its work-slice limit|^This reply is over\./, 'work_slice'],
  [/^The terminal controller is unavailable/, 'controller_unavailable']
]

// Where each finding is decided in the Harness, and the spec page that governs it.
export const EVIDENCE = {
  plan_mode: { source: 'src/sessions/planMode.ts (planRefusal), src/terminal/piExtension.ts', spec: '02-sessions-and-runs.md#plan-mode, 07-tools-and-gate.md' },
  workspace: { source: 'src/sessions/workspaceBoundary.ts, src/sessions/sessions.ts (gate)', spec: '07-tools-and-gate.md' },
  scope: { source: 'src/sessions/sessions.ts (gate), ToolPolicy.scope in the host', spec: '07-tools-and-gate.md, 01-extension-points.md' },
  policy: { source: 'ToolPolicy.authorize in the host (App: sidecar policy), src/sessions/sessions.ts', spec: '01-extension-points.md, 07-tools-and-gate.md' },
  approval_denied: { source: 'src/sessions/registry.ts (requestApproval), src/sessions/sessions.ts (gate)', spec: '07-tools-and-gate.md#standing-approvals' },
  unattended: { source: 'src/sessions/sessions.ts (gate: probe/improver/reflection)', spec: '05-refinement.md (INV-REF-4), 07-tools-and-gate.md' },
  work_slice: { source: 'src/sessions/workSlice.ts', spec: '02-sessions-and-runs.md (work slices, PROP-0041)' },
  controller_unavailable: { source: 'src/terminal/piExtension.ts, src/terminal/controller.ts', spec: '11-terminal.md' },
  slice_budget: { source: 'src/sessions/workSlice.ts, src/sessions/runner.ts', spec: '02-sessions-and-runs.md (work slices)' },
  compaction_thrash: { source: 'src/sessions/workSlice.ts, src/sessions/runner.ts (compaction_end)', spec: '02-sessions-and-runs.md, 04-prompt.md' },
  context_pressure: { source: 'src/sessions/runner.ts (usage.updated, compaction)', spec: '04-prompt.md, 02-sessions-and-runs.md (token accounting)' },
  stalled: { source: 'src/sessions/runStore.ts (reconcileStaleRuns), src/terminal/stallWatch.ts', spec: '02-sessions-and-runs.md' },
  owner_gone: { source: 'src/sessions/runStore.ts (reconcileStaleRuns)', spec: '02-sessions-and-runs.md' },
  harness_restart: { source: 'src/sessions/runStore.ts (markInterruptedRuns), src/harness.ts', spec: '02-sessions-and-runs.md, 12-storage.md' },
  terminal_attention: { source: 'src/terminal/controller.ts', spec: '11-terminal.md' },
  terminal_closed: { source: 'src/terminal/controller.ts (dispose)', spec: '11-terminal.md' },
  never_settled: { source: 'src/sessions/runStore.ts (reconcileStaleRuns, markInterruptedRuns)', spec: '02-sessions-and-runs.md' },
  user_abort: { source: 'src/sessions/runner.ts (abort)', spec: '02-sessions-and-runs.md' },
  parent_stopped: { source: 'src/sessions/registry.ts (stopped ancestor)', spec: '02-sessions-and-runs.md' },
  awaiting_person: { source: 'src/sessions/registry.ts (requestApproval, requestAnswer)', spec: '02-sessions-and-runs.md (approvals and questions), 07-tools-and-gate.md' },
  provider_error: { source: 'src/sessions/runner.ts (stopReason error), src/accounts/', spec: '09-accounts-and-connectors.md' },
  capability_gap: { source: 'src/tools/definitions.ts, src/capabilities/, the plugin or connector that should supply it', spec: '06-plugins-and-capabilities.md, 07-tools-and-gate.md, 13-world-tools.md' },
  tool_errors: { source: 'the failing tool (src/tools/dispatch.ts for Harness tools)', spec: '07-tools-and-gate.md' },
  model_behaviour: { source: 'the variant (c1–c8) and the compiled prompt (src/prompt/compile.ts)', spec: '03-variants.md, 04-prompt.md' }
}

// ---------- reading ----------

const readJson = (path) => {
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null }
}

export function readEvents(dir) {
  const path = join(dir, 'events.jsonl')
  if (!existsSync(path)) return { events: [], unreadable: 0 }
  let unreadable = 0
  const events = []
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try { events.push(JSON.parse(line)) } catch { unreadable += 1 }
  }
  events.sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0))
  return { events, unreadable }
}

export function candidateRoots(explicit = [], home = homedir()) {
  if (explicit.length) return [...new Set(explicit.map((root) => resolve(root)))].filter((root) => existsSync(join(root, 'runs')))
  const roots = []
  for (const profile of [join(home, '.xingular-harness', 'profile.json'), join(home, '.xingular-harness-dev', 'profile.json')]) {
    const data = readJson(profile)?.dataRoot
    if (typeof data === 'string') roots.push(data)
  }
  roots.push(
    join(home, '.xingular-harness', 'data'),
    join(home, '.xingular-harness-dev', 'data'),
    join(home, 'Library', 'Application Support', 'com.xagent.local', 'vault'),
    join(home, 'Library', 'Application Support', 'com.xagent.local.dev', 'vault')
  )
  return [...new Set(roots.map((root) => resolve(root)))].filter((root) => existsSync(join(root, 'runs')))
}

export function listRuns(roots) {
  const runs = []
  for (const root of roots) {
    for (const id of readdirSync(join(root, 'runs'))) {
      const record = readJson(join(root, 'runs', id, 'run.json'))
      if (record && typeof record.id === 'string') runs.push({ root, record })
    }
  }
  return runs.sort((a, b) => String(b.record.startedAt ?? '').localeCompare(String(a.record.startedAt ?? '')))
}

export function findRun(roots, target) {
  const runs = listRuns(roots)
  const exact = runs.find((entry) => entry.record.id === target)
  if (exact) return exact
  const prefixed = target.length >= 6 ? runs.filter((entry) => entry.record.id.startsWith(target)) : []
  if (prefixed.length === 1) return prefixed[0]
  if (prefixed.length > 1) throw new Error(`Run prefix ${target} matches ${prefixed.length} runs; use more characters.`)
  return null
}

const isUserRun = (record) => !record.parentRunId && !SYSTEM_TRIGGERS.has(record.trigger)

export function currentSessionRuns(roots, id) {
  if (!id) throw new Error('current-session requires --current-run with the full invoking run id.')
  const all = listRuns(roots)
  const matches = all.filter(({ record }) => record.id === id)
  if (matches.length !== 1) throw new Error(`Current run ${id} ${matches.length ? 'is ambiguous across data roots' : 'was not found exactly'}.`)
  const current = matches[0]
  const record = current.record
  if (typeof record.sessionId !== 'string' || !record.sessionId.trim()) throw new Error('Current run is missing session identity.')
  const currentTime = Date.parse(record.startedAt)
  if (!Number.isFinite(currentTime)) throw new Error('Current run has missing or invalid start time; ordering is ambiguous.')
  const prior = []
  for (const item of all) {
    const candidate = item.record
    if (item.root !== current.root || candidate.id === id || !isUserRun(candidate)) continue
    if (typeof candidate.sessionId !== 'string' || !candidate.sessionId.trim()) {
      const time = Date.parse(candidate.startedAt)
      if (!Number.isFinite(time) || time <= currentTime) throw new Error(`Run ${candidate.id} has missing session identity; cannot determine conversation.`)
      continue
    }
    if (candidate.sessionId !== record.sessionId) continue
    const native = typeof record.nativeSessionId === 'string' && record.nativeSessionId.trim() ? record.nativeSessionId : null
    const otherNative = typeof candidate.nativeSessionId === 'string' && candidate.nativeSessionId.trim() ? candidate.nativeSessionId : null
    if (native && otherNative && native !== otherNative) continue
    const time = Date.parse(candidate.startedAt)
    if (!Number.isFinite(time) || time === currentTime) throw new Error(`Run ${candidate.id} has missing or ambiguous ordering relative to the current run.`)
    if (time > currentTime) continue
    if (Boolean(native) !== Boolean(otherNative)) throw new Error(`Run ${candidate.id} has missing native session identity; cannot determine conversation.`)
    prior.push({ ...item, time })
  }
  prior.sort((a, b) => b.time - a.time)
  if (prior.length > 1 && prior[0].time === prior[1].time) throw new Error('Most recent prior run has ambiguous ordering (equal start times).')
  if (!prior.length) throw new Error('No prior run found in the current conversation.')
  return prior
}

/** Whether the process that owns a run is still alive (a live run is not a stopped one). */
export function ownerAlive(root, id) {
  const pid = readJson(join(root, 'runs', id, 'owner.json'))?.pid
  if (!Number.isInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch (error) { return error?.code === 'EPERM' }
}
const isUnsettled = (status) => LIVE_STATUSES.has(status) || String(status ?? '').startsWith('waiting_')

// ---------- analysis ----------

const clip = (text, max = 240) => {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim()
  return value.length > max ? `${value.slice(0, max - 1)}…` : value
}

export function refusalCode(output) {
  const text = String(output ?? '').trim()
  for (const [pattern, code] of REFUSAL_PATTERNS) if (pattern.test(text)) return code
  return null
}

function classifyProviderMessage(message, category) {
  const text = String(message ?? '')
  if (category === 'auth_expired' || /oauth|unauthori[sz]ed|\b401\b|invalid api key|token (request|refresh)|login/i.test(text)) return 'auth'
  if (category === 'quota' || /quota|usage limit|insufficient (credit|balance)|billing|subscription/i.test(text)) return 'quota'
  if (category === 'rate_limited' || /\b429\b|rate.?limit|at capacity|overloaded|\b529\b/i.test(text)) return 'rate_limited'
  if (/not supported|unknown model|model .*not found|does not exist|not configured/i.test(text)) return 'configuration'
  if (category === 'network' || /timed? ?out|connection|ECONN|ENOTFOUND|socket|network/i.test(text)) return 'network'
  if (/context|too long|maximum.*tokens|prompt is too long/i.test(text)) return 'context_overflow'
  return 'unknown'
}

const UNFINISHED_PHRASES = /\b(i (could not|couldn't|cannot|can't|was unable|am unable|did not|didn't)|unable to|not able to|remaining (work|steps|items)|next steps?|still (need|needs|to do)|left to do|todo:|blocked)\b/i
const CANNOT_PHRASES = /\b(i (don't|do not) have (access|a tool|the ability)|no tool (to|for)|not available in this (session|environment)|isn't available|is not available|outside (my|the) (capabilities|scope)|i can't (access|reach|run|open))\b/i

export function analyzeRun(root, record, options = {}) {
  const dir = join(root, 'runs', record.id)
  const { events, unreadable } = readEvents(dir)
  const capabilities = readJson(join(dir, 'capabilities.json'))
  const context = readJson(join(dir, 'context.json'))
  const terminalIndex = events.findIndex((event) => TERMINAL_TYPES.has(event.type) || (event.type === 'status.changed' && event.payload?.status === 'interrupted'))
  const execution = terminalIndex >= 0 ? events.slice(0, terminalIndex + 1) : events
  const terminal = terminalIndex >= 0 ? events[terminalIndex] : null

  const tools = new Map()
  const refusals = []
  const approvals = new Map()
  const questions = new Map()
  const compactions = []
  const retries = []
  const accountIssues = []
  const notices = []
  const steering = []
  const userMessages = []
  let lastAssistant = null
  let todo = null
  let checkpoint = null
  let heartbeat = null
  let usage = null
  let peakContext = null
  const requestStops = new Map()
  const unknownTools = []
  const cannotSays = []

  for (const event of execution) {
    const p = event.payload ?? {}
    const seq = event.sequence
    switch (event.type) {
      case 'tool.started':
        tools.set(p.toolCallId, { toolCallId: p.toolCallId, seq, name: p.name, summary: clip(p.summary || p.input, 160), inputKey: `${p.name}:${String(p.input ?? p.summary ?? '').slice(0, 400)}` })
        break
      case 'tool.completed': {
        const call = tools.get(p.toolCallId) ?? { toolCallId: p.toolCallId, seq, name: p.name, summary: '' }
        Object.assign(call, { endSeq: seq, ok: p.ok !== false, durationMs: p.durationMs, output: clip(p.output, 300) })
        tools.set(p.toolCallId, call)
        if (p.ok === false) {
          const code = refusalCode(p.output)
          if (code && !refusals.some((refusal) => refusal.toolCallId === p.toolCallId)) refusals.push({ seq, toolCallId: p.toolCallId, name: p.name, code, reason: clip(p.output, 300), inferred: true })
          if (/tool .*(not found|unknown|is not available|does not exist)|unknown tool/i.test(String(p.output ?? ''))) unknownTools.push({ seq, name: p.name, output: clip(p.output, 200) })
        }
        break
      }
      case 'tool.refused':
        refusals.push({ seq, toolCallId: p.toolCallId, name: p.name, code: p.code, reason: clip(p.reason, 300), inferred: false })
        break
      case 'approval.requested':
        approvals.set(p.approvalId, { seq, target: p.target, action: clip(p.action, 160), decision: null })
        break
      case 'approval.resolved': {
        const approval = approvals.get(p.approvalId) ?? { seq, target: '?', action: '' }
        Object.assign(approval, { decision: p.decision, automatic: p.automatic, resolvedSeq: seq })
        approvals.set(p.approvalId, approval)
        break
      }
      case 'question.requested':
        questions.set(p.questionId, { seq, question: clip(p.question, 200), answered: null })
        break
      case 'question.answered': {
        const question = questions.get(p.questionId)
        if (question) Object.assign(question, { answered: (p.selected ?? []).length > 0 || Boolean(p.text), selected: p.selected, answeredSeq: seq })
        break
      }
      case 'compaction.started':
        compactions.push({ seq, reason: p.reason, contextTokens: p.contextTokens, contextWindow: p.contextWindow })
        break
      case 'compaction.ended': {
        const open = [...compactions].reverse().find((item) => item.endSeq === undefined) ?? (compactions.push({ seq }), compactions.at(-1))
        Object.assign(open, { endSeq: seq, aborted: p.aborted === true, error: p.error ? clip(p.error, 200) : undefined, willRetry: p.willRetry, tokensBefore: p.tokensBefore, tokensAfter: p.tokensAfter })
        break
      }
      case 'retry.started':
        retries.push({ seq, attempt: p.attempt, maxAttempts: p.maxAttempts, error: clip(p.error, 200) })
        break
      case 'retry.ended':
        if (retries.length) Object.assign(retries.at(-1), { success: p.success, endSeq: seq })
        break
      case 'account.status':
        if (p.category || p.message) accountIssues.push({ seq, category: p.category, message: clip(p.message, 200) })
        break
      case 'extension.notice':
        if (p.level === 'warning' || p.level === 'error') notices.push({ seq, level: p.level, text: clip(p.text, 200) })
        break
      case 'message.steered':
        steering.push({ seq, text: clip(p.text, 200) })
        break
      case 'message.completed':
        if (p.role === 'user') userMessages.push({ seq, text: clip(p.text, 600) })
        else if (p.role === 'assistant' && String(p.text ?? '').trim()) {
          lastAssistant = { seq, text: String(p.text) }
          if (CANNOT_PHRASES.test(String(p.text))) cannotSays.push({ seq, text: clip(String(p.text).match(new RegExp(`.{0,120}${CANNOT_PHRASES.source}.{0,120}`, 'i'))?.[0] ?? p.text, 260) })
        }
        break
      case 'todo.updated':
      case 'checklist.updated':
        todo = { seq, items: Array.isArray(p.items) ? p.items : [] }
        break
      case 'checkpoint':
        checkpoint = { seq, ...p }
        break
      case 'heartbeat':
        heartbeat = { seq, ...p }
        break
      case 'usage.updated':
        usage = { seq, ...p }
        if (typeof p.contextTokens === 'number' && (!peakContext || p.contextTokens > peakContext.tokens)) peakContext = { seq, tokens: p.contextTokens, window: p.contextWindow }
        if (p.request?.stopReason) requestStops.set(p.request.stopReason, (requestStops.get(p.request.stopReason) ?? 0) + 1)
        break
    }
  }

  const calls = [...tools.values()].sort((a, b) => a.seq - b.seq)
  const loops = []
  let streak = []
  for (const call of calls) {
    if (streak.length && streak[0].inputKey === call.inputKey) streak.push(call)
    else {
      if (streak.length >= 3) loops.push({ seq: streak[0].seq, name: streak[0].name, times: streak.length, summary: streak[0].summary })
      streak = [call]
    }
  }
  if (streak.length >= 3) loops.push({ seq: streak[0].seq, name: streak[0].name, times: streak.length, summary: streak[0].summary })
  const errorStreaks = []
  let errors = []
  for (const call of calls) {
    if (call.ok === false && !refusals.some((refusal) => refusal.toolCallId != null && refusal.toolCallId === call.toolCallId)) errors.push(call)
    else {
      if (errors.length >= 3) errorStreaks.push({ seq: errors[0].seq, length: errors.length, tools: [...new Set(errors.map((item) => item.name))] })
      errors = []
    }
  }
  if (errors.length >= 3) errorStreaks.push({ seq: errors[0].seq, length: errors.length, tools: [...new Set(errors.map((item) => item.name))] })
  const lastCall = calls.at(-1) ?? null
  const openTodos = todo ? todo.items.filter((item) => item && item.status !== 'completed' && item.status !== 'cancelled') : []
  const pendingApprovals = [...approvals.values()].filter((approval) => !approval.decision)
  const deniedApprovals = [...approvals.values()].filter((approval) => approval.decision === 'denied')
  const openQuestions = [...questions.values()].filter((question) => question.answered !== true)
  const subagentIds = readJson(join(dir, 'subagents.json'))
  const children = (Array.isArray(subagentIds) ? subagentIds : Array.isArray(subagentIds?.runIds) ? subagentIds.runIds : [])
    .map((id) => typeof id === 'string' ? id : id?.runId ?? id?.id)
    .filter((id) => typeof id === 'string' && id.length <= 128 && /^[A-Za-z0-9_-]+$/.test(id))
    .map((id) => {
      const child = readJson(join(root, 'runs', id, 'run.json'))
      return child ? { id, status: child.status, terminalCode: child.terminalCode ?? null, terminalReason: clip(child.terminalReason, 160) || null, goal: clip(child.goal, 120) } : { id, status: 'missing' }
    })

  const outcome = {
    status: record.status,
    terminalCode: record.terminalCode ?? terminal?.payload?.code ?? null,
    terminalReason: record.terminalReason ?? null,
    terminalSeq: terminal?.sequence ?? null,
    endedAt: record.endedAt ?? null,
    eventsAfterEnd: terminalIndex >= 0 ? events.length - terminalIndex - 1 : 0
  }

  const live = isUnsettled(record.status) && ownerAlive(root, record.id)
  const findings = classify({ live, record, outcome, terminal, refusals, deniedApprovals, pendingApprovals, openQuestions, openTodos, todo, checkpoint, lastAssistant, compactions, peakContext, requestStops, retries, accountIssues, loops, errorStreaks, unknownTools, cannotSays, steering, notices, lastCall, capabilities, children, heartbeat })

  return {
    run: {
      id: record.id,
      sessionId: record.sessionId,
      root,
      trigger: record.trigger ?? null,
      mode: record.mode,
      effectiveMode: record.effectiveMode ?? null,
      model: record.model ?? null,
      effort: record.effort ?? null,
      startedAt: record.startedAt,
      endedAt: record.endedAt,
      durationMin: record.startedAt && record.endedAt ? Math.round((Date.parse(record.endedAt) - Date.parse(record.startedAt)) / 6000) / 10 : null,
      workingDirectory: record.workingDirectory,
      workspaceRoot: record.workspaceRoot ?? null,
      parentRunId: record.parentRunId,
      resumedFromRunId: record.resumedFromRunId,
      goal: clip(record.goal, 400),
      variant: context?.variant ?? null,
      loadedSkills: record.loadedSkills ?? null,
      capabilities: capabilities ? { tools: capabilities.tools ?? [], connectors: capabilities.connectors ?? [], contributions: (capabilities.contributions ?? []).length } : null,
      events: events.length,
      unreadableLines: unreadable
    },
    outcome,
    findings,
    evidence: {
      request: userMessages.slice(0, 2),
      steering,
      lastAssistant: lastAssistant ? { seq: lastAssistant.seq, text: clip(lastAssistant.text, 900) } : null,
      todo: todo ? { seq: todo.seq, total: todo.items.length, open: openTodos.map((item) => `${item.status}: ${clip(item.text, 140)}`) } : null,
      checkpoint: checkpoint ? { seq: checkpoint.seq, reason: checkpoint.reason, summary: clip(checkpoint.summary, 400), next: clip(checkpoint.next, 300), blocked: checkpoint.blocked ? clip(checkpoint.blocked, 300) : undefined, done: (checkpoint.done ?? []).length } : null,
      refusals,
      approvals: { requested: approvals.size, denied: deniedApprovals, pending: pendingApprovals },
      questions: { asked: questions.size, open: openQuestions },
      limits: {
        toolCalls: calls.length,
        heartbeat: heartbeat ? { seq: heartbeat.seq, steps: heartbeat.steps, maxToolCalls: heartbeat.maxToolCalls, elapsedMin: Math.round(heartbeat.elapsedMs / 6000) / 10, slice: heartbeat.slice, compactions: heartbeat.compactions, lastTool: heartbeat.lastTool } : null,
        compactions,
        peakContext: peakContext ? { ...peakContext, percent: peakContext.window ? Math.round((peakContext.tokens / peakContext.window) * 100) : null } : null,
        requestStopReasons: Object.fromEntries(requestStops)
      },
      provider: { retries, accountIssues, usage: usage ? { requests: usage.requests, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cacheReadTokens: usage.cacheReadTokens, costUsd: usage.costUsd, model: usage.model, provider: usage.provider } : null },
      behaviour: { loops, errorStreaks, unknownTools, cannotSays, notices, lastCall: lastCall ? { seq: lastCall.seq, name: lastCall.name, ok: lastCall.ok ?? null, finished: lastCall.endSeq !== undefined, summary: lastCall.summary } : null },
      children
    },
    timeline: timeline(execution, options.timeline ?? 70)
  }
}

function finding(cls, code, confidence, seqs, detail, intended = null) {
  const where = EVIDENCE[code] ?? EVIDENCE[cls] ?? null
  return { class: cls, code, confidence, intended, evidence: seqs.filter((seq) => typeof seq === 'number'), detail, ...(where ? { source: where.source, spec: where.spec } : {}) }
}

export function classify(input) {
  const { record, outcome, terminal, refusals, deniedApprovals, pendingApprovals, openQuestions, openTodos, todo, checkpoint, lastAssistant, compactions, peakContext, requestStops, retries, accountIssues, loops, errorStreaks, unknownTools, cannotSays, steering, notices, lastCall, children } = input
  const primary = []
  const contributing = []
  const code = outcome.terminalCode
  const reason = String(outcome.terminalReason ?? '')
  const endSeq = outcome.terminalSeq

  if (record.status === 'failed') {
    const failureCode = terminal?.payload?.code ?? code ?? 'failed'
    const providerKind = classifyProviderMessage(terminal?.payload?.message ?? reason, accountIssues.at(-1)?.category)
    if (failureCode === 'terminal_attention' && providerKind === 'unknown') primary.push(finding('lifecycle', 'terminal_attention', 'high', [endSeq], `Terminal needed attention: ${clip(terminal?.payload?.message ?? reason, 200)}`))
    else if (providerKind === 'unknown' && !String(failureCode).startsWith('provider_')) primary.push(finding('unknown', 'failed', 'low', [endSeq], `Failed; cause not established: ${clip(terminal?.payload?.message ?? reason, 200)}`))
    else {
      const kind = classifyProviderMessage(terminal?.payload?.message ?? reason, accountIssues.at(-1)?.category)
      const cls = kind === 'context_overflow' ? 'lifecycle' : 'provider'
      const via = failureCode === 'terminal_attention' ? ' (reported by the terminal as terminal_attention)' : ''
      primary.push(finding(cls, kind === 'context_overflow' ? 'context_pressure' : 'provider_error', 'high', [endSeq, accountIssues.at(-1)?.seq], `Provider failure (${kind})${via}: ${clip(terminal?.payload?.message ?? reason, 240)}`, kind === 'configuration' ? false : null))
    }
  } else if (record.status === 'interrupted') {
    if (code === 'slice_budget' || code === 'compaction_thrash' || reason === 'slice_complete') {
      const thrash = code === 'compaction_thrash' || checkpoint?.reason === 'compaction-thrash'
      primary.push(finding('lifecycle', thrash ? 'compaction_thrash' : 'slice_budget', 'high', [endSeq, checkpoint?.seq], thrash ? 'The reply hit three compactions and was ended as compaction thrash.' : 'The reply reached its work-slice budget (tool calls or minutes) and handed off.', true))
    } else if (code === 'stalled' || reason === 'stalled') primary.push(finding('lifecycle', 'stalled', 'high', [endSeq, input.heartbeat?.seq], 'No progress or heartbeat for the stall window; the run was reconciled as stalled.'))
    else if (code === 'owner_gone' || reason === 'owner_gone') primary.push(finding('lifecycle', 'owner_gone', 'high', [endSeq], 'The owning process went away without settling the run.'))
    else if (code === 'harness_restart' || /stopped before the run settled/.test(reason)) primary.push(finding('lifecycle', 'harness_restart', 'high', [endSeq], 'The harness restarted while this run was live; startup marked it interrupted.'))
    else if (code === 'terminal_closed') primary.push(finding('lifecycle', 'terminal_closed', 'high', [endSeq], 'The terminal closed while the run was live.'))
    else if (code === 'parent_stopped' || reason === 'parent_stopped') primary.push(finding('lifecycle', 'parent_stopped', 'high', [endSeq], 'The run was interrupted because an ancestor stopped.', true))
    else if (code === 'user_abort' || !reason) primary.push(finding('user', 'user_abort', code === 'user_abort' ? 'high' : 'medium', [endSeq, steering.at(-1)?.seq], 'Interrupted with no reason recorded: normally a person pressed stop.', true))
    else primary.push(finding('lifecycle', 'never_settled', 'low', [endSeq], `Interrupted: ${clip(reason, 200)}`))
  } else if (isUnsettled(record.status)) {
    if (input.live) primary.push(finding('none', 'live', 'high', [lastCall?.seq], `The run is still live (owner process alive, status ${record.status}). Diagnose it after it settles, or read what it is waiting on below.`))
    else primary.push(finding('lifecycle', 'never_settled', 'medium', [lastCall?.seq], `The record still says ${record.status} and its owner process is gone: it never settled (crash, or not reconciled yet).`))
    if (pendingApprovals.length) primary.push(finding('user', 'awaiting_person', 'medium', pendingApprovals.map((item) => item.seq), `Waiting on ${pendingApprovals.length} approval(s) nobody answered.`, true))
    if (openQuestions.length) primary.push(finding('user', 'awaiting_person', 'medium', openQuestions.map((item) => item.seq), `Waiting on ${openQuestions.length} question(s) nobody answered.`, true))
  }

  // A refusal right before the end, or one the model never got past, is the likeliest cause of an early stop.
  const lastRefusal = refusals.at(-1)
  if (lastRefusal) {
    const nearEnd = endSeq !== null && endSeq - lastRefusal.seq <= 12
    const target = record.status === 'completed' && nearEnd ? primary : contributing
    const intended = lastRefusal.code === 'controller_unavailable' ? false : true
    target.push(finding('guardrail', lastRefusal.code, nearEnd ? 'high' : 'medium', refusals.map((item) => item.seq), `${refusals.length} gate refusal(s); last: ${lastRefusal.name} → ${lastRefusal.code}${lastRefusal.inferred ? ' (inferred from text)' : ''}: ${clip(lastRefusal.reason, 160)}`, intended))
  }
  if (deniedApprovals.length) contributing.push(finding('user', 'approval_denied', 'high', deniedApprovals.map((item) => item.resolvedSeq ?? item.seq), `${deniedApprovals.length} approval(s) denied${deniedApprovals.some((item) => !item.automatic) ? '' : ' (automatic)'}: ${deniedApprovals.map((item) => item.target).join(', ')}`, true))

  if (record.status === 'completed') {
    const signals = []
    if (openTodos.length) signals.push(`${openTodos.length}/${todo.items.length} todo item(s) not completed`)
    if (checkpoint?.blocked) signals.push(`checkpoint says blocked: ${clip(checkpoint.blocked, 120)}`)
    if (typeof checkpoint?.next === 'string' && checkpoint.next.trim()) signals.push(`checkpoint has next work: ${clip(checkpoint.next, 120)}`)
    if (notices.some((notice) => /plan reply did not include a valid plan or blocked (?:block|outcome)/i.test(notice.text))) signals.push('the plan outcome was invalid')
    if (lastAssistant && /\?\s*$/.test(lastAssistant.text.trim())) signals.push('the last reply ends with a question')
    if (lastAssistant && UNFINISHED_PHRASES.test(lastAssistant.text.slice(-1500))) signals.push('the last reply mentions unfinished or blocked work')
    if (lastCall && lastCall.ok === false) signals.push(`the last tool call (${lastCall.name}) failed`)
    if (cannotSays.length) primary.push(finding('capability', 'capability_gap', 'medium', cannotSays.map((item) => item.seq), `The model said it lacks access or a tool: "${cannotSays.at(-1).text}"`))
    if (unknownTools.length) primary.push(finding('capability', 'capability_gap', 'high', unknownTools.map((item) => item.seq), `Calls to tools that do not exist in this run: ${[...new Set(unknownTools.map((item) => item.name))].join(', ')}`))
    if (signals.length) primary.push(finding('model', 'model_behaviour', signals.length > 1 ? 'medium' : 'low', [todo?.seq, lastAssistant?.seq, checkpoint?.seq, ...notices.filter((notice) => /plan reply did not include a valid plan or blocked (?:block|outcome)/i.test(notice.text)).map((notice) => notice.seq)], `Completed but unfinished: ${signals.join('; ')}`))
    if (!primary.length) primary.push(finding('none', 'completed', 'low', [endSeq], 'Completed with no unfinished signal in the record. Compare the request with the result, or ask what was expected.'))
  } else {
    if (unknownTools.length) contributing.push(finding('capability', 'capability_gap', 'high', unknownTools.map((item) => item.seq), `Calls to tools that do not exist in this run: ${[...new Set(unknownTools.map((item) => item.name))].join(', ')}`))
    if (cannotSays.length) contributing.push(finding('capability', 'capability_gap', 'medium', cannotSays.map((item) => item.seq), `The model said it lacks access or a tool: "${cannotSays.at(-1).text}"`))
  }

  if (loops.length) contributing.push(finding('model', 'model_behaviour', 'medium', loops.map((item) => item.seq), `Repeated identical calls: ${loops.map((item) => `${item.name}×${item.times}`).join(', ')}`))
  if (errorStreaks.length) contributing.push(finding('environment', 'tool_errors', 'medium', errorStreaks.map((item) => item.seq), `Tool error streaks: ${errorStreaks.map((item) => `${item.length} in a row (${item.tools.join(', ')})`).join('; ')}`))
  const badCompactions = compactions.filter((item) => item.aborted || item.error)
  if (badCompactions.length) contributing.push(finding('lifecycle', 'compaction_thrash', 'medium', badCompactions.map((item) => item.endSeq ?? item.seq), `${badCompactions.length} compaction(s) aborted or failed: ${badCompactions.map((item) => item.error ?? 'aborted').join('; ')}`))
  else if (compactions.length >= 2) contributing.push(finding('lifecycle', 'context_pressure', 'low', compactions.map((item) => item.seq), `${compactions.length} compactions in the run`))
  if (peakContext?.window && peakContext.tokens / peakContext.window >= 0.85) contributing.push(finding('lifecycle', 'context_pressure', 'medium', [peakContext.seq], `Context peaked at ${Math.round((peakContext.tokens / peakContext.window) * 100)}% of the window (${peakContext.tokens}/${peakContext.window})`))
  if (requestStops.get('length')) contributing.push(finding('provider', 'provider_error', 'medium', [], `${requestStops.get('length')} request(s) stopped at the output length limit`))
  const failedRetries = retries.filter((item) => item.success === false)
  if (retries.length) contributing.push(finding('provider', 'provider_error', failedRetries.length ? 'medium' : 'low', retries.map((item) => item.seq), `${retries.length} provider retr${retries.length === 1 ? 'y' : 'ies'} (${failedRetries.length} failed): ${retries.at(-1).error}`))
  if (notices.length) contributing.push(finding('model', 'model_behaviour', 'low', notices.map((item) => item.seq), `Warnings: ${notices.map((item) => item.text).join(' | ')}`))
  const badChildren = children.filter((child) => child.status !== 'completed')
  if (badChildren.length) contributing.push(finding('lifecycle', 'never_settled', 'medium', [], `${badChildren.length} subagent run(s) did not complete: ${badChildren.map((child) => `${child.id.slice(0, 8)} ${child.status}${child.terminalReason ? ` (${child.terminalReason})` : ''}`).join('; ')}`))

  return { primary, contributing }
}

function timeline(events, keep) {
  const rows = []
  const started = new Map()
  for (const event of events) {
    const p = event.payload ?? {}
    let text = null
    switch (event.type) {
      case 'message.completed': text = `${p.role}: ${clip(p.text, p.role === 'user' ? 300 : 200)}`; break
      case 'message.steered': text = `steer: ${clip(p.text, 160)}`; break
      case 'tool.started':
        if (p.toolCallId != null) started.set(p.toolCallId, event)
        text = `tool ${p.name} started${p.summary || p.input ? `: ${clip(p.summary || p.input, 160)}` : ''}`
        break
      case 'tool.completed': {
        const start = p.toolCallId != null ? started.get(p.toolCallId) : null
        if (start) started.delete(p.toolCallId)
        text = `tool ${p.name ?? start?.payload?.name ?? '?'} ${p.ok === false ? 'FAILED' : 'ok'}${start ? ` (started seq ${start.sequence})` : ' (start not recorded)'}${typeof p.durationMs === 'number' ? ` ${p.durationMs}ms` : ''}${p.output ? `: ${clip(p.output, 160)}` : ''}`
        break
      }
      case 'tool.refused': text = `REFUSED ${p.name} [${p.code}]: ${clip(p.reason, 160)}`; break
      case 'approval.requested': text = `approval asked: ${p.target} ${clip(p.action, 100)}`; break
      case 'approval.resolved': text = `approval ${p.decision}${p.automatic ? ` (${p.automatic})` : ''}`; break
      case 'question.requested': text = `question: ${clip(p.question, 140)}`; break
      case 'question.answered': text = `answer: ${(p.selected ?? []).join(', ') || clip(p.text, 80) || '(none)'}`; break
      case 'compaction.started': text = `compaction started (${p.reason ?? '?'})`; break
      case 'compaction.ended': text = `compaction ended${p.aborted ? ' ABORTED' : ''}${p.error ? ` error: ${clip(p.error, 100)}` : ''}${p.tokensBefore ? ` before=${p.tokensBefore}` : ''}`; break
      case 'retry.started': text = `retry ${p.attempt}/${p.maxAttempts}: ${clip(p.error, 120)}`; break
      case 'account.status': if (p.category) text = `account ${p.category}: ${clip(p.message, 120)}`; break
      case 'todo.updated':
      case 'checklist.updated': {
        const items = Array.isArray(p.items) ? p.items : []
        text = `todo ${items.filter((item) => item.status === 'completed').length}/${items.length} done`
        break
      }
      case 'checkpoint': text = `checkpoint (${p.reason}): next=${clip(p.next, 120)}${p.blocked ? ` blocked=${clip(p.blocked, 100)}` : ''}`; break
      case 'extension.notice': if (p.level === 'warning' || p.level === 'error') text = `notice ${p.level}: ${clip(p.text, 140)}`; break
      case 'status.changed': if (p.status !== 'running') text = `status ${p.status}${p.reason ? `: ${clip(p.reason, 120)}` : ''}${p.code ? ` [${p.code}]` : ''}`; break
      case 'failed': text = `FAILED [${p.code}]: ${clip(p.message, 200)}`; break
      case 'completed': text = 'completed'; break
    }
    if (text) rows.push({ seq: event.sequence, at: String(event.timestamp ?? '').slice(11, 19), text })
  }
  if (rows.length <= keep) return { rows, omitted: 0 }
  const head = Math.floor(keep * 0.25)
  return { rows: [...rows.slice(0, head), { seq: null, at: '', text: `… ${rows.length - keep} entries omitted; use --around <seq>` }, ...rows.slice(rows.length - (keep - head))], omitted: rows.length - keep }
}

// ---------- repositories ----------

const REPOS = [
  ['harness', (dir) => readJson(join(dir, 'package.json'))?.name === '@xingular/harness'],
  ['app', (dir) => readJson(join(dir, 'package.json'))?.name === 'xingular-agent'],
  ['hub', (dir) => readJson(join(dir, 'package.json'))?.name === 'xingular-hub'],
  ['evaluation', (dir) => existsSync(join(dir, 'pyproject.toml')) && /^name\s*=\s*"(xeval|xingular-evaluation)"/m.test(readFileSync(join(dir, 'pyproject.toml'), 'utf8'))]
]

// Walks up at most eight folders and never above the home folder: repositories sit near the work.
function ancestors(start, home = homedir()) {
  const list = []
  let dir = resolve(start)
  for (let depth = 0; depth < 8; depth += 1) {
    list.push(dir)
    const parent = dirname(dir)
    if (parent === dir || dir === home) break
    dir = parent
  }
  return list
}

export function discoverRepos(starts) {
  for (const start of starts.filter(Boolean)) {
    if (!existsSync(start)) continue
    for (const dir of ancestors(start)) {
      const found = {}
      let children = []
      try { children = readdirSync(dir, { withFileTypes: true }).filter((item) => item.isDirectory() && !item.name.startsWith('.') && item.name !== 'node_modules').map((item) => join(dir, item.name)) } catch {}
      if (children.length > 200) children = []
      for (const candidate of [dir, ...children]) {
        for (const [name, test] of REPOS) {
          try { if (!found[name] && test(candidate)) found[name] = candidate } catch {}
        }
      }
      if (Object.keys(found).length >= 2) return { workspace: dir, repos: found }
    }
  }
  return { workspace: null, repos: {} }
}

function git(dir, args) {
  try { return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() } catch { return null }
}

export function repoState(repos, runStartedAt) {
  const state = {}
  for (const [name, dir] of Object.entries(repos)) {
    const head = git(dir, ['log', '-1', '--format=%h %cI'])
    const [commit, committedAt] = head ? head.split(' ') : [null, null]
    const pkg = readJson(join(dir, 'package.json'))
    state[name] = {
      path: dir,
      branch: git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']),
      commit,
      committedAt,
      version: pkg?.version ?? null,
      dirty: Boolean(git(dir, ['status', '--porcelain', '--untracked-files=no'])),
      newerThanRun: Boolean(committedAt && runStartedAt && Date.parse(committedAt) > Date.parse(runStartedAt))
    }
  }
  return state
}

// ---------- rendering ----------

function renderFinding(item) {
  const intended = item.intended === true ? ' · working as designed' : item.intended === false ? ' · not intended' : ''
  const cites = item.evidence.length ? ` · seq ${item.evidence.slice(0, 8).join(', ')}` : ''
  const where = item.source ? `\n  - look at: ${item.source}\n  - spec: ${item.spec}` : ''
  return `- **${item.class} / ${item.code}** (${item.confidence}${intended}${cites})\n  ${item.detail}${where}`
}

export function renderMarkdown(digest) {
  const { run, outcome, findings, evidence, timeline: tl } = digest
  const lines = []
  lines.push(`# Run ${run.id}`, '')
  lines.push(`- session ${run.sessionId} · trigger ${run.trigger ?? 'person'} · mode ${run.mode}${run.effectiveMode ? `/${run.effectiveMode}` : ''} · model ${run.model ?? '?'}${run.effort ? ` (${run.effort})` : ''}`)
  lines.push(`- ${run.startedAt} → ${run.endedAt ?? 'never ended'}${run.durationMin !== null ? ` (${run.durationMin} min)` : ''} · ${run.events} events${run.unreadableLines ? ` · ${run.unreadableLines} unreadable lines` : ''}`)
  lines.push(`- workspace ${run.workspaceRoot ?? run.workingDirectory ?? '?'} · data root ${run.root}`)
  if (run.variant) lines.push(`- variant ${run.variant.scope ?? '?'} @ ${run.variant.fingerprint ?? run.variant.version ?? '?'}`)
  if (run.capabilities) {
    lines.push(`- capability set: ${run.capabilities.tools.length} tools, ${run.capabilities.connectors.length} connectors, ${run.capabilities.contributions} plugin contributions`)
    lines.push(`- tools: ${run.capabilities.tools.join(', ') || '(none)'}`)
    lines.push(`- connectors: ${run.capabilities.connectors.join(', ') || '(none)'}`)
  }
  lines.push(`- loaded skills: ${run.loadedSkills === null ? 'not recorded' : run.loadedSkills.join(', ') || '(none observed)'}`)
  lines.push('- Harness package version used by this run: not recorded; checkout version alone cannot prove a match')
  if (run.parentRunId || run.resumedFromRunId) lines.push(`- parent ${run.parentRunId ?? '—'} · resumed from ${run.resumedFromRunId ?? '—'}`)
  lines.push('', '## Outcome', '')
  lines.push(`- status **${outcome.status}**${outcome.terminalCode ? ` · code \`${outcome.terminalCode}\`` : ''}${outcome.terminalSeq !== null ? ` · seq ${outcome.terminalSeq}` : ''}`)
  if (outcome.terminalReason) lines.push(`- reason: ${clip(outcome.terminalReason, 400)}`)
  if (outcome.eventsAfterEnd) lines.push(`- ${outcome.eventsAfterEnd} event(s) arrived after the run ended`)
  lines.push('', '## Preliminary classification', '')
  lines.push(...(findings.primary.length ? findings.primary.map(renderFinding) : ['- none']))
  if (findings.contributing.length) lines.push('', 'Contributing:', '', ...findings.contributing.map(renderFinding))
  lines.push('', '## Evidence', '')
  if (evidence.request.length) lines.push(`- request (seq ${evidence.request[0].seq}): ${evidence.request[0].text}`)
  else lines.push(`- goal: ${run.goal || '(none recorded)'}`)
  for (const steer of evidence.steering) lines.push(`- steered (seq ${steer.seq}): ${steer.text}`)
  if (evidence.todo) lines.push(`- todo (seq ${evidence.todo.seq}): ${evidence.todo.total - evidence.todo.open.length}/${evidence.todo.total} done${evidence.todo.open.length ? `; open: ${evidence.todo.open.join(' | ')}` : ''}`)
  if (evidence.checkpoint) lines.push(`- checkpoint (seq ${evidence.checkpoint.seq}, ${evidence.checkpoint.reason}): ${evidence.checkpoint.summary} · next: ${evidence.checkpoint.next}${evidence.checkpoint.blocked ? ` · blocked: ${evidence.checkpoint.blocked}` : ''}`)
  for (const refusal of evidence.refusals) lines.push(`- refused (seq ${refusal.seq}) ${refusal.name} [${refusal.code}${refusal.inferred ? ', inferred' : ''}]: ${refusal.reason}`)
  for (const approval of evidence.approvals.denied) lines.push(`- approval denied (seq ${approval.resolvedSeq ?? approval.seq}${approval.automatic ? `, ${approval.automatic}` : ''}): ${approval.target} ${approval.action}`)
  for (const approval of evidence.approvals.pending) lines.push(`- approval never answered (seq ${approval.seq}): ${approval.target} ${approval.action}`)
  for (const question of evidence.questions.open) lines.push(`- question not answered (seq ${question.seq}): ${question.question}`)
  const limits = evidence.limits
  lines.push(`- tool calls: ${limits.toolCalls}${limits.heartbeat ? ` · slice ${limits.heartbeat.slice}: ${limits.heartbeat.steps}/${limits.heartbeat.maxToolCalls} steps, ${limits.heartbeat.elapsedMin} min (heartbeat seq ${limits.heartbeat.seq})` : ''}`)
  if (limits.peakContext) lines.push(`- peak context: ${limits.peakContext.tokens}${limits.peakContext.window ? ` / ${limits.peakContext.window} (${limits.peakContext.percent}%)` : ''} at seq ${limits.peakContext.seq}`)
  if (limits.compactions.length) lines.push(`- compactions: ${limits.compactions.map((item) => `seq ${item.seq}${item.aborted ? ' aborted' : ''}${item.error ? ` error` : ''}${item.tokensBefore ? ` ${item.tokensBefore} tok` : ''}`).join('; ')}`)
  if (Object.keys(limits.requestStopReasons).length) lines.push(`- provider stop reasons: ${Object.entries(limits.requestStopReasons).map(([key, value]) => `${key}×${value}`).join(', ')}`)
  for (const issue of evidence.provider.accountIssues) lines.push(`- account (seq ${issue.seq}) ${issue.category ?? ''}: ${issue.message}`)
  if (evidence.provider.usage) lines.push(`- usage: ${evidence.provider.usage.requests ?? '?'} requests, ${evidence.provider.usage.inputTokens ?? '?'} in / ${evidence.provider.usage.outputTokens ?? '?'} out${typeof evidence.provider.usage.costUsd === 'number' ? `, $${evidence.provider.usage.costUsd.toFixed(4)}` : ''}`)
  const behaviour = evidence.behaviour
  if (behaviour.lastCall) lines.push(`- last tool call (seq ${behaviour.lastCall.seq}): ${behaviour.lastCall.name} ${behaviour.lastCall.finished ? (behaviour.lastCall.ok ? 'ok' : 'failed') : 'never finished'} ${behaviour.lastCall.summary}`)
  for (const say of behaviour.cannotSays) lines.push(`- model said (seq ${say.seq}): "${say.text}"`)
  if (evidence.lastAssistant) lines.push('', `Last assistant reply (seq ${evidence.lastAssistant.seq}):`, '', `> ${evidence.lastAssistant.text.replace(/\n/g, '\n> ')}`)
  if (evidence.children.length) {
    lines.push('', '## Subagents', '')
    for (const child of evidence.children) lines.push(`- ${child.id} ${child.status}${child.terminalCode ? ` [${child.terminalCode}]` : ''}${child.terminalReason ? `: ${child.terminalReason}` : ''}${child.goal ? ` — ${child.goal}` : ''}`)
  }
  if (digest.session?.length > 1) {
    lines.push('', '## Session runs', '')
    for (const item of digest.session) lines.push(`- ${item.id === run.id ? '**this** ' : ''}${item.id} ${item.startedAt} ${item.status}${item.terminalCode ? ` [${item.terminalCode}]` : ''}${item.resumedFromRunId ? ` (resumes ${item.resumedFromRunId.slice(0, 8)})` : ''}`)
  }
  if (digest.repos) {
    lines.push('', '## Source checkouts', '')
    if (!Object.keys(digest.repos).length) lines.push('- none found; pass --workspace <dir> or set XINGULAR_WORKSPACE')
    for (const [name, repo] of Object.entries(digest.repos)) lines.push(`- ${name}: ${repo.path} · ${repo.branch ?? '?'} @ ${repo.commit ?? '?'}${repo.version ? ` · v${repo.version}` : ''}${repo.dirty ? ' · uncommitted changes' : ''}${repo.newerThanRun ? ' · **HEAD is newer than the run: the code that ran may differ**' : ''}`)
  }
  lines.push('', `## Timeline${tl.omitted ? ` (${tl.omitted} omitted)` : ''}`, '')
  for (const row of tl.rows) lines.push(row.seq === null ? `  ${row.text}` : `- ${String(row.seq).padStart(4)} ${row.at} ${row.text}`)
  return lines.join('\n')
}

// ---------- command line ----------

function parseArgs(argv) {
  const options = { data: [], timeline: 70, span: 6 }
  const positional = []
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const next = () => argv[++index]
    if (arg === '--data') options.data.push(next())
    else if (arg === '--session') options.session = next()
    else if (arg === '--current-run') options.currentRun = next()
    else if (arg === '--exclude') options.exclude = next()
    else if (arg === '--all') options.all = true
    else if (arg === '--around') options.around = Number(next())
    else if (arg === '--span') options.span = Number(next())
    else if (arg === '--children') options.children = true
    else if (arg === '--timeline') options.timeline = Number(next())
    else if (arg === '--workspace') options.workspace = next()
    else if (arg === '--json') options.json = true
    else if (arg === '--list') {
      options.list = 20
      if (/^\d+$/.test(argv[index + 1] ?? '')) options.list = Number(next())
    } else if (arg === '-h' || arg === '--help') options.help = true
    else positional.push(arg)
  }
  options.target = positional[0]
  return options
}

function looksUnfinished(root, record) {
  if (record.status !== 'completed') return true
  const digest = analyzeRun(root, record, { timeline: 0 })
  return digest.findings.primary.some((item) => item.code !== 'completed')
}

export function main(argv = process.argv.slice(2), out = (text) => process.stdout.write(`${text}\n`)) {
  const options = parseArgs(argv)
  if (options.help || (!options.target && !options.list)) {
    out(USAGE)
    return options.help ? 0 : 2
  }
  const roots = candidateRoots(options.data)
  if (!roots.length) throw new Error('No data root with a runs/ folder was found. Pass --data <root>.')
  const keep = (entry) => (options.all || isUserRun(entry.record)) && (!options.session || entry.record.sessionId === options.session) && entry.record.id !== options.exclude

  if (options.list) {
    const rows = listRuns(roots).filter(keep).slice(0, options.list)
    if (options.json) out(JSON.stringify(rows.map(({ root, record }) => ({ root, id: record.id, sessionId: record.sessionId, startedAt: record.startedAt, status: record.status, terminalCode: record.terminalCode ?? null, terminalReason: record.terminalReason, goal: record.goal })), null, 2))
    else {
      out(`Data roots: ${roots.join(', ')}\n`)
      for (const { record } of rows) out(`${record.id}  ${String(record.startedAt ?? '').slice(0, 19)}  ${String(record.status).padEnd(11)} ${record.terminalCode ?? ''} ${clip(record.terminalReason ?? '', 60)} — ${clip(record.goal ?? '', 70)}`)
    }
    return 0
  }

  let entry
  let currentSession
  if (options.target === 'current-session') {
    currentSession = currentSessionRuns(roots, options.currentRun)
    entry = currentSession[0]
  } else if (options.target === 'latest' || options.target === 'latest-unfinished') {
    const runs = listRuns(roots).filter(keep).filter((item) => !(isUnsettled(item.record.status) && ownerAlive(item.root, item.record.id)))
    entry = options.target === 'latest' ? runs[0] : runs.find((item) => looksUnfinished(item.root, item.record))
    if (!entry) throw new Error(`No ${options.target === 'latest' ? 'settled' : 'unfinished'} run found${options.session ? ` in session ${options.session}` : ''}.`)
  } else {
    entry = findRun(roots, options.target)
    if (!entry) throw new Error(`Run ${options.target} was not found under: ${roots.join(', ')}`)
  }

  if (Number.isFinite(options.around)) {
    const { events } = readEvents(join(entry.root, 'runs', entry.record.id))
    const window = events.filter((event) => Math.abs(event.sequence - options.around) <= options.span && event.type !== 'message.delta')
    for (const event of window) {
      const payload = { ...event.payload }
      if (event.type === 'context.snapshot') { payload.systemPrompt = clip(payload.systemPrompt, 300); delete payload.tools }
      out(JSON.stringify({ sequence: event.sequence, timestamp: event.timestamp, type: event.type, payload }).slice(0, 6000))
    }
    return 0
  }

  const digest = analyzeRun(entry.root, entry.record, { timeline: options.timeline })
  digest.session = (currentSession ?? listRuns([entry.root])
    .filter((item) => item.record.sessionId === entry.record.sessionId && !item.record.parentRunId))
    .map(({ record }) => ({ id: record.id, startedAt: record.startedAt, status: record.status, terminalCode: record.terminalCode ?? null, resumedFromRunId: record.resumedFromRunId }))
    .reverse()
  const here = dirname(fileURLToPath(import.meta.url))
  const { workspace, repos } = discoverRepos([options.workspace, process.env.XINGULAR_WORKSPACE, process.cwd(), entry.record.workingDirectory, here])
  digest.workspace = workspace
  digest.repos = repoState(repos, entry.record.startedAt)
  if (options.children) {
    digest.childDigests = []
    const seen = new Set([entry.record.id])
    const pending = [...digest.evidence.children]
    for (let index = 0; index < pending.length; index += 1) {
      const child = pending[index]
      if (seen.has(child.id)) continue
      seen.add(child.id)
      const record = readJson(join(entry.root, 'runs', child.id, 'run.json'))
      if (!record || typeof record.id !== 'string' || record.id !== child.id) continue
      const childDigest = analyzeRun(entry.root, record, { timeline: 25 })
      digest.childDigests.push(childDigest)
      pending.push(...childDigest.evidence.children)
    }
  }

  if (options.json) out(JSON.stringify(digest, null, 2))
  else {
    out(renderMarkdown(digest))
    for (const child of digest.childDigests ?? []) out(`\n---\n\n${renderMarkdown(child)}`)
  }
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.exitCode = main()
  } catch (error) {
    process.stderr.write(`run-digest: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}

