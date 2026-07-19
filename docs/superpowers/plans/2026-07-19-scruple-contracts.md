# Scruple Contracts (Phase 1 / CP2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the on-chain core of Scruple — `CardIssuer.sol` (payer-side spending-policy cards) and `SubscriptionManager.sol` (plans, versioned pricing, recurring charges with grace/expiry and 1% fee split) — fully TDD'd with Foundry and deployable to Arc testnet.

**Architecture:** Two contracts, non-custodial. Customer USDC never leaves their wallet until `charge()` pulls it directly to merchant + treasury via `transferFrom`. `CardIssuer` is the policy layer (period budgets, allowlists, expiry, freeze); `SubscriptionManager` is the only authorized charger in this phase. Metered settlement intentionally has **no custom contract** (rides Circle's live `GatewayWalletBatched`).

**Tech Stack:** Solidity ^0.8.24, Foundry (forge/anvil), OpenZeppelin ERC20 (test mock only), Arc testnet (chain 5042002).

## Global Constraints

- Solidity `^0.8.24`; Foundry toolchain; tests in `contracts/test/`, sources in `contracts/src/`.
- USDC math is **6-decimal** everywhere ($1 = `1_000_000`). Never use `ether` literals in contract tests.
- Fee: `FEE_BPS = 100` (1%), split inside `charge()`; treasury address set at deploy. No other fees.
- Grace window: `GRACE = 3 days` (spec §5); charge window opens at `nextChargeAt`, sub expires past `nextChargeAt + GRACE`.
- Non-custodial: contracts must never hold customer funds (no `transfer` to `address(this)`).
- Plan prices are immutable rows: price change = new version, applied at next renewal (no mid-period proration).
- `charge(subId)` must be callable by **anyone** (permissionless keeper fallback, spec §6).
- Card fields mirror ERC-7715 `erc20-token-periodic` semantics: `periodAmount`, `periodDuration`, `expiry`, `signer`.
- Every commit message ends with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

## File Structure

```
scruple/
  contracts/
    foundry.toml
    src/CardIssuer.sol           # card policy: mint, freeze/unfreeze, cancel, authorizeSpend
    src/SubscriptionManager.sol  # plans, versions, subscribe, charge, cancel, expire
    test/MockUSDC.sol            # 6-decimal ERC20 mock
    test/CardIssuer.t.sol
    test/SubscriptionManager.t.sol
    script/Deploy.s.sol          # Arc testnet deploy + wiring
  README.md                      # public-facing (CP2 requires public repo)
  .gitignore
```

---

### Task 1: Foundry scaffold + MockUSDC

**Files:**
- Create: `contracts/foundry.toml`, `contracts/test/MockUSDC.sol`, `contracts/test/MockUSDC.t.sol`, `.gitignore`, `README.md`

**Interfaces:**
- Produces: `MockUSDC` — OZ ERC20, `decimals() == 6`, `mint(address to, uint256 amount)` public. Used by every later test.

- [ ] **Step 1: Scaffold**

```bash
cd /Users/beko/Documents/beko/Arc/scruple
mkdir -p contracts && cd contracts
forge init --no-git --force .
rm -f src/Counter.sol test/Counter.t.sol script/Counter.s.sol
forge install OpenZeppelin/openzeppelin-contracts --no-commit
```

`contracts/foundry.toml`:
```toml
[profile.default]
src = "src"
out = "out"
libs = ["lib"]
solc_version = "0.8.24"
remappings = ["@openzeppelin/=lib/openzeppelin-contracts/"]
```

Repo-root `.gitignore`:
```
contracts/out/
contracts/cache/
node_modules/
.env
```

Repo-root `README.md` (stub, expanded in Task 6):
```markdown
# Scruple

Stripe-grade billing for the USDC economy on Arc: usage-based + subscription
billing (merchant side) and spending-policy Cards (payer side). Non-custodial.

Encode × Arc Programmable Money Hackathon 2026 — tracks: DeFi + Agentic Economy.
```

- [ ] **Step 2: Write the failing test**

`contracts/test/MockUSDC.t.sol`:
```solidity
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
```

- [ ] **Step 3: Run test to verify it fails**

Run: `forge test --match-contract MockUSDCTest -vv`
Expected: compile error — `MockUSDC.sol` not found.

- [ ] **Step 4: Implement**

`contracts/test/MockUSDC.sol`:
```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract MockUSDC is ERC20 {
    constructor() ERC20("USD Coin", "USDC") {}
    function decimals() public pure override returns (uint8) { return 6; }
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `forge test --match-contract MockUSDCTest -vv`
Expected: `[PASS] test_sixDecimals_andMint()`

- [ ] **Step 6: Commit**

```bash
cd /Users/beko/Documents/beko/Arc/scruple && git add -A
git commit -m "chore: Foundry scaffold + 6-decimal MockUSDC

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: CardIssuer — mint + lifecycle (freeze/unfreeze/cancel)

**Files:**
- Create: `contracts/src/CardIssuer.sol`, `contracts/test/CardIssuer.t.sol`

**Interfaces:**
- Produces:
  - `mintCard(address signer, address token, uint256 periodAmount, uint48 periodDuration, uint48 expiry, address[] calldata allowedMerchants) returns (uint256 cardId)`
  - `freeze(uint256)`, `unfreeze(uint256)`, `cancel(uint256)` — card owner only; cancel is terminal.
  - `getCard(uint256) returns (Card memory)`; `enum CardState { Active, Frozen, Cancelled }`
  - `Card` struct fields: `owner, signer, token, periodAmount, periodDuration, expiry, state, periodStart, spentInPeriod, useAllowlist`
  - Events: `CardMinted(cardId, owner, signer)`, `CardFrozen(cardId)`, `CardUnfrozen(cardId)`, `CardCancelled(cardId)`
  - Errors: `NotCardOwner()`, `CardNotActive()`, `CardIsCancelled()`, `InvalidPeriod()`

- [ ] **Step 1: Write the failing tests**

`contracts/test/CardIssuer.t.sol`:
```solidity
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
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `forge test --match-contract CardIssuerTest -vv`
Expected: compile error — `CardIssuer.sol` not found.

- [ ] **Step 3: Implement**

`contracts/src/CardIssuer.sol`:
```solidity
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `forge test --match-contract CardIssuerTest -vv`
Expected: 4 tests `[PASS]`.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(contracts): CardIssuer mint + freeze/unfreeze/cancel lifecycle

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: CardIssuer — spend accounting (budget, allowlist, expiry, rolling periods)

**Files:**
- Modify: `contracts/src/CardIssuer.sol`
- Test: `contracts/test/CardIssuer.t.sol` (append)

**Interfaces:**
- Produces:
  - `setChargerAuthorization(address charger, bool authorized)` — deployer (`admin`) only.
  - `authorizeSpend(uint256 cardId, address merchant, uint256 amount)` — authorized chargers only; rolls the accounting period forward, enforces state/expiry/allowlist/budget, then debits `spentInPeriod`. Reverts otherwise.
  - `previewSpend(uint256 cardId, address merchant, uint256 amount) view returns (bool)` — same checks, no mutation (off-chain verify path).
  - Event: `SpendAuthorized(cardId, merchant, amount)`
  - Errors: `NotAuthorizedCharger()`, `CardExpired()`, `MerchantNotAllowed()`, `BudgetExceeded()`
- Consumes: Task 2 `Card`/lifecycle.

- [ ] **Step 1: Write the failing tests** (append inside `CardIssuerTest`)

```solidity
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `forge test --match-contract CardIssuerTest -vv`
Expected: compile error — `setChargerAuthorization` undefined.

- [ ] **Step 3: Implement** (add to `CardIssuer.sol`)

Add state/events/errors:
```solidity
    address public immutable admin;
    mapping(address => bool) public authorizedChargers;

    event SpendAuthorized(uint256 indexed cardId, address indexed merchant, uint256 amount);
    event ChargerAuthorizationSet(address indexed charger, bool authorized);

    error NotAuthorizedCharger();
    error NotAdmin();
    error CardExpired();
    error MerchantNotAllowed();
    error BudgetExceeded();
```

Add `constructor() { admin = msg.sender; }` and functions:
```solidity
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `forge test --match-contract CardIssuerTest -vv`
Expected: 8 tests `[PASS]`.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(contracts): CardIssuer spend accounting — rolling period budget, allowlist, expiry

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: SubscriptionManager — plans + immutable versions

**Files:**
- Create: `contracts/src/SubscriptionManager.sol`, `contracts/test/SubscriptionManager.t.sol`

**Interfaces:**
- Produces:
  - `constructor(address cardIssuer, address treasury)`
  - `createPlan(address token, uint256 amount, uint48 period, uint48 trialPeriod) returns (uint256 planId)` — `msg.sender` becomes merchant; stores version 1.
  - `pushPlanVersion(uint256 planId, uint256 amount, uint48 period, uint48 trialPeriod)` — merchant only; appends immutable version, bumps `latestVersion`.
  - `getPlan(uint256) returns (Plan memory)`; `getPlanVersion(uint256 planId, uint16 version) returns (PlanVersion memory)`
  - Structs: `Plan { address merchant; address token; uint16 latestVersion; bool active; }`, `PlanVersion { uint256 amount; uint48 period; uint48 trialPeriod; }`
  - Constants: `FEE_BPS = 100`, `GRACE = 3 days`
  - Events: `PlanCreated(planId, merchant, version)`, `PlanVersionPushed(planId, version)`
  - Errors: `NotMerchant()`, `InvalidPeriod()`
- Consumes: Task 3 `CardIssuer` (address wired in constructor; used from Task 5 on).

- [ ] **Step 1: Write the failing tests**

`contracts/test/SubscriptionManager.t.sol`:
```solidity
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `forge test --match-contract SubscriptionManagerTest -vv`
Expected: compile error — `SubscriptionManager.sol` not found.

- [ ] **Step 3: Implement**

`contracts/src/SubscriptionManager.sol`:
```solidity
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `forge test --match-contract SubscriptionManagerTest -vv`
Expected: 3 tests `[PASS]`.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(contracts): SubscriptionManager plans with immutable versioning

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: SubscriptionManager — subscribe

**Files:**
- Modify: `contracts/src/SubscriptionManager.sol`
- Test: `contracts/test/SubscriptionManager.t.sol` (append)

**Interfaces:**
- Produces:
  - `subscribe(uint256 planId, uint256 cardId) returns (uint256 subId)` — caller must own the card; pins current `latestVersion`; `nextChargeAt = now + trialPeriod` (charge due immediately when trial is 0).
  - `getSubscription(uint256) returns (Subscription memory)`
  - `Subscription { address customer; uint256 planId; uint16 planVersion; uint256 cardId; uint48 nextChargeAt; SubState state; }`, `enum SubState { Active, Cancelled, Expired }`
  - Event: `SubscriptionCreated(subId, planId, customer, cardId)`
  - Errors: `PlanInactive()`, `NotCardOwnerOfCard()`
- Consumes: Task 2 `issuer.getCard(cardId).owner`, Task 4 plans.

- [ ] **Step 1: Write the failing tests** (append; also add helper + card mint to `setUp` flow)

```solidity
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `forge test --match-contract SubscriptionManagerTest -vv`
Expected: compile error — `subscribe` undefined.

- [ ] **Step 3: Implement** (add to `SubscriptionManager.sol`)

```solidity
    enum SubState { Active, Cancelled, Expired }

    struct Subscription {
        address customer;
        uint256 planId;
        uint16 planVersion;
        uint256 cardId;
        uint48 nextChargeAt;
        SubState state;
    }

    uint256 public nextSubId;
    mapping(uint256 => Subscription) internal _subs;

    event SubscriptionCreated(uint256 indexed subId, uint256 indexed planId, address indexed customer, uint256 cardId);

    error PlanInactive();
    error NotCardOwnerOfCard();

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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `forge test --match-contract SubscriptionManagerTest -vv`
Expected: 6 tests `[PASS]`.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(contracts): subscribe with version pinning and trial scheduling

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: SubscriptionManager — charge, grace/expiry, cancel, renewal migration

**Files:**
- Modify: `contracts/src/SubscriptionManager.sol`
- Test: `contracts/test/SubscriptionManager.t.sol` (append)

**Interfaces:**
- Produces:
  - `charge(uint256 subId)` — permissionless. Inside `[nextChargeAt, nextChargeAt+GRACE]`: migrates sub to `latestVersion`, calls `cardIssuer.authorizeSpend(cardId, merchant, amount)`, pulls `fee = amount*FEE_BPS/10_000` to treasury and `amount-fee` to merchant via `transferFrom(customer, …)`, then `nextChargeAt += period` (schedule-anchored, no drift). Past grace: flips to `Expired` without transferring.
  - `cancel(uint256 subId)` — customer only.
  - Events: `PaymentSucceeded(subId, version, amount, fee)`, `SubscriptionExpired(subId)`, `SubscriptionCancelled(subId)`
  - Errors: `SubNotActive()`, `ChargeNotDue()`
- Consumes: Task 3 `authorizeSpend` (card policy enforcement), Task 5 subscriptions.

- [ ] **Step 1: Write the failing tests** (append; fund + approve in helper)

```solidity
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `forge test --match-contract SubscriptionManagerTest -vv`
Expected: compile error — `charge` undefined.

- [ ] **Step 3: Implement** (add to `SubscriptionManager.sol`; also add `error NotCustomer();`)

```solidity
    event PaymentSucceeded(uint256 indexed subId, uint16 version, uint256 amount, uint256 fee);
    event SubscriptionExpired(uint256 indexed subId);
    event SubscriptionCancelled(uint256 indexed subId);

    error SubNotActive();
    error ChargeNotDue();
    error NotCustomer();

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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `forge test -vv`
Expected: all CardIssuer + SubscriptionManager + MockUSDC tests `[PASS]` (20 total).

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(contracts): permissionless charge with fee split, grace/expiry, renewal migration, cancel

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Deploy script for Arc testnet + README

**Files:**
- Create: `contracts/script/Deploy.s.sol`
- Modify: `README.md`

**Interfaces:**
- Consumes: both contracts; env vars `PRIVATE_KEY`, `TREASURY`, `RPC` (Arc testnet RPC URL — `https://rpc.testnet.arc.network` or the arc-canteen authenticated URL).
- Produces: deployed addresses printed to console; `CardIssuer.setChargerAuthorization(subs, true)` wired in the same broadcast.

- [ ] **Step 1: Write the deploy script**

`contracts/script/Deploy.s.sol`:
```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {CardIssuer} from "../src/CardIssuer.sol";
import {SubscriptionManager} from "../src/SubscriptionManager.sol";

contract Deploy is Script {
    function run() external {
        address treasury = vm.envAddress("TREASURY");
        vm.startBroadcast(vm.envUint("PRIVATE_KEY"));
        CardIssuer issuer = new CardIssuer();
        SubscriptionManager subs = new SubscriptionManager(address(issuer), treasury);
        issuer.setChargerAuthorization(address(subs), true);
        vm.stopBroadcast();
        console.log("CardIssuer:          ", address(issuer));
        console.log("SubscriptionManager: ", address(subs));
    }
}
```

- [ ] **Step 2: Dry-run locally**

Run: `forge script script/Deploy.s.sol --fork-url https://rpc.testnet.arc.network -vv` with `TREASURY` and `PRIVATE_KEY` env vars set (any funded key; simulation only).
Expected: simulation succeeds, two addresses printed.

- [ ] **Step 3: Deploy to Arc testnet** (needs a funded wallet — the arc-canteen $5 USDC wallet covers gas)

Run:
```bash
export RPC=<arc testnet rpc>; export PRIVATE_KEY=<funded key>; export TREASURY=<address>
forge script script/Deploy.s.sol --rpc-url $RPC --broadcast -vv
```
Expected: two contract addresses on chain 5042002; verify on `https://testnet.arcscan.app`.

- [ ] **Step 4: Expand README** — append deployed addresses, architecture diagram from the spec (§4), quickstart (`forge test`), and link to spec + this plan.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(contracts): Arc testnet deploy script + README with deployed addresses

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Out of scope for this plan (later phases)

- **Phase 2:** Merchant SDK (402 middleware, verify/settle, `@circle-fin/x402-batching` settlement loop) + Payer/Agent SDK.
- **Phase 3:** Indexer (chunked `getLogs`), webhook service (full taxonomy incl. `subscription.at_risk` monitor), keeper bot.
- **Phase 4:** Dashboard (Next.js, card visuals), demo script, video + deck.
