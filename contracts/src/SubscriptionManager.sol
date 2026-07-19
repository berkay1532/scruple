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
    error PeriodTooShort();
    error PlanInactive();
    error NotCardOwnerOfCard();
    error TokenMismatch();
    error SubNotActive();
    error ChargeNotDue();
    error NotCustomer();
    error ZeroTreasury();

    constructor(address cardIssuer_, address treasury_) {
        if (treasury_ == address(0)) revert ZeroTreasury();
        cardIssuer = CardIssuer(cardIssuer_);
        treasury = treasury_;
    }

    /// @notice `period` must exceed GRACE. The double-charge guard in `charge()` relies on
    /// `nextChargeAt += period` moving strictly past `block.timestamp` after a late-but-in-grace
    /// charge; for `period <= GRACE` that guard can leave `nextChargeAt <= block.timestamp`,
    /// letting a permissionless caller invoke `charge()` repeatedly in one block. Sub-GRACE
    /// billing intervals belong to a metered module, not subscriptions.
    function createPlan(address token, uint256 amount, uint48 period, uint48 trialPeriod)
        external returns (uint256 planId)
    {
        if (period <= GRACE) revert PeriodTooShort();
        planId = nextPlanId++;
        _plans[planId] = Plan({merchant: msg.sender, token: token, latestVersion: 1, active: true});
        _versions[planId][1] = PlanVersion({amount: amount, period: period, trialPeriod: trialPeriod});
        emit PlanCreated(planId, msg.sender, 1);
    }

    function pushPlanVersion(uint256 planId, uint256 amount, uint48 period, uint48 trialPeriod) external {
        Plan storage p = _plans[planId];
        if (p.merchant != msg.sender) revert NotMerchant();
        if (period <= GRACE) revert PeriodTooShort();
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
        if (cardIssuer.getCard(cardId).token != p.token) revert TokenMismatch();
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

    /// @dev Charges migrate the sub to the plan's latest version; the card's periodAmount — not
    /// the subscribed price — is the customer's hard ceiling.
    function charge(uint256 subId) external {
        Subscription storage s = _subs[subId];
        if (s.customer == address(0)) revert SubNotActive();
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

        // CEI: finalize all state (reschedule + version migration already done above) before
        // any external calls, so a reentrant charge() sees a subscription that is not due yet.
        uint16 version = s.planVersion;
        uint256 amount = v.amount;
        uint256 fee = (amount * FEE_BPS) / 10_000;
        s.nextChargeAt = uint48(uint256(s.nextChargeAt) + v.period);

        cardIssuer.authorizeSpend(s.cardId, p.merchant, amount);

        IERC20 token = IERC20(p.token);
        require(token.transferFrom(s.customer, treasury, fee), "FEE_PULL");
        require(token.transferFrom(s.customer, p.merchant, amount - fee), "PAY_PULL");

        emit PaymentSucceeded(subId, version, amount, fee);
    }

    function cancel(uint256 subId) external {
        Subscription storage s = _subs[subId];
        if (s.customer != msg.sender) revert NotCustomer();
        if (s.state != SubState.Active) revert SubNotActive();
        s.state = SubState.Cancelled;
        emit SubscriptionCancelled(subId);
    }
}
