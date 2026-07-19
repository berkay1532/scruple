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
}
