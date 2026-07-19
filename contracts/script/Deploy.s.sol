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
