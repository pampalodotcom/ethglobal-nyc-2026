import { expect } from "chai";
import { ethers } from "ethers";
import hre from "hardhat";
import { BASE, ROUTES, USDC_UNIT, WETH_UNIT, type Venue } from "./helpers/constants.js";
import { deploySwapFixture, fundUsdc, parseEvent, type SwapFixture } from "./helpers/fixture.js";
import { MerkleTree } from "./helpers/merkle-tree.js";
import { noteCommitment, noteNullifier, ownerPubkey } from "./helpers/poseidon.js";
import { EMPTY_NOTE, inputNote } from "./helpers/notes.js";
import { SwapProver, type SwapWitness } from "./helpers/prover.js";

// Round-trip: a real Noir proof, verified on-chain by the real SwapVerifier,
// drives a real swap against Base liquidity. The proof is venue-agnostic (the
// circuit doesn't know which AMM fills the order), so the SAME proof is run
// through both the v4 and v3 adapters. A test-only harness seeds the input
// note via direct _insert (production seeds via shield → executeShield).
const VENUES: Venue[] = ["v4", "v3"];

const assetA = BigInt(BASE.USDC);
const assetB = BigInt(BASE.WETH);
const noteAmount = 1_000n * USDC_UNIT;
const ownerSecret = 111111111111111111111n;
const noteSecret = 222222222222222222222n;
const recipOwner = 333333333333333333333n; // B-note recipient pubkey
const recipSecret = 444444444444444444444n;
const T = WETH_UNIT / 1000n; // 0.001 WETH floor (<< realized)

// Build the spend witness for our single USDC note, swapping the whole amount
// for WETH (no change note). Each call builds a fresh 1-leaf tree, so
// witness.root is that 1-leaf root — a known root on-chain once seeded.
function buildSpend(): { leaf: bigint; nullifier: bigint; tree: MerkleTree; witness: SwapWitness } {
  const owner = ownerPubkey(ownerSecret);
  const leaf = noteCommitment(assetA, noteAmount, owner, noteSecret);
  const tree = new MerkleTree();
  tree.insert(leaf, 0);
  const nullifier = noteNullifier(0n, owner, noteSecret, assetA, noteAmount);
  const bHash = noteCommitment(assetB, T, recipOwner, recipSecret);
  return {
    leaf,
    nullifier,
    tree,
    witness: {
      root: tree.root(),
      inputNotes: [
        inputNote(
          { assetId: assetA, amount: noteAmount, owner, ownerSecret, secret: noteSecret, leafIndex: 0n },
          tree.proof(0),
        ),
        EMPTY_NOTE,
        EMPTY_NOTE,
      ],
      nullifiers: [nullifier, 0n, 0n],
      outputHashes: [bHash, 0n, 0n],
      swapNote: { owner: recipOwner, secret: recipSecret },
      changeNote: { owner: 0n, secret: 0n },
      inputAsset: assetA,
      inputAmount: noteAmount,
      outputAsset: assetB,
      targetOutput: T,
    },
  };
}

// One Barretenberg worker shared across all venues; the proof is identical.
let prover: SwapProver;
before(async () => {
  prover = new SwapProver();
  await prover.init();
});
after(async () => {
  await prover?.destroy();
});

for (const venue of VENUES) {
  describe(`private swap round-trip — ${venue} (real proof, Base fork)`, () => {
    let fx: SwapFixture;

    before(async () => {
      fx = await deploySwapFixture(await hre.network.connect("baseFork"), {
        venue,
        harness: true,
        realVerifier: true,
      });
    });

    it("proves a real swap spend and executes it against Base", async () => {
      const { leaf, nullifier, tree, witness } = buildSpend();

      await (await fx.contract.harnessInsert(leaf)).wait();
      expect(tree.root(), "off-chain root must match on-chain").to.equal(
        await fx.contract.currentRoot(),
      );

      const proof = await prover.prove(witness);
      // bb.js returns the 11 declared public inputs; the aggregation fields
      // (NUMBER_OF_PUBLIC_INPUTS=19 - 11) ride inside the proof bytes.
      expect(proof.publicInputs.length).to.equal(11);

      await fundUsdc(fx.connection, fx.swapAddr, noteAmount);
      const usdcBefore = await fx.usdc.balanceOf(fx.swapAddr);
      const wethBefore = await fx.weth.balanceOf(fx.swapAddr);
      const nextIndexBefore = await fx.contract.nextIndex();

      const receipt = await (
        await fx.contract.privateSwap(proof.proof, proof.publicInputs, ROUTES[venue], [])
      ).wait();

      expect(usdcBefore - (await fx.usdc.balanceOf(fx.swapAddr))).to.equal(noteAmount);
      const realized = (await fx.weth.balanceOf(fx.swapAddr)) - wethBefore;
      expect(realized).to.be.greaterThan(T);

      // Only the B note was inserted (no change note).
      expect(await fx.contract.nextIndex()).to.equal(nextIndexBefore + 1n);
      expect(await fx.contract.nullifierUsed(ethers.toBeHex(nullifier, 32))).to.equal(true);

      const ev = parseEvent(fx.contract, receipt, "PrivateSwapExecuted");
      expect(ev, "PrivateSwapExecuted not emitted").to.not.equal(undefined);
      expect(ev!.args.realizedOutput).to.equal(realized);

      console.log(
        `    [${venue}] real proof: 1000 USDC -> ${ethers.formatEther(realized)} WETH ` +
          `(note minted @ ${ethers.formatEther(T)} WETH), gas ${receipt.gasUsed.toLocaleString()}`,
      );
    });

    it("rejects a replayed proof (nullifier already spent)", async () => {
      // Same spend again, proven against the 1-leaf historical root (still
      // known after the first swap moved currentRoot). Nullifier is burned.
      const { witness } = buildSpend();
      const proof = await prover.prove(witness);

      await expect(
        fx.contract.privateSwap(proof.proof, proof.publicInputs, ROUTES[venue], []),
      ).to.be.revertedWith("Nullifier already spent");
    });
  });
}
