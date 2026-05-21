# Leash documentation

The docs that ship with the code. These pages are the contract: when a new CLI flag, policy field, error code, or upstream adapter lands, the doc here is updated **before** the code.

The full rule lives in [`CLAUDE.md`](../CLAUDE.md) under "Documentation-first workflow."

## Pages

| Page | For | Status |
|---|---|---|
| [`index.md`](index.md) | What Leash is, who it's for, the three-minute pitch. | Draft |
| [`quickstart.md`](quickstart.md) | First-time setup → first paid call in 5 minutes. | Draft |
| [`policy.md`](policy.md) | The full policy-file format spec, every field, every validation. | Draft |
| [`cli.md`](cli.md) | Every `leash` command, every flag, every exit code, every error. | Draft |
| [`mcp-tools.md`](mcp-tools.md) | The 5 own tools + the upstream-tool prefix convention + the error envelope. | Draft |
| [`upstreams.md`](upstreams.md) | The live-verified upstream catalog, per-upstream pricing and protocol notes. | Draft |
| [`adapter-guide.md`](adapter-guide.md) | High-level guide for contributors adding a new upstream. The full walkthrough is in `.claude/skills/writing-x402-adapters/SKILL.md`. | Draft |

## Three audiences

The docs are written for three readers; each page declares its primary audience at the top:

- **User** — someone running an agent (the `cryptonit` operator). They want a working setup, a clear policy file, and a CLI that doesn't surprise them. Targets: `index`, `quickstart`, `policy`, `cli`.
- **Contributor** — someone changing Leash itself (adding an adapter, fixing a bug, extending the CLI). Targets: `adapter-guide`, plus [`CONTRIBUTING.md`](../CONTRIBUTING.md) and [`CLAUDE.md`](../CLAUDE.md).
- **Agent** — Claude Code running inside an agent repo. Targets: `mcp-tools.md` (for tool schemas), `upstreams.md` (for what's available). The agent's `CLAUDE.md` (shipped in `examples/*/CLAUDE.md`) points to these.

## Preview locally

Until the static-site generator is wired (planned alongside the `getleash.dev` deploy), the docs are read directly on GitHub at `github.com/getleash/leash/tree/main/docs` or in your editor as Markdown.

## Conventions

- **One H1 per page**, matching the filename.
- **Examples are runnable.** Code blocks in `quickstart.md` and `cli.md` should be copy-paste-able against the current build. If a command changed, the example changed too.
- **Errors are quoted verbatim** — the exact string the user sees, not a paraphrase.
- **Internal phase / sprint terminology stays out** of these pages. Talk about behavior and contracts, not project history.
- **Link to source when useful.** A field's validation rules live in code; the doc summarizes and points to it.

## How to update these docs

1. Edit the page directly (these are plain Markdown).
2. If you change a user-visible surface in code, update the matching doc page in the **same PR** — that's the docs-first rule. Code review will flag a PR that doesn't.
3. When adding a new doc, add a row to the table above + an entry in the relevant audience list.
4. Keep the "Status" column honest: `Draft` until reviewed once end-to-end, `Stable` once the surface it describes is shipping and field-tested.
