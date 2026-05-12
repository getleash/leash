# verify-grant

Standalone counterparty-verifier for Leash authorization grants.

Given a `SignedAuthorizationGrant` JSON file produced by `leash apply`,
this example runs the **pure signature check** — the part a counterparty
can do offline, without any RPC calls. See
[`summary/authorization-object.md`](../../summary/authorization-object.md)
for the full two-RPC flow (hub binding + session-key currency) that a
production counterparty would compose on top.

## Run

```bash
# From this directory
npx tsx verify.ts sample-grant.json
```

Expected output:

```
✓ signature valid
  signer:    0x14791697260E4c9A71f18484C9f997B308e59325
  principal: 0x14791697260E4c9A71f18484C9f997B308e59325
  agent:     0x6C718844Aaa21cAad240C2F968173095f62b40D9
  ...
```

Pass a tampered file to see the failure path:

```bash
# Edit sample-grant.json — change a limit or the purpose — then:
npx tsx verify.ts sample-grant.json
# ✗ signature does not verify against grant.principal
```

## What the verifier does NOT do

- **No RPC.** A real counterparty would additionally check
  `LeashFactory.hubOfSub(subAccount)` resolves to the hub owned by
  `principal`, and `SessionKeyValidator.sessions(subAccount)` shows the
  `agent` still registered and unexpired. Those require a Base RPC
  endpoint and are out of scope for this example.
- **No policy integrity check.** If you have the policy markdown, you
  can compute `hashPolicyMarkdown(markdown)` and compare against
  `grant.policyHash` locally. Also out of scope here.
- **No revocation check.** On-chain revocation (`uninstallValidation`)
  is observed by the session-key-currency RPC above; off-chain
  principal revocation (`grant.revokedAt`) is visible in the JSON itself.

## Adapting this into your own service

The three functions you'd lift:

```typescript
import {
  hashAuthorizationGrant,        // deterministic digest
  verifyAuthorizationGrantSignature, // pure crypto
  hashPolicyMarkdown,            // integrity anchor if you have the markdown
} from '@getleash/core';
```

No other Leash code is required. The verifier has zero dependencies on
the MCP server, CLI, or bundler.
