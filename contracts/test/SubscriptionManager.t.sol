// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {CardIssuer} from "../src/CardIssuer.sol";
import {SubscriptionManager} from "../src/SubscriptionManager.sol";
import {MockUSDC} from "./MockUSDC.sol";

contract SubscriptionManagerTest is Test {
    CardIssuer issuer;
    SubscriptionManager subs;
    MockUSDC usdc;
    address treasury = makeAddr("treasury");
    address merchant = makeAddr("merchant");
    address customer = makeAddr("customer");

    function setUp() public {
        issuer = new CardIssuer();
        usdc = new MockUSDC();
        subs = new SubscriptionManager(address(issuer), treasury);
        issuer.setChargerAuthorization(address(subs), true);
    }

    function test_createPlan_storesVersion1() public {
        vm.prank(merchant);
        uint256 planId = subs.createPlan(address(usdc), 29_000_000, 30 days, 0);
        SubscriptionManager.Plan memory p = subs.getPlan(planId);
        assertEq(p.merchant, merchant);
        assertEq(p.latestVersion, 1);
        SubscriptionManager.PlanVersion memory v = subs.getPlanVersion(planId, 1);
        assertEq(v.amount, 29_000_000); // $29
        assertEq(v.period, 30 days);
    }

    function test_pushPlanVersion_appendsImmutably_merchantOnly() public {
        vm.prank(merchant);
        uint256 planId = subs.createPlan(address(usdc), 29_000_000, 30 days, 0);

        vm.prank(makeAddr("stranger"));
        vm.expectRevert(SubscriptionManager.NotMerchant.selector);
        subs.pushPlanVersion(planId, 35_000_000, 30 days, 0);

        vm.prank(merchant);
        subs.pushPlanVersion(planId, 35_000_000, 30 days, 0);
        assertEq(subs.getPlan(planId).latestVersion, 2);
        assertEq(subs.getPlanVersion(planId, 1).amount, 29_000_000); // v1 untouched
        assertEq(subs.getPlanVersion(planId, 2).amount, 35_000_000);
    }

    function test_createPlan_revertsOnZeroPeriod() public {
        vm.prank(merchant);
        vm.expectRevert(SubscriptionManager.InvalidPeriod.selector);
        subs.createPlan(address(usdc), 1, 0, 0);
    }

    function _plan(uint256 amount) internal returns (uint256 planId) {
        vm.prank(merchant);
        planId = subs.createPlan(address(usdc), amount, 30 days, 0);
    }

    function _card() internal returns (uint256 cardId) {
        address[] memory allow = new address[](1);
        allow[0] = merchant;
        vm.prank(customer);
        cardId = issuer.mintCard(customer, address(usdc), 50_000_000, 30 days, 0, allow);
    }

    function test_subscribe_pinsVersion_andSchedulesImmediateCharge() public {
        uint256 planId = _plan(29_000_000);
        uint256 cardId = _card();
        vm.prank(customer);
        uint256 subId = subs.subscribe(planId, cardId);
        SubscriptionManager.Subscription memory s = subs.getSubscription(subId);
        assertEq(s.customer, customer);
        assertEq(s.planVersion, 1);
        assertEq(s.nextChargeAt, uint48(block.timestamp)); // trial 0 → due now
        assertEq(uint256(s.state), uint256(SubscriptionManager.SubState.Active));
    }

    function test_subscribe_trialDefersFirstCharge() public {
        vm.prank(merchant);
        uint256 planId = subs.createPlan(address(usdc), 29_000_000, 30 days, 14 days);
        uint256 cardId = _card();
        vm.prank(customer);
        uint256 subId = subs.subscribe(planId, cardId);
        assertEq(subs.getSubscription(subId).nextChargeAt, uint48(block.timestamp + 14 days));
    }

    function test_subscribe_requiresCardOwnership() public {
        uint256 planId = _plan(29_000_000);
        uint256 cardId = _card();
        vm.prank(makeAddr("stranger"));
        vm.expectRevert(SubscriptionManager.NotCardOwnerOfCard.selector);
        subs.subscribe(planId, cardId);
    }

    function _fundAndApprove(uint256 amount) internal {
        usdc.mint(customer, amount);
        vm.prank(customer);
        usdc.approve(address(subs), type(uint256).max);
    }

    function test_charge_pullsFeeSplit_andReschedules() public {
        uint256 planId = _plan(29_000_000);
        uint256 cardId = _card();
        _fundAndApprove(100_000_000);
        vm.prank(customer);
        uint256 subId = subs.subscribe(planId, cardId);

        uint48 scheduled = subs.getSubscription(subId).nextChargeAt;
        subs.charge(subId); // callable by anyone (test contract is a stranger)

        assertEq(usdc.balanceOf(treasury), 290_000);            // 1% of $29
        assertEq(usdc.balanceOf(merchant), 28_710_000);         // $29 - fee
        assertEq(subs.getSubscription(subId).nextChargeAt, scheduled + 30 days);
    }

    function test_charge_revertsBeforeDue_andWhenCardBlocks() public {
        vm.prank(merchant);
        uint256 planId = subs.createPlan(address(usdc), 29_000_000, 30 days, 14 days);
        uint256 cardId = _card();
        _fundAndApprove(100_000_000);
        vm.prank(customer);
        uint256 subId = subs.subscribe(planId, cardId);

        vm.expectRevert(SubscriptionManager.ChargeNotDue.selector);
        subs.charge(subId); // trial not over

        vm.warp(block.timestamp + 14 days);
        vm.prank(customer);
        issuer.freeze(cardId);
        vm.expectRevert(CardIssuer.CardNotActive.selector);
        subs.charge(subId); // frozen card declines — the demo's red-card moment
    }

    function test_charge_pastGrace_expiresWithoutTransfer() public {
        uint256 planId = _plan(29_000_000);
        uint256 cardId = _card();
        _fundAndApprove(100_000_000);
        vm.prank(customer);
        uint256 subId = subs.subscribe(planId, cardId);

        vm.warp(block.timestamp + 3 days + 1); // past GRACE
        subs.charge(subId);
        assertEq(uint256(subs.getSubscription(subId).state), uint256(SubscriptionManager.SubState.Expired));
        assertEq(usdc.balanceOf(merchant), 0);
    }

    function test_charge_migratesToLatestVersionAtRenewal() public {
        uint256 planId = _plan(29_000_000);
        uint256 cardId = _card();
        _fundAndApprove(100_000_000);
        vm.prank(customer);
        uint256 subId = subs.subscribe(planId, cardId);
        subs.charge(subId); // v1 charge

        vm.prank(merchant);
        subs.pushPlanVersion(planId, 35_000_000, 30 days, 0);
        vm.warp(block.timestamp + 30 days);
        subs.charge(subId); // renewal at v2 price
        assertEq(subs.getSubscription(subId).planVersion, 2);
        assertEq(usdc.balanceOf(merchant), 28_710_000 + 34_650_000); // $29 & $35, each -1%
    }

    function test_cancel_customerOnly_stopsCharges() public {
        uint256 planId = _plan(29_000_000);
        uint256 cardId = _card();
        _fundAndApprove(100_000_000);
        vm.prank(customer);
        uint256 subId = subs.subscribe(planId, cardId);

        vm.expectRevert(SubscriptionManager.NotCustomer.selector);
        subs.cancel(subId);

        vm.prank(customer);
        subs.cancel(subId);
        vm.expectRevert(SubscriptionManager.SubNotActive.selector);
        subs.charge(subId);
    }
}
