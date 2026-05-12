import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

console.log('=== Leash Testnet Key Generation ===\n');

const deployerKey = generatePrivateKey();
const deployerAccount = privateKeyToAccount(deployerKey);

const paymasterSignerKey = generatePrivateKey();
const paymasterSignerAccount = privateKeyToAccount(paymasterSignerKey);

const bundlerKey = generatePrivateKey();
const bundlerAccount = privateKeyToAccount(bundlerKey);

console.log('Deployer (deploys factory + paymaster, one-time use):');
console.log(`  Private key: ${deployerKey}`);
console.log(`  Address:     ${deployerAccount.address}\n`);

console.log('Paymaster signer (signs gas sponsorship approvals):');
console.log(`  Private key: ${paymasterSignerKey}`);
console.log(`  Address:     ${paymasterSignerAccount.address}\n`);

console.log('Bundler (submits UserOps, pays gas):');
console.log(`  Private key: ${bundlerKey}`);
console.log(`  Address:     ${bundlerAccount.address}\n`);

console.log('--- Next steps ---');
console.log(`1. Fund deployer with testnet ETH:  ${deployerAccount.address}`);
console.log(`   → https://www.alchemy.com/faucets/base-sepolia`);
console.log(`   → Or https://faucet.quicknode.com/base/sepolia`);
console.log(`2. Fund bundler with testnet ETH:   ${bundlerAccount.address}`);
console.log(`   (same faucets, needs ~0.01 ETH for submitting UserOps)`);
console.log(`3. Copy these into .env:`);
console.log(`\n   DEPLOYER_PRIVATE_KEY=${deployerKey}`);
console.log(`   PAYMASTER_SIGNER_KEY=${paymasterSignerKey}`);
console.log(`   PAYMASTER_SIGNER_ADDRESS=${paymasterSignerAccount.address}`);
console.log(`   BUNDLER_PRIVATE_KEY=${bundlerKey}`);
console.log(`   CHAIN=base-sepolia`);
console.log(`   BASE_RPC_URL=https://sepolia.base.org`);
