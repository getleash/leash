# GitHub Actions for Leash

Three workflows under `.github/workflows/`:

| Workflow | Trigger | What it runs |
|---|---|---|
| `test.yml` | Every PR + push to `main` | `npm test --workspaces` + `forge test --fork-url $BASE_RPC_URL`. No Claude. |
| `security-review.yml` | PR diffs touching `contracts/src/**` or `packages/*/src/**` | Claude runs `/security-audit` (Sol) and/or `/security-review-ts` (TS), posts findings as a PR comment. Comment-only — does not block merge. |
| `nightly-sweep.yml` | Cron `0 3 * * *` (03:00 UTC) + manual `workflow_dispatch` | Runs both security reviews against `main`. Opens (or updates) a GitHub issue labelled `security` + `nightly-sweep` if CRITICAL/HIGH findings appear. |

## Required repository secrets

Configure under **Settings → Secrets and variables → Actions**:

| Secret | Used by | Notes |
|---|---|---|
| `BASE_RPC_URL` | `test.yml`, `security-review.yml` (contracts job), `nightly-sweep.yml` | A dedicated Base RPC endpoint. The public `https://mainnet.base.org` works but is load-balanced and flakes under CI parallelism; Alchemy or QuickNode are reliable. |
| `ANTHROPIC_API_KEY` | `security-review.yml`, `nightly-sweep.yml` | API key for the `anthropics/claude-code-action`. Issue one with usage limits set at the Anthropic console so a runaway prompt can't burn through your monthly cap. |

The default `GITHUB_TOKEN` is automatic — no setup required.

## Claude action version

All Claude jobs currently use `anthropics/claude-code-action@beta`. Once you've run a few PRs through and confirmed the interface is stable for this repo, **pin to a SHA** (not just a tag):

```yaml
- uses: anthropics/claude-code-action@<commit-sha>
```

SHA pinning is the supply-chain-hygiene default for any third-party action in a repo that handles signed transactions.

## Why comment-only (not merge-blocking) by default

`security-review.yml` posts findings as a PR comment but never exits non-zero. The team builds confidence in the reviewer's signal-to-noise before tightening to a hard gate. To switch later:

1. Add a final job that parses the Claude comment for `CRITICAL` or `HIGH`.
2. Exit non-zero if found.
3. Mark that job as a required status check in branch protection.

## Disabling a workflow temporarily

Either rename the file (e.g. `.yml.off`) on a branch, or use **Actions → workflow → … → Disable workflow** in the GitHub UI. Don't delete — disabling is reversible.

## Local equivalents

Everything CI runs has a local equivalent:

```bash
# what test.yml runs
npm ci && npm run build --workspaces && npm test --workspaces
cd contracts && forge test --fork-url $BASE_RPC_URL -vv

# what security-review.yml runs (against local diff vs main)
claude --print '/security-audit'        # in this repo, inside Claude Code
claude --print '/security-review-ts'    # in this repo, inside Claude Code
```

Run them locally before pushing to save a CI round-trip.
