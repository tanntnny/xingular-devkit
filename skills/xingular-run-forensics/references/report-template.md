# Report template

Fill every section. Write "none" or "unknown" with the reason rather than dropping a section. Cite as `seq N` and `repo/path:line`.

```markdown
# Run diagnosis: <first 8 of run id> — <one-line verdict>

Run `<run id>` · session `<session id>` · <started> → <ended> · <model> · data root `<path>`
Harness checkout `<branch>@<commit>` (newer than the run: yes/no)

## TL;DR
<two or three sentences: what was asked, how far it got, why it stopped, what to do>

## What was asked
<first user message, quoted, seq N>

## What happened
<5–10 bullets from the timeline, each with seq N>

## Root cause
- **Class / code:** <class> / <code> — <intended | defect | capability gap | external | model behaviour>
- **Mechanism:** <what the Harness, App or model did, with repo/path:line>
- **Rule:** <spec page § / INV-* that governs it, quoted briefly>
- **Confidence:** <high/medium/low> — would change if <evidence>

## Contributing factors
- <finding, seq N, why it mattered or why it did not>

## What to do now
<what the person can do immediately: approve, continue the session, switch the model, leave plan mode…>

## Proposed fix
- **Repository:** <Harness | App | Evaluation | Hub | variant> — routed by <ladder step>
- **Change:** <what changes, file by file>
- **Spec and records:** <pages, INV-*, parity.md, CHANGELOG>
- **Tests:** <the test that goes red without the fix>
- **Risks:** <what could break, other surfaces affected>

## Open questions
- <what the record cannot tell and who can answer it>
```
