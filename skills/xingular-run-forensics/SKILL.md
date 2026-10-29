---
name: xingular-run-forensics
description: Diagnose why a Xingular Harness run stopped short (in the xagent terminal or the App), whether it failed, was interrupted, or "completed" with the work undone. Tells a guardrail apart from a Harness limit, a missing capability, the provider, or the model, then proposes the fix in the right Xingular repository. Also use it to find patterns across recent runs.
---

# Xingular run forensics

You are doing **forensics** on a recorded run. The run record is the crime scene. Every claim in your
verdict cites **evidence**: an event `seq` from the run, plus a source `file:line` or a spec section.
A claim without a citation is a guess. Label it as one.

The bundled script turns a run record into a compact, cited **digest**. Run it with Node from this skill's folder:

```sh
node <this-skill-dir>/scripts/run-digest.mjs --help
```

You read; you do not repair. Your only writes are:
- the report;
- when the person asks, one proposal draft.

Product code stays untouched.

## Steps

1. **Pick the run.**
   - With no run id, use `latest-unfinished`. It skips runs that are still live, including this one.
   - If the person's description doesn't match what the digest shows, run `--list 15` and ask which run they mean.
   - `--session <id>` narrows the search to one conversation.
   - Done when you have one run id that the person's description matches.

2. **Read the digest.** Run `node …/run-digest.mjs <run-id>`. Add `--children` when a subagent did not complete.
   - Read all of it, including the timeline and the "Source checkouts" section.
   - Done when you can state the outcome, the primary findings, and the `seq` numbers behind each.

3. **Interrogate the evidence.** The digest's classification is a **hypothesis**. Overturn it when the evidence disagrees. For each primary finding, and each contributing one that could explain the stop:
   - Read the moment itself: `--around <seq> --span 8`.
   - Find the mechanism in source. Grep the repository named under "look at" for the refusal text, stop code or behaviour, and cite the exact `file:line`.
     - If the checkout is marked **newer than the run**, check `git log --since=<run start> -- <file>`. The code that ran may differ.
   - Open the spec page named under "spec" and find the rule (`INV-*` or section) that governs it.
   - Compare what was asked (the first user message) with the last reply and the final todo or checkpoint.
   - Done when every finding in your verdict has a `seq` and a `file:line` or spec section, or is marked unconfirmed with the reason.

4. **Reach a verdict.** Classify the run with [the failure taxonomy](references/failure-taxonomy.md).
   - Say which of these it was: **intended** (a guardrail or limit doing its job), **defect**, **capability gap**, **external** (provider, account, environment), or **model behaviour**.
   - State your confidence and the one piece of evidence that would change it.
   - Done when the verdict names one root cause; anything else goes under contributing factors.

5. **Route the fix** with [repo routing](references/repo-routing.md).
   - An intended outcome gets user advice, such as approving the call, leaving plan mode, or continuing the session, instead of a code change.
   - Done when the fix names its repository, the files, and the spec pages or `INV-*`s it touches, and how it would be tested.

6. **Write the report** from [the report template](references/report-template.md).
   - Save it to `<workspace>/outputs/diagnoses/<YYYY-MM-DD>-<first 8 of run id>.md`. The workspace is the folder the digest printed above the checkouts.
   - In chat, give the TL;DR, the verdict, the fix in one line each, and the report path.
   - Done when the file exists and the chat summary fits in eight lines.

7. **Offer a proposal** when the fix belongs in a repository. If the person accepts, follow [proposal drafting](references/proposal-drafting.md).

## Other branches

- **Patterns across many runs** (`/xdiag:sweep`, or "why do my runs keep stopping"): follow [the sweep](references/sweep.md).
- **What an event or field means**, or where the Harness records it: see [the evidence map](references/evidence-map.md).
