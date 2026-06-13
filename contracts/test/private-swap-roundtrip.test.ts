import { expect } from "chai";
import { ethers } from "ethers";
import hre from "hardhat";
import { Noir } from "@noir-lang/noir_js";
import { UltraHonkBackend, Barretenberg } from "@aztec/bb.js";
import { poseidon2Hash } from "@zkpassport/poseidon2";
import Poseidon2HuffJson from "@pampalo/contracts/contracts/utils/Poseidon2Huff.json" with { type: "json" };
import swapCircuit from "../../circuits/target/circuits.json" with { type: "json" };

// ─── Base mainnet v4 + tokens ───────────────────────────────────────────
const POOL_MANAGER = "0x498581ff718922c3f8e6a244956af099b2652b2b";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const WETH = "0x4200000000000000000000000000000000000006";
const POOL_KEY = [WETH, USDC, 500, 10, ethers.ZeroAddress] as const; // c0=WETH<c1=USDC
const USDC_BALANCE_SLOT = 9n;

const TREE_HEIGHT = 12;
const ZERO_VALUE =
  0x1e2856f9f722631c878a92dc1d84283d04b76df3e1831492bdf7098c1e65e478n; // keccak("TANGERINE") % PRIME

const h2 = (a: bigint, b: bigint) => BigInt(poseidon2Hash([a, b]).toString());
const hN = (xs: bigint[]) => BigInt(poseidon2Hash(xs).toString());

// Minimal off-chain mirror of the on-chain PoseidonMerkleTree — enough to
// insert a leaf and produce an inclusion proof. Same default-node + hash
// scheme as PoseidonMerkleTree.sol, so roots match the contract.
class MerkleTree {
  levels: number;
  defaults: bigint[] = [];
  nodes = new Map<string, bigint>();
  constructor(levels: number) {
    this.levels = levels;
    this.defaults[0] = ZERO_VALUE;
    for (let i = 1; i < levels; i++)
      this.defaults[i] = h2(this.defaults[i - 1], this.defaults[i - 1]);
  }
  insert(leaf: bigint, index: number) {
    let idx = index;
    let cur = leaf;
    this.nodes.set(`0:${idx}`, cur);
    for (let i = 0; i < this.levels - 1; i++) {
      const isLeft = idx % 2 === 0;
      const sib =
        this.nodes.get(`${i}:${isLeft ? idx + 1 : idx - 1}`) ?? this.defaults[i];
      cur = isLeft ? h2(cur, sib) : h2(sib, cur);
      idx = Math.floor(idx / 2);
      this.nodes.set(`${i + 1}:${idx}`, cur);
    }
  }
  root(): bigint {
    return this.nodes.get(`${this.levels - 1}:0`) ?? this.defaults[this.levels - 1];
  }
  proof(index: number): { siblings: bigint[]; indices: number[] } {
    const siblings: bigint[] = [];
    const indices: number[] = [];
    let idx = index;
    for (let i = 0; i < this.levels - 1; i++) {
      const isLeft = idx % 2 === 0;
      siblings.push(
        this.nodes.get(`${i}:${isLeft ? idx + 1 : idx - 1}`) ?? this.defaults[i]
      );
      indices.push(isLeft ? 1 : 0);
      idx = Math.floor(idx / 2);
    }
    return { siblings, indices };
  }
}

const noteHash = (assetId: bigint, amount: bigint, owner: bigint, secret: bigint) =>
  hN([assetId, amount, owner, secret]);
const nullifierOf = (
  leafIndex: bigint,
  owner: bigint,
  secret: bigint,
  assetId: bigint,
  amount: bigint
) => hN([leafIndex, owner, secret, assetId, amount]);

const EMPTY_NOTE = {
  asset_id: "0",
  asset_amount: "0",
  owner: "0",
  owner_secret: "0",
  secret: "0",
  leaf_index: "0",
  path: Array(TREE_HEIGHT - 1).fill("0"),
  path_indices: Array(TREE_HEIGHT - 1).fill("0"),
};

describe("private swap round-trip (real proof, Base fork)", () => {
  let connection: Awaited<ReturnType<typeof hre.network.connect>>;
  let e: any;
  let harness: ethers.Contract;
  let usdc: ethers.Contract;
  let weth: ethers.Contract;
  let swapAddr: string;
  let noir: Noir;
  let backend: UltraHonkBackend;
  let bbApi: Barretenberg;

  // The asset-A (USDC) input note we seed into the tree.
  const assetA = BigInt(USDC);
  const assetB = BigInt(WETH);
  const noteAmount = 1_000n * 10n ** 6n; // 1000 USDC
  const ownerSecret = 111111111111111111111n;
  const noteSecret = 222222222222222222222n;
  const recipOwner = 333333333333333333333n; // B-note recipient pubkey
  const recipSecret = 444444444444444444444n;
  const T = 10n ** 15n; // 0.001 WETH floor (<< realized)

  before(async () => {
    connection = await hre.network.connect("baseFork");
    e = connection.ethers;
    const [deployer] = await e.getSigners();

    const Mock = await e.getContractFactory("MockVerifier");
    const mock = await Mock.deploy();
    await mock.waitForDeployment();
    const mockAddr = await mock.getAddress();

    // The REAL swap verifier — this is what the round-trip exercises. The
    // bb-generated verifier depends on the ZKTranscriptLib library, which
    // must be deployed and linked first.
    const ZKTL = await e.getContractFactory(
      "contracts/verifiers/SwapVerifier.sol:ZKTranscriptLib"
    );
    const zktl = await ZKTL.deploy();
    await zktl.waitForDeployment();
    const SV = await e.getContractFactory("SwapVerifier", {
      libraries: { ZKTranscriptLib: await zktl.getAddress() },
    });
    const swapVerifier = await SV.deploy();
    await swapVerifier.waitForDeployment();

    const PS = await e.getContractFactory("PampaloSwapHarness");
    harness = await PS.deploy(
      mockAddr,
      mockAddr,
      mockAddr,
      mockAddr,
      POOL_MANAGER,
      await swapVerifier.getAddress()
    );
    await harness.waitForDeployment();
    swapAddr = await harness.getAddress();

    const PoseidonFactory = new ethers.ContractFactory(
      [],
      Poseidon2HuffJson.bytecode,
      deployer
    );
    const poseidon = await PoseidonFactory.deploy();
    await poseidon.waitForDeployment();
    await (await harness.setPoseidon(await poseidon.getAddress())).wait();

    await (await harness.addSupportedAsset(USDC, ethers.ZeroAddress, 6)).wait();
    await (await harness.addSupportedAsset(WETH, ethers.ZeroAddress, 18)).wait();

    usdc = new ethers.Contract(
      USDC,
      ["function balanceOf(address) view returns (uint256)"],
      deployer
    );
    weth = new ethers.Contract(
      WETH,
      ["function balanceOf(address) view returns (uint256)"],
      deployer
    );

    bbApi = await Barretenberg.new();
    noir = new Noir(swapCircuit as any);
    backend = new UltraHonkBackend((swapCircuit as any).bytecode, bbApi);
  });

  after(async () => {
    await bbApi?.destroy();
  });

  it("proves a real swap spend and executes it against Base v4", async () => {
    const owner = hN([ownerSecret]); // Poseidon identifier
    const leaf = noteHash(assetA, noteAmount, owner, noteSecret);

    // Seed the note into both the contract tree and the off-chain mirror.
    await (await harness.harnessInsert(leaf)).wait();
    const tree = new MerkleTree(TREE_HEIGHT);
    tree.insert(leaf, 0);

    const onchainRoot = await harness.currentRoot();
    expect(tree.root(), "off-chain root must match on-chain").to.equal(onchainRoot);

    const { siblings, indices } = tree.proof(0);
    const nullifier = nullifierOf(0n, owner, noteSecret, assetA, noteAmount);

    // Swap the whole note (no change). Output note: asset B @ T.
    const bHash = noteHash(assetB, T, recipOwner, recipSecret);

    const inputNote = {
      asset_id: assetA.toString(),
      asset_amount: noteAmount.toString(),
      owner: owner.toString(),
      owner_secret: ownerSecret.toString(),
      secret: noteSecret.toString(),
      leaf_index: "0",
      path: siblings.map((s) => s.toString()),
      path_indices: indices.map((i) => i.toString()),
    };

    const { witness } = await noir.execute({
      root: onchainRoot.toString(),
      input_notes: [inputNote, EMPTY_NOTE, EMPTY_NOTE] as never,
      nullifiers: [nullifier.toString(), "0", "0"],
      output_hashes: [bHash.toString(), "0", "0"],
      swap_note: { owner: recipOwner.toString(), secret: recipSecret.toString() } as never,
      change_note: { owner: "0", secret: "0" } as never,
      input_asset: assetA.toString(),
      input_amount: noteAmount.toString(),
      output_asset: assetB.toString(),
      target_output: T.toString(),
    });

    const proof = await backend.generateProof(witness, { keccakZK: true });
    // bb.js returns the 11 declared public inputs; the aggregation fields
    // (NUMBER_OF_PUBLIC_INPUTS=19 - 11) ride inside the proof bytes.
    expect(proof.publicInputs.length).to.equal(11);

    // Fund the contract's pooled USDC so it can settle the swap.
    const slot = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "uint256"],
        [swapAddr, USDC_BALANCE_SLOT]
      )
    );
    await connection.provider.request({
      method: "hardhat_setStorageAt",
      params: [USDC, slot, ethers.toBeHex(noteAmount, 32)],
    });

    const usdcBefore = await usdc.balanceOf(swapAddr);
    const wethBefore = await weth.balanceOf(swapAddr);
    const nextIndexBefore = await harness.nextIndex();

    const tx = await harness.privateSwap(
      proof.proof,
      proof.publicInputs,
      [[POOL_KEY, false]],
      []
    );
    const receipt = await tx.wait();

    // Spent exactly the note amount of USDC; received realized WETH.
    expect(usdcBefore - (await usdc.balanceOf(swapAddr))).to.equal(noteAmount);
    const realized = (await weth.balanceOf(swapAddr)) - wethBefore;
    expect(realized).to.be.greaterThan(T);

    // Only the B note was inserted (no change note).
    expect(await harness.nextIndex()).to.equal(nextIndexBefore + 1n);

    // The input note's nullifier is spent — replay must now fail.
    expect(await harness.nullifierUsed(ethers.toBeHex(nullifier, 32))).to.equal(true);

    const ev = receipt.logs
      .map((l: any) => {
        try {
          return harness.interface.parseLog(l);
        } catch {
          return null;
        }
      })
      .find((p: any) => p && p.name === "PrivateSwapExecuted");
    expect(ev, "PrivateSwapExecuted not emitted").to.not.equal(undefined);
    expect(ev!.args.realizedOutput).to.equal(realized);

    console.log(
      `    real proof: swapped ${noteAmount / 10n ** 6n} USDC -> ${ethers.formatEther(
        realized
      )} WETH (note minted @ ${ethers.formatEther(T)} WETH)`
    );
  });

  it("rejects a replayed proof (nullifier already spent)", async () => {
    // Re-run the exact same spend — the nullifier is now burned.
    const owner = hN([ownerSecret]);
    const leaf = noteHash(assetA, noteAmount, owner, noteSecret);
    const tree = new MerkleTree(TREE_HEIGHT);
    tree.insert(leaf, 0);
    const { siblings, indices } = tree.proof(0);
    const nullifier = nullifierOf(0n, owner, noteSecret, assetA, noteAmount);
    const bHash = noteHash(assetB, T, recipOwner, recipSecret);

    // Prove against the 1-leaf historical root (still a known root even
    // after the first swap inserted the B note and moved currentRoot).
    const { witness } = await noir.execute({
      root: tree.root().toString(),
      input_notes: [
        {
          asset_id: assetA.toString(),
          asset_amount: noteAmount.toString(),
          owner: owner.toString(),
          owner_secret: ownerSecret.toString(),
          secret: noteSecret.toString(),
          leaf_index: "0",
          path: siblings.map((s) => s.toString()),
          path_indices: indices.map((i) => i.toString()),
        },
        EMPTY_NOTE,
        EMPTY_NOTE,
      ] as never,
      nullifiers: [nullifier.toString(), "0", "0"],
      output_hashes: [bHash.toString(), "0", "0"],
      swap_note: { owner: recipOwner.toString(), secret: recipSecret.toString() } as never,
      change_note: { owner: "0", secret: "0" } as never,
      input_asset: assetA.toString(),
      input_amount: noteAmount.toString(),
      output_asset: assetB.toString(),
      target_output: T.toString(),
    });
    const proof = await backend.generateProof(witness, { keccakZK: true });

    await expect(
      harness.privateSwap(proof.proof, proof.publicInputs, [[POOL_KEY, false]], [])
    ).to.be.revertedWith("Nullifier already spent");
  });
});
