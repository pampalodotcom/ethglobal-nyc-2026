// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {PampaloSwapBase} from "./PampaloSwapBase.sol";

/// @dev Minimal slice of the Uniswap v3 SwapRouter02 interface (no deadline
///      in the params struct, unlike the original SwapRouter).
interface IV3SwapRouter {
    struct ExactInputParams {
        bytes path;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
    }

    function exactInput(
        ExactInputParams calldata params
    ) external payable returns (uint256 amountOut);
}

/// @title PampaloSwapV3
/// @notice Private swaps routed through the Uniswap v3 SwapRouter. No
///         unlock/callback model: the router handles v3's per-swap callback
///         internally and pulls the input via allowance. The `route` bytes
///         are a v3 packed path: abi.encodePacked(tokenIn, fee, tokenOut, ...).
///         See PampaloSwapBase for the venue-agnostic note logic.
contract PampaloSwapV3 is PampaloSwapBase {
    using SafeERC20 for IERC20;

    IV3SwapRouter public immutable swapRouter;

    constructor(
        address _depositVerifier,
        address _transferVerifier,
        address _withdrawVerifier,
        address _transferExternalVerifier,
        address _swapRouter,
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
        swapRouter = IV3SwapRouter(_swapRouter);
    }

    function _executeSwap(
        address inputAsset,
        uint256 inputAmount,
        address outputAsset,
        uint256 minOut,
        bytes calldata route
    ) internal override returns (uint256 realized) {
        // A v3 path is tokenIn(20) || fee(3) || tokenOut(20) [|| fee || token...].
        require(route.length >= 43 && (route.length - 20) % 23 == 0, "bad v3 path");

        // Bindings: the path's first and last 20 bytes must be the proven
        // input / output assets. An untrusted route can then only give a bad
        // price, never redirect funds or change which asset is received.
        require(
            address(bytes20(route[0:20])) == inputAsset,
            "input asset mismatch"
        );
        require(
            address(bytes20(route[route.length - 20:route.length])) == outputAsset,
            "output asset mismatch"
        );

        // Exact, per-swap approval — no standing allowance to the router.
        IERC20(inputAsset).forceApprove(address(swapRouter), inputAmount);

        // The router enforces amountOutMinimum (and the base re-checks the
        // realized >= minOut floor). Output is sent to this contract; the
        // surplus realized - minOut stays as forfeited pooled reserves.
        realized = swapRouter.exactInput(
            IV3SwapRouter.ExactInputParams({
                path: route,
                recipient: address(this),
                amountIn: inputAmount,
                amountOutMinimum: minOut
            })
        );
    }
}
