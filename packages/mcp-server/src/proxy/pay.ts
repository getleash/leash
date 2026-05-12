import { type Hex, type Address } from 'viem';
import type { PrivateKeyAccount } from 'viem/accounts';
import {
  type X402Accepted,
  type X402Authorization,
  type X402Challenge,
  buildWitnessOuter1271Signature,
  hashTransferWithAuthorization,
  networkToChainId,
  wrapForKernel,
} from '@getleash/core';
import type { UpstreamAdapter } from '../upstreams/types.js';
import type { AgentRuntime } from '../agent-config.js';

// ─── x402 payment signing ────────────────────────────────────────────
//
// Collapses the live path into one function: given a parsed challenge
// (from @getleash/core::parseX402Challenge) and the agent's runtime,
// produce (signature, authorization) ready to drop into buildPaymentPayload.
//
// The signing chain, from the inside out:
//   USDC EIP-712 digest (TransferWithAuthorization)
//     ↳ Kernel EIP-712 wrapper ({name:"Kernel", version:"0.3.3", ...})
//       ↳ session-key ECDSA signature (65 bytes)
//         ↳ append abi.encode(witness) = 160 bytes — the v2 design from
//                                                    summary/eip3009-policy-enforcement.md
//           ↳ prepend 0x01 || sessionKeyValidator(20) routing prefix
//             ↳ → USDC SignatureChecker → Kernel.isValidSignature →
//                 SessionKeyValidator.isValidSignatureWithSender

export interface SignX402PaymentParams {
  challenge: X402Challenge;
  chosen: X402Accepted;
  adapter: UpstreamAdapter;
  runtime: AgentRuntime;
  sessionKey: PrivateKeyAccount;
  /** Override Date.now()/1000 in tests. */
  nowSec?: number;
}

export interface SignedX402Payment {
  signature: Hex;
  authorization: X402Authorization;
  /** The USDC TransferWithAuthorization digest — used as the payment identifier in the SQLite log. */
  authorizationDigest: Hex;
  /** Kernel-wrapped digest that the session key actually signed. */
  kernelDigest: Hex;
}

export async function signX402Payment(
  params: SignX402PaymentParams,
): Promise<SignedX402Payment> {
  const { challenge, chosen, adapter, runtime, sessionKey } = params;
  const chainId = networkToChainId(chosen.network);
  const nowSec = params.nowSec ?? Math.floor(Date.now() / 1000);

  // USDC EIP-712 domain — honour adapter's declared source.
  const domain =
    adapter.usdcDomainSource === 'challenge-extra'
      ? {
          name: chosen.extra?.name ?? runtime.chainConfig.usdcDomainName,
          version: chosen.extra?.version ?? runtime.chainConfig.usdcDomainVersion,
        }
      : {
          name: runtime.chainConfig.usdcDomainName,
          version: runtime.chainConfig.usdcDomainVersion,
        };

  // Time bounds: validAfter = now - 60s (tolerate small clock skew),
  // validBefore = now + maxTimeout + 60s (room for the facilitator to settle).
  const validAfter = BigInt(nowSec - 60);
  const validBefore = BigInt(nowSec + chosen.maxTimeoutSeconds + 60);
  const nonce = randomNonce();
  const value = BigInt(chosen.amount);

  const from = runtime.agent.subAccount;
  const to = chosen.payTo;

  const authorization: X402Authorization = {
    from,
    to,
    value: value.toString(),
    validAfter: validAfter.toString(),
    validBefore: validBefore.toString(),
    nonce,
  };

  // ── inner: USDC TransferWithAuthorization digest ─────────────────
  const authorizationDigest = hashTransferWithAuthorization({
    from,
    to,
    value,
    validAfter,
    validBefore,
    nonce,
    usdc: chosen.asset as Address,
    usdcDomainName: domain.name,
    usdcDomainVersion: domain.version,
    chainId,
  });

  // ── Kernel envelope ──────────────────────────────────────────────
  const kernelDigest = wrapForKernel({
    innerHash: authorizationDigest,
    subAccount: from,
    chainId,
  });

  // ── session key signs the kernel digest ──────────────────────────
  const ecdsaSig = await sessionKey.sign({ hash: kernelDigest });

  // ── outer 1271 signature with witness payload ────────────────────
  // The validator's 1271 path rebuilds the USDC digest from the witness,
  // verifies digest-equality against the supplied `hash`, recovers the
  // ECDSA signer, then enforces per-recipient cap on `to`/`value`. See
  // contracts/src/SessionKeyValidator.sol::isValidSignatureWithSender.
  const signature = buildWitnessOuter1271Signature({
    validator: runtime.chainConfig.sessionKeyValidator,
    ecdsaSig,
    witness: { to, value, validAfter, validBefore, nonce },
  });

  return { signature, authorization, authorizationDigest, kernelDigest };
}

// ─── helpers ─────────────────────────────────────────────────────────

function randomNonce(): Hex {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `0x${Buffer.from(bytes).toString('hex')}` as Hex;
}
