// SPDX-License-Identifier: MIT

pragma solidity 0.8.7;

import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/security/Pausable.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "../interfaces/IProtocolFeeCollector.sol";
import "../interfaces/IxEMBR.sol";


contract EmbrProtocolFeeDistrubutor is ReentrancyGuard, Pausable, Ownable  {
    using SafeERC20 for IERC20;


    /* ========== STATE VARIABLES ========== */
    IProtocolFeeCollector public protocolFeeCollector;
    IxEMBR public xEmbr;

    uint256 public teamPercentage = 0;
    uint256 public xembrPercentage = 0;
    uint256 public treasuaryPercentage = 0;

    address public team;
    address public treasuary;

    mapping(address => uint256) public teamBalance;
    mapping(address => uint256) public treasuaryBalance;
    /* ========== CONSTRUCTOR ========== */

    constructor(
        address _protocolFeeCollector,
        address _xEmbr,
        address _teamOwner,
        address _treasuaryOwner,
        uint256 _teamPercentage,
        uint256 _xembrPercentage,
        uint256 _treasuaryPercentage
    ) {
        require(_teamPercentage + _xembrPercentage + _treasuaryPercentage == 1000, "Distrubtion percent is not 1000");

        protocolFeeCollector = IProtocolFeeCollector(_protocolFeeCollector);
        xEmbr = IxEMBR(_xEmbr);

        teamPercentage = _teamPercentage;
        xembrPercentage = _xembrPercentage;
        treasuaryPercentage = _treasuaryPercentage;
        team = _teamOwner;
        treasuary = _treasuaryOwner;
    }

    function collect()
        external
        onlyOwner
    {
        IERC20[] memory rewardTokens =  xEmbr.rewardTokens();
        uint256[] memory feeAmounts = protocolFeeCollector.getCollectedFeeAmounts(rewardTokens);
        protocolFeeCollector.withdrawCollectedFees(rewardTokens, feeAmounts, address(this));
        //xEmbr.
        for(uint256 i=0; i <= rewardTokens.length - 1; i++) { 
            uint256 balance = rewardTokens[i].balanceOf(address(this));
            if (balance > 0) {
                uint256 xmbrAmt = (balance * xembrPercentage) / 1000;
                uint256 teamAmt = (balance * teamPercentage) / 1000;
                uint256 treasuaryAmt = (balance * treasuaryPercentage) / 1000;

                if (teamAmt > 0) { 
                    teamBalance[address(rewardTokens[i])];
                }
                if (treasuaryAmt > 0) {
                    treasuaryBalance[address(rewardTokens[i])];
                }

                rewardTokens[i].safeTransfer(address(xEmbr), xmbrAmt);
            }
        }
        xEmbr.notifyRewardAmount(feeAmounts);
    }


    function balanceOf(address _token) external view returns (uint256) {
        uint256 balance = IERC20(_token).balanceOf(address(this));
        return balance;
    }

    function setTeam(address _team) external {
        require(msg.sender == team, "!team");
        team = _team;
    }

    function setTreasuary(address _treasuary) external {
        require(msg.sender == treasuary, "!treasuary");
        treasuary = _treasuary;
    }

    function withdrawTeam(address _addr, address _token) external {
        require(msg.sender == team, "!team");
        uint256 _teamBalance = teamBalance[_token];
        if (_teamBalance > 0) { 
            uint256 balance = IERC20(_token).balanceOf(address(this));
            if (balance > 0 && balance >= _teamBalance) {
                teamBalance[_token] = 0;
                IERC20(_token).safeTransfer(_addr, _teamBalance);
            }
        }
    }

    function withdrawTreasuary(address _addr, address _token) external  {
        require(msg.sender == treasuary, "!treasuary");
        
         uint256 _treasuaryBalance = treasuaryBalance[_token];
        if (_treasuaryBalance > 0) { 
            uint256 balance = IERC20(_token).balanceOf(address(this));
            if (balance > 0 && balance >= _treasuaryBalance) {
                treasuaryBalance[_token] = 0;
                IERC20(_token).safeTransfer(_addr, _treasuaryBalance);
            }
        }

    }

    function setPercentages(uint256[] calldata _percentages) external onlyOwner {
        require(_percentages.length == 3, "!incorrect length");
        require(_percentages[0] + _percentages[1] + _percentages[2] == 1000, "Distrubtion percent is not 1000");

        teamPercentage = _percentages[0];
        xembrPercentage = _percentages[1];
        treasuaryPercentage = _percentages[2];
    }

    function recoverERC20(address tokenAddress)
        external
        onlyOwner
    {
        uint256 balance = IERC20(tokenAddress).balanceOf(address(this));
        if (balance > 0) {
            IERC20(tokenAddress).safeTransfer(msg.sender, balance);
        }
        //emit Recovered(tokenAddress, balance);
    }
}