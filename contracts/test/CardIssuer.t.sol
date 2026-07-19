// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {CardIssuer} from "../src/CardIssuer.sol";
import {MockUSDC} from "./MockUSDC.sol";

contract CardIssuerTest is Test {
    CardIssuer issuer;
    MockUSDC usdc;
    address owner = makeAddr("owner");
    address agentKey = makeAddr("agentKey");
    address merchant = makeAddr("merchant");

    function setUp() public {
        issuer = new CardIssuer();
        usdc = new MockUSDC();
    }

    function _mintDefaultCard() internal returns (uint256) {
        address[] memory allow = new address[](1);
        allow[0] = merchant;
        vm.prank(owner);
        return issuer.mintCard(agentKey, address(usdc), 2_000_000, 1 days, uint48(block.timestamp + 30 days), allow);
    }

    function test_mint_storesPolicy() public {
        uint256 id = _mintDefaultCard();
        CardIssuer.Card memory c = issuer.getCard(id);
        assertEq(c.owner, owner);
        assertEq(c.signer, agentKey);
        assertEq(c.periodAmount, 2_000_000); // $2/day
        assertEq(uint256(c.state), uint256(CardIssuer.CardState.Active));
        assertTrue(c.useAllowlist);
        assertTrue(issuer.allowlist(id, merchant));
    }

    function test_mint_revertsOnZeroPeriod() public {
        address[] memory allow = new address[](0);
        vm.prank(owner);
        vm.expectRevert(CardIssuer.InvalidPeriod.selector);
        issuer.mintCard(agentKey, address(usdc), 1, 0, 0, allow);
    }

    function test_freeze_unfreeze_onlyOwner() public {
        uint256 id = _mintDefaultCard();
        vm.prank(makeAddr("stranger"));
        vm.expectRevert(CardIssuer.NotCardOwner.selector);
        issuer.freeze(id);

        vm.prank(owner);
        issuer.freeze(id);
        assertEq(uint256(issuer.getCard(id).state), uint256(CardIssuer.CardState.Frozen));

        vm.prank(owner);
        issuer.unfreeze(id);
        assertEq(uint256(issuer.getCard(id).state), uint256(CardIssuer.CardState.Active));
    }

    function test_cancel_isTerminal() public {
        uint256 id = _mintDefaultCard();
        vm.prank(owner);
        issuer.cancel(id);
        vm.prank(owner);
        vm.expectRevert(CardIssuer.CardIsCancelled.selector);
        issuer.unfreeze(id);
    }

    function _authorizeSelfAsCharger() internal {
        issuer.setChargerAuthorization(address(this), true); // test contract deployed issuer → is admin
    }

    function test_authorizeSpend_debitsBudget_andEmits() public {
        uint256 id = _mintDefaultCard();
        _authorizeSelfAsCharger();
        issuer.authorizeSpend(id, merchant, 1_500_000);
        assertEq(issuer.getCard(id).spentInPeriod, 1_500_000);
        vm.expectRevert(CardIssuer.BudgetExceeded.selector);
        issuer.authorizeSpend(id, merchant, 600_000); // 1.5 + 0.6 > $2
    }

    function test_authorizeSpend_periodRollsOver() public {
        uint256 id = _mintDefaultCard();
        _authorizeSelfAsCharger();
        issuer.authorizeSpend(id, merchant, 2_000_000);      // exhaust day 1
        vm.warp(block.timestamp + 1 days + 1);
        issuer.authorizeSpend(id, merchant, 2_000_000);      // fresh budget day 2
        assertEq(issuer.getCard(id).spentInPeriod, 2_000_000);
    }

    function test_authorizeSpend_enforcesAllowlistExpiryStateCaller() public {
        uint256 id = _mintDefaultCard();
        _authorizeSelfAsCharger();

        vm.expectRevert(CardIssuer.MerchantNotAllowed.selector);
        issuer.authorizeSpend(id, makeAddr("otherMerchant"), 1);

        vm.prank(owner);
        issuer.freeze(id);
        vm.expectRevert(CardIssuer.CardNotActive.selector);
        issuer.authorizeSpend(id, merchant, 1);
        vm.prank(owner);
        issuer.unfreeze(id);

        vm.warp(block.timestamp + 31 days); // past expiry
        vm.expectRevert(CardIssuer.CardExpired.selector);
        issuer.authorizeSpend(id, merchant, 1);

        vm.prank(makeAddr("stranger"));
        vm.expectRevert(CardIssuer.NotAuthorizedCharger.selector);
        issuer.authorizeSpend(id, merchant, 1);
    }

    function test_previewSpend_matchesWithoutMutation() public {
        uint256 id = _mintDefaultCard();
        assertTrue(issuer.previewSpend(id, merchant, 2_000_000));
        assertFalse(issuer.previewSpend(id, merchant, 2_000_001));
        assertFalse(issuer.previewSpend(id, makeAddr("otherMerchant"), 1));
        assertEq(issuer.getCard(id).spentInPeriod, 0); // no mutation
    }
}
