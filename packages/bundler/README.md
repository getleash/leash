# @getleash/bundler

In-process ERC-4337 v0.7 bundler for [Leash](https://getleash.dev). Pack a `PackedUserOperation`, fetch the next nonce, attach a `VerifyingPaymaster` sponsorship signature, and submit to an EntryPoint v0.7 — all from inside your Node process. No external rundler service required.

## Install

```bash
npm install @getleash/bundler
```

You usually don't install this directly — install `@getleash/cli` and it pulls `@getleash/bundler` in transitively. Install `@getleash/bundler` on its own only when building 4337 tooling that doesn't want a hosted bundler.

## Use

```ts
import { buildUserOp, packUserOp, submitUserOp } from '@getleash/bundler';
```

Full API + the v0.7 packing layout details + how Leash sponsors gas: **[getleash.dev](https://getleash.dev)**.

**v0.7-only.** No v0.6 back-port; the `PackedUserOperation` shape and `accountGasLimits`/`gasFees` packing are baked in.

## License

MIT © Stepan Kouba and Leash contributors.
