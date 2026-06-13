# Implementation plan — Private Swaps into pampalo (dev branch)

**Audience:** an agent working on the head of the `pampalo` `dev` branch, with
full pampalo context but little on the private-swap model. This document gives
(1) the model and why it's shaped this way, and (2) a precise, file-by-file plan
to land it natively in the monorepo.

**You will also be given the reference implementation** built in a separate repo
(`ethglobal-nyc-2026/`): the swap circuit, `PampaloSwapBase/V4/V3` contracts,
test helpers, and venue-parameterized tests. That code is proven end-to-end
(real Noir proofs verified on-chain driving real swaps against forked Base v4 and
v3 liquidity). **Treat it as the source of truth for behaviour**; this plan tells
you how to re-home it into pampalo's structure (it currently consumes
`@pampalo/contracts` as a package and inlines helpers because `@pampalo/shared`
isn't externally consumable — in-repo you reuse the real thing).

The decision record already exists on this branch: **`docs/adr/0020-private-swaps-
fixed-output-notes-no-on-chain-construction.md`** and the **"Private swap"** /
**"Target output (T)"** terms in `CONTEXT.md`. Read those first; this plan assumes
them.

---

## 1. The model (what's new vs the rest of pampalo)

A **private swap** spends private note(s) of asset A and creates a private note of
asset B, with the trade executing against **public Uniswap liquidity** in one
atomic transaction. It is shaped by one hard constraint and four decisions.

**Privacy model — ownership-private, amount-public.** The swap hits a public AMM,
so `(tokenIn, tokenOut, amount)` is observable. The nullifier breaks the input
note's lineage and the output note's owner is hidden, but the amount is public.
This is the only model achievable against public liquidity.

**The hard constraint — the realized amount doesn't exist at proof time.** Proofs
are generated client-side *before* the tx; the AMM produces the output amount
*during* the tx. So the output note's amount **cannot be committed in the proof**.

**Decision 1 — fixed-output note, forfeit surplus (ADR 0020).** The swap is
exact-input and mints a fixed-output note at a target `T`, committed in-circuit
(so the commitment stays an ordinary public input, like every other flow). The
contract enforces `realized >= T` and **forfeits the surplus `realized - T`** into
its pooled reserves. This avoids needing an on-chain arity-4 Poseidon (pampalo's
on-chain hasher is the arity-2 tree-node compressor only) — which would have been
a new, byte-exact-match-to-Noir hasher and the integration's biggest audit risk.
`T` doubles as the slippage/sandwich floor — there is **no separate `minOut`**.

**Decision 2 — no monthly cap on swaps.** Value stays inside the shield (note A →
note B, no external recipient); extraction is still gated at `unshield`. Charging
would throttle internal activity with no AML benefit. (The oracle is therefore not
read on the swap path.)

**Decision 3 — venue-agnostic (v4 and v3).** The note machinery is identical
regardless of which AMM fills the order; only the swap-execution layer differs.
Support both as a hedge on venue availability/liquidity. (In testing, the v3
USDC/WETH pool on Base was ~25% deeper than v4 at one block — venue choice matters.)

**Decision 4 — ERC-20 / WETH only in v1; relayer-sponsored.** Native-ETH legs
(v4's `address(0)` sentinel vs pampalo's `0xEeee…eEeE`) are deferred — route ETH
through WETH. Broadcast is relayer-sponsored like transfer/unshield (ADR 0015);
unlike those, a swap can genuinely revert on `realized < T`, so the relayer must
re-simulate at broadcast or accept rare failed-tx gas.

**A same-asset change note** is supported: spend notes summing to more than the
swapped amount and mint an asset-A change note for the remainder (its amount is
known at proof time, so it's committed in-circuit like a transfer change).

---

## 2. Architecture

Three new contracts; the rest of pampalo is untouched.

```
PampaloSwapBase  (abstract, is Pampalo)   ← venue-agnostic note logic
   ├── PampaloSwapV4  (is …Base, IUnlockCallback)   ← v4 PoolManager unlock/callback
   └── PampaloSwapV3  (is …Base)                     ← v3 SwapRouter exactInput
```

`PampaloSwapBase.privateSwap(bytes proof, bytes32[] publicInputs, bytes route,
bytes[] payload)` does: `isKnownRoot` → `IVerifier(swapVerifier).verify` →
nullify inputs `[1..3]` → `_executeSwap(...)` (abstract) → `require(realized >= T)`
→ `_insert` output commitments `[4..6]` → emit `NotePayload` + `PrivateSwapExecuted`.

`route` is opaque `bytes` so the shell is venue-agnostic: v4 decodes
`abi.encode(Hop[])`; v3 uses a packed path `tokenIn||fee||tokenOut[…]`.

**Reused from `Pampalo` unchanged** (all reachable from a subclass): `_insert`
(internal), `_assertSupportedAsset` (internal), `nullifierUsed` (public),
`isKnownRoot` (public), `NOTES_INPUT_LENGTH`, `ETH_ADDRESS`, `supportedAssets`,
events `NotePayload`/`NullifierUsed`. The nullify loop and the `_insert` loop are
copied verbatim from `unshieldBundled`.

**Deployment (ADR 0017 clean-break):** deploy `PampaloSwapV4` (or `…V3`) *instead
of* `Pampalo` — it is a superset. Don't fold `privateSwap` into `Pampalo.sol`;
keeping it a subclass keeps the base stable and the venue split clean.

---

## 3. The swap circuit

Lives at `circuits/swap/` (mirror the other circuit packages; `Nargo.toml` depends
on `pum_lib` and `poseidon` exactly like `transfer`). It is a clone of `transfer`'s
input side with **no cross-asset balance check** plus a **same-asset input
conservation**. It reuses `pum_lib` (`reconstruct_leaf`, `compute_nullifier`,
`compute_merkle_root`, `HEIGHT`) so the note-commitment and nullifier schemes are
byte-identical to the rest of the protocol.

It proves: every non-empty input note is `input_asset`, owned, and a member at
`root`, with correct nullifiers; `Σ inputs == input_amount + change`; the swap
output commitment `= reconstruct_leaf(output_asset, T, owner, secret)`; the change
commitment (or 0) for the leftover asset-A; all amounts 128-bit range-bound. It
does **not** see the realized output amount.

**Public-input layout (must match `PampaloSwapBase`'s indices):**

| idx | field | notes |
|----|-------|-------|
| 0 | `root` | `isKnownRoot` |
| 1–3 | `nullifiers[3]` | spent asset-A notes |
| 4–6 | `output_hashes[3]` | `[4]`=B note @ T, `[5]`=A change, `[6]`=0 |
| 7 | `input_asset` | every input note is this; bound to route's input |
| 8 | `input_amount` | asset-A sent into the pool |
| 9 | `output_asset` | bound to route's output |
| 10 | `target_output` `T` | B-note amount + slippage floor |

Declare the `pub` params in this exact order in `main()` (private params may be
interleaved; they don't consume public-input indices).

**Verifier generation:** add one line to `scripts/build-verifiers.sh`'s `CIRCUITS`
array — `"swap:SwapVerifier"`. The existing flow (`nargo compile` → `bb write_vk
--oracle_hash keccak` → `bb write_solidity_verifier`, rename `HonkVerifier` →
`SwapVerifier`, sync `shared/circuits/swap.json`) then produces
`contracts/contracts/verifiers/SwapVerifier.sol` and the checked-in circuit JSON.

**Gotcha:** the generated `SwapVerifier` reports `NUMBER_OF_PUBLIC_INPUTS = 19` =
the 11 declared + 8 bb-appended aggregation fields. `bb.js`/`@noir-lang/noir_js`
return `publicInputs.length == 11` (the 8 ride inside the proof bytes), and the
contract indexes the front 11 — same pattern as `transfer` (7 declared → 15). Do
not expect 19 in the array.

---

## 4. Contracts — porting from the reference repo

Copy the three contracts + two harnesses, then apply these deltas:

1. **Imports.** Reference repo imports `Pampalo` and `IVerifier` from
   `@pampalo/contracts/contracts/...`. In-repo, import from `./Pampalo.sol` and
   `./verifiers/DepositVerifier.sol` (where `IVerifier` is declared).
2. **`PampaloSwapBase`** — abstract `is Pampalo`; holds `swapVerifier` (immutable)
   + the public-input index constants + the `PrivateSwapExecuted` event + the
   shared `privateSwap` shell + `abstract _executeSwap(inputAsset, inputAmount,
   outputAsset, minOut, route) returns (realized)`. The shell enforces a
   belt-and-suspenders `require(realized >= minOut)`; adapters MUST also enforce
   the three bindings (input asset, output asset, floor) — an untrusted calldata
   route is only safe because of them.
3. **`PampaloSwapV4`** (`is …Base, IUnlockCallback`) — `poolManager` immutable;
   `Hop`/`SwapJob` structs; `_executeSwap` decodes `Hop[]` from `route`, calls
   `poolManager.unlock`; `unlockCallback` chains hops (exact-input, negative
   `amountSpecified`), binds first-hop input currency == `inputAsset` and last-hop
   output == `outputAsset`, checks the floor, `_settle`s only the first input and
   `take`s only the last output (flash accounting nets intermediates). v4-core
   import paths are pinned to the version you vendor — verify them.
4. **`PampaloSwapV3`** (`is …Base`) — `swapRouter` immutable; `_executeSwap`
   validates the packed path length, binds `inputAsset`/`outputAsset` to the path's
   first/last 20 bytes, does a **per-swap exact** `forceApprove(router,
   inputAmount)` (the contract holds the pooled funds, so it approves the router
   for its own tokens; no standing allowance, no user/admin step), then
   `swapRouter.exactInput(path, recipient=this, amountIn, amountOutMinimum=T)`.
   Use OZ `SafeERC20.forceApprove`. (Note: `Pampalo.addSupportedAsset` is not
   `virtual`, so don't try to hook approval there — per-swap approve is simpler
   and safer anyway.)
5. **Harnesses** (`PampaloSwapV4Harness`, `PampaloSwapV3Harness`) — test-only,
   add `harnessInsert(uint256 leaf)` exposing `_insert` so tests can seed a note
   without the full shield flow. Keep them under a test/mocks path; never deploy.

Constructor shape (both venues): `(depositVerifier, transferVerifier,
withdrawVerifier, transferExternalVerifier, venueAddr, swapVerifier)` where
`venueAddr` is the PoolManager (v4) or SwapRouter (v3).

Optimizer: pampalo already uses `runs: 100`, which keeps the Honk `SwapVerifier`
under the 24,576-byte limit. Keep it.

---

## 5. Ignition modules

Add, mirroring the existing verifier modules:

- `ignition/modules/SwapVerifier.ts` — `m.library("contracts/verifiers/
  SwapVerifier.sol:ZKTranscriptLib", { id: "SwapVerifierLib" })` then
  `m.contract("SwapVerifier", [], { libraries: { ZKTranscriptLib: … } })`.
- `ignition/modules/PampaloSwapV4.ts` / `PampaloSwapV3.ts` — `useModule` the four
  base verifier modules + `SwapVerifier`, deploy the contract with the venue
  address, return it. (Poseidon is set via `setPoseidon` post-deploy as today;
  `addSupportedAsset` for USDC/WETH + oracle is a deploy script step.)

---

## 6. Tests

Reuse pampalo's existing proving infra rather than the reference repo's inlined
versions:

- **Tree / hashing:** reuse `helpers/objects/poseidon-merkle-tree.ts`
  (`getMerkleTree`) and `helpers/functions/{get-note-hash,get-nullifier}.ts`. The
  reference repo inlined a `MerkleTree` + poseidon wrappers only because
  `@pampalo/shared` isn't consumable externally — you have the real classes.
- **Proving class:** add `shared/classes/Swap.ts` mirroring `Transfer.ts` (wrap
  `Noir(swapCircuit)` + `UltraHonkBackend(swap.json.bytecode)`), register it in
  `helpers/objects/get-noir-classes.ts`, and add a
  `helpers/functions/get-swap-details.ts` mirroring `get-transfer-details.ts`
  (execute witness, `generateProof(witness, { keccakZK: true })`).
- **Fork network:** the swap tests need real v4/v3 liquidity. pampalo already
  configures `mainnetFork` — use it: mainnet has both v4 + v3 with deep USDC/WETH
  liquidity. (Verify current addresses against the Uniswap deployment docs;
  mainnet v4 PoolManager, v3 SwapRouter02, and USDC/WETH.) Fund the contract's
  pooled USDC by overwriting the token's balance slot (`hardhat_setStorageAt`);
  find the slot for the token/chain you use.
- **Tests to port (venue-parameterized over `["v4","v3"]`):**
  - *Mechanics* (mock swap verifier): swap pooled USDC→WETH; assert exact-input
    spend, `realized > T`, both output commitments inserted, nullifiers spent,
    `PrivateSwapExecuted`; and a floor-revert (`T` absurdly high → reverts; v4 =
    "slippage / sandwich floor", v3 router = "Too little received").
  - *Round-trip* (real `SwapVerifier`, harness-seeded note): seed a note via
    `harnessInsert`, confirm the off-chain tree root == on-chain `currentRoot`,
    generate a real proof, execute, assert balances/insert/nullifier/event; then
    a replay test (same proof again → "Nullifier already spent").
- **Additional security tests worth adding** (we flagged but didn't all write):
  multi-hop A→C→B; wrong-output-asset route → revert; malicious-but-bound route
  (bad price, no theft); change-note correctness.

**Test gotchas (all learned the hard way):**
- `generateProof` option is `{ keccakZK: true }` (matches `--oracle_hash keccak`
  + the ZK Honk verifier).
- `SwapVerifier` must be deployed with `ZKTranscriptLib` linked:
  `getContractFactory("SwapVerifier", { libraries: { ZKTranscriptLib } })`.
- Replay/second-spend proofs must use the **1-leaf historical root** (still in
  `knownRoots`), not `currentRoot` after the first swap moved it.
- Mocha `.to.be.reverted` is deprecated in this toolchain — assert with
  `.revertedWith(reason)`.

---

## 7. Porting deltas (reference repo → pampalo) — quick map

| Reference repo (ethglobal-nyc-2026) | In pampalo |
|---|---|
| `import … "@pampalo/contracts/contracts/Pampalo.sol"` | `import … "./Pampalo.sol"` |
| `IVerifier` from `@pampalo/contracts/.../DepositVerifier.sol` | `./verifiers/DepositVerifier.sol` |
| inlined `test/helpers/merkle-tree.ts`, `poseidon.ts` | reuse `helpers/objects/poseidon-merkle-tree.ts`, `functions/get-note-hash.ts`, `get-nullifier.ts` |
| inlined `SwapProver` (Noir+bb) | `shared/classes/Swap.ts` + `get-noir-classes.ts` + `get-swap-details.ts` |
| circuit at `circuits/src/main.nr` | `circuits/swap/src/main.nr` (+ `Nargo.toml`) |
| `baseFork` in hardhat config + Base addresses | reuse `mainnetFork` + mainnet Uniswap/USDC/WETH addresses |
| `Poseidon2Huff.json` imported from package | the in-repo `contracts/contracts/utils/Poseidon2Huff.json` |
| `@pampalo/shared` removed (unconsumable externally) | use it directly in-repo |

> Side note for the maintainer: `@pampalo/shared`'s published `exports` map points
> at `./classes/*.ts` source files that aren't in the published build (only
> compiled `dist/*.js` ships), so it can't be imported by external consumers.
> Worth fixing (`exports` → `dist/*.js`) if shared code is meant to be reused
> outside the monorepo. Irrelevant in-repo.

---

## 8. Downstream (out of core scope, but mapped)

- **SDK (`@pampalo/sdk`):** add a `Swap` proof class + a `privateSwap` intent in
  `sdk/src/intents.ts` mirroring the `transfer`/`unshieldBundled` entries (it
  passes `proof.proof`, `proof.publicInputs`, the encoded `route`, and the
  payload). Client builds the route (v4 `Hop[]` encode / v3 packed path) and the
  output/change notes.
- **Relayer (convex):** allow relaying `privateSwap`; handle the new genuine
  revert risk (`realized < T`) with a pre-broadcast re-sim and tolerance for
  occasional failed-tx gas. The relayer holds no role (same as transfer/unshield).
- **Supported assets for live deploy:** add **WETH** via `addSupportedAsset` with
  a Chainlink oracle (the oracle is unused by `privateSwap` but `shield` needs it,
  and ETH notes must wrap to WETH to swap in v1).
- **UI:** a private-swap flow + the explainer (see `private-swap-explainer-brief.md`
  if provided). Surface that the output is "at least `T`" with surplus forfeited.

---

## 9. Build order

1. Circuit `circuits/swap/` + `build-verifiers.sh` line → generate `SwapVerifier`.
2. `PampaloSwapBase` + `PampaloSwapV4` + `PampaloSwapV3` + harnesses; compile.
3. `shared/classes/Swap.ts` + `get-noir-classes.ts` + `get-swap-details.ts`.
4. Venue-parameterized mechanics + round-trip tests on `mainnetFork`; green.
5. Ignition modules (`SwapVerifier`, `PampaloSwapV4/V3`).
6. Security tests (multi-hop, malicious-route, change-note).
7. (Downstream) SDK intent, relayer, WETH+oracle wiring, UI.

## 10. Definition of done (core)

- `circuits/swap` compiles; its 3+ `nargo` tests pass (no-change, with-change,
  overspend-rejected).
- `SwapVerifier` generated, library-linked, deploys under the size limit.
- `PampaloSwapV4` and `PampaloSwapV3` compile and extend `Pampalo`.
- Venue-parameterized mechanics + round-trip tests pass on a fork against real v4
  **and** v3 liquidity (real proof verified on-chain, replay rejected).
- ADR 0020 and the `CONTEXT.md` terms remain accurate to what shipped.
