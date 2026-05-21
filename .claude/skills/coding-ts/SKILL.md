---
name: coding-ts
description: Conventions and traps for writing TypeScript in this repo. Use whenever editing files under packages/*/src/, when adding tests, when wiring a new MCP tool or proxy route, when touching the bundler / x402 / Kernel-wrap code, or when adding a CLI command. Codifies the rules the compiler doesn't enforce — stdio purity in the MCP server, bigint USDC math, structured errors, viem retry transport, no-disk-secrets, session-key lifetime.
---

# Writing TypeScript in Leash

The TS surface is ~4 packages (`core`, `bundler`, `mcp-server`, `cli`). Most "obvious" bugs in this codebase aren't compiler-catchable — they're invariants like "never log a session key" or "stdout must stay clean." This file captures the ones that repeat.

If you're doing a **security review**, use the `/security-review-ts` slash command. This file is for *authoring* code.

## Package-shape rules

| Package | Job | Tip |
|---|---|---|
| `core` | Pure utilities. ABIs, parsers, EIP-712 builders, x402 challenge handler. No I/O. | If you reach for `fs` or `fetch` here, you're in the wrong package. |
| `bundler` | In-process ERC-4337 v0.7 bundler. RPC + UserOp assembly. | v0.7 only. No external rundler. |
| `mcp-server` | The stdio MCP proxy. Owns the SQLite store, the upstream adapters, the per-request signing flow. | `stdout` is the JSON-RPC frame — see "stdio purity" below. |
| `cli` | Operator-facing commands. Apply / serve / status / fund / drain / revoke / backup. | This is the *only* package that should ever read or write disk. |

If a new piece of functionality could live in multiple packages, push it toward `core` (testable, no I/O) unless it must do I/O. Avoid circular dependencies — `core` is the leaf; `bundler`, `mcp-server`, `cli` depend on it.

## Strict mode is non-negotiable

CONTRIBUTING.md: *"TypeScript strict mode. No `as any` or `@ts-ignore` in production paths. Tests can use them sparingly for type-narrowing assertions."*

If you find yourself wanting `as any`, the right move is almost always a Zod parse, a discriminated-union narrow, or a `satisfies` check. The wrong move is suppressing the type.

## Session keys never touch disk (THE invariant)

CLAUDE.md: *"Session keys never touch disk. They live in-memory inside the `leash serve` subprocess, derived from the encrypted agent config."*

- **No `fs.writeFile*` ever takes a session key.** Not even for "debug" / "dev-mode" / "temporarily." A PR that does this is a hard reject.
- **No `console.log` / logger call** with a session key in its arguments. Loggers can be tee'd to disk by operators downstream.
- Session keys are derived in `packages/mcp-server/src/session-key.ts`; any new consumer should accept the key as a parameter and not hold a long-lived reference. Drop it when the request completes.
- Disk writes are legitimate in `packages/cli/` (apply, backup, restore, export). Those write *encrypted blobs* and *policy files*, never raw keys. If you're in CLI code and you have a raw key in scope at write time, you're holding the wrong object.

## stdio purity in `mcp-server`

The MCP server runs as a stdio JSON-RPC subprocess. **`stdout` is the wire.** Any uninvited byte on stdout corrupts the frame and breaks every subsequent request.

Rules:
- **No `console.log`, no `console.info`** anywhere reachable from `packages/mcp-server/src/`. Not in production paths, not in dev-only branches that ship.
- Logging goes to **stderr** (`console.error`, or whatever structured logger exists). Stderr is fair game.
- Don't add a logger that defaults to stdout. If you pull in a new logging library, configure it with `stream: process.stderr` explicitly.
- The CLI is not stdio-constrained. `console.log` is fine in `packages/cli/`. The constraint is server-side only.

## Structured errors

`packages/mcp-server/src/errors.ts` is the canonical error shape. Tools return errors with a structured `code`, `message`, and (optionally) `data`. The MCP client renders them; the agent (LLM) sees them.

- **Don't** throw raw `Error`s out of a tool handler. Wrap in the structured shape.
- **Don't** include private state (session-key fragments, fund balances, internal IDs that aren't already public) in `error.message` — the agent can be coaxed into exfiltrating those.
- **Do** include enough context that a human reading the log can diagnose: file path, the offending field name, the upstream name, but not raw secrets.
- Error messages have line numbers and file paths when relevant (CONTRIBUTING.md rule).

## USDC math: bigint everywhere

USDC has 6 decimals. **All internal accounting is bigint base units.**

- Never convert to `number` for arithmetic. Float precision loss in financial code is how money gets lost.
- Display formatting (string for the human) happens at the very last moment, in the CLI or in the tool response.
- Parsing user input: use `parseUnits(str, 6)` from viem. Don't roll your own.

## viem patterns

This repo standardizes on viem. Conventions:

- **Retry transport for any RPC client:** `http(url, { retryCount: 5, retryDelay: 2000 })`. The public Base RPC (`https://mainnet.base.org`) is load-balanced and lags 3–5 seconds after a write. Stale-read errors look like contract bugs but are RPC bugs.
- **Typed contract reads:** use viem's `getContract({ address, abi, client })` rather than untyped `readContract` calls.
- **EIP-712:** use viem's `hashTypedData` / `signTypedData`. Do not hand-roll. The `core/kernel-wrap.ts` and `core/x402.ts` builders already do the wrapping; downstream code should call them, not re-implement.
- **Address handling:** treat addresses as `0x${string}` (viem's `Address` type). Lowercase comparison; checksum on display.

## MCP tool input validation

The agent (LLM) is **untrusted input.** Every tool input goes through validation before reaching anything that touches money or signs.

- Use a Zod schema (or whatever shape the existing tools use — match the pattern).
- Validate addresses are real `0x` + 40 hex chars, then `getAddress(...)` to checksum/normalize.
- Validate amounts are positive bigints within the policy bounds (a tool should reject "1000000000000 USDC" before it ever reaches the signer).
- Reject unknown upstream names. The `UPSTREAM_PAYTO` registry is the allowlist.

The agent will eventually try every weird input. Treat tool boundaries the way you'd treat a public HTTP API.

## SQLite (`packages/mcp-server/src/db.ts`)

- **Parameterized queries only.** `?` placeholders, never string concatenation. Better-sqlite3 makes this easy — there's no reason to skip it.
- **Transactions** for any read-modify-write on a counter. Concurrent tool calls happen.
- The DB enforces *rolling* daily/weekly/monthly windows — on-chain enforces the *hard cap*. Don't blur the boundary; both layers are deliberate.

## CLI conventions

- **Confirmation gates** before broadcasting any tx to Base mainnet. CLAUDE.md: *"read its config from env, print a confirmation summary, and require explicit operator action."* No happy-path auto-broadcast.
- **No private keys via CLI flag.** Flags appear in `ps`. Read from env (`process.env.X`) or stdin.
- **Print chain name + chainId** in the confirmation summary so Sepolia-vs-mainnet is obvious.
- **Exit codes:** non-zero on any failure that should fail CI. Don't silently swallow.

## Adding a new dependency

CONTRIBUTING.md: *"No new dependencies casually. If you need a library, justify it in the PR (size, alternatives considered, security posture). We prefer viem and the existing stack; one new top-level dep is often a 1-day discussion."*

Before adding, check:
- Is it already a transitive dep? Don't add a duplicate.
- Does viem already do it? Often the answer is yes for crypto/RPC.
- Maintenance signal: recent commits, multiple maintainers, no obvious typo-squat risk.

When in doubt, write 20 lines of the helper yourself rather than adding a dep.

## Testing

- **Vitest** in every package. New features extend the existing `*.test.ts` for the module you're changing; new files only for genuinely new modules.
- **Mocks vs fork:** TS unit tests can mock RPC (look at `proxy/*.test.ts` patterns). Integration tests that need real chain state go on the Solidity side via `forge --fork-url`. Don't hit live RPC from TS tests.
- **Fixture-driven adapter tests:** new upstreams test against `tests/fixtures/upstream-probes/<name>.json`. The fixture is golden.
- A new EIP-712 typehash or witness layout needs a TS test that asserts the digest bytes AND a Solidity test that rebuilds the same digest on-chain. Same PR.

## Comments where the protocol bites

CLAUDE.md: *"Generous comments where the protocol is subtle. Anywhere a v0.7-vs-v0.6 difference, a Kernel-wrapped vs. raw signature, or a v1-vs-v2 x402 quirk could trip a future reader — leave a comment with the source of truth."*

This codebase is small enough that comments are load-bearing. Don't explain *what* the code does (the name does that); explain *why* it differs from the obvious approach. If you find yourself writing "this looks wrong but is intentional because X" — that's exactly the comment to leave in.

## Backwards-compat scaffolding

CLAUDE.md: *"No backwards-compat scaffolding before a surface is published."* All four `@getleash/*` packages are still `private: true` on npm (see memory: `npm-publish-pending`). Until publish:

- Change internal APIs and callers in the **same** PR.
- No re-exports, type aliases, or `// removed` comments for removed code.
- Once we ship to npm, this rule flips — but flag the transition in CLAUDE.md when it happens.

## Hard rules (recap)

- Strict mode, no `as any` in prod paths.
- Session keys never on disk, never in logs.
- `console.log` is **forbidden** in `mcp-server/`; use stderr.
- USDC math in bigint base units.
- viem with retry transport for any load-balanced RPC.
- Structured errors via `errors.ts`, no raw `Error` to MCP clients.
- Validate every tool input.
- No SQL via string concat.
- CLI confirmation before mainnet broadcast.
- Justify any new top-level dep.
- New typehash → tests on both sides.
