// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {Script, console2} from "../lib/forge-std/src/Script.sol";
import {CurveLiquidator} from "./CurveLiquidator.sol";
import "../src/Interfaces.sol";

interface ICurveController {
    function debt(address user) external view returns (uint256);
    function health(address user, bool full) external view returns (int256);
}

contract MultiLiquidatePositionScript is Script {
    address constant CURVE_CONTROLLER = 0xEdA215b7666936DEd834f76f3fBC6F323295110A;
    address constant LIQUIDATION_TARGET = 0x6F8C5692b00c2eBbd07e4FD80E332DfF3ab8E83c;
    address constant CRV = 0xD533a949740bb3306d119CC777fa900bA034cd52;
    address constant CRVUSD = 0xf939E0A03FB07F59A73314E73794Be0E57ac1b4E;
    
    // Liquidation parameters
    uint256 constant LIQUIDATION_FRACTION = 1e15; // 0.1% = 0.001 = 1e15 / 1e18
    uint256 constant TARGET_CRV_AMOUNT = 20_000e18; // 20,000 CRV target
    
    function run() external {
        vm.startBroadcast();
        
        address deployer = msg.sender;
        ICurveController controller = ICurveController(CURVE_CONTROLLER);
        
        // Deploy liquidator contract once
        CurveLiquidator liquidator = new CurveLiquidator();
        
        // Record initial balance
        uint256 initialCrvBalance = IERC20(CRV).balanceOf(deployer);
        console2.log("=== STARTING MULTI-LIQUIDATION ===");
        console2.log("Initial CRV balance:", initialCrvBalance / 1e18);
        console2.log("Target CRV amount:", TARGET_CRV_AMOUNT / 1e18);
        console2.log("");
        
        // Execute multiple liquidations
        uint256 maxLiquidations = 100; // 设置最大清算次数防止无限循环
        uint256 successfulLiquidations = 0;
        
        for (uint256 i = 0; i < maxLiquidations; i++) {
            // Check if position is still liquidatable
            int256 health = controller.health(LIQUIDATION_TARGET, true);
            uint256 debt = controller.debt(LIQUIDATION_TARGET);
            
            console2.log("--- Round", i + 1, "---");
            console2.log("Position health:", health);
            console2.log("Position debt:", debt / 1e18, "tokens");
            
            if (health >= 0) {
                console2.log("Position is healthy, stopping liquidation");
                break;
            }
            
            if (debt == 0) {
                console2.log("No debt remaining, stopping liquidation");
                break;
            }
            
            // Record balance before this liquidation
            uint256 balanceBefore = IERC20(CRV).balanceOf(deployer);
            
            // Execute liquidation
            try liquidator.liquidate(LIQUIDATION_FRACTION) {
                uint256 balanceAfter = IERC20(CRV).balanceOf(deployer);
                uint256 profit = balanceAfter - balanceBefore;
                successfulLiquidations++;
                
                console2.log("Liquidation SUCCESS!");
                console2.log("Profit this round:", profit / 1e18, "CRV");
                console2.log("Current total CRV:", balanceAfter / 1e18);
                
                // Check if we have enough CRV
                if (balanceAfter >= TARGET_CRV_AMOUNT) {
                    console2.log("");
                    console2.log("SUCCESS! Reached target of", TARGET_CRV_AMOUNT / 1e18, "CRV");
                    console2.log("Total liquidations performed:", successfulLiquidations);
                    break;
                }
                console2.log("Still need:", (TARGET_CRV_AMOUNT - balanceAfter) / 1e18, "more CRV");
                console2.log("");
                
            } catch Error(string memory reason) {
                console2.log("Liquidation FAILED:", reason);
                break;
            } catch {
                console2.log("Liquidation FAILED: Unknown error");
                break;
            }
        }
        
        // Final summary
        uint256 finalCrvBalance = IERC20(CRV).balanceOf(deployer);
        uint256 totalProfit = finalCrvBalance - initialCrvBalance;
        
        console2.log("=== FINAL RESULTS ===");
        console2.log("Successful liquidations:", successfulLiquidations);
        console2.log("Total CRV profit:", totalProfit / 1e18);
        console2.log("Final CRV balance:", finalCrvBalance / 1e18);
        console2.log("Target achieved:", finalCrvBalance >= TARGET_CRV_AMOUNT ? "YES" : "NO");
        
        if (finalCrvBalance < TARGET_CRV_AMOUNT) {
            console2.log("Still need:", (TARGET_CRV_AMOUNT - finalCrvBalance) / 1e18, "more CRV");
        }
        
        vm.stopBroadcast();
    }
}
