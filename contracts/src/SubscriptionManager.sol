// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {CardIssuer} from "./CardIssuer.sol";

interface IERC20 {
    function transferFrom(address from, address to, uint256 value) external returns (bool);
}

/// @title SubscriptionManager — Scruple recurring billing. Non-custodial:
/// charge() pulls USDC straight from customer to merchant + treasury.
contract SubscriptionManager {
    enum SubState { Active, Cancelled, Expired }

    struct PlanVersion { uint256 amount; uint48 period; uint48 trialPeriod; }
    struct Plan { address merchant; address token; uint16 latestVersion; bool active; }
    struct Subscription {
        address customer;
        uint256 planId;
        uint16 planVersion;
        uint256 cardId;
        uint48 nextChargeAt;
        SubState state;
    }

    uint16 public constant FEE_BPS = 100; // 1%
    uint48 public constant GRACE = 3 days;

    CardIssuer public immutable cardIssuer;
    address public immutable treasury;

    uint256 public nextPlanId;
    mapping(uint256 => Plan) internal _plans;
    mapping(uint256 => mapping(uint16 => PlanVersion)) internal _versions;

    uint256 public nextSubId;
    mapping(uint256 => Subscription) internal _subs;

    event PlanCreated(uint256 indexed planId, address indexed merchant, uint16 version);
    event PlanVersionPushed(uint256 indexed planId, uint16 version);
    event SubscriptionCreated(uint256 indexed subId, uint256 indexed planId, address indexed customer, uint256 cardId);
    event PaymentSucceeded(uint256 indexed subId, uint16 version, uint256 amount, uint256 fee);
    event SubscriptionExpired(uint256 indexed subId);
    event SubscriptionCancelled(uint256 indexed subId);

    error NotMerchant();
    error InvalidPeriod();
    error PlanInactive();
    error NotCardOwnerOfCard();
    error SubNotActive();
    error ChargeNotDue();
    error NotCustomer();

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

    function subscribe(uint256 planId, uint256 cardId) external returns (uint256 subId) {
        Plan storage p = _plans[planId];
        if (!p.active) revert PlanInactive();
        if (cardIssuer.getCard(cardId).owner != msg.sender) revert NotCardOwnerOfCard();
        PlanVersion storage v = _versions[planId][p.latestVersion];
        subId = nextSubId++;
        _subs[subId] = Subscription({
            customer: msg.sender,
            planId: planId,
            planVersion: p.latestVersion,
            cardId: cardId,
            nextChargeAt: uint48(block.timestamp + v.trialPeriod),
            state: SubState.Active
        });
        emit SubscriptionCreated(subId, planId, msg.sender, cardId);
    }

    function getSubscription(uint256 subId) external view returns (Subscription memory) {
        return _subs[subId];
    }

    function charge(uint256 subId) external {
        Subscription storage s = _subs[subId];
        if (s.state != SubState.Active) revert SubNotActive();
        if (block.timestamp < s.nextChargeAt) revert ChargeNotDue();

        if (block.timestamp > uint256(s.nextChargeAt) + GRACE) {
            s.state = SubState.Expired;
            emit SubscriptionExpired(subId);
            return;
        }

        Plan storage p = _plans[s.planId];
        // migrate to latest version at each renewal (spec: price changes apply at renewal)
        s.planVersion = p.latestVersion;
        PlanVersion storage v = _versions[s.planId][s.planVersion];

        cardIssuer.authorizeSpend(s.cardId, p.merchant, v.amount);

        uint256 fee = (v.amount * FEE_BPS) / 10_000;
        IERC20 token = IERC20(p.token);
        require(token.transferFrom(s.customer, treasury, fee), "FEE_PULL");
        require(token.transferFrom(s.customer, p.merchant, v.amount - fee), "PAY_PULL");

        s.nextChargeAt = uint48(uint256(s.nextChargeAt) + v.period);
        emit PaymentSucceeded(subId, s.planVersion, v.amount, fee);
    }

    function cancel(uint256 subId) external {
        Subscription storage s = _subs[subId];
        if (s.customer != msg.sender) revert NotCustomer();
        if (s.state != SubState.Active) revert SubNotActive();
        s.state = SubState.Cancelled;
        emit SubscriptionCancelled(subId);
    }
}
