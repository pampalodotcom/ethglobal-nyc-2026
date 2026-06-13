// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Pampalo} from "@pampalo/contracts/contracts/Pampalo.sol";
import {IVerifier} from "@pampalo/contracts/contracts/verifiers/DepositVerifier.sol";

/// @title PampaloSwapBase
/// @notice Venue-agnostic core of a private swap (ADR 0020): spend private
///         note(s) of asset A, receive a private note of asset B, with the
///         trade executing against public AMM liquidity. The note machinery —
///         proof verification, nullification, fixed-output commitment insert,
///         and surplus forfeit — is identical regardless of which AMM fills
///         the order. Only the swap-execution layer differs, so it is left
///         abstract: see PampaloSwapV4 (Uniswap v4 PoolManager) and
///         PampaloSwapV3 (Uniswap v3 SwapRouter).
///
///         Privacy model: ownership-private, amount-public. The output note's
///         amount can't be committed in the proof (it doesn't exist until the
///         swap runs), so the swap is exact-input and mints a fixed-output
///         note at a target `T`; the contract requires `realized >= T` and
///         forfeits the surplus into its pooled reserves. No on-chain Poseidon.
abstract contract PampaloSwapBase is Pampalo {
    /// @notice Verifier for the `swap` circuit (alongside the base four).
    address public immutable swapVerifier;

    /// @dev Public-input layout for the swap circuit:
    ///        0      merkle root            (isKnownRoot)
    ///        1..3   input nullifiers       (spent asset-A notes)
    ///        4..6   output commitments     ([4]=B note @ T, [5]=A change, [6]=0)
    ///        7      input asset (A)
    ///        8      input amount           (A sent into the pool)
    ///        9      output asset (B)
    ///        10     target output T        (B-note amount + slippage floor)
    uint256 internal constant INPUT_ASSET_INDEX = 7;
    uint256 internal constant INPUT_AMOUNT_INDEX = 8;
    uint256 internal constant OUTPUT_ASSET_INDEX = 9;
    uint256 internal constant TARGET_OUTPUT_INDEX = 10;

    event PrivateSwapExecuted(
        address indexed inputAsset,
        address indexed outputAsset,
        uint256 inputAmount,
        uint256 realizedOutput
    );

    constructor(
        address _depositVerifier,
        address _transferVerifier,
        address _withdrawVerifier,
        address _transferExternalVerifier,
        address _swapVerifier
    )
        Pampalo(
            _depositVerifier,
            _transferVerifier,
            _withdrawVerifier,
            _transferExternalVerifier
        )
    {
        swapVerifier = _swapVerifier;
    }

    function privateSwap(
        bytes calldata _proof,
        bytes32[] calldata _publicInputs,
        bytes calldata _route,
        bytes[] calldata _payload
    ) external {
        require(isKnownRoot(uint256(_publicInputs[0])), "Invalid Root!");

        require(
            IVerifier(swapVerifier).verify(_proof, _publicInputs),
            "Invalid swap proof"
        );

        // Spend the input notes BEFORE the swap — same call frame, so any
        // revert during the swap rolls these writes back atomically.
        for (uint256 i = 1; i <= NOTES_INPUT_LENGTH; i++) {
            if (_publicInputs[i] != bytes32(0)) {
                require(
                    nullifierUsed[_publicInputs[i]] == false,
                    "Nullifier already spent"
                );
                nullifierUsed[_publicInputs[i]] = true;
                emit NullifierUsed(_publicInputs[i]);
            }
        }

        address inputAsset = address(uint160(uint256(_publicInputs[INPUT_ASSET_INDEX])));
        uint256 inputAmount = uint256(_publicInputs[INPUT_AMOUNT_INDEX]);
        address outputAsset = address(uint160(uint256(_publicInputs[OUTPUT_ASSET_INDEX])));
        uint256 minOut = uint256(_publicInputs[TARGET_OUTPUT_INDEX]);

        _assertSupportedAsset(inputAsset);
        _assertSupportedAsset(outputAsset);

        // Venue adapter executes the trade. It MUST enforce the three
        // bindings (input asset, output asset, realized >= minOut) — an
        // untrusted calldata route is only safe because of them. The
        // belt-and-suspenders floor below backstops a buggy adapter.
        uint256 realized = _executeSwap(
            inputAsset,
            inputAmount,
            outputAsset,
            minOut,
            _route
        );
        require(realized >= minOut, "slippage / sandwich floor");

        // Insert the output commitments (B note @ T + optional A change).
        // Both are static public inputs — no on-chain hashing. The surplus
        // realized - minOut stays in this contract's pooled balance (forfeit).
        for (
            uint256 i = NOTES_INPUT_LENGTH + 1;
            i < NOTES_INPUT_LENGTH + 1 + NOTES_INPUT_LENGTH;
            i++
        ) {
            if (_publicInputs[i] != bytes32(0)) {
                _insert(uint256(_publicInputs[i]));
            }
        }

        for (uint256 i = 0; i < 3 && i < _payload.length; i++) {
            if (_payload[i].length != 0) {
                emit NotePayload(_payload[i]);
            }
        }

        emit PrivateSwapExecuted(inputAsset, outputAsset, inputAmount, realized);
    }

    /// @dev Execute an exact-input swap of `inputAmount` of `inputAsset` for
    ///      `outputAsset` along `route`, returning the realized output amount
    ///      received by this contract. MUST enforce: route's input asset ==
    ///      `inputAsset`, route's output asset == `outputAsset`, and the
    ///      realized output >= `minOut`.
    function _executeSwap(
        address inputAsset,
        uint256 inputAmount,
        address outputAsset,
        uint256 minOut,
        bytes calldata route
    ) internal virtual returns (uint256 realized);
}
