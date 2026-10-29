# Sweep: patterns across runs

Use a sweep when the question is about runs in general ("why do my runs keep stopping?"), not one run.

1. **List** runs with `node …/run-digest.mjs --list 1000 --json`. Add `--session <id>` to narrow it, or `--all` to include system and subagent runs. Keep the runs inside the requested window (default: last 7 days). If the list reaches its limit and its oldest run is still inside the window, increase the limit and repeat; disclose any remaining bound.
2. **Digest every run in the window**, including completed runs, with `node …/run-digest.mjs <id> --json --timeline 0`. Completion alone does not establish the work was finished. Record `findings.primary[*].class/code`, `intended`, and the detail. Done when every run in the window has a row.
3. **Tally** by `class/code`, separating intended from not intended. A code that appears three or more times, or any not-intended lifecycle or guardrail code, is a **pattern**.
4. **Pick a representative run** for each pattern. Run the full single-run workflow on it (SKILL.md steps 3 to 5). The tally says how often; the representative run says why.
5. **Report** to `<workspace>/outputs/diagnoses/<YYYY-MM-DD>-sweep.md`:
   - the window and the run count;
   - the tally table;
   - per pattern: the representative run, the verdict and the routed fix;
   - runs you could not classify.

   Offer a proposal for the most frequent pattern that is not intended.
