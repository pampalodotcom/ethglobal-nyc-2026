// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {PampaloSwap} from "../PampaloSwap.sol";

/// @title PampaloSwapHarness
/// @notice Test-only: exposes a direct leaf insert so the round-trip swap
///         test can seed a real input note into the tree without driving
///         the full shield → executeShield flow (production's only insert
///         path). The privateSwap path under test is otherwise untouched.
///         NEVER deploy to a live network.
contract PampaloSwapHarness is PampaloSwap {
    constructor(
        address _depositVerifier,
        address _transferVerifier,
        address _withdrawVerifier,
        address _transferExternalVerifier,
        address _poolManager,
        address _swapVerifier
    )
        PampaloSwap(
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
