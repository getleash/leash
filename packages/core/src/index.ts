// @getleash/core — shared TS primitives.
//
// Stable surface used by the bundler, MCP server, and CLI.
// Policy / AuthorizationGrant / x402 types and the Kernel-wrapped
// EIP-712 builder live here so there's one source of truth for each
// primitive across the workspaces.

// ─── Types ───────────────────────────────────────────────────────────
export type {
  AgentPolicy,
  AuthorizationGrant,
  ChainName,
  MCPError,
  MCPErrorCategory,
  MCPErrorCode,
  PackedUserOperation,
  PolicyCheckResult,
  PolicyCounterparty,
  PolicyLimits,
  PolicyUpstream,
  SessionKeyEntry,
  SignedAuthorizationGrant,
  TransactionRecord,
  X402Accepted,
  X402Authorization,
  X402Challenge,
  X402LeashMeta,
  X402Network,
  X402PaymentPayload,
  X402PaymentPayloadV1,
  X402PaymentPayloadV2,
  X402Scheme,
} from './types.js';

// ─── Constants ───────────────────────────────────────────────────────
export {
  BASE_MAINNET,
  BASE_SEPOLIA,
  GAS_DEFAULTS,
  KERNEL_DOMAIN_NAME,
  KERNEL_DOMAIN_VERSION,
  KERNEL_ROOT_VALIDATOR_PREFIX,
  KERNEL_WRAPPER_TYPEHASH,
  USDC_DECIMALS,
  formatUsdc,
  getChainConfig,
  parseUsdc,
} from './constants.js';
export type { ChainConfig } from './constants.js';

// ─── ABIs ────────────────────────────────────────────────────────────
export {
  ecdsaValidatorAbi,
  entryPointAbi,
  erc20Abi,
  kernelAbi,
  leashFactoryAbi,
  sessionKeyValidatorAbi,
  verifyingPaymasterAbi,
} from './abis/index.js';

// ─── Policy parser ───────────────────────────────────────────────────
export { parsePolicy, PolicyParseError } from './policy-parser.js';

// ─── Static upstream payTo registry ──────────────────────────────────
export { UPSTREAM_PAYTO, resolveUpstreamPayTo } from './upstream-payto.js';
export type { UpstreamPayTo } from './upstream-payto.js';

// ─── Kernel-wrapped EIP-712 + EIP-3009 digest ────────────────────────
// `wrapForKernelManual` is intentionally NOT exported — it's a parity
// guard against viem's `hashTypedData` used only by `kernel-wrap.test.ts`,
// which imports it directly. Adding it to the public surface invites a
// downstream consumer to depend on the slower manual path.
export {
  buildWitnessOuter1271Signature,
  encodeEip3009Witness,
  hashTransferWithAuthorization,
  prefixRootValidatorSignature,
  prefixSecondaryValidatorSignature,
  wrapForKernel,
} from './kernel-wrap.js';
export type {
  BuildWitnessSignatureParams,
  Eip3009WitnessParams,
  TransferWithAuthorizationParams,
  WrapForKernelParams,
} from './kernel-wrap.js';

// ─── x402 parser + retry builder ─────────────────────────────────────
export {
  buildPaymentPayload,
  encodeRetryHeader,
  networkToChainId,
  parseX402Challenge,
  X402ParseError,
} from './x402.js';
export type { BuildPaymentPayloadParams, ParseX402Input } from './x402.js';

// ─── Authorization Grant (principal → agent) ─────────────────────────
export {
  LEASH_AUTHORIZATION_DOMAIN_NAME,
  LEASH_AUTHORIZATION_DOMAIN_VERSION,
  canonicalizeGrant,
  hashAuthorizationGrant,
  hashPolicyMarkdown,
  mintGrantId,
  signAuthorizationGrant,
  verifyAuthorizationGrantSignature,
} from './authorization.js';
export type { VerifyGrantResult } from './authorization.js';
