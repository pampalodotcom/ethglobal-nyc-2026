// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {Pampalo} from "@pampalo/contracts/contracts/Pampalo.sol";
import {IVerifier} from "@pampalo/contracts/contracts/verifiers/DepositVerifier.sol";

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";

/// @title PampaloSwap
/// @notice Extends Pampalo with **private swaps** against public Uniswap v4
///         liquidity: spend private note(s) of asset A, receive a private
///         note of asset B, with the trade executing against public v4
///         pools in one atomic call. Pampalo is a *caller* of the v4
///         PoolManager (unlock → unlockCallback), not a hook author.
///
///         Privacy model: ownership-private, amount-public (ADR 0020). The
///         nullifier breaks the input note's lineage and the output note's
///         owner is hidden, but `(assetA, assetB, amount)` is observable at
///         the AMM — the only model achievable against public liquidity.
///
///         The realized output amount does not exist at proof time, so it
///         cannot be committed in the proof. Instead the swap is
///         exact-input and mints a **fixed-output note** at a target `T`
///         (committed in-circuit, exposed as a public input). The contract
///         enforces `realized >= T` and forfeits the surplus `realized - T`
///         into its pooled asset-B reserves. No on-chain Poseidon. See
///         ADR 0020 for the trade-off against on-chain note construction.
contract PampaloSwap is Pampalo, IUnlockCallback {
    // ──────────────────────────────────────────────────────────────────────
    // State
    // ──────────────────────────────────────────────────────────────────────

    /// @notice The v4 PoolManager all swaps route through.
    IPoolManager public immutable poolManager;

    /// @notice Verifier for the `swap` circuit (alongside the base four).
    address public immutable swapVerifier;

    /// @dev Public-input layout for the swap circuit (mirrors the
    ///      transfer/transfer_external convention through idx 6):
    ///        0      merkle root            (isKnownRoot)
    ///        1..3   input nullifiers       (spent asset-A notes)
    ///        4..6   output commitments     ([4]=B note @ T, [5]=A change, [6]=0)
    ///        7      input asset (A)        (every input note is this asset)
    ///        8      input amount           (A sent into the pool)
    ///        9      output asset (B)       (bound to final hop's currency)
    ///        10     target output T        (B-note amount + slippage floor)
    uint256 private constant INPUT_ASSET_INDEX = 7;
    uint256 private constant INPUT_AMOUNT_INDEX = 8;
    uint256 private constant OUTPUT_ASSET_INDEX = 9;
    uint256 private constant TARGET_OUTPUT_INDEX = 10;

    /// @notice One leg of a (possibly multi-hop) route.
    struct Hop {
        PoolKey poolKey;
        bool zeroForOne;
    }

    /// @dev Decoded inside `unlockCallback`. Owner/blinding are absent: the
    ///      output commitment is a public input inserted in `privateSwap`,
    ///      not rebuilt here.
    struct SwapJob {
        Hop[] path;
        address inputAsset;
        uint256 inputAmount;
        address outputAsset;
        uint256 minOut; // == target output T
    }

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
        address _poolManager,
        address _swapVerifier
    )
        Pampalo(
            _depositVerifier,
            _transferVerifier,
            _withdrawVerifier,
            _transferExternalVerifier
        )
    {
        poolManager = IPoolManager(_poolManager);
        swapVerifier = _swapVerifier;
    }

    // ──────────────────────────────────────────────────────────────────────
    // Private swap — note A → note B against public v4 liquidity
    // ──────────────────────────────────────────────────────────────────────

    function privateSwap(
        bytes calldata _proof,
        bytes32[] calldata _publicInputs,
        Hop[] calldata _path,
        bytes[] calldata _payload
    ) external {
        require(isKnownRoot(uint256(_publicInputs[0])), "Invalid Root!");

        require(
            IVerifier(swapVerifier).verify(_proof, _publicInputs),
            "Invalid swap proof"
        );

        // Spend the input notes. Done BEFORE unlock — same call frame, so a
        // revert anywhere in the swap rolls these writes back atomically.
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

        // Route through Uniswap v4. Flash accounting nets intermediate legs;
        // we settle only the first input currency and take only the last
        // output currency (see unlockCallback).
        bytes memory res = poolManager.unlock(
            abi.encode(
                SwapJob({
                    path: _path,
                    inputAsset: inputAsset,
                    inputAmount: inputAmount,
                    outputAsset: outputAsset,
                    minOut: minOut
                })
            )
        );
        uint256 realized = abi.decode(res, (uint256));

        // Insert the output commitments. C_out (B note @ T) and the optional
        // A change note are both static public inputs — no on-chain hashing.
        for (
            uint256 i = NOTES_INPUT_LENGTH + 1;
            i < NOTES_INPUT_LENGTH + 1 + NOTES_INPUT_LENGTH;
            i++
        ) {
            if (_publicInputs[i] != bytes32(0)) {
                _insert(uint256(_publicInputs[i]));
            }
        }

        // Emit encrypted note blobs so recipients can scan and find them.
        for (uint256 i = 0; i < 3 && i < _payload.length; i++) {
            if (_payload[i].length != 0) {
                emit NotePayload(_payload[i]);
            }
        }

        emit PrivateSwapExecuted(inputAsset, outputAsset, inputAmount, realized);
    }

    // ──────────────────────────────────────────────────────────────────────
    // v4 unlock callback — the multi-hop swap
    // ──────────────────────────────────────────────────────────────────────

    function unlockCallback(
        bytes calldata data
    ) external returns (bytes memory) {
        require(msg.sender == address(poolManager), "only pool manager");

        SwapJob memory job = abi.decode(data, (SwapJob));
        require(job.path.length > 0, "empty path");

        // Bind the first hop's input currency to the proven input asset, so
        // a relayer cannot spend a different pooled asset than the one the
        // user nullified.
        Currency inCur = job.path[0].zeroForOne
            ? job.path[0].poolKey.currency0
            : job.path[0].poolKey.currency1;
        require(
            Currency.unwrap(inCur) == job.inputAsset,
            "input asset mismatch"
        );

        // Chain the hops: each hop's output feeds the next hop's input. Each
        // intermediate currency's "owed to us" from hop N is cancelled by the
        // "we owe" of hop N+1, so flash accounting nets them to zero.
        uint256 amount = job.inputAmount;
        Currency outCur;
        for (uint256 i = 0; i < job.path.length; i++) {
            Hop memory hop = job.path[i];
            BalanceDelta d = poolManager.swap(
                hop.poolKey,
                SwapParams({
                    zeroForOne: hop.zeroForOne,
                    amountSpecified: -int256(amount), // negative = exact input
                    sqrtPriceLimitX96: hop.zeroForOne
                        ? TickMath.MIN_SQRT_PRICE + 1
                        : TickMath.MAX_SQRT_PRICE - 1
                }),
                ""
            );
            // Output is the leg we did NOT specify.
            int128 outLeg = hop.zeroForOne ? d.amount1() : d.amount0();
            require(outLeg > 0, "non-positive output");
            amount = uint256(uint128(outLeg));
            outCur = hop.zeroForOne
                ? hop.poolKey.currency1
                : hop.poolKey.currency0;
        }

        uint256 realized = amount;

        // Mandatory invariants (ADR 0020 / spec §7):
        // 1. sandwich / slippage floor (also the fixed note amount T)
        // 2. asset binding — a malicious route can only give a bad price,
        //    never redirect funds or change which asset is received.
        require(realized >= job.minOut, "slippage / sandwich floor");
        require(
            Currency.unwrap(outCur) == job.outputAsset,
            "output asset mismatch"
        );

        // Settle what we owe (input) and take what we're owed (output). The
        // surplus realized - minOut stays in this contract's pooled balance,
        // unowned by any note (forfeit — ADR 0020).
        _settle(inCur, job.inputAmount);
        poolManager.take(outCur, address(this), realized);

        return abi.encode(realized);
    }

    // ──────────────────────────────────────────────────────────────────────
    // Internal
    // ──────────────────────────────────────────────────────────────────────

    /// @dev ERC-20 settlement only (v1). Native-ETH legs (v4's address(0)
    ///      sentinel) are deferred; Pampalo's ETH notes use 0xEeee…eEeE and
    ///      must wrap to WETH first.
    function _settle(Currency currency, uint256 amount) internal {
        poolManager.sync(currency);
        require(
            IERC20(Currency.unwrap(currency)).transfer(
                address(poolManager),
                amount
            ),
            "settle transfer failed"
        );
        poolManager.settle();
    }
}
