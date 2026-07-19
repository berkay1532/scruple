// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {CardIssuer} from "./CardIssuer.sol";

interface IERC20 {
    function transferFrom(address from, address to, uint256 value) external returns (bool);
}

/// @title SubscriptionManager — Scruple recurring billing. Non-custodial:
/// charge() pulls USDC straight from customer to merchant + treasury.
contract SubscriptionManager {
    struct PlanVersion { uint256 amount; uint48 period; uint48 trialPeriod; }
    struct Plan { address merchant; address token; uint16 latestVersion; bool active; }

    uint16 public constant FEE_BPS = 100; // 1%
    uint48 public constant GRACE = 3 days;

    CardIssuer public immutable cardIssuer;
    address public immutable treasury;

    uint256 public nextPlanId;
    mapping(uint256 => Plan) internal _plans;
    mapping(uint256 => mapping(uint16 => PlanVersion)) internal _versions;

    event PlanCreated(uint256 indexed planId, address indexed merchant, uint16 version);
    event PlanVersionPushed(uint256 indexed planId, uint16 version);

    error NotMerchant();
    error InvalidPeriod();

    constructor(address cardIssuer_, address treasury_) {
        cardIssuer = CardIssuer(cardIssuer_);
        treasury = treasury_;
    }

    function createPlan(address token, uint256 amount, uint48 period, uint48 trialPeriod)
        external returns (uint256 planId)
    {
        if (period == 0) revert InvalidPeriod();
        planId = nextPlanId++;
        _plans[planId] = Plan({merchant: msg.sender, token: token, latestVersion: 1, active: true});
        _versions[planId][1] = PlanVersion({amount: amount, period: period, trialPeriod: trialPeriod});
        emit PlanCreated(planId, msg.sender, 1);
    }

    function pushPlanVersion(uint256 planId, uint256 amount, uint48 period, uint48 trialPeriod) external {
        Plan storage p = _plans[planId];
        if (p.merchant != msg.sender) revert NotMerchant();
        if (period == 0) revert InvalidPeriod();
        p.latestVersion += 1;
        _versions[planId][p.latestVersion] = PlanVersion({amount: amount, period: period, trialPeriod: trialPeriod});
        emit PlanVersionPushed(planId, p.latestVersion);
    }

    function getPlan(uint256 planId) external view returns (Plan memory) { return _plans[planId]; }

    function getPlanVersion(uint256 planId, uint16 version) external view returns (PlanVersion memory) {
        return _versions[planId][version];
    }
}
