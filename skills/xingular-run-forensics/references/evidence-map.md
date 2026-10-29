# Evidence map

Paths are relative to the Harness checkout. The spec in `docs/architecture/` is binding. When it disagrees with code, note the drift instead of picking a side.

## Where a run lives

`<data root>/runs/<run id>/`, written only by the Harness (`src/sessions/runStore.ts`):

| File | Holds |
|---|---|
| `run.json` | The record. Key fields: `status`, `terminalCode`, `terminalReason`, `goal`, `trigger`, `parentRunId`, `resumedFromRunId`, `model`, `effectiveMode`, `workspaceRoot` |
| `events.jsonl` | Every validated event, in `sequence` order. Event types and payloads: `src/sessions/contracts.ts` |
| `capabilities.json` | The frozen capability set: the tools, connectors and plugin contributions this run could use (INV-RUN-1) |
| `context.json` | The compiled context pack: sections, sizes, and variant scope and fingerprint (`src/prompt/compile.ts`) |
| `subagents.json`, `owner.json` | Child run ids; the owning process id |

The data root comes from `--data`, or the profile at `~/.xingular-harness/profile.json`. The dev setup uses `~/.xingular-harness-dev`, whose profile may point at the App's `vault`. Spec: `12-storage.md`.

## Events that explain a stop

| Event | Meaning | Emitted by | Spec |
|---|---|---|---|
| `failed {code, message}` | The run failed. `provider_error` comes from the model call; `terminal_attention` from the terminal | `runner.ts`, `terminal/controller.ts` | 02 |
| `status.changed {status:'interrupted', reason, code}` | Interrupted; `code` is the stop code (newer runs) | `registry.ts` `finish`, `runStore.ts` reconcile | 02 |
| `tool.refused {toolCallId, name, code, reason}` | The gate, plan mode, or the work slice refused a call (newer runs; older runs show only `tool.completed{ok:false}` text) | `sessions.ts` gate, `runner.ts`, `workSlice.ts`, `terminal/piExtension.ts` | 07 |
| `approval.requested/resolved` | A person was asked; `decision`, and `automatic` when a standing rule answered | `registry.ts`, `sessions.ts` gate | 07 |
| `question.requested/answered` | The model asked the person | `registry.ts` | 02 |
| `checkpoint {reason, next, blocked}` | The work-slice handoff | `workSlice.ts`, `compactionCheckpoint.ts` | 02 |
| `heartbeat {steps, maxToolCalls, compactions}` | Liveness and slice counters, every 30 s | `runner.ts` | 02 |
| `compaction.started/ended` | Context compaction; `aborted`, `error`, `tokensBefore` | `runner.ts` | 04 |
| `usage.updated {contextTokens, contextWindow, request.stopReason}` | Per-request size and stop reason | `runner.ts` | 02 (token accounting) |
| `retry.*`, `account.status {category}` | Provider retries; classified account trouble | `runner.ts`, `src/accounts/` | 09 |
| `todo.updated`, `message.completed` | The model's plan and its replies | Pi via `runner.ts` | 02 |

## Other readers

- **Model tools:** `trajectory_search`, `trajectory_read`, `history_search`.
- **Server methods:** `runs.continuation` is the Harness's own "why did it stop and can it resume" summary (`src/sessions/continuation.ts`). Also `runs.events` and `runs.family`.
- **Terminal pages:** `/trajectory <run-id>`, `/context`, `/log`, `/doctor`.
