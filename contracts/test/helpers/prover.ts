import { Noir } from "@noir-lang/noir_js";
import { UltraHonkBackend, Barretenberg, type ProofData } from "@aztec/bb.js";
import swapCircuit from "../../../circuits/target/circuits.json" with { type: "json" };
import type { InputNote } from "./notes.js";

export interface SwapWitness {
  root: bigint;
  inputNotes: InputNote[]; // length 3
  nullifiers: bigint[]; // length 3
  outputHashes: bigint[]; // length 3 ([0]=B note, [1]=A change, [2]=0)
  swapNote: { owner: bigint; secret: bigint };
  changeNote: { owner: bigint; secret: bigint };
  inputAsset: bigint;
  inputAmount: bigint;
  outputAsset: bigint;
  targetOutput: bigint;
}

// Wraps Noir witness execution + bb.js proving for the swap circuit. One
// Barretenberg worker; call destroy() in an `after` hook so the process can
// exit. Proofs use keccakZK to match the bb-generated solidity verifier
// (write_vk --oracle_hash keccak + the ZK Honk verifier).
export class SwapProver {
  private noir!: Noir;
  private backend!: UltraHonkBackend;
  private api!: Barretenberg;

  async init(): Promise<void> {
    this.api = await Barretenberg.new();
    this.noir = new Noir(swapCircuit as never);
    this.backend = new UltraHonkBackend((swapCircuit as never).bytecode, this.api);
  }

  async prove(w: SwapWitness): Promise<ProofData> {
    const { witness } = await this.noir.execute({
      root: w.root.toString(),
      input_notes: w.inputNotes as never,
      nullifiers: w.nullifiers.map((n) => n.toString()),
      output_hashes: w.outputHashes.map((c) => c.toString()),
      swap_note: {
        owner: w.swapNote.owner.toString(),
        secret: w.swapNote.secret.toString(),
      } as never,
      change_note: {
        owner: w.changeNote.owner.toString(),
        secret: w.changeNote.secret.toString(),
      } as never,
      input_asset: w.inputAsset.toString(),
      input_amount: w.inputAmount.toString(),
      output_asset: w.outputAsset.toString(),
      target_output: w.targetOutput.toString(),
    });
    return this.backend.generateProof(witness, { keccakZK: true });
  }

  async destroy(): Promise<void> {
    await this.api?.destroy();
  }
}
