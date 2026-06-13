import { ethers } from "ethers";
import { TREE_HEIGHT } from "./constants.js";

// Spend-side note shape consumed by the swap circuit's InputNote witness
// (mirrors @pampalo/shared's InputNote).
export interface InputNote {
  asset_id: string;
  asset_amount: string;
  owner: string;
  owner_secret: string;
  secret: string;
  leaf_index: string;
  path: string[];
  path_indices: string[];
}

export const EMPTY_NOTE: InputNote = {
  asset_id: "0",
  asset_amount: "0",
  owner: "0",
  owner_secret: "0",
  secret: "0",
  leaf_index: "0",
  path: Array(TREE_HEIGHT - 1).fill("0"),
  path_indices: Array(TREE_HEIGHT - 1).fill("0"),
};

// Assemble an InputNote witness from a note's fields + its merkle proof.
export function inputNote(
  note: {
    assetId: bigint;
    amount: bigint;
    owner: bigint;
    ownerSecret: bigint;
    secret: bigint;
    leafIndex: bigint;
  },
  proof: { siblings: bigint[]; indices: number[] },
): InputNote {
  return {
    asset_id: note.assetId.toString(),
    asset_amount: note.amount.toString(),
    owner: note.owner.toString(),
    owner_secret: note.ownerSecret.toString(),
    secret: note.secret.toString(),
    leaf_index: note.leafIndex.toString(),
    path: proof.siblings.map((s) => s.toString()),
    path_indices: proof.indices.map((i) => i.toString()),
  };
}

// Build the raw 11-field public-input array the contract reads, for tests
// that drive privateSwap with a mock verifier (no real proof):
//   [root, n1,n2,n3, c1,c2,c3, inputAsset, inputAmount, outputAsset, T]
export function swapPublicInputs(opts: {
  root: bigint;
  nullifiers: [bigint, bigint, bigint];
  outputCommitments: [bigint, bigint, bigint];
  inputAsset: string;
  inputAmount: bigint;
  outputAsset: string;
  targetOutput: bigint;
}): string[] {
  const b32 = (v: bigint) => ethers.toBeHex(v, 32);
  const addr = (a: string) => ethers.zeroPadValue(a, 32);
  return [
    b32(opts.root),
    ...opts.nullifiers.map(b32),
    ...opts.outputCommitments.map(b32),
    addr(opts.inputAsset),
    b32(opts.inputAmount),
    addr(opts.outputAsset),
    b32(opts.targetOutput),
  ];
}
