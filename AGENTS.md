## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

When the user types `/graphify`, use the installed graphify skill or instructions before doing anything else.

Rules:
- When graphify-out/graph.json exists, run `graphify query "<question>"` before your first grep, search or source-file read for a codebase question, and put this rule in every subagent prompt that explores code. Read raw files only for lines the graph or an earlier read already located. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- Dirty graphify-out/ files are expected after hooks or incremental updates; dirty graph files are not a reason to skip graphify. Only skip graphify if the task is about stale or incorrect graph output, or the user explicitly says not to use it.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
- A committed graphify-out/graph.json is rewritten whole on every build, so a large diff to it in a pull request is expected. Do not flag it as churn or suggest skipping the graph rebuild or its hooks.

## Graphify in this repo

- The graph is built locally and is code-first. TS/TSX/Astro/Python/SQL files are indexed by AST; markdown only by headings. SQL migration bodies (`packages/db/drizzle/*.sql`) and plan docs (`PROGRESS.md`, `DECISIONS.md`, `BLOCKERS.md`) are mostly file nodes, so read the specific file once the graph has pointed you to it.
- Query with code identifiers, not prose: prose words match unrelated symbols (e.g. "between" hits `secondsBetween`). Start with a small budget (`--budget 800`), then narrow with `graphify explain "<symbol or repo path>"`, e.g. `graphify explain "packages/db/src/migrate.ts"`.
- Starting points: AI model routing → `ModelProvider` (`packages/agent-kernel/src/types.ts`, `gateway.ts`); Meta → `packages/connectors/src/providers/meta.ts`; DB migrations → `runAllMigrations()` in `packages/db/src/migrate.ts`.
- Git hooks rebuild the graph in the background after commits, checkouts, merges and rebases. Run `graphify update .` yourself (local, ~35 s) after significant uncommitted changes (adding, deleting, moving or renaming files or exported symbols) before relying on the graph again. Add `--force` if it refuses to shrink the graph after a refactor that deleted code. Edits inside a function body don't need a refresh.
- Never run `graphify extract` without `--code-only`, or `graphify cluster-only` / `graphify label` without `--no-label`: those paths can send repository content to an external LLM. `graphify-out/` is gitignored; don't commit it.
- The graph only speeds up navigation. Still read the code you change, and still run `npm run typecheck`, `npm run lint` and `npm test`.
