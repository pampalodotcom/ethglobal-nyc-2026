// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {PampaloSwapV4} from "../PampaloSwapV4.sol";

/// @title PampaloSwapV4Harness
/// @notice Test-only: exposes a direct leaf insert so round-trip tests can
///         seed a real input note without driving the full shield flow
///         (production's only insert path). NEVER deploy to a live network.
contract PampaloSwapV4Harness is PampaloSwapV4 {
    constructor(
        address _depositVerifier,
        address _transferVerifier,
        address _withdrawVerifier,
        address _transferExternalVerifier,
        address _poolManager,
        address _swapVerifier
    )
        PampaloSwapV4(
            _depositVerifier,
            _transferVerifier,
            _withdrawVerifier,
            _transferExternalVerifier,
            _poolManager,
            _swapVerifier
        )
    {}

    function harnessInsert(uint256 leaf) external returns (uint256) {
        return _insert(leaf);
    }
}
