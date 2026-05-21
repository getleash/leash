---
description: Leash-specific security review of the TypeScript surface. Runs the vitest suite, then reviews the diff (or specified files) against the Leash-aware checklist — session-key invariants, x402 nonce/witness handling, MCP stdio purity, SQLite budget integrity, env-var leakage, CLI confirmation gates. Read-only review; produces a CRITICAL / HIGH / MEDIUM / LOW / INFO report.
allowed-tools: Bash(npm test:*), Bash(npm run build:*), Bash(npm run test:*), Bash(git diff:*), Bash(git log:*), Bash(git status), Bash(git show:*), Bash(rg:*), Bash(ls:*), Bash(jq:*), Read, Grep, Glob
---

Run a Leash-specific security review on the TypeScript surface. Work step-by-step; report at the end.

## Step 1 — run the full TS suite

```bash
npm test --workspaces
```

Report pass/fail counts. Anything failing is a blocker — fix it (or have it fixed) before continuing.

## Step 2 — confirm typecheck passes

```bash
npm run build --workspaces
```

Strict-mode TypeScript is the first line of defense. A build error is a finding.

## Step 3 — establish the scope

If the user named specific files, review those. Otherwise:

```bash
git diff origin/main...HEAD -- 'packages/*/src/**/*.ts'
```

If there's no diff, ask the user what to review — don't review the whole codebase blindly.

## Step 4 — manual review against the Leash-specific checklist

Read every changed `.ts` line **in full context** (load surrounding 30+ lines, don't review hunks in isolation). For each finding, note severity (CRITICAL / HIGH / MEDIUM / LOW / INFO), the `file:line`, and a one-paragraph explanation.

### A. Session-key handling (HIGHEST risk — the #1 Leash invariant)

CLAUDE.md: *"Session keys never touch disk. They live in-memory inside the `leash serve` subprocess."*

- **CRITICAL** if any new code path writes a session key (or any field that includes one) to disk via `fs.writeFile*`, `localStorage`, `sqlite`, or any logging sink.
- **CRITICAL** if a session key is included in an error message, stack trace, or thrown error — error formatters can be captured by the agent harness.
- **HIGH** if a session key is passed through a function whose other callers log their inputs.
- **HIGH** if `process.env` is used to *read* a session key (env vars leak into child processes and `ps` output).
- Trace any new variable named `sessionKey`, `signerKey`, `privateKey`, `mnemonic`, `seed` from origin to last use. Where does it die? Is the buffer zeroed? (Node has no `zero-on-drop`, but at minimum it shouldn't survive past the request that needed it.)

### B. x402 signing path

The signing code lives in `@getleash/core` (`x402.ts`, `kernel-wrap.ts`, `authorization.ts`). The proxy in `packages/mcp-server/src/proxy/` calls it. Bugs here are settlement bugs and worse — replay bugs.

- **CRITICAL** if a witness field (`to`, `value`, `validAfter`, `validBefore`, `nonce`) is constructed from agent-controlled input without validation. The witness is the cap-enforcement record; spoofing it bypasses the on-chain check.
- **CRITICAL** if a nonce is ever reused, or derived from a non-cryptographic source. `randomBytes(32)` is the standard; anything else needs justification.
- **CRITICAL** if the USDC EIP-712 domain is built with `version: "2.2"` instead of `"2"`. Greppable; verify on any new digest builder.
- **HIGH** if `chainId` is hardcoded inconsistently or read from a non-trusted source. Both the EIP-3009 digest and the Kernel envelope must agree, and both must equal the chain we're actually broadcasting to.
- **HIGH** if a retry attempt re-uses a previously rejected sig. Failures should re-sign with a fresh nonce, not retry with the old witness.
- **MEDIUM** if `validAfter`/`validBefore` windows are unreasonably wide (>1h forward, >5min back) without a comment justifying it.

### C. MCP stdio purity (server.ts, tools/*, proxy/*)

CLAUDE.md: *"The MCP server runs as a stdio subprocess; stdout pollution breaks the JSON-RPC framing."*

- **CRITICAL** if any new `console.log` / `process.stdout.write` appears in code reachable from `packages/mcp-server/src/` (excluding tests). It will silently corrupt the MCP frame.
- **HIGH** if a logger writes to stdout by default. Loggers in this codebase write to stderr; verify any new logger inherits that.
- **MEDIUM** if an error message contains user-controlled markup that could break a downstream parser (newlines, JSON-special chars, control chars).
- **LOW** if a stderr log includes a session-key fragment, fund balance, or other agent-exfiltrable secret. An MCP client can be coaxed into reading stderr in some configurations.

### D. SQLite budget integrity (`packages/mcp-server/src/db.ts`)

The SQLite store enforces *local* policy (rolling daily/weekly/monthly windows). On-chain enforces the hard cap, but SQLite is what stops the agent from burning the budget in a single window.

- **CRITICAL** if any query is built by string concatenation of agent input. `?` placeholders mandatory.
- **HIGH** if a counter can be reset, decremented, or bypassed by a tool call without operator confirmation. The agent must not be able to call its own way out of the budget.
- **HIGH** if a write happens outside a transaction in a code path that reads-then-writes a counter (race condition on concurrent tool calls).
- **MEDIUM** if schema migrations are present but not gated on a version check (re-running migrations is idempotent only if explicitly designed that way).
- **LOW** if errors leak the schema (table/column names) to the agent — these are guessable, but make recon free.

### E. Input validation at MCP/proxy boundaries

The agent (LLM) is **untrusted input**. Every value the agent sends to a tool or through the proxy needs validation.

- **HIGH** if a tool handler trusts the agent's `amount`, `recipient`, `upstream` field without normalization (lowercase hex, address checksum, range check).
- **HIGH** if a proxy route forwards an agent-supplied header verbatim. The agent can inject `X-PAYMENT` and try to short-circuit the 402 flow.
- **MEDIUM** if a tool returns the raw exception (`error.message`) to the agent. Use the structured shape in `packages/mcp-server/src/errors.ts`.
- **MEDIUM** if a URL is constructed by template-string-concatenating agent input. Use `URL` / `URLSearchParams`.
- **LOW** if a Zod (or similar) schema is missing on a tool input. Schemas are belt-and-braces; missing them is a slow-burn finding.

### F. CLI confirmation gates (`packages/cli/src/commands/`)

CLAUDE.md: *"Real money lives behind clear gates. Anything that signs and broadcasts a transaction to Base mainnet must (a) read its config from env, (b) print a confirmation summary, and (c) require explicit operator action — no auto-broadcast on a script's happy path."*

- **CRITICAL** if a new command broadcasts a tx without an explicit `--yes` / prompt acknowledgement. Reject any "trust the config" flow on mainnet.
- **HIGH** if a command reads a private key from a CLI flag (it shows up in `ps`). Env var or stdin only.
- **HIGH** if `fund`, `drain`, `transfer`, `revoke`, or `apply` skip the confirmation summary in any branch.
- **MEDIUM** if Sepolia/mainnet distinction is implicit (relying on `BASE_RPC_URL` alone). The summary should print the chain ID and the resolved chain name.

### G. Env-var hygiene

- **HIGH** if `console.log(process.env)` or any "dump all env" appears anywhere. Even in test setup.
- **HIGH** if `.env` files are read by any code outside `packages/cli/` (the CLI is the only legitimate consumer; the proxy gets its config via the agent config dir).
- **MEDIUM** if a required env var is checked late (at call time) instead of at startup. Late checks fail mid-payment, which is worse than refusing to start.
- **LOW** if `.env.example` has drifted from the env vars the code actually reads — outdated examples mislead operators into setting nothing or the wrong thing.

### H. Bundler / UserOp construction (`packages/bundler/`)

- **CRITICAL** if `accountGasLimits` or `gasFees` packing is changed and doesn't preserve big-endian 16B||16B layout (CLAUDE.md "Key technical details" section).
- **HIGH** if any code path falls back to ERC-4337 v0.6 fields (`callGasLimit` as a separate field, etc.). v0.7 only in this repo.
- **MEDIUM** if RPC errors leak the full endpoint URL (and an API key embedded in it) into a thrown error.

### I. Dependency hygiene

- **HIGH** for any new top-level dep added without justification in the PR (CONTRIBUTING.md rule).
- **HIGH** for a dep that has a typo-similar name to a popular package (typo-squatting).
- **MEDIUM** for a new dep with <100 weekly downloads or an unknown maintainer.
- **LOW** if `package-lock.json` is regenerated without explanation. Lockfile churn hides supply-chain swaps.

### J. Process / child-process surface

- **HIGH** if a new `spawn` / `exec` passes user-controlled input as an argument without explicit array form (string-form invokes a shell — injection risk).
- **MEDIUM** if a child process inherits the full parent env by default (use an explicit `env:` allowlist).
- **LOW** if a long-running child process has no exit/kill plumbing — orphans on crash.

## Step 5 — report

Produce a structured summary:

- **Test results:** counts from Steps 1 and 2.
- **Findings:** every issue from Step 4, categorized CRITICAL / HIGH / MEDIUM / LOW / INFO with `file:line`.
- **Recommendations:** specific code changes for each non-INFO finding.
- **Status:** **PASS** (no CRITICAL/HIGH issues) or **NEEDS WORK** (action required before merge).

If the review passes, state explicitly: "TS surface ready for merge." If issues are found, list exactly what needs to change and where.

Do **not** modify any source files during this review — read-only. Any changes go in a separate PR after triage.
