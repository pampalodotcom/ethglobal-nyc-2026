// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {PampaloSwapBase} from "./PampaloSwapBase.sol";

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";

/// @title PampaloSwapV4
/// @notice Private swaps routed through the Uniswap v4 PoolManager. Pampalo is
///         a *caller* (unlock -> unlockCallback -> swap), not a hook author.
///         Flash accounting nets intermediate multi-hop legs, so only the
///         first input currency is settled and only the last output currency
///         is taken. See PampaloSwapBase for the venue-agnostic note logic.
contract PampaloSwapV4 is PampaloSwapBase, IUnlockCallback {
    IPoolManager public immutable poolManager;

    /// @notice One leg of a (possibly multi-hop) route. The v4 `route` bytes
    ///         are `abi.encode(Hop[])`.
    struct Hop {
        PoolKey poolKey;
        bool zeroForOne;
    }

    struct SwapJob {
        Hop[] path;
        address inputAsset;
        uint256 inputAmount;
        address outputAsset;
        uint256 minOut;
    }

    constructor(
        address _depositVerifier,
        address _transferVerifier,
        address _withdrawVerifier,
        address _transferExternalVerifier,
        address _poolManager,
        address _swapVerifier
    )
        PampaloSwapBase(
            _depositVerifier,
            _transferVerifier,
            _withdrawVerifier,
            _transferExternalVerifier,
            _swapVerifier
        )
    {
        poolManager = IPoolManager(_poolManager);
    }

    function _executeSwap(
        address inputAsset,
        uint256 inputAmount,
        address outputAsset,
        uint256 minOut,
        bytes calldata route
    ) internal override returns (uint256 realized) {
        Hop[] memory path = abi.decode(route, (Hop[]));
        bytes memory res = poolManager.unlock(
            abi.encode(
                SwapJob({
                    path: path,
                    inputAsset: inputAsset,
                    inputAmount: inputAmount,
                    outputAsset: outputAsset,
                    minOut: minOut
                })
            )
        );
        realized = abi.decode(res, (uint256));
    }

    function unlockCallback(
        bytes calldata data
    ) external returns (bytes memory) {
        require(msg.sender == address(poolManager), "only pool manager");

        SwapJob memory job = abi.decode(data, (SwapJob));
        require(job.path.length > 0, "empty path");

        // Bind the first hop's input currency to the proven input asset.
        Currency inCur = job.path[0].zeroForOne
            ? job.path[0].poolKey.currency0
            : job.path[0].poolKey.currency1;
        require(
            Currency.unwrap(inCur) == job.inputAsset,
            "input asset mismatch"
        );

        // Chain the hops: each hop's output feeds the next hop's input, so
        // intermediate currencies net to zero under flash accounting.
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
            int128 outLeg = hop.zeroForOne ? d.amount1() : d.amount0();
            require(outLeg > 0, "non-positive output");
            amount = uint256(uint128(outLeg));
            outCur = hop.zeroForOne
                ? hop.poolKey.currency1
                : hop.poolKey.currency0;
        }

        uint256 realized = amount;

        // Bindings (ADR 0020 / spec section 7): output asset + slippage floor.
        require(realized >= job.minOut, "slippage / sandwich floor");
        require(
            Currency.unwrap(outCur) == job.outputAsset,
            "output asset mismatch"
        );

        _settle(inCur, job.inputAmount);
        poolManager.take(outCur, address(this), realized);

        return abi.encode(realized);
    }

    /// @dev ERC-20 settlement only (v1). Native-ETH legs (v4's address(0)
    ///      sentinel) are deferred; Pampalo's ETH notes use 0xEeee...eEeE.
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
