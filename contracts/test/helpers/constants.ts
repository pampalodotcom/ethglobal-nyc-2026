import { ethers } from "ethers";

// ─── Base mainnet: Uniswap v4 + tokens ──────────────────────────────────
export const BASE = {
  POOL_MANAGER: "0x498581ff718922c3f8e6a244956af099b2652b2b", // Uniswap v4
  V3_ROUTER: "0x2626664c2603336E57B271c5C0b26F421741e481", // Uniswap v3 SwapRouter02
  USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // 6 dec
  WETH: "0x4200000000000000000000000000000000000006", // 18 dec
} as const;

export type Venue = "v4" | "v3";

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

// privateSwap takes an opaque `bytes route` decoded by the venue adapter.
// v4: abi.encode(Hop[]), Hop = (PoolKey, zeroForOne).
const HOP_ARRAY_TYPE =
  "tuple(tuple(address,address,uint24,int24,address) poolKey, bool zeroForOne)[]";
export function encodeV4Route(
  hops: Array<{ poolKey: typeof USDC_WETH_POOL_KEY; zeroForOne: boolean }>,
): string {
  return ethers.AbiCoder.defaultAbiCoder().encode(
    [HOP_ARRAY_TYPE],
    [hops.map((h) => [h.poolKey, h.zeroForOne])],
  );
}
// v3: packed path tokenIn || fee || tokenOut [|| fee || token...].
export function encodeV3Route(tokens: string[], fees: number[]): string {
  const types: string[] = ["address"];
  const values: (string | number)[] = [tokens[0]];
  for (let i = 0; i < fees.length; i++) {
    types.push("uint24", "address");
    values.push(fees[i], tokens[i + 1]);
  }
  return ethers.solidityPacked(types, values);
}

// USDC → WETH single-hop routes for each venue (0.05% pool).
export const ROUTES: Record<Venue, string> = {
  v4: encodeV4Route([{ poolKey: USDC_WETH_POOL_KEY, zeroForOne: false }]),
  v3: encodeV3Route([BASE.USDC, BASE.WETH], [500]),
};

// USDC on Base (FiatTokenV2_2) stores balances in the mapping at slot 9.
export const USDC_BALANCE_SLOT = 9n;

export const TREE_HEIGHT = 12;
// keccak256(abi.encodePacked("TANGERINE")) % BN254_PRIME — the empty-leaf
// value seeded by PoseidonMerkleTree.setPoseidon.
export const ZERO_VALUE =
  0x1e2856f9f722631c878a92dc1d84283d04b76df3e1831492bdf7098c1e65e478n;
