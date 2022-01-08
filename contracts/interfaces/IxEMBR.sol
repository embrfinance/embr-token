// SPDX-License-Identifier: MIT
pragma solidity 0.8.7;
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IxEMBR {
  function balanceOf(address account) external view returns (uint256);
  function rewardTokens() external view returns(IERC20[] memory);
  function notifyRewardAmount(uint256[] calldata _rewards) external;
}