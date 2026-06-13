use poseidon::poseidon2;
use pum_lib::{compute_merkle_root, compute_nullifier, HEIGHT, reconstruct_leaf};

// Swap circuit - proves the note-spend half of a private swap (ADR 0020).
//
// It spends up to NOTE_COUNT input notes of a single asset A (proving
// ownership + membership + nullifiers) and commits TWO output notes:
//   - the swap output: asset B at the fixed `target_output` (T)
//   - an optional same-asset change note: asset A at the leftover amount
//
// The crucial difference from `transfer`: there is NO cross-asset (A<->B)
// balance check. The realized B amount is set by the AMM at execution time
// and does not exist at proof time, so the swap output note is minted at a
// pre-chosen `target_output` (T) committed here; on-chain the contract
// enforces `realized >= T` and forfeits the surplus (see PampaloSwap). What
// IS conserved is the same-asset input split: the asset-A inputs equal the
// amount sent to the pool (`input_amount`) plus the change note.
//
// Public-input order MUST match PampaloSwap's expected layout:
//   [0]    root
//   [1..3] nullifiers
//   [4..6] output_hashes      ([4]=swap note @ T, [5]=A change, [6]=0)
//   [7]    input_asset
//   [8]    input_amount       (asset A sent into the pool)
//   [9]    output_asset
//   [10]   target_output (T)
// Private params interleaved below do not consume public-input indices.

global NOTE_COUNT: u32 = 3;

struct InputNote {
    asset_id: Field,
    asset_amount: Field,
    owner: Field,
    owner_secret: Field,
    secret: Field,
    leaf_index: Field,
    path: [Field; HEIGHT - 1],
    path_indices: [Field; HEIGHT - 1],
}

// Owner pubkey + blinding for an output note the contract inserts. The
// asset and amount come from public inputs (output_asset/T for the swap
// note; input_asset + derived change for the change note), so they are not
// carried here.
struct OutputOwner {
    owner: Field,
    secret: Field,
}

fn main(
    root: pub Field,
    input_notes: [InputNote; NOTE_COUNT],
    nullifiers: pub [Field; NOTE_COUNT],
    output_hashes: pub [Field; NOTE_COUNT],
    swap_note: OutputOwner,
    change_note: OutputOwner,
    input_asset: pub Field,
    input_amount: pub Field,
    output_asset: pub Field,
    target_output: pub Field,
) {
    // Pass 0: range-bound amounts to 128 bits. The conservation check below
    // sums Field elements (BN254, p ~ 2^254); without a bound a prover could
    // pick amounts that wrap mod p and conserve against nothing.
    for i in 0..NOTE_COUNT {
        input_notes[i].asset_amount.assert_max_bit_size::<128>();
    }
    input_amount.assert_max_bit_size::<128>();
    target_output.assert_max_bit_size::<128>();

    // You must swap something, and you always receive something.
    assert(input_amount != 0);
    assert(target_output != 0);

    // Pass 1: per-input verification. Every non-empty input must be
    // `input_asset` so the contract spends exactly that pooled asset.
    let mut input_sum: Field = 0;
    for i in 0..NOTE_COUNT {
        if input_notes[i].asset_amount != 0 {
            let owner_pub_key = poseidon2::Poseidon2::hash([input_notes[i].owner_secret], 1);
            assert(owner_pub_key == input_notes[i].owner);

            assert(input_notes[i].asset_id == input_asset);

            let reconstructed_nullifier = compute_nullifier(
                input_notes[i].leaf_index,
                input_notes[i].owner,
                input_notes[i].secret,
                input_notes[i].asset_id,
                input_notes[i].asset_amount,
            );
            assert(reconstructed_nullifier == nullifiers[i]);

            let reconstructed_leaf = reconstruct_leaf(
                input_notes[i].asset_id,
                input_notes[i].asset_amount,
                input_notes[i].owner,
                input_notes[i].secret,
            );
            let reconstructed_root = compute_merkle_root(
                reconstructed_leaf,
                input_notes[i].path,
                input_notes[i].path_indices,
            );
            assert(reconstructed_root == root);

            input_sum += input_notes[i].asset_amount;
        }
    }

    // Same-asset conservation: inputs (all asset A) == amount sent to the
    // pool + change. change_amount underflows (wraps high) if input_amount >
    // input_sum, which the 128-bit bound then rejects - so this also proves
    // you can't swap more than you spent.
    let change_amount = input_sum - input_amount;
    change_amount.assert_max_bit_size::<128>();

    // Swap output note: asset B at T.
    let swap_commitment =
        reconstruct_leaf(output_asset, target_output, swap_note.owner, swap_note.secret);
    assert(output_hashes[0] == swap_commitment);

    // Change note: asset A at the leftover. Empty (slot must be 0) when
    // there is no change, so the contract inserts nothing.
    if change_amount != 0 {
        let change_commitment =
            reconstruct_leaf(input_asset, change_amount, change_note.owner, change_note.secret);
        assert(output_hashes[1] == change_commitment);
    } else {
        assert(output_hashes[1] == 0);
    }

    // The swap circuit never uses the third output slot.
    assert(output_hashes[2] == 0);
}

// ------------------------- tests -------------------------
// Reuses the `transfer` circuit's membership fixture: one real input note
// (asset A, amount 5) at a known root, so the merkle proof is genuine.

global FIX_ROOT: Field =
    4221110344891604176205088962198904729260430126413313722462390172704999703195;
global FIX_ASSET_A: Field = 1096978651789611665652906124278561787240579697095;
global FIX_OWNER: Field =
    10812186542955647827474372651967207045861174805371180171801345448553285386806;
global FIX_OWNER_SECRET: Field =
    10036677144260647934022413515521823129584317400947571241312859176539726523915;
global FIX_SECRET: Field =
    2389312107716289199307843900794656424062350252250388738019021107824217896920;
global FIX_NULLIFIER: Field =
    3889730504789135603011318287331683111639714777739573239289638917879152395137;

// Distinct asset B + an output-note recipient (reusing valid field elements
// from the transfer fixture's alice/bob notes).
global ASSET_B: Field = 999999999999999999999999999999999999999;
global SWAP_OWNER: Field =
    10812186542955647827474372651967207045861174805371180171801345448553285386806;
global SWAP_SECRET: Field =
    19536471094918068928039225564664574556680178861106125446000998678966251111926;
global CHANGE_OWNER: Field =
    6868973719921785236727144517868768664734231208097695530688003960085654392226;
global CHANGE_SECRET: Field =
    3957740128091467064337395812164919758932045173069261808814882570720300029469;

fn fixture_input_note() -> InputNote {
    let path = [
        13640659629327953230197633652529006805891215582818597888084863207147219313784,
        19984673905358619496530873554532699316557532969285237470013525856790495658245,
        16054022188397161938956278061878851932956033792728066452148841350372709856325,
        5088416905632566847489144423785449560596474956704206833561295200206123281740,
        7133742548945823648162717112853949322814446130740022056636610844051076979955,
        15996976533936258369996214630141201173712053425083354410411158951568838211277,
        12856765864455281126306545538308148448222111081433610923407492298111988109924,
        4407863489559565071205165471845081321675763465852502126771740970311657294198,
        20448284296610764092326252358036828964180135505542140040145855516028834425624,
        7022843789375185322738689530892530453984779704784378294646894048972162829679,
        10906054357754859492130109809751867122631984061959461434096281674698176679467,
    ];
    let path_indices = [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1];
    InputNote {
        asset_id: FIX_ASSET_A,
        asset_amount: 5,
        owner: FIX_OWNER,
        owner_secret: FIX_OWNER_SECRET,
        secret: FIX_SECRET,
        leaf_index: 0,
        path,
        path_indices,
    }
}

fn empty_input_note() -> InputNote {
    InputNote {
        asset_id: 0,
        asset_amount: 0,
        owner: 0,
        owner_secret: 0,
        secret: 0,
        leaf_index: 0,
        path: [0; HEIGHT - 1],
        path_indices: [0; HEIGHT - 1],
    }
}

// Swap the whole note (amount 5) for B - no change note.
#[test]
fn test_swap_no_change() {
    let swap_owner = OutputOwner { owner: SWAP_OWNER, secret: SWAP_SECRET };
    let change_owner = OutputOwner { owner: 0, secret: 0 };
    let t: Field = 100;
    let swap_commitment = reconstruct_leaf(ASSET_B, t, SWAP_OWNER, SWAP_SECRET);

    main(
        FIX_ROOT,
        [fixture_input_note(), empty_input_note(), empty_input_note()],
        [FIX_NULLIFIER, 0, 0],
        [swap_commitment, 0, 0],
        swap_owner,
        change_owner,
        FIX_ASSET_A,
        5, // swap all 5
        ASSET_B,
        t,
    );
}

// Swap part of the note (3 of 5) for B, mint a 2-unit asset-A change note.
#[test]
fn test_swap_with_change() {
    let swap_owner = OutputOwner { owner: SWAP_OWNER, secret: SWAP_SECRET };
    let change_owner = OutputOwner { owner: CHANGE_OWNER, secret: CHANGE_SECRET };
    let t: Field = 100;
    let swap_commitment = reconstruct_leaf(ASSET_B, t, SWAP_OWNER, SWAP_SECRET);
    let change_commitment = reconstruct_leaf(FIX_ASSET_A, 2, CHANGE_OWNER, CHANGE_SECRET);

    main(
        FIX_ROOT,
        [fixture_input_note(), empty_input_note(), empty_input_note()],
        [FIX_NULLIFIER, 0, 0],
        [swap_commitment, change_commitment, 0],
        swap_owner,
        change_owner,
        FIX_ASSET_A,
        3, // swap 3, change 2
        ASSET_B,
        t,
    );
}

// Cannot swap more than was spent: input_amount (6) > input_sum (5) makes
// change_amount underflow, which the 128-bit bound rejects.
#[test(should_fail)]
fn test_overspend_rejected() {
    let swap_owner = OutputOwner { owner: SWAP_OWNER, secret: SWAP_SECRET };
    let change_owner = OutputOwner { owner: 0, secret: 0 };
    let t: Field = 100;
    let swap_commitment = reconstruct_leaf(ASSET_B, t, SWAP_OWNER, SWAP_SECRET);

    main(
        FIX_ROOT,
        [fixture_input_note(), empty_input_note(), empty_input_note()],
        [FIX_NULLIFIER, 0, 0],
        [swap_commitment, 0, 0],
        swap_owner,
        change_owner,
        FIX_ASSET_A,
        6, // more than the 5 spent
        ASSET_B,
        t,
    );
}
