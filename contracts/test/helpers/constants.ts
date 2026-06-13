import { ethers } from "ethers";

// ─── Base mainnet: Uniswap v4 + tokens ──────────────────────────────────
export const BASE = {
  POOL_MANAGER: "0x498581ff718922c3f8e6a244956af099b2652b2b",
  USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // 6 dec
  WETH: "0x4200000000000000000000000000000000000006", // 18 dec
} as const;

export const USDC_UNIT = 10n ** 6n;
export const WETH_UNIT = 10n ** 18n;

// PoolKey currencies are address-sorted: WETH (0x42..) < USDC (0x83..), so
// currency0 = WETH, currency1 = USDC. Selling USDC for WETH sells currency1
// for currency0 → zeroForOne = false (one-for-zero).
export const USDC_WETH_POOL_KEY: [string, string, number, number, string] = [
  BASE.WETH,
  BASE.USDC,
  500, // fee
  10, // tickSpacing
  ethers.ZeroAddress, // hooks
];
export const USDC_TO_WETH_HOP: [typeof USDC_WETH_POOL_KEY, boolean] = [
  USDC_WETH_POOL_KEY,
  false,
];

// USDC on Base (FiatTokenV2_2) stores balances in the mapping at slot 9.
export const USDC_BALANCE_SLOT = 9n;

export const TREE_HEIGHT = 12;
// keccak256(abi.encodePacked("TANGERINE")) % BN254_PRIME — the empty-leaf
// value seeded by PoseidonMerkleTree.setPoseidon.
export const ZERO_VALUE =
  0x1e2856f9f722631c878a92dc1d84283d04b76df3e1831492bdf7098c1e65e478n;
