// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.13;

import {Test, console} from "forge-std/Test.sol";
import "../src/Interfaces.sol";
import "../src/Constants.sol";
// 导入解答代码
import "../solution/CurveLiquidator.sol";

contract LLAMMALiquidation is Test {
    address user = vm.envAddress("USER_ADDRESS");

    function setUp() public {
        vm.createSelectFork(vm.envString("ETH_RPC_URL"), 20063807);
    }

    function test_Solution() public {
        vm.startBroadcast(user);
        
        // 使用多次清算策略
        CurveLiquidator liquidator = new CurveLiquidator();
        
        // 执行多次清算直到达到目标
        uint256 liquidationFraction = 1e15; // 0.1%
        uint256 maxLiquidations = 100;
        
        for (uint256 i = 0; i < maxLiquidations; i++) {
            // 检查是否已达到目标
            uint256 currentBalance = IERC20(CRV).balanceOf(user);
            if (currentBalance >= 20_000e18) {
                break;
            }
            
            // 检查位置是否仍可清算
            uint256 debt = ILLAMMA(LLAMMA).debt(LIQUIDATABLE_USER);
            if (debt == 0) {
                break;
            }
            
            // 执行清算
            try liquidator.liquidate(liquidationFraction) {
                // 清算成功，继续下一轮
            } catch {
                // 清算失败，停止
                break;
            }
        }
        
        vm.stopBroadcast();
        checkSolve();
    }

    function checkSolve() public view {
        // User must have CRV balance of >= 20,000
        uint256 balance = IERC20(CRV).balanceOf(user);
        require(balance >= 20_000e18);

        // At least 1% of the position has to be liquidated
        uint256 debt = ILLAMMA(LLAMMA).debt(LIQUIDATABLE_USER);
        require(debt <= STARTING_DEBT * 99 / 100);

        console.log('Task #4 "Before the storm" has been solved!');
    }
}
