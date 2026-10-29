# Failure taxonomy

The digest prints findings as `class / code`. Use the same words in your verdict. **Intended** means
the Harness did what its spec says; the fix is advice to the person, or a proposal to change the rule,
not a bug fix.

| Class | Code | Signals in the digest | Intended? | Usual fix and owner |
|---|---|---|---|---|
| guardrail | `plan_mode` | refusal "Plan mode is research-only…" / "Plan mode Bash is read-only…" | yes | Leave plan mode or approve the plan. If a research tool was wrongly refused: Harness `planMode.ts` |
| guardrail | `workspace` | "…outside the active project workspace…" | yes | Open the right project or approve the boundary escape. Wrong root detection: Harness `workspaceBoundary.ts` |
| guardrail | `scope` | "Outside the approved work scope." | yes | Host scope policy (App `ToolPolicy.scope`); Harness only if the gate misreads the scope |
| guardrail | `policy` | "Tool unavailable in the app settings." | yes | Turn the tool on in the host settings; App policy if the setting is wrong |
| guardrail | `approval_denied` | refusal "The user denied this action…", approval `denied` | yes | Re-run and approve; standing approval if repeated |
| guardrail | `unattended` | "Refused in a refinement/reflection run…" | yes | By design (INV-REF-4); nothing to fix in a person's run |
| guardrail | `work_slice` | "…reached its work-slice limit…" | yes | Continue the session; slice policy lives in Harness `workSlice.ts` |
| guardrail | `controller_unavailable` | "The terminal controller is unavailable" | **no** | Harness terminal (`piExtension.ts`, `controller.ts`) |
| lifecycle | `slice_budget` | interrupted `slice_complete` + budget checkpoint | yes | Continue: the next slice reads the checkpoint |
| lifecycle | `compaction_thrash` | three compactions in one reply, or aborted compactions | partly | Context too big for the task: split the work. Harness if compaction itself failed |
| lifecycle | `context_pressure` | peak context ≥ 85 %, many compactions, provider "too long" | partly | Variant prompt size, tool output trimming (`output-trim`), or the task |
| lifecycle | `stalled` / `owner_gone` | reconciled after no heartbeat / no owner | **no** | Find what hung (last tool call, a long `bash`): Harness stall watch or the tool |
| lifecycle | `harness_restart` | "…stopped before the run settled." | **no** | Why the Harness or App restarted (crash, update, quit) |
| lifecycle | `terminal_attention` / `terminal_closed` | terminal startup error, decision callback lost, terminal closed | **no** | Harness terminal |
| lifecycle | `never_settled` | status still running/waiting, owner gone | **no** | Harness run store reconciliation |
| capability | `capability_gap` | the model says it lacks a tool or access; calls to unknown tools; the needed tool is missing from the capability set | — | Harness capability first (tool, server method, terminal surface), then the App screen. A host-only object (WebKit, computer control) needs a Harness contract plus an App backend |
| provider | `provider_error` | `failed{provider_error}`, `account.status`, retries, stop reason `length` | external | auth/quota/rate limit: the account. Unsupported model or unconfigured provider: settings or Harness model catalogue. A misreported error: Harness `runner.ts`, `src/accounts/` |
| model | `model_behaviour` | completed with open todos, a blocked checkpoint, a last reply that asks or says what is left, loops | — | Often the variant (c1–c8: prompt, skills) through refinement. Sometimes the model is right that it was blocked; check before blaming it |
| user | `user_abort` / `awaiting_person` | bare interrupt, a steer, unanswered approvals or questions | yes | Nothing to fix; say so |
| environment | `tool_errors` | error streaks from `bash`, tests, installs in the person's project | external | The person's project, not product code |
| none | `completed` / `live` | no unfinished signal / still running | — | Ask what was expected and compare it with the result |

## Distinguishing look-alikes

- **Capability gap vs model behaviour.** Is the tool the model needed in `capabilities.json` for this run? If it is, and the model didn't use it, that's model behaviour. If it isn't, that's a capability gap or a plugin or connector that is switched off.
- **Guardrail vs defect.** A refusal is intended when the rule in the spec matches the situation. It is a defect when the rule, applied to this call's arguments, should have allowed it. Quote the arguments (`--around`).
- **Completed vs finished.** `completed` means the model stopped replying. Whether the work is done is your judgement: compare the request with the final todo, the checkpoint, and the last reply.
