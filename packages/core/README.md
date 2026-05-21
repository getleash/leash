# @getleash/core

Shared TypeScript primitives for [Leash](https://getleash.dev) — a scoped wallet for AI agents that pay for APIs.

This package is the "no I/O" layer: types, ABIs, policy parser, Kernel-wrapped EIP-712 builder, x402 challenge parser, USDC EIP-3009 signer, and the canonical `UPSTREAM_PAYTO` registry. It's imported by `@getleash/mcp-server`, `@getleash/bundler`, and `@getleash/cli`.

## Install

```bash
npm install @getleash/core
```

You usually don't install this directly — install `@getleash/cli` and it pulls `@getleash/core` in transitively. Install `@getleash/core` on its own only when building Leash-adjacent tooling (custom adapter generators, off-chain verifiers, etc.).

## Use

```ts
import { parsePolicy, buildKernelHash, wrapForKernel } from '@getleash/core';
```

Full API + the policy file format + Kernel-wrap details: **[getleash.dev](https://getleash.dev)** (or the `docs/` directory of [github.com/getleash/leash](https://github.com/getleash/leash)).

## License

MIT © Stepan Kouba and Leash contributors.
