# Proposal drafting

This turns one diagnosis report into one draft design record in the repository that owns the fix. Write exactly one new file, tell the person its path, and stop. Committing, branching and implementing are for the person to ask for later.

1. **Read the target's conventions.** Read the repository's `AGENTS.md`, and the newest two records in its proposals folder. Copy their front matter and section shape, not this page's.
2. **Pick the next id and path:**

   | Repo | Folder | Name | Front matter |
   |---|---|---|---|
   | Harness | `docs/architecture/proposals/` | `PROP-<next 4-digit>-<slug>.md` | `id`, `title`, `status: Draft`, `created`, `updated`, `affects: [INV-…, NN-page.md, parity.md]` |
   | App | `docs/proposals/` | follow the newest file's numbering | as the newest file |
   | Evaluation | `docs/features/` | follow the newest file's numbering | as the newest file |
   | Hub | `<workspace>/outputs/proposals/` | `hub-<slug>.md` | none: it is the body of a pull request |
   | Variant | `<workspace>/outputs/proposals/` | `variant-<slug>.md` | none: it is a brief for refinement, with no Harness release |

   The next number is the highest existing one plus one. Check for a number already used on another branch with `git log --all --oneline -- <folder>`.

3. **Write the draft:**
   - **Problem:** start with the evidence: the run id and `seq` citations from the report, and how often it happens if a sweep showed it.
   - **Proposal:** the change. Name every contract, `INV-*` and spec page it touches, and say whether it is foundation or variant.
   - **Surfaces:** for a capability, the terminal surface and the App screen (parity).
   - **Tests:** the test that goes red today.
   - **Alternatives:** at least one, and why it lost.
   - **Out of scope.**
   - Link back to the report file.
4. **Check the draft.** Confirm every file path and `INV-*` you cite exists (`grep -rn "INV-XXX" docs/`). Done when the draft cites only things that exist and the person has the path.
