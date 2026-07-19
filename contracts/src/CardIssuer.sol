// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title CardIssuer — Scruple payer-side spending-policy cards.
/// Field semantics mirror ERC-7715 `erc20-token-periodic` (periodAmount,
/// periodDuration, expiry, signer) so future native-7715 wallets map 1:1.
contract CardIssuer {
    enum CardState { Active, Frozen, Cancelled }

    struct Card {
        address owner;          // controls lifecycle
        address signer;         // key that exercises the permission (human session key or agent key)
        address token;          // USDC
        uint256 periodAmount;   // budget per period, 6-decimal units
        uint48 periodDuration;  // seconds
        uint48 expiry;          // unix ts; 0 = no expiry
        CardState state;
        uint48 periodStart;     // current accounting-period start
        uint256 spentInPeriod;
        bool useAllowlist;      // false = any merchant
    }

    uint256 public nextCardId;
    mapping(uint256 => Card) internal _cards;
    mapping(uint256 => mapping(address => bool)) public allowlist;
    address public immutable admin;
    mapping(address => bool) public authorizedChargers;

    event CardMinted(uint256 indexed cardId, address indexed owner, address signer);
    event CardFrozen(uint256 indexed cardId);
    event CardUnfrozen(uint256 indexed cardId);
    event CardCancelled(uint256 indexed cardId);
    event SpendAuthorized(uint256 indexed cardId, address indexed merchant, uint256 amount);
    event ChargerAuthorizationSet(address indexed charger, bool authorized);

    error NotCardOwner();
    error CardNotActive();
    error CardIsCancelled();
    error InvalidPeriod();
    error NotAuthorizedCharger();
    error NotAdmin();
    error CardExpired();
    error MerchantNotAllowed();
    error BudgetExceeded();

    modifier onlyCardOwner(uint256 cardId) {
        if (_cards[cardId].owner != msg.sender) revert NotCardOwner();
        _;
    }

    constructor() {
        admin = msg.sender;
    }

    function setChargerAuthorization(address charger, bool authorized) external {
        if (msg.sender != admin) revert NotAdmin();
        authorizedChargers[charger] = authorized;
        emit ChargerAuthorizationSet(charger, authorized);
    }

    function _rolledPeriodStart(Card memory c) internal view returns (uint48 start, uint256 spent) {
        start = c.periodStart;
        spent = c.spentInPeriod;
        if (block.timestamp >= start + c.periodDuration) {
            uint256 elapsed = (block.timestamp - start) / c.periodDuration;
            start = uint48(start + elapsed * c.periodDuration);
            spent = 0;
        }
    }

    function _checkSpend(Card memory c, uint256 cardId, address merchant, uint256 amount)
        internal view returns (bool ok, uint48 newStart, uint256 newSpent)
    {
        if (c.state != CardState.Active) return (false, 0, 0);
        if (c.expiry != 0 && block.timestamp > c.expiry) return (false, 0, 0);
        if (c.useAllowlist && !allowlist[cardId][merchant]) return (false, 0, 0);
        (uint48 start, uint256 spent) = _rolledPeriodStart(c);
        if (spent + amount > c.periodAmount) return (false, 0, 0);
        return (true, start, spent + amount);
    }

    function previewSpend(uint256 cardId, address merchant, uint256 amount) external view returns (bool ok) {
        (ok,,) = _checkSpend(_cards[cardId], cardId, merchant, amount);
    }

    function authorizeSpend(uint256 cardId, address merchant, uint256 amount) external {
        if (!authorizedChargers[msg.sender]) revert NotAuthorizedCharger();
        Card storage c = _cards[cardId];
        if (c.state != CardState.Active) revert CardNotActive();
        if (c.expiry != 0 && block.timestamp > c.expiry) revert CardExpired();
        if (c.useAllowlist && !allowlist[cardId][merchant]) revert MerchantNotAllowed();
        (uint48 start, uint256 spent) = _rolledPeriodStart(c);
        if (spent + amount > c.periodAmount) revert BudgetExceeded();
        c.periodStart = start;
        c.spentInPeriod = spent + amount;
        emit SpendAuthorized(cardId, merchant, amount);
    }

    function mintCard(
        address signer,
        address token,
        uint256 periodAmount,
        uint48 periodDuration,
        uint48 expiry,
        address[] calldata allowedMerchants
    ) external returns (uint256 cardId) {
        if (periodDuration == 0) revert InvalidPeriod();
        cardId = nextCardId++;
        _cards[cardId] = Card({
            owner: msg.sender,
            signer: signer,
            token: token,
            periodAmount: periodAmount,
            periodDuration: periodDuration,
            expiry: expiry,
            state: CardState.Active,
            periodStart: uint48(block.timestamp),
            spentInPeriod: 0,
            useAllowlist: allowedMerchants.length > 0
        });
        for (uint256 i = 0; i < allowedMerchants.length; i++) {
            allowlist[cardId][allowedMerchants[i]] = true;
        }
        emit CardMinted(cardId, msg.sender, signer);
    }

    function getCard(uint256 cardId) external view returns (Card memory) {
        return _cards[cardId];
    }

    function freeze(uint256 cardId) external onlyCardOwner(cardId) {
        Card storage c = _cards[cardId];
        if (c.state == CardState.Cancelled) revert CardIsCancelled();
        c.state = CardState.Frozen;
        emit CardFrozen(cardId);
    }

    function unfreeze(uint256 cardId) external onlyCardOwner(cardId) {
        Card storage c = _cards[cardId];
        if (c.state == CardState.Cancelled) revert CardIsCancelled();
        c.state = CardState.Active;
        emit CardUnfrozen(cardId);
    }

    function cancel(uint256 cardId) external onlyCardOwner(cardId) {
        _cards[cardId].state = CardState.Cancelled;
        emit CardCancelled(cardId);
    }
}
