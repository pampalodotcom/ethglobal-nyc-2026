// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title Counter
/// @notice Minimal example contract to verify the Hardhat 3 + ethers v6
///         + mocha toolchain. Replace with your real contracts.
contract Counter {
    uint256 public count;

    event Incremented(address indexed by, uint256 newCount);

    /// @param startingCount initial value of the counter
    constructor(uint256 startingCount) {
        count = startingCount;
    }

    /// @notice Increase the counter by `amount`.
    function increment(uint256 amount) external {
        count += amount;
        emit Incremented(msg.sender, count);
    }
}
