# Repo routing

`<workspace>/AGENTS.md`, section "Classify a request", is authoritative; read it before routing. Then read the target repository's own `AGENTS.md`. Folders are found by package identity (the digest's "Source checkouts"), not by the names `Harness/` or `App/`.

The ladder, first yes wins:

1. Does it only measure, compare or grade runs? → **Evaluation**.
2. Is it something a person or a model can do (a tool, a capability, a gate rule, a stop rule)? → **Harness**: the capability, its server methods and its terminal surface. Then the App screen. Update `docs/parity.md`.
3. Does it need an operating-system object only the App has (WebKit tab, keychain, computer control)? → the **Harness** contract, with a terminal fallback or an "unavailable" state, plus the **App** native backend.
4. Is it only how the App shows an existing capability? → **App**.
5. Is it about catalog entries, plugin listings or payloads? → **Hub**.
6. Is it a variant's behaviour (prompt wording, skills, c1–c8)? → a **variant** change through refinement, not a Harness release (`03-variants.md`, INV-FND-1/2).

When you route a fix, check it against the "Never" list in the workspace `AGENTS.md`. Common ones:
- the Harness never names an application (INV-BND-2);
- the App never writes run records;
- a benchmark score is never a reason to change product code.

## What each repository needs in a fix

| Repo | Spec it must respect | Checks to name in the fix |
|---|---|---|
| Harness | `docs/architecture/` pages and `INV-*`; update them in the same change | `npm run typecheck`, `npm test`, `npm run prove` for server, CLI or startup changes |
| App | `docs/architecture/overview.md`, `app-only-surfaces.md` | `npm run typecheck`, `npm test`, `npm run check:layers`, `cargo test` in `src-tauri` |
| Evaluation | `docs/protocol.md`; bump the suite or grader version when a task changes | `uv sync --locked --offline`, then `unittest` |
| Hub | `CONTRIBUTING.md`; published versions are immutable | `npm run build`, `npm run check`, `npm test` |
