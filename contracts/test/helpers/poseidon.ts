import { poseidon2Hash } from "@zkpassport/poseidon2";

// Thin wrappers over @zkpassport/poseidon2 — the same Poseidon2 used by the
// Noir circuits (pum_lib) and the on-chain huff hasher, so values computed
// here match both the proof witness and the contract's merkle tree.
export const poseidonHash = (inputs: bigint[]): bigint =>
  BigInt(poseidon2Hash(inputs).toString());

// Note commitment / merkle leaf: poseidon2([asset_id, amount, owner, secret]).
// Matches pum_lib::reconstruct_leaf and the leaf PampaloSwap inserts.
export const noteCommitment = (
  assetId: bigint,
  amount: bigint,
  owner: bigint,
  secret: bigint,
): bigint => poseidonHash([assetId, amount, owner, secret]);

// Spend nullifier: poseidon2([leaf_index, owner, secret, asset_id, amount]).
export const noteNullifier = (
  leafIndex: bigint,
  owner: bigint,
  secret: bigint,
  assetId: bigint,
  amount: bigint,
): bigint => poseidonHash([leafIndex, owner, secret, assetId, amount]);

// Poseidon identifier (owner pubkey) from an owner secret: poseidon2([secret]).
export const ownerPubkey = (ownerSecret: bigint): bigint =>
  poseidonHash([ownerSecret]);
