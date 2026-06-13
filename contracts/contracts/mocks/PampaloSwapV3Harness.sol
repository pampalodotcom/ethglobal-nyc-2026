// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {PampaloSwapV3} from "../PampaloSwapV3.sol";

/// @title PampaloSwapV3Harness
/// @notice Test-only: exposes a direct leaf insert so round-trip tests can
///         seed a real input note without driving the full shield flow
///         (production's only insert path). NEVER deploy to a live network.
contract PampaloSwapV3Harness is PampaloSwapV3 {
    constructor(
        address _depositVerifier,
        address _transferVerifier,
        address _withdrawVerifier,
        address _transferExternalVerifier,
        address _swapRouter,
        address _swapVerifier
    )
        PampaloSwapV3(
            _depositVerifier,
            _transferVerifier,
            _withdrawVerifier,
            _transferExternalVerifier,
            _swapRouter,
            _swapVerifier
        )
    {}

    function harnessInsert(uint256 leaf) external returns (uint256) {
        return _insert(leaf);
    }
}
