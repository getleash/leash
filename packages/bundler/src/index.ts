// @getleash/bundler — minimal in-process ERC-4337 v0.7 submitter.
//
// The "bundler" in Leash is a thin layer: build a PackedUserOperation
// for a Kernel sub-account, optionally attach VerifyingPaymaster
// sponsorship, sign with the session key, and submit via
// `EntryPoint.handleOps([op], beneficiary)`. No mempool, no bundling
// of multiple ops, no priority-fee auction — one UserOp at a time.
//
// Consumers (the MCP server) compose these primitives; there is no
// hidden wrapper. For an end-to-end example see packages/bundler/test/
// integration/base-fork.test.ts.

// Gas-field packing
export {
  packAccountGasLimits,
  packGasFees,
  unpackPair,
} from './pack.js';

// Kernel nonce encoding
export {
  KERNEL_MODE_DEFAULT,
  KERNEL_VTYPE_PERMISSION,
  KERNEL_VTYPE_VALIDATOR,
  encodeKernelNonce,
  encodeKernelNonceKey,
} from './nonce.js';
export type { EncodeKernelNonceKeyParams } from './nonce.js';

// UserOp construction
export {
  buildUnsignedUserOp,
  encodeSingleExecute,
  getUserOpHash,
} from './user-op.js';
export type {
  BuildUserOpParams,
  EncodeSingleExecuteParams,
  GasOverrides,
} from './user-op.js';

// Paymaster sponsorship
export { NO_PAYMASTER, sponsorUserOp } from './paymaster.js';
export type { SponsorUserOpParams } from './paymaster.js';

// Submission + event parsing
export { parseUserOpEvent, submitUserOp } from './submit.js';
export type {
  ParsedUserOpEvent,
  SubmitUserOpParams,
  SubmitUserOpResult,
} from './submit.js';
