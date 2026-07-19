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

    event CardMinted(uint256 indexed cardId, address indexed owner, address signer);
    event CardFrozen(uint256 indexed cardId);
    event CardUnfrozen(uint256 indexed cardId);
    event CardCancelled(uint256 indexed cardId);

    error NotCardOwner();
    error CardNotActive();
    error CardIsCancelled();
    error InvalidPeriod();

    modifier onlyCardOwner(uint256 cardId) {
        if (_cards[cardId].owner != msg.sender) revert NotCardOwner();
        _;
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
