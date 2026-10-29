# Xingular devkit

Developer tools for people building Xingular Agent. When a run in the `xagent` terminal or the App stops short, this plugin works out why and proposes the fix in the repository that owns it. The cause can be:
- a guardrail (plan mode, the workspace boundary, a policy, or a denied approval);
- a Harness limit (the work-slice budget, compaction, a stall or a restart);
- a missing capability;
- the provider or account;
- the model stopping early.

It is a text-only Pi package: one skill, three slash commands, and a dependency-free Node script. It loads no extension code, so it needs no plugin trust.

## Install

- **Harness terminal:** open `/plugins` and choose **Install package…**. Enter the absolute folder path, for example `/Users/you/…/agent-hub/plugins/xingular-devkit`.
- **App:** open **Plugins**, choose **Install**, and enter the same folder path.

A folder is used where it is, not copied, so edits apply after a restart. New plugins arrive switched off. Switch it on in `/plugins`, globally or for one project, then restart the session.

## Use

| Command | What it does |
|---|---|
| `/xdiag: [run-id\|latest\|latest-unfinished] [what you expected]` | Diagnoses one run. By default it selects the latest prior run in the invoking conversation, including completed or stuck runs. |
| `/xdiag:sweep [days] [focus]` | Tallies why recent runs stopped and diagnoses one example of each pattern. |
| `/xdiag:propose [report path]` | Turns a diagnosis report into one draft proposal in the owning repository. |

These routes require a Harness version implementing the package `commandPrefix` and `defaultPrompt` prompt-routing contract. You can also just ask: "why did my last run stop?" The skill `xingular-run-forensics` triggers on its own.

Reports go to `<workspace>/outputs/diagnoses/`. The workspace is the folder that holds the Xingular repositories, found by package name. Override it with `--workspace` or `$XINGULAR_WORKSPACE`.

The script also works on its own:

```sh
node skills/xingular-run-forensics/scripts/run-digest.mjs --list 20
node skills/xingular-run-forensics/scripts/run-digest.mjs current-session --current-run <full-invoking-run-id>
node skills/xingular-run-forensics/scripts/run-digest.mjs latest-unfinished
node skills/xingular-run-forensics/scripts/run-digest.mjs <run-id> --around 120 --span 8
```

For the default, the skill gets the invoking full run ID from `trajectory_read({run:'current'})`. The selector matches its exact data root and session and, where recorded, native session; it excludes the current and later runs. Missing or ambiguous identity or ordering and no prior run are errors, not a reason to search globally. Explicit selectors retain their existing behavior.

## What it reads and writes

- It **reads** run records under the Harness data roots:
  - `--data`;
  - the `dataRoot` in `~/.xingular-harness{,-dev}/profile.json`;
  - `~/.xingular-harness{,-dev}/data`;
  - the App's `vault`.

  It also runs `git log`/`git status` in the local checkouts.

  Run records hold your prompts and tool output, and they stay on your machine. The skill shows excerpts to the model you are running it with.
- It **writes** only the diagnosis report and, when you ask, one proposal draft. It never edits product code or run records.

## Develop

```sh
npm test    # node --test, against synthetic runs for every failure class
```

The refusal-text table in `run-digest.mjs` (`REFUSAL_PATTERNS`) mirrors the Harness gate's messages. When a Harness records structured `tool.refused` events and a `terminalCode`, the digest uses them; older runs fall back to the text table.
