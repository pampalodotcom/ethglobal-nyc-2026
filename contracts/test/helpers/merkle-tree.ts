import { poseidonHash } from "./poseidon.js";
import { TREE_HEIGHT, ZERO_VALUE } from "./constants.js";

// Off-chain mirror of PoseidonMerkleTree.sol — same ZERO_VALUE and arity-2
// poseidon2 default-node scheme, so its root matches the contract's after
// the same inserts. Enough to insert a leaf and produce an inclusion proof
// for a circuit witness.
//
// (@pampalo/shared ships an equivalent PoseidonMerkleTree, but its package
// exports map points at .ts sources that aren't included in the published
// build, so it isn't importable from here.)
export class MerkleTree {
  readonly levels: number;
  private readonly defaults: bigint[] = [];
  private readonly nodes = new Map<string, bigint>();

  constructor(levels: number = TREE_HEIGHT) {
    this.levels = levels;
    this.defaults[0] = ZERO_VALUE;
    for (let i = 1; i < levels; i++) {
      this.defaults[i] = poseidonHash([
        this.defaults[i - 1],
        this.defaults[i - 1],
      ]);
    }
  }

  private sibling(level: number, index: number): bigint {
    const isLeft = index % 2 === 0;
    return (
      this.nodes.get(`${level}:${isLeft ? index + 1 : index - 1}`) ??
      this.defaults[level]
    );
  }

  insert(leaf: bigint, index: number): void {
    let idx = index;
    let cur = leaf;
    this.nodes.set(`0:${idx}`, cur);
    for (let i = 0; i < this.levels - 1; i++) {
      const isLeft = idx % 2 === 0;
      const sib = this.sibling(i, idx);
      cur = isLeft ? poseidonHash([cur, sib]) : poseidonHash([sib, cur]);
      idx = Math.floor(idx / 2);
      this.nodes.set(`${i + 1}:${idx}`, cur);
    }
  }

  root(): bigint {
    return (
      this.nodes.get(`${this.levels - 1}:0`) ?? this.defaults[this.levels - 1]
    );
  }

  // siblings + indices in the order pum_lib::compute_merkle_root expects:
  // path_indices[i] == 0 → sibling is left; 1 → sibling is right.
  proof(index: number): { siblings: bigint[]; indices: number[] } {
    const siblings: bigint[] = [];
    const indices: number[] = [];
    let idx = index;
    for (let i = 0; i < this.levels - 1; i++) {
      siblings.push(this.sibling(i, idx));
      indices.push(idx % 2 === 0 ? 1 : 0);
      idx = Math.floor(idx / 2);
    }
    return { siblings, indices };
  }
}
