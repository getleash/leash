# Contributing to Leash

Thanks for thinking about contributing. Leash is single-maintainer for now (Stepan Kouba, [@stepankouba](https://github.com/stepankouba)) — small drive-by fixes and well-scoped PRs are welcome; larger features should be discussed in an issue first so we don't both spend a weekend on incompatible designs.

## Quick start

```bash
git clone https://github.com/getleash/leash.git
cd leash
git submodule update --init --recursive   # contracts/lib/kernel
npm install
npm run build --workspaces
npm test --workspaces
```

Contracts:

```bash
cd contracts
forge test --fork-url $BASE_RPC_URL       # 66 tests on a Base mainnet fork
```

Set `BASE_RPC_URL` to any Base RPC endpoint (the public one at `https://mainnet.base.org` works for tests).

## What to read first

- [`README.md`](README.md) — the project pitch, quickstart, and architecture overview.
- [`CHANGELOG.md`](CHANGELOG.md) — what shipped recently and why.
- `packages/*/src/` — the implementation. Each package's `index.ts` is a clean entry point.
- `contracts/src/` — the three on-chain contracts: `LeashFactory`, `SessionKeyValidator`, `VerifyingPaymaster`.

## What's in scope

Good fits for a contribution:

- **Bug fixes.** Especially anything where the policy bounds, session-key lifecycle, or signature construction misbehave. Pair with a regression test.
- **Adapter for a new x402-enabled upstream.** Each upstream is a ~30 LOC adapter in `packages/mcp-server/src/upstreams/` + a `payTo` entry in `packages/core/src/upstream-payto.ts` + a unit test. See `coinmarketcap.ts` as the template. Inclusion filter: permissionless (no API-key signup), USDC on Base, $0.001–$0.50 per call, stable URL backed by docs or a working live endpoint. Open an issue first with the candidate's 402 response so we don't duplicate work.
- **Docs improvements.** README and the in-repo documentation are the user-facing contract; treat them as code.
- **Test coverage.** Especially fork tests for edge cases in `contracts/test/` or vitest cases that exercise error paths in `packages/`.

Discuss in an issue before starting:

- New CLI commands or material UX changes to existing ones.
- New on-chain contracts or non-trivial validator changes.
- Anything that moves package boundaries or changes the public API of `@getleash/core`.
- New protocol support beyond x402 (e.g. ERC-4337 v0.8 migration, multi-chain).

Not currently accepted:

- Adapter PRs for upstreams that aren't permissionless / don't settle in USDC on Base / cost >$0.50/call. See the inclusion filter above.
- Speculative refactors without a measurable benefit (LOC, perf, or surface narrowing) — three similar lines is fine; a premature abstraction is worse.

## How to propose a change

1. **Open an issue** describing the problem or proposal. For obvious bug fixes, skip straight to the PR.
2. **Branch off `main`.** Name the branch `<topic>/<short-slug>` (e.g. `fix/policy-parser-trailing-newline`).
3. **Keep PRs small.** A reviewable PR is ≤300 LOC of substance plus tests. If it's bigger, split it.
4. **Tests must pass:** `npm test --workspaces` (217+) and `forge test --fork-url $BASE_RPC_URL` (66+). If you add features that hit live infra, add a vitest + a fork test rather than a script.
5. **No formatter wars.** Match the existing style (Prettier config at repo root applies). If your editor reflows long blocks, undo that before committing.
6. **PR description:** what problem this solves, what changed, how it was tested. Reference any related issue.

## Coding conventions

These come up enough to spell out:

- **TypeScript strict mode.** No `as any` or `@ts-ignore` in production paths. Tests can use them sparingly for type-narrowing assertions.
- **No new dependencies casually.** If you need a library, justify it in the PR (size, alternatives considered, security posture). We prefer viem and the existing stack; one new top-level dep is often a 1-day discussion.
- **Comments explain why, not what.** Names should already explain what. Use comments for hidden constraints, subtle invariants, "this looks wrong but is intentional because X".
- **Error messages have context.** Include file paths, line numbers, the field that's wrong. Errors returned from MCP tools follow a structured shape — see `packages/mcp-server/src/errors.ts` for the canonical format.
- **No console.log in production paths.** The MCP server runs as a stdio subprocess; stdout pollution breaks the JSON-RPC framing. Use the existing structured logging where it exists; add minimal logging where it doesn't.

## Commit messages

One-line subject in imperative mood, optional body for context:

```
parser: derive SUPPORTED_UPSTREAMS from UPSTREAM_PAYTO

Adding a new upstream is now a single edit in upstream-payto.ts;
the parser auto-accepts it. Closes #42.
```

No specific commit-message template required, but please write the *why*, not just the *what*.

## Security issues

See [`SECURITY.md`](SECURITY.md). Don't open a public issue for security vulnerabilities — email **stepan.kouba@gmail.com** directly.

## License

By contributing, you agree your contributions are licensed under the [MIT License](LICENSE) — same as the rest of the project.

---

If you've made it this far and still want to contribute, that's already a good signal. Open an issue or PR and we'll go from there.
