// SPDX-License-Identifier: MIT

pragma solidity 0.8.7;

import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import "./EmbrToken.sol";
import "../interfaces/IRewarder.sol";

/*
    This master chef is based on SUSHI's version with some adjustments:
     - Upgrade to pragma 0.8.7
     - therefore remove usage of SafeMath (built in overflow check for solidity > 8)
     - Merge sushi's master chef V1 & V2 (no usage of dummy pool)
     - remove withdraw function (without harvest) => requires the rewardDebt to be an signed int instead of uint which requires a lot of casting and has no real usecase for us
     - no dev emissions, but treasury emissions instead
     - treasury percentage is subtracted from emissions instead of added on top
     - update of emission rate with upper limit of 6 EMBR/block
     - more require checks in general
*/

// Have fun reading it. Hopefully it's still bug-free
contract EmbrMasterChef is Ownable {
    using SafeERC20 for IERC20;
    using EnumerableSet for EnumerableSet.AddressSet;

    // Info of each user.
    struct UserInfo {
        uint256 amount; // How many LP tokens the user has provided.
        uint256 rewardDebt; // Reward debt. See explanation below.
        //
        // We do some fancy math here. Basically, any point in time, the amount of EMBR
        // entitled to a user but is pending to be distributed is:
        //
        //   pending reward = (user.amount * pool.accEmbrPerShare) - user.rewardDebt
        //
        // Whenever a user deposits or withdraws LP tokens to a pool. Here's what happens:
        //   1. The pool's `accEmbrPerShare` (and `lastRewardBlock`) gets updated.
        //   2. User receives the pending reward sent to his/her address.
        //   3. User's `amount` gets updated.
        //   4. User's `rewardDebt` gets updated.
    }
    // Info of each pool.
    struct PoolInfo {
        // we have a fixed number of EMBR tokens released per block, each pool gets his fraction based on the allocPoint
        uint256 allocPoint; // How many allocation points assigned to this pool. the fraction EMBR to distribute per block.
        uint256 lastRewardTimestamp; // Last block number that EMBR distribution occurs.
        uint256 accEmbrPerShare; // Accumulated EMBR per LP share. this is multiplied by ACC_EMBR_PRECISION for more exact results (rounding errors)
    }
    // The EMBR TOKEN!
    EmbrToken public embr;

    // Treasury address.
    address public treasuryAddress;

    // EMBR tokens created per second.
    uint256 public embrPerSec;

    uint256 private constant ACC_EMBR_PRECISION = 1e12;

    // distribution percentages: a value of 1000 = 100%
    // 10.0% percentage of pool rewards that goes to the treasury.
    uint256 public constant TREASURY_PERCENTAGE = 100;

    // 90.0% percentage of pool rewards that goes to LP holders.
    uint256 public constant POOL_PERCENTAGE = 900;

    // Info of each pool.
    PoolInfo[] public poolInfo;
    // Info of each user that stakes LP tokens per pool. poolId => address => userInfo
    /// @notice Address of the LP token for each MCV pool.
    IERC20[] public lpTokens;

    EnumerableSet.AddressSet private lpTokenAddresses;

    /// @notice Address of each `IRewarder` contract in MCV.
    IRewarder[] public rewarder;

    mapping(uint256 => mapping(address => UserInfo)) public userInfo; // mapping form poolId => user Address => User Info
    // Total allocation points. Must be the sum of all allocation points in all pools.
    uint256 public totalAllocPoint = 0;
    // The block number when EMBR mining starts.
    uint256 public startTimestamp;

    event Deposit(
        address indexed user,
        uint256 indexed pid,
        uint256 amount,
        address indexed to
    );
    event Withdraw(
        address indexed user,
        uint256 indexed pid,
        uint256 amount,
        address indexed to
    );
    event EmergencyWithdraw(
        address indexed user,
        uint256 indexed pid,
        uint256 amount,
        address indexed to
    );
    event Harvest(address indexed user, uint256 indexed pid, uint256 amount);
    event LogPoolAddition(
        uint256 indexed pid,
        uint256 allocPoint,
        IERC20 indexed lpToken,
        IRewarder indexed rewarder
    );
    event LogSetPool(
        uint256 indexed pid,
        uint256 allocPoint,
        IRewarder indexed rewarder,
        bool overwrite
    );
    event LogUpdatePool(
        uint256 indexed pid,
        uint256 lastRewardTimestamp,
        uint256 lpSupply,
        uint256 accEmbrPerShare
    );
    event SetTreasuryAddress(
        address indexed oldAddress,
        address indexed newAddress
    );
    event UpdateEmissionRate(address indexed user, uint256 _embrPerSec);

    constructor(
        EmbrToken _embr,
        address _treasuryAddress,
        uint256 _embrPerSec,
        uint256 _startTimestamp
    ) {
        embr = _embr;
        treasuryAddress = _treasuryAddress;
        embrPerSec = _embrPerSec;
        startTimestamp = _startTimestamp;
    }

    function poolLength() external view returns (uint256) {
        return poolInfo.length;
    }

    // Add a new lp to the pool. Can only be called by the owner.
    function add(
        uint256 _allocPoint,
        IERC20 _lpToken,
        IRewarder _rewarder
    ) public onlyOwner {
        require(
            Address.isContract(address(_lpToken)),
            "add: LP token must be a valid contract"
        );
        require(
            Address.isContract(address(_rewarder)) ||
                address(_rewarder) == address(0),
            "add: rewarder must be contract or zero"
        );
        // we make sure the same LP cannot be added twice which would cause trouble
        require(
            !lpTokenAddresses.contains(address(_lpToken)),
            "add: LP already added"
        );

        // respect startBlock!
        uint256 lastRewardTimestamp = block.timestamp > startTimestamp
            ? block.timestamp
            : startTimestamp;
        totalAllocPoint = totalAllocPoint + _allocPoint;

        // LP tokens, rewarders & pools are always on the same index which translates into the pid
        lpTokens.push(_lpToken);
        lpTokenAddresses.add(address(_lpToken));
        rewarder.push(_rewarder);

        poolInfo.push(
            PoolInfo({
                allocPoint: _allocPoint,
                lastRewardTimestamp: lastRewardTimestamp,
                accEmbrPerShare: 0
            })
        );
        emit LogPoolAddition(
            lpTokens.length - 1,
            _allocPoint,
            _lpToken,
            _rewarder
        );
    }

    // Update the given pool's EMBR allocation point. Can only be called by the owner.
    /// @param _pid The index of the pool. See `poolInfo`.
    /// @param _allocPoint New AP of the pool.
    /// @param _rewarder Address of the rewarder delegate.
    /// @param overwrite True if _rewarder should be `set`. Otherwise `_rewarder` is ignored.
    function set(
        uint256 _pid,
        uint256 _allocPoint,
        IRewarder _rewarder,
        bool overwrite
    ) public onlyOwner {
        require(
            Address.isContract(address(_rewarder)) ||
                address(_rewarder) == address(0),
            "set: rewarder must be contract or zero"
        );

        // we re-adjust the total allocation points
        totalAllocPoint =
            totalAllocPoint -
            poolInfo[_pid].allocPoint +
            _allocPoint;

        poolInfo[_pid].allocPoint = _allocPoint;

        if (overwrite) {
            rewarder[_pid] = _rewarder;
        }
        emit LogSetPool(
            _pid,
            _allocPoint,
            overwrite ? _rewarder : rewarder[_pid],
            overwrite
        );
    }

    // View function to see pending EMBR on frontend.
    function pendingEmbr(uint256 _pid, address _user)
        external
        view
        returns (uint256 pending)
    {
        PoolInfo storage pool = poolInfo[_pid];
        UserInfo storage user = userInfo[_pid][_user];
        // how many EMBR per lp token
        uint256 accEmbrPerShare = pool.accEmbrPerShare;
        // total staked lp tokens in this pool
        uint256 lpSupply = lpTokens[_pid].balanceOf(address(this));

        if (block.timestamp > pool.lastRewardTimestamp && lpSupply != 0) {
            uint256 multiplier = block.timestamp - pool.lastRewardTimestamp;
            // based on the pool weight (allocation points) we calculate the embr rewarded for this specific pool
            uint256 embrRewards = (multiplier *
                embrPerSec *
                pool.allocPoint) / totalAllocPoint;

            // we take parts of the rewards for treasury, these can be subject to change, so we recalculate it
            // a value of 1000 = 100%
            uint256 embrRewardsForPool = (embrRewards * POOL_PERCENTAGE) /
                1000;

            // we calculate the new amount of accumulated embr per LP token
            accEmbrPerShare =
                accEmbrPerShare +
                ((embrRewardsForPool * ACC_EMBR_PRECISION) / lpSupply);
        }
        // based on the number of LP tokens the user owns, we calculate the pending amount by subtracting the amount
        // which he is not eligible for (joined the pool later) or has already harvested
        pending =
            (user.amount * accEmbrPerShare) /
            ACC_EMBR_PRECISION -
            user.rewardDebt;
    }

    /// @notice Update reward variables for all pools. Be careful of gas spending!
    /// @param pids Pool IDs of all to be updated. Make sure to update all active pools.
    function massUpdatePools(uint256[] calldata pids) external {
        uint256 len = pids.length;
        for (uint256 i = 0; i < len; ++i) {
            updatePool(pids[i]);
        }
    }

    // Update reward variables of the given pool to be up-to-date.
    function updatePool(uint256 _pid) public returns (PoolInfo memory pool) {
        pool = poolInfo[_pid];
        uint256 lpSupply = lpTokens[_pid].balanceOf(address(this));
        
         if (block.timestamp <= pool.lastRewardTimestamp) {
            return pool;
        }
        
        if (lpSupply == 0) {
            pool.lastRewardTimestamp = block.timestamp;
            return pool;
        }

        uint256 multiplier = block.timestamp - pool.lastRewardTimestamp;
        // rewards for this pool based on his allocation points
        uint256 embrRewards = (multiplier *
            embrPerSec *
            pool.allocPoint) / totalAllocPoint;

        uint256 embrRewardsForPool = (embrRewards * POOL_PERCENTAGE) /
            1000;

         embr.mint(
            treasuryAddress,
            (embrRewards * TREASURY_PERCENTAGE) / 1000
        );

        embr.mint(address(this), embrRewardsForPool);
        pool.accEmbrPerShare =
            pool.accEmbrPerShare +
            ((embrRewardsForPool * ACC_EMBR_PRECISION) / lpSupply);
        pool.lastRewardTimestamp = block.timestamp;

        poolInfo[_pid] = pool;
        emit LogUpdatePool(
            _pid,
            pool.lastRewardTimestamp,
            lpSupply,
            pool.accEmbrPerShare
        );
    }

    // Deposit LP tokens to MasterChef for EMBR allocation.
    function deposit(
        uint256 _pid,
        uint256 _amount,
        address _to
    ) public {
        PoolInfo memory pool = updatePool(_pid);
        UserInfo storage user = userInfo[_pid][_to];
        
        user.amount = user.amount + _amount;
        // since we add more LP tokens, we have to keep track of the rewards he is not eligible for
        // if we would not do that, he would get rewards like he added them since the beginning of this pool
        // note that only the accEmbrPerShare have the precision applied
        user.rewardDebt =
            user.rewardDebt +
            (_amount * pool.accEmbrPerShare) /
            ACC_EMBR_PRECISION;

        IRewarder _rewarder = rewarder[_pid];
        if (address(_rewarder) != address(0)) {
            _rewarder.onEmbrReward(_pid, _to, _to, 0, user.amount);
        }

        lpTokens[_pid].safeTransferFrom(msg.sender, address(this), _amount);

        emit Deposit(msg.sender, _pid, _amount, _to);
    }

    function harvestAll(uint256[] calldata _pids, address _to) external {
        for (uint256 i = 0; i < _pids.length; i++) {
            if (userInfo[_pids[i]][msg.sender].amount > 0) {
                harvest(_pids[i], _to);
            }
        }
    }

    /// @notice Harvest proceeds for transaction sender to `_to`.
    /// @param _pid The index of the pool. See `poolInfo`.
    /// @param _to Receiver of EMBR rewards.
    function harvest(uint256 _pid, address _to) public {
        PoolInfo memory pool = updatePool(_pid);
        UserInfo storage user = userInfo[_pid][msg.sender];

        // this would  be the amount if the user joined right from the start of the farm
        uint256 accumulatedEmbr = (user.amount * pool.accEmbrPerShare) /
            ACC_EMBR_PRECISION;
        // subtracting the rewards the user is not eligible for
        uint256 eligibleEmbr = accumulatedEmbr - user.rewardDebt;

        // we set the new rewardDebt to the current accumulated amount of rewards for his amount of LP token
        user.rewardDebt = accumulatedEmbr;

        if (eligibleEmbr > 0) {
            safeEmbrTransfer(_to, eligibleEmbr);
        }

        IRewarder _rewarder = rewarder[_pid];
        if (address(_rewarder) != address(0)) {
            _rewarder.onEmbrReward(
                _pid,
                msg.sender,
                _to,
                eligibleEmbr,
                user.amount
            );
        }

        emit Harvest(msg.sender, _pid, eligibleEmbr);
    }

    /// @notice Withdraw LP tokens from MCV and harvest proceeds for transaction sender to `_to`.
    /// @param _pid The index of the pool. See `poolInfo`.
    /// @param _amount LP token amount to withdraw.
    /// @param _to Receiver of the LP tokens and EMBR rewards.
    function withdrawAndHarvest(
        uint256 _pid,
        uint256 _amount,
        address _to
    ) public {
        PoolInfo memory pool = updatePool(_pid);
        UserInfo storage user = userInfo[_pid][msg.sender];

        require(_amount <= user.amount, "cannot withdraw more than deposited");

        // this would  be the amount if the user joined right from the start of the farm
        uint256 accumulatedEmbr = (user.amount * pool.accEmbrPerShare) /
            ACC_EMBR_PRECISION;
        // subtracting the rewards the user is not eligible for
        uint256 eligibleEmbr = accumulatedEmbr - user.rewardDebt;

        /*
            after harvest & withdraw, he should be eligible for exactly 0 tokens
            => userInfo.amount * pool.accEmbrPerShare / ACC_EMBR_PRECISION == userInfo.rewardDebt
            since we are removing some LP's from userInfo.amount, we also have to remove
            the equivalent amount of reward debt
        */

        user.rewardDebt =
            accumulatedEmbr -
            (_amount * pool.accEmbrPerShare) /
            ACC_EMBR_PRECISION;
        user.amount = user.amount - _amount;

        safeEmbrTransfer(_to, eligibleEmbr);

        IRewarder _rewarder = rewarder[_pid];
        if (address(_rewarder) != address(0)) {
            _rewarder.onEmbrReward(
                _pid,
                msg.sender,
                _to,
                eligibleEmbr,
                user.amount
            );
        }

        lpTokens[_pid].safeTransfer(_to, _amount);

        emit Withdraw(msg.sender, _pid, _amount, _to);
        emit Harvest(msg.sender, _pid, eligibleEmbr);
    }

    // Withdraw without caring about rewards. EMERGENCY ONLY.
    function emergencyWithdraw(uint256 _pid, address _to) public {
        UserInfo storage user = userInfo[_pid][msg.sender];
        uint256 amount = user.amount;
        user.amount = 0;
        user.rewardDebt = 0;

        IRewarder _rewarder = rewarder[_pid];
        if (address(_rewarder) != address(0)) {
            _rewarder.onEmbrReward(_pid, msg.sender, _to, 0, 0);
        }

        // Note: transfer can fail or succeed if `amount` is zero.
        lpTokens[_pid].safeTransfer(_to, amount);
        emit EmergencyWithdraw(msg.sender, _pid, amount, _to);
    }

    // Safe EMBR transfer function, just in case if rounding error causes pool to not have enough EMBR.
    function safeEmbrTransfer(address _to, uint256 _amount) internal {
        uint256 embrBalance = embr.balanceOf(address(this));
        if (_amount > embrBalance) {
            embr.transfer(_to, embrBalance);
        } else {
            embr.transfer(_to, _amount);
        }
    }

    // Update treasury address by the owner.
    function treasury(address _treasuryAddress) public onlyOwner {
        treasuryAddress = _treasuryAddress;
        emit SetTreasuryAddress(treasuryAddress, _treasuryAddress);
    }

    function updateEmissionRate(uint256 _embrPerSec) public onlyOwner {
        embrPerSec = _embrPerSec;
        emit UpdateEmissionRate(msg.sender, _embrPerSec);
    }
}