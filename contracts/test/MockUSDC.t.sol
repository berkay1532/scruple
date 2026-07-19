// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {MockUSDC} from "./MockUSDC.sol";

contract MockUSDCTest is Test {
    function test_sixDecimals_andMint() public {
        MockUSDC usdc = new MockUSDC();
        assertEq(usdc.decimals(), 6);
        usdc.mint(address(0xA11CE), 5_000_000); // $5
        assertEq(usdc.balanceOf(address(0xA11CE)), 5_000_000);
    }
}
