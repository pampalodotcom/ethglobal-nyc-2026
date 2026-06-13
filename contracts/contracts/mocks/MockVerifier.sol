// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IVerifier} from "@pampalo/contracts/contracts/verifiers/DepositVerifier.sol";

/// @title MockVerifier
/// @notice Test-only IVerifier that accepts any proof. Lets us exercise the
///         PampaloSwap v4 mechanics (unlock → swap → forfeit → insert)
///         against real liquidity before the real `swap` Noir circuit and
///         its generated verifier exist. NEVER deploy to a live network.
contract MockVerifier is IVerifier {
    function verify(
        bytes calldata,
        bytes32[] calldata
    ) external pure returns (bool) {
        return true;
    }
}
