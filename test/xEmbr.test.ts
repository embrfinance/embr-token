import { expect } from "chai"
import { advanceBlock, advanceBlockTo, bn, deployProtocolDistrubutor, deployContract, deployERC20Mock, setAutomineBlocks } from "./utilities"
import { ethers } from "hardhat"
import { ContractTransaction, Event, ContractReceipt } from "ethers"
import { getTimestamp, increaseTime, increaseTimeTo } from "./mstableutils/time"
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"
import { assertBNClose, assertBNSlightlyGT, assertBNClosePercent } from "./mstableutils/assertions"
import { BN, simpleToExactAmount, sqrt } from "./mstableutils/math"
import { ONE_WEEK, ONE_DAY, FIVE_DAYS, fullScale, DEFAULT_DECIMALS } from "./mstableutils/constants"
import {
    XEmbr,
    XEmbr__factory,
    ERC20Mock,
    ERC20Mock__factory,
    EmbrToken
} from "../types"


const EVENTS = { DEPOSIT: "Staked", WITHDRAW: "Withdraw", REWARD_PAID: "RewardPaid" }

const goToNextUnixWeekStart = async () => {
    const unixWeekCount = (await getTimestamp()).div(ONE_WEEK)
    const nextUnixWeek = unixWeekCount.add(1).mul(ONE_WEEK)
    await increaseTimeTo(nextUnixWeek)
}

const oneWeekInAdvance = async (): Promise<BN> => {
    const now = await getTimestamp()
    return now.add(ONE_WEEK)
}

const twoWeekInAdvance = async (): Promise<BN> => {
    const now = await getTimestamp()
    return now.add(ONE_WEEK).add(ONE_WEEK)
}


const isContractEvent = (address: string, eventName: string) => (event: Event) => event.address === address && event.event === eventName

const findContractEvent = (receipt: ContractReceipt, address: string, eventName: string) =>
    receipt.events?.find(isContractEvent(address, eventName))

interface WithdrawEventArgs {
    provider: string
    value: BN
}

const expectWithdrawEvent = async (
    xEmbr: XEmbr,
    tx: Promise<ContractTransaction>,
    receipt: ContractReceipt,
    args: WithdrawEventArgs,
) => {
    const currentTime = await getTimestamp()
    await expect(tx).to.emit(xEmbr, EVENTS.WITHDRAW)
    const withdrawEvent = findContractEvent(receipt, xEmbr.address, EVENTS.WITHDRAW)
    expect(withdrawEvent).to.not.equal(undefined)
    expect(withdrawEvent?.args?.provider, "provider in Withdraw event").to.eq(args.provider)
    expect(withdrawEvent?.args?.value, "value in Withdraw event").to.eq(args.value)
    assertBNClose(withdrawEvent?.args?.ts, currentTime.add(1), BN.from(10), "ts in Withdraw event")
}

describe("xEmbrRewards", () => {
    let stakingToken: EmbrToken
    let owner: SignerWithAddress
    let treasury: SignerWithAddress
    let team: SignerWithAddress
    let alice: SignerWithAddress
    let bob: SignerWithAddress
    let carol: SignerWithAddress
    let susan: SignerWithAddress
    let joe: SignerWithAddress
    let ryan: SignerWithAddress

    const treasuryPercentage = 100
    const teamPercentage = 0
    const stakingPercentage = 900

    let xEmbr: XEmbr
    

    before("Init contract", async () => {
        const signers = await ethers.getSigners()
        owner = signers[0]
        team = signers[1]
        treasury = signers[2]
        alice = signers[4]
        bob = signers[5]
        carol = signers[6]
        susan = signers[7]
        joe = signers[8]
        ryan = signers[9]
    })

    let rewardTokens: Array<ERC20Mock> = []

    const redeployRewards = async (): Promise<XEmbr> => {
        const deployer = owner
        stakingToken = await deployContract("EmbrToken", [])
        //await stakingToken.transfer(rewardsDistributorAddress, simpleToExactAmount(1000, 21))
        return new XEmbr__factory(deployer).deploy(
            stakingToken.address,
            "xEmbr",
            "xEMBR"
        )
    }

    const redeployRewardTokens = async(xEmbr: XEmbr) => { 
        rewardTokens = []
        for(let i =0; i< 3; i++) {
            const rt = await deployERC20Mock("USDC"+i, "USDC"+i, bn(10000000000000))
            await xEmbr.add(rt.address)
            rewardTokens.push(rt)
        }

    }

    interface LockedBalance {
        amount: BN
        end: BN
    }

    interface Point {
        bias: BN
        slope: BN
        ts: BN
        blk?: BN
    }

    interface Reward {
        amount: BN
    }

    interface StakingData {
        totalStaticWeight: BN
        userStaticWeight: BN
        userLocked: LockedBalance
        userLastPoint: Point
        senderStakingTokenBalance: BN
        contractStakingTokenBalance: BN
        userRewardPerTokenPaid: Reward[]
        beneficiaryRewardsEarned: Reward[]
        beneficiaryRewardsUnClaimed: Reward[]
        rewardPerTokenStored: Reward[]
        rewardRate: Reward[]
        lastUpdateTime: BN
        lastTimeRewardApplicable: BN
        periodFinishTime: BN
    }

    enum LockAction {
        CREATE_LOCK,
        INCREASE_LOCK_AMOUNT,
        INCREASE_LOCK_TIME,
    }

    const snapshotStakingData = async (sender = owner): Promise<StakingData> => {
        const locked = await xEmbr.locked(sender.address)
        const lastPoint = await xEmbr.getLastUserPoint(sender.address)
        let userRewardPerTokenPaid = []
        let senderStakingTokenBalance = await stakingToken.balanceOf(sender.address)
        let contractStakingTokenBalance = await stakingToken.balanceOf(xEmbr.address)
        let beneficiaryRewardsEarned = []
        let beneficiaryRewardsUnClaimed = []
        let rewardPerTokenStored = []
        let rewardRate = []
        let lastUpdateTime = await xEmbr.lastUpdateTime()
        let lastTimeRewardApplicable = await xEmbr.lastTimeRewardApplicable()
        let periodFinishTime = await xEmbr.periodFinish()

        for (let i =0; i < rewardTokens.length; i++) {
            let urptp = await xEmbr.userRewardPerTokenPaid(i, sender.address)
            let bre = await xEmbr.rewards(i, sender.address)
            let bruc = await xEmbr.earned(i, sender.address)
            let rpts = await xEmbr.rewardPerTokenStored(i)
            let rr = await xEmbr.rewardRate(i)
            userRewardPerTokenPaid.push({amount: urptp})
            beneficiaryRewardsEarned.push({amount: bre})
            beneficiaryRewardsUnClaimed.push({amount: bruc})
            rewardPerTokenStored.push({amount: rpts})
            rewardRate.push({amount: rr})
        }

        return {
            totalStaticWeight: await xEmbr.totalStaticWeight(),
            userStaticWeight: await xEmbr.staticBalanceOf(sender.address),
            userLocked: {
                amount: locked[0],
                end: locked[1],
            },
            userLastPoint: {
                bias: lastPoint[0],
                slope: lastPoint[1],
                ts: lastPoint[2],
            },
            userRewardPerTokenPaid: userRewardPerTokenPaid,
            senderStakingTokenBalance: senderStakingTokenBalance,
            contractStakingTokenBalance: contractStakingTokenBalance,
            beneficiaryRewardsEarned: beneficiaryRewardsEarned,
            beneficiaryRewardsUnClaimed: beneficiaryRewardsUnClaimed,
            rewardPerTokenStored: rewardPerTokenStored,
            rewardRate: rewardRate,
            lastUpdateTime: lastUpdateTime,
            lastTimeRewardApplicable: lastTimeRewardApplicable,
            periodFinishTime: periodFinishTime,
        }
    }

    before(async () => {
        xEmbr = await redeployRewards()
        await redeployRewardTokens(xEmbr)
    })


    describe("constructor & settings", async () => {
        before(async () => {
            xEmbr = await redeployRewards()
            await redeployRewardTokens(xEmbr)
        })

        it("should set all initial state", async () => {
            // Set in constructor
            expect(await xEmbr.stakingToken(), stakingToken.address)
            expect(await xEmbr.periodFinish()).eq(BN.from(0))
            expect(await xEmbr.lastUpdateTime()).eq(BN.from(0))
            expect(await xEmbr.lastTimeRewardApplicable()).eq(BN.from(0))
            expect(await xEmbr.totalStaticWeight()).eq(BN.from(0))

            // Basic storage
            for (let i =0; i < rewardTokens.length; i++) {
                expect(await xEmbr.rewardRate(i)).eq(BN.from(0))
                expect(await xEmbr.rewardPerTokenStored(i)).eq(BN.from(0))
                expect(await xEmbr.rewardPerToken(i)).eq(BN.from(0))
            }
        })
    })

    /**
     * @dev Ensures the reward units are assigned correctly, based on the last update time, etc
     * @param beforeData Snapshot after the tx
     * @param afterData Snapshot after the tx
     * @param isExistingStaker Expect the staker to be existing?
     */
    const assertRewardsAssigned = async (
        beforeData: StakingData,
        afterData: StakingData,
        rewardTokenId: number, 
        isExistingStaker: boolean,
        shouldResetRewards = false,
    ): Promise<void> => {
        const timeAfter = await getTimestamp()
        const periodIsFinished = timeAfter.gt(beforeData.periodFinishTime)
        const lastUpdateTokenTime =
            beforeData.rewardPerTokenStored[rewardTokenId].amount.eq(0) && beforeData.totalStaticWeight.eq(0) ? beforeData.lastUpdateTime : timeAfter
        //    LastUpdateTime
        expect(periodIsFinished ? beforeData.periodFinishTime : lastUpdateTokenTime).eq(afterData.lastUpdateTime)

        //    RewardRate does not change
        expect(beforeData.rewardRate[rewardTokenId].amount).eq(afterData.rewardRate[rewardTokenId].amount)
        //    RewardPerTokenStored goes up
        expect(afterData.rewardPerTokenStored[rewardTokenId].amount).gte(beforeData.rewardPerTokenStored[rewardTokenId].amount.toNumber())
        //      Calculate exact expected 'rewardPerToken' increase since last update
        const timeApplicableToRewards = periodIsFinished
            ? beforeData.periodFinishTime.sub(beforeData.lastUpdateTime)
            : timeAfter.sub(beforeData.lastUpdateTime)
        const increaseInRewardPerToken = beforeData.totalStaticWeight.eq(BN.from(0))
            ? BN.from(0)
            : beforeData.rewardRate[rewardTokenId].amount.mul(timeApplicableToRewards).mul(fullScale).div(beforeData.totalStaticWeight)
       
       
        console.log(beforeData.rewardPerTokenStored[rewardTokenId].amount.toString(), increaseInRewardPerToken.toString(), afterData.rewardPerTokenStored[rewardTokenId].amount.toString())
        expect(beforeData.rewardPerTokenStored[rewardTokenId].amount.add(increaseInRewardPerToken)).eq(afterData.rewardPerTokenStored[rewardTokenId].amount)

        // Expect updated personal state
        //    userRewardPerTokenPaid(beneficiary) should update
        expect(afterData.userRewardPerTokenPaid[rewardTokenId].amount).eq(afterData.rewardPerTokenStored[rewardTokenId].amount)

        //    If existing staker, then rewards Should increase
        if (shouldResetRewards) {
            expect(afterData.beneficiaryRewardsEarned).eq(BN.from(0))
        } else if (isExistingStaker) {
            // rewards(beneficiary) should update with previously accrued tokens
            const increaseInUserRewardPerToken = afterData.rewardPerTokenStored[rewardTokenId].amount.sub(beforeData.userRewardPerTokenPaid[rewardTokenId].amount)
            const assignment = beforeData.userStaticWeight.mul(increaseInUserRewardPerToken).div(fullScale)
            expect(beforeData.beneficiaryRewardsEarned[rewardTokenId].amount.add(assignment)).eq(afterData.beneficiaryRewardsEarned[rewardTokenId].amount)
        } else {
            // else `rewards` should stay the same
            expect(beforeData.beneficiaryRewardsEarned[rewardTokenId].amount).eq(afterData.beneficiaryRewardsEarned[rewardTokenId].amount)
        }
    }

    const calculateStaticBalance = async (lockupLength: BN, amount: BN): Promise<BN> => {
        const slope = amount.div(await xEmbr.MAXTIME())
        const s = slope.mul(10000).mul(sqrt(lockupLength))
        return s
    }

    /**
     * @dev Ensures a stake is successful, updates the rewards for the beneficiary and
     * collects the stake
     * @param lockAction The lock action to perform (CREATE_LOCK, INCREASE_LOCK_AMOUNT, INCREASE_LOCK_TIME)
     * @param stakeAmount Exact units to stake
     * @param sender Sender of the tx
     */
    const expectSuccessfulStake = async (lockAction: LockAction, stakeAmount: BN, sender = owner): Promise<void> => {
        // 1. Get data from the contract
        console.log(sender.address)
        const beforeData = await snapshotStakingData(sender)

        const isExistingStaker = beforeData.userStaticWeight.gt(BN.from(0))
        // 2. Approve staking token spending and send the TX
        await stakingToken.connect(sender).approve(xEmbr.address, stakeAmount)

        let tx: Promise<ContractTransaction>
        let expectedLocktime: BN
        let expectedAmount = stakeAmount

        const floorToWeek = (t: number) => Math.trunc(Math.trunc(t / ONE_WEEK.toNumber()) * ONE_WEEK.toNumber())
        switch (lockAction) {
            case LockAction.CREATE_LOCK:
                tx = xEmbr.connect(sender).createLock(stakeAmount, await oneWeekInAdvance())
                expectedLocktime = BN.from(floorToWeek((await oneWeekInAdvance()).toNumber()))
                break
            case LockAction.INCREASE_LOCK_AMOUNT:
                expect(isExistingStaker).eq(true)
                tx = xEmbr.connect(sender).increaseLockAmount(stakeAmount)
                expectedLocktime = await getTimestamp()
                break
            default:
                // INCREASE_LOCK_TIME
                tx = xEmbr.connect(sender).increaseLockLength((await oneWeekInAdvance()).add(ONE_WEEK))
                expectedLocktime = BN.from(floorToWeek((await oneWeekInAdvance()).add(ONE_WEEK).toNumber()))
                expectedAmount = BN.from(0)
                break
        }

        const receipt = await (await tx).wait()
        await expect(tx).to.emit(xEmbr, EVENTS.DEPOSIT)
        const depositEvent = findContractEvent(receipt, xEmbr.address, EVENTS.DEPOSIT)
        expect(depositEvent).to.not.equal(undefined)
        expect(depositEvent?.args?.provider, "provider in Stake event").to.eq(sender.address)
        expect(depositEvent?.args?.value, "value in Stake event").to.eq(expectedAmount)
        expect(depositEvent?.args?.locktime, "locktime in Stake event").to.eq(expectedLocktime)
        expect(depositEvent?.args?.action, "action in Stake event").to.eq(lockAction)
        assertBNClose(depositEvent?.args?.ts, (await getTimestamp()).add(1), BN.from(10), "ts in Stake event")

        // 3. Ensure rewards are accrued to the beneficiary
        const afterData = await snapshotStakingData(sender)

        for (let i =0; i < rewardTokens.length; i++) {
            await assertRewardsAssigned(beforeData, afterData, i, isExistingStaker)
        }

        // 4. Expect token transfer
        const shouldIncreaseTime = lockAction === LockAction.INCREASE_LOCK_TIME
        //    StakingToken balance of sender
        expect(shouldIncreaseTime ? beforeData.senderStakingTokenBalance : beforeData.senderStakingTokenBalance.sub(stakeAmount)).eq(
            afterData.senderStakingTokenBalance,
        )
        //    StakingToken balance of xEmbr
        expect(shouldIncreaseTime ? beforeData.contractStakingTokenBalance : beforeData.contractStakingTokenBalance.add(stakeAmount)).eq(
            afterData.contractStakingTokenBalance,
        )
        //    totalStaticWeight of xEmbr
        expect(
            isExistingStaker
                ? beforeData.totalStaticWeight.add(afterData.userStaticWeight).sub(beforeData.userStaticWeight)
                : beforeData.totalStaticWeight.add(afterData.userStaticWeight),
        ).eq(afterData.totalStaticWeight)
    }

    /**
     * @dev Ensures a funding is successful, checking that it updates the rewardRate etc
     * @param rewardUnits Number of units to stake
     */
    const expectSuccesfulFunding = async (rewardUnits: BN): Promise<void> => {
        const beforeData = await snapshotStakingData()

        let notify = []
        for (let i =0; i < rewardTokens.length; i++) {
            notify.push(rewardUnits)
        }

        const tx = await xEmbr.connect(owner).notifyRewardAmount(notify)
        await expect(tx).to.emit(xEmbr, "RewardsAdded").withArgs(notify)

        const cur = BN.from(await getTimestamp())
            
        const afterData = await snapshotStakingData()
        // Sets lastTimeRewardApplicable to latest
        expect(cur).eq(afterData.lastTimeRewardApplicable)
        // Sets lastUpdateTime to latest
        expect(cur).eq(afterData.lastUpdateTime)
        // Sets periodFinish to 1 week from now
        expect(cur.add(ONE_WEEK)).eq(afterData.periodFinishTime)
        for (let i =0; i < rewardTokens.length; i++) {
            const leftOverRewards = beforeData.rewardRate[i].amount.mul(beforeData.periodFinishTime.sub(beforeData.lastTimeRewardApplicable))

            // Sets rewardRate to rewardUnits / ONE_WEEK
            if (leftOverRewards.gt(0)) {
                const total = rewardUnits.add(leftOverRewards)
                assertBNClose(
                    total.div(ONE_WEEK),
                    afterData.rewardRate[i].amount,
                    beforeData.rewardRate[i].amount.div(ONE_WEEK).mul(5), // the effect of 1 second on the future scale
                )
            } else {
                expect(rewardUnits.div(ONE_WEEK)).eq(afterData.rewardRate[i].amount)
            }
        }

    }

    /**
     * @dev Makes a withdrawal from the contract, and ensures that resulting state is correct
     * and the rewards have been applied
     * @param sender User to execute the tx
     */
    const expectStakingWithdrawal = async (sender = owner): Promise<void> => {
        // 1. Get data from the contract
        const beforeData = await snapshotStakingData(sender)
        const isExistingStaker = beforeData.userStaticWeight.gt(BN.from(0))
        expect(isExistingStaker).eq(true)
        // 2. Send withdrawal tx
        const tx = xEmbr.connect(sender).withdraw()
        const receipt = await (await tx).wait()

        await expectWithdrawEvent(xEmbr, tx, receipt, { provider: sender.address, value: beforeData.userLocked.amount })

        // 3. Expect Rewards to accrue to the beneficiary
        //    StakingToken balance of sender
        const afterData = await snapshotStakingData(sender)
        for (let i =0; i < rewardTokens.length; i++) {
            await assertRewardsAssigned(beforeData, afterData, i, isExistingStaker)
        }
        // 4. Expect token transfer
        //    StakingToken balance of sender
        expect(beforeData.senderStakingTokenBalance.add(beforeData.userLocked.amount)).eq(afterData.senderStakingTokenBalance)
        //    Withdraws from the actual rewards wrapper token
        expect(afterData.userLocked.amount).eq(BN.from(0))
        expect(afterData.userLocked.end).eq(BN.from(0))
        expect(afterData.userStaticWeight).eq(BN.from(0))
        //    Updates total supply
        expect(beforeData.totalStaticWeight.sub(beforeData.userStaticWeight)).eq(afterData.totalStaticWeight)
    }

    context("initialising and staking in a new pool", () => {
        describe("notifying the pool of reward", () => {
            it("should begin a new period through", async () => {
                const rewardUnits = simpleToExactAmount(1, DEFAULT_DECIMALS)
                for (let i =0; i < rewardTokens.length; i++) {
                    await rewardTokens[i].connect(owner).transfer(xEmbr.address, rewardUnits)
                }
                await expectSuccesfulFunding(rewardUnits)
            })
        })
        describe("staking in the new period", () => {
            it("should assign rewards to the staker", async () => {
                // Do the stake


                const stakeAmount = simpleToExactAmount(100, DEFAULT_DECIMALS)
                await stakingToken.connect(owner).mint(owner.address, stakeAmount)
                await expectSuccessfulStake(LockAction.CREATE_LOCK, stakeAmount)

                await increaseTime(ONE_DAY)
                
                const sb = await xEmbr.staticBalanceOf(owner.address)
                for (let i =0; i < rewardTokens.length; i++) {
                    const rewardRate = await xEmbr.rewardRate(i)
                    // This is the total reward per staked token, since the last update
                    const rewardPerToken = await xEmbr.rewardPerToken(i)
                    const rewardPerSecond = BN.from(1)
                        .mul(rewardRate)
                        .mul(fullScale)
                        .div(sb)
                    //console.log(sb.toString(), rewardRate.toString(), rewardPerToken.toString(), ONE_DAY.mul(rewardPerSecond).toString(), rewardPerSecond.mul(10).toString())
                    assertBNClose(rewardPerToken, ONE_DAY.mul(rewardPerSecond), rewardPerSecond.mul(20))

                    // Calc estimated unclaimed reward for the user
                    // earned == balance * (rewardPerToken-userExistingReward)
                    const earned = await xEmbr.earned(i, owner.address)
                    expect((await xEmbr.staticBalanceOf(owner.address)).mul(rewardPerToken).div(fullScale)).eq(earned)
                }
            })
            /*it("should update stakers rewards after consequent stake", async () => {
                const stakeAmount = simpleToExactAmount(100, DEFAULT_DECIMALS)

                // This checks resulting state after second stake
                await stakingToken.connect(owner).mint(owner.address, stakeAmount)
                await expectSuccessfulStake(LockAction.INCREASE_LOCK_TIME, stakeAmount)
            })*/

            it("should fail if stake amount is 0", async () => {
                await expect(xEmbr.connect(owner).createLock(0, await oneWeekInAdvance())).to.be.revertedWith(
                    "Must stake non zero amount",
                )
            })

            it("should fail if staker has insufficient balance", async () => {
                const expectedReason = "ERC20: transfer amount exceeds balance"
                await stakingToken.connect(alice).approve(xEmbr.address, 1)
                await expect(
                    xEmbr.connect(alice).createLock(1, await oneWeekInAdvance()),
                    `voting create lock tx should revert with "${expectedReason}"`,
                ).to.be.revertedWith(expectedReason)
            })
        })
    })
    context("staking before rewards are added", () => {
        before(async () => {
            xEmbr = await redeployRewards()
            await redeployRewardTokens(xEmbr)
        })
        it("should assign no rewards", async () => {
            // Get data before
            const stakeAmount = simpleToExactAmount(100, DEFAULT_DECIMALS)
            const beforeData = await snapshotStakingData()

            expect(beforeData.totalStaticWeight).eq(BN.from(0))
           for (let i =0; i < rewardTokens.length -1; i++) {
                expect(beforeData.rewardRate[i].amount).eq(BN.from(0))
                expect(beforeData.rewardPerTokenStored[i].amount).eq(BN.from(0))
                expect(beforeData.beneficiaryRewardsEarned[i].amount).eq(BN.from(0))
                expect(beforeData.lastTimeRewardApplicable).eq(BN.from(0))
           }

            await goToNextUnixWeekStart()
            // Do the stake
            await stakingToken.connect(owner).mint(owner.address, stakeAmount)
            await expectSuccessfulStake(LockAction.CREATE_LOCK, stakeAmount)

            // Wait a day
            await increaseTime(ONE_DAY)

            // Do another stake
            // await expectSuccessfulStake(LockAction.CREATE_LOCK,stakeAmount);
            // Get end results
            const afterData = await snapshotStakingData()
            assertBNClosePercent(afterData.totalStaticWeight, await calculateStaticBalance(ONE_WEEK, stakeAmount), "0.5")

            for (let i =0; i < rewardTokens.length; i++) {
                expect(afterData.rewardRate[i].amount).eq(BN.from(0))
                expect(afterData.rewardPerTokenStored[i].amount).eq(BN.from(0))
                expect(afterData.beneficiaryRewardsEarned[i].amount).eq(BN.from(0))
                expect(afterData.lastTimeRewardApplicable).eq(BN.from(0))
            }
        })
    })
    context("adding first stake days after funding", () => {
        before(async () => {
            xEmbr = await redeployRewards()
            await redeployRewardTokens(xEmbr)
        })
        it("should retrospectively assign rewards to the first staker", async () => {

            for (let i =0; i < rewardTokens.length; i++) {
                await rewardTokens[i].connect(owner).transfer(xEmbr.address, simpleToExactAmount(100, DEFAULT_DECIMALS))
            }
            await expectSuccesfulFunding(simpleToExactAmount(100, DEFAULT_DECIMALS))
            
           let rewardRate: Array<BN> = []
            for (let i =0; i < rewardTokens.length; i++) {
                // Do the stake
                const rr = await xEmbr.rewardRate(i)
               rewardRate.push(rr)
            }

            await increaseTime(FIVE_DAYS)

            const stakeAmount = simpleToExactAmount(100, DEFAULT_DECIMALS)
            await stakingToken.connect(owner).mint(owner.address, stakeAmount)
            await expectSuccessfulStake(LockAction.CREATE_LOCK, stakeAmount)

            for (let i =0; i < rewardTokens.length; i++) {
                // This is the total reward per staked token, since the last update
                const rewardPerToken = await xEmbr.rewardPerToken(i)
                const sb = await xEmbr.staticBalanceOf(owner.address)

                const rewardPerSecond = BN.from(1)
                    .mul(rewardRate[i])
                    .mul(fullScale)
                    .div(sb)

                assertBNClose(rewardPerToken, FIVE_DAYS.mul(rewardPerSecond), rewardPerSecond.mul(10))

                // Calc estimated unclaimed reward for the user
                // earned == balance * (rewardPerToken-userExistingReward)
                const earnedAfterConsequentStake = await xEmbr.earned(i, owner.address)
                expect((await xEmbr.staticBalanceOf(owner.address)).mul(rewardPerToken).div(fullScale)).eq(
                    earnedAfterConsequentStake,
                )
            }
        })
    })
    
    context("staking over multiple funded periods", () => {
        context("with a single staker", () => {
            before(async () => {
                xEmbr = await redeployRewards()
                await redeployRewardTokens(xEmbr)
            })
            it("should assign all the rewards from the periods", async () => {
                const fundAmount1 = simpleToExactAmount(100, DEFAULT_DECIMALS)
                const fundAmount2 = simpleToExactAmount(200, DEFAULT_DECIMALS)
                for (let i =0; i < rewardTokens.length; i++) {
                    await rewardTokens[i].connect(owner).transfer(xEmbr.address, fundAmount1)
                }
                await expectSuccesfulFunding(fundAmount1)

                const stakeAmount = simpleToExactAmount(1, DEFAULT_DECIMALS)
                await stakingToken.connect(owner).mint(owner.address, stakeAmount)
                await expectSuccessfulStake(LockAction.CREATE_LOCK, stakeAmount)

                await increaseTime(ONE_WEEK.mul(2))

                for (let i =0; i < rewardTokens.length; i++) {
                    const earned = await xEmbr.earned(i, owner.address)
                    console.log("earned", i, earned.toString(), fundAmount1.add(fundAmount2).toString())
                    //assertBNSlightlyGT(fundAmount1.add(fundAmount2), earned, BN.from(1000000), false)
                }


                for  (let i =0; i < rewardTokens.length; i++) {
                    await rewardTokens[i].connect(owner).transfer(xEmbr.address, fundAmount2)
                }
                await expectSuccesfulFunding(fundAmount2)

                await increaseTime(ONE_WEEK.mul(2))

                for (let i =0; i < rewardTokens.length; i++) {
                    const earned = await xEmbr.earned(i, owner.address)
                    console.log("earned", i, earned.toString(), fundAmount1.add(fundAmount2).toString())
                    assertBNSlightlyGT(fundAmount1.add(fundAmount2), earned, BN.from(1000000), false)
                }
            })
        })
        
        context("with multiple stakers coming in and out", () => {
            const fundAmount1 = simpleToExactAmount(10000, 19)
            const fundAmount2 = simpleToExactAmount(20000, 19)
            const staker1Stake1 = simpleToExactAmount(100, DEFAULT_DECIMALS)
            const staker1Stake2 = simpleToExactAmount(200, DEFAULT_DECIMALS)
            const staker2Stake = simpleToExactAmount(100, DEFAULT_DECIMALS)
            const staker3Stake = simpleToExactAmount(100, DEFAULT_DECIMALS)
            let staker2: SignerWithAddress
            let staker3: SignerWithAddress
            before(async () => {
                staker2 = bob
                staker3 = carol
                xEmbr = await redeployRewards()
                await redeployRewardTokens(xEmbr)

                //
                
                
            })
            it("should accrue rewards on a pro rata basis", async () => {


                const expectedStatic1 = await calculateStaticBalance(ONE_WEEK, staker1Stake1)
                const expectedStatic2 = await calculateStaticBalance(ONE_WEEK.div(2), staker1Stake1)
                const totalStaticp2 = expectedStatic1.mul(2).add(expectedStatic2)
                const expectedStatic3 = await calculateStaticBalance(ONE_WEEK, staker1Stake2)
                const totalStaticp3 = expectedStatic3.add(expectedStatic2)
                const staker1share = fundAmount1
                    .div(2)
                    .div(2)
                    .add(fundAmount1.div(2).mul(expectedStatic1).div(totalStaticp2))
                    .add(fundAmount2.mul(expectedStatic3).div(totalStaticp3))
                const staker2share = fundAmount1
                    .div(2)
                    .mul(expectedStatic2)
                    .div(totalStaticp2)
                    .add(fundAmount2.mul(expectedStatic2).div(totalStaticp3))
                const staker3share = fundAmount1.div(2).div(2).add(fundAmount1.div(2).mul(expectedStatic1).div(totalStaticp2))

                // WEEK 0-1 START
                await goToNextUnixWeekStart()
                await stakingToken.mint(owner.address, staker1Stake1)
                await expectSuccessfulStake(LockAction.CREATE_LOCK, staker1Stake1)
                console.log("a")

                await stakingToken.mint(staker3.address, staker3Stake)
                await expectSuccessfulStake(LockAction.CREATE_LOCK, staker3Stake, staker3)

                for (let i =0; i < rewardTokens.length; i++) {
                    await rewardTokens[i].connect(owner).transfer(xEmbr.address, fundAmount1)
                }                
                await expectSuccesfulFunding(fundAmount1)
                console.log("b")
                await increaseTime(ONE_WEEK.div(2).add(1))

                await stakingToken.mint(staker2.address, staker2Stake)
                await expectSuccessfulStake(LockAction.CREATE_LOCK, staker2Stake, staker2)

                console.log("c")
                await increaseTime(ONE_WEEK.div(2).add(1))

                // WEEK 1-2 START
                for (let i =0; i < rewardTokens.length; i++) {
                    await rewardTokens[i].connect(owner).transfer(xEmbr.address, fundAmount2)
                }                
                await expectSuccesfulFunding(fundAmount2)
                console.log("d")

                await xEmbr.eject(staker3.address)
                await xEmbr.connect(owner).withdraw()
                console.log("e")
                await stakingToken.mint(owner.address, staker1Stake2)
                await expectSuccessfulStake(LockAction.CREATE_LOCK, staker1Stake2, owner)

                console.log("f")
                await increaseTime(ONE_WEEK)

                // WEEK 2 FINISH
                for (let i =0; i < rewardTokens.length; i++) {
                    const earned1 = await xEmbr.earned(i, owner.address)
                    const earned2 = await xEmbr.earned(i, staker2.address)
                    const earned3 = await xEmbr.earned(i, staker3.address)
                    assertBNClose(earned1, staker1share, simpleToExactAmount(5, 19))
                    assertBNClose(earned2, staker2share, simpleToExactAmount(5, 19))
                    assertBNClose(earned3, staker3share, simpleToExactAmount(5, 19))
                    // Ensure that sum of earned rewards does not exceed funcing amount
                    expect(fundAmount1.add(fundAmount2)).gte(earned1.add(earned2).add(earned3))
                }
            })
        })
    })
    /*
    context("staking after period finish", () => {
        const fundAmount1 = simpleToExactAmount(100, 21)

        before(async () => {
            xEmbr = await redeployRewards()
            await redeployRewardTokens(xEmbr)
        })
        it("should stop accruing rewards after the period is over", async () => {
            await stakingToken.connect(owner).mint(owner.address, simpleToExactAmount(1, DEFAULT_DECIMALS))
            await expectSuccessfulStake(LockAction.CREATE_LOCK, simpleToExactAmount(1, DEFAULT_DECIMALS))
            for (let i =0; i < rewardTokens.length -1; i++) {
                await rewardTokens[i].connect(owner).transfer(xEmbr.address, fundAmount1)
            }
            await expectSuccesfulFunding(fundAmount1)

            await increaseTime(ONE_WEEK.add(1))

            let earnedAfterWeek: Array<BN> = []

            for (let i =0; i < rewardTokens.length -1; i++) {
                let result:BN = await xEmbr.earned(i, owner.address)
                earnedAfterWeek.push(result)
            }

            await increaseTime(ONE_WEEK.add(1))
            const now = await getTimestamp()

            for (let i =0; i < rewardTokens.length -1; i++) {
                let earnedAfterTwoWeeks:BN = await xEmbr.earned(i, owner.address)

                expect(earnedAfterWeek[i]).eq(earnedAfterTwoWeeks)

                const lastTimeRewardApplicable = await xEmbr.lastTimeRewardApplicable(i)
                assertBNClose(lastTimeRewardApplicable, now.sub(ONE_WEEK).sub(2), BN.from(2))
            }
        })
    })

    context("getting the reward token", () => {
        before(async () => {
            xEmbr = await redeployRewards()
            await redeployRewardTokens(xEmbr)
        })
        it("should simply return the rewards Token", async () => {
            const readToken = await xEmbr.getRewardToken()
            expect(readToken).eq(stakingToken.address)
            expect(readToken).eq(await xEmbr.stakingToken())
        })
    })

    context("notifying new reward amount", () => {
        context("from someone other than the distributor", () => {
            before(async () => {
                xEmbr = await redeployRewards()
                await redeployRewardTokens(xEmbr)
            })
            it("should fail", async () => {
                await expect(xEmbr.connect(alice).notifyRewardAmount(0, 1)).to.be.revertedWith(
                    "Caller is not reward distributor",
                )
                await expect(xEmbr.connect(bob).notifyRewardAmount(0, 1)).to.be.revertedWith(
                    "Caller is not reward distributor",
                )
                await expect(xEmbr.connect(carol).notifyRewardAmount(0, 1)).to.be.revertedWith(
                    "Caller is not reward distributor",
                )
            })
        })
        context("before current period finish", async () => {
            const funding1 = simpleToExactAmount(100, DEFAULT_DECIMALS)
            const funding2 = simpleToExactAmount(200, DEFAULT_DECIMALS)
            beforeEach(async () => {
                xEmbr = await redeployRewards()
                await redeployRewardTokens(xEmbr)
            })
            it("should factor in unspent units to the new rewardRate", async () => {
                // Do the initial funding
                for (let i =0; i < rewardTokens.length -1; i++) {
                    await rewardTokens[i].connect(owner).transfer(xEmbr.address, funding1)
                }
                await expectSuccesfulFunding(funding1)

                let actualRewardRate: Array<BN> = []

                for (let i =0; i < rewardTokens.length -1; i++) {
                    const rewardRate = await xEmbr.rewardRate(i)
                    const expectedRewardRate = funding1.div(ONE_WEEK)
                    expect(expectedRewardRate).eq(rewardRate)
                    actualRewardRate.push(rewardRate)
                }

                // Zoom forward half a week
                await increaseTime(ONE_WEEK.div(2))

                // Do the second funding, and factor in the unspent units
                const expectedLeftoverReward = funding1.div(2)
                for (let i =0; i < rewardTokens.length -1; i++) {
                    await rewardTokens[i].connect(owner).transfer(xEmbr.address, funding2)
                }
                await expectSuccesfulFunding(funding2)

                for (let i =0; i < rewardTokens.length -1; i++) {
                    const actualRewardRateAfter = await xEmbr.rewardRate(i)
                    const totalRewardsForWeek = funding2.add(expectedLeftoverReward)
                    const expectedRewardRateAfter = totalRewardsForWeek.div(ONE_WEEK)
                    assertBNClose(actualRewardRateAfter, expectedRewardRateAfter, actualRewardRate[i].div(ONE_WEEK).mul(20))
                }
            })
            it("should factor in unspent units to the new rewardRate if instant", async () => {
                // Do the initial funding
                for (let i =0; i < rewardTokens.length -1; i++) {
                    await rewardTokens[i].connect(owner).transfer(xEmbr.address, funding1)
                }
                await expectSuccesfulFunding(funding1)

                let actualRewardRate: Array<BN> = []

                for (let i =0; i < rewardTokens.length -1; i++) {
                    const rewardRate = await xEmbr.rewardRate(i)
                    const expectedRewardRate = funding1.div(ONE_WEEK)
                    expect(expectedRewardRate).eq(rewardRate)
                    actualRewardRate.push(rewardRate)
                }

                // Zoom forward half a week
                await increaseTime(1)

                // Do the second funding, and factor in the unspent units
                for (let i =0; i < rewardTokens.length -1; i++) {
                    await rewardTokens[i].connect(owner).transfer(xEmbr.address, funding2)
                }
                await expectSuccesfulFunding(funding2)
                for (let i =0; i < rewardTokens.length -1; i++) {

                    const actualRewardRateAfter = await xEmbr.rewardRate(i)
                    const expectedRewardRateAfter = funding1.add(funding2).div(ONE_WEEK)
                    assertBNClose(actualRewardRateAfter, expectedRewardRateAfter, actualRewardRate[i].div(ONE_WEEK).mul(20))
                }
            })
        })

        context("after current period finish", () => {
            const funding1 = simpleToExactAmount(100, DEFAULT_DECIMALS)
            before(async () => {
                xEmbr = await redeployRewards()
                await redeployRewardTokens(xEmbr)
            })
            it("should start a new period with the correct rewardRate", async () => {
                // Do the initial funding
                for (let i =0; i < rewardTokens.length -1; i++) {
                    await rewardTokens[i].connect(owner).transfer(xEmbr.address, funding1)
                }
                await expectSuccesfulFunding(funding1)
                let actualRewardRate: Array<BN> = []
                let expectedRewardRate: Array<BN> = []
                for (let i =0; i < rewardTokens.length -1; i++) {
                    const rewardRate = await xEmbr.rewardRate(i)
                    const eRewardRate = funding1.div(ONE_WEEK)
                    expect(eRewardRate).eq(rewardRate)
                    expectedRewardRate.push(eRewardRate)
                    actualRewardRate.push(rewardRate)
                }

                // Zoom forward half a week
                await increaseTime(ONE_WEEK.add(1))

                // Do the second funding, and factor in the unspent units
                for (let i =0; i < rewardTokens.length -1; i++) {
                    await rewardTokens[i].connect(owner).transfer(xEmbr.address, funding1.mul(2))
                }
                await expectSuccesfulFunding(funding1.mul(2))
                for (let i =0; i < rewardTokens.length -1; i++) {

                    const actualRewardRateAfter = await xEmbr.rewardRate(i)
                    const expectedRewardRateAfter = expectedRewardRate[i].mul(2)
                    expect(actualRewardRateAfter).eq(expectedRewardRateAfter)
                }
            })
        })
    })

    context("withdrawing stake or rewards", () => {
        context("withdrawing a stake amount", () => {
            const fundAmount = simpleToExactAmount(100, 21)
            const stakeAmount = simpleToExactAmount(100, DEFAULT_DECIMALS)

            before(async () => {
                xEmbr = await redeployRewards()
                await redeployRewardTokens(xEmbr)

                await stakingToken.connect(owner).mint(owner.address, stakeAmount)
                await expectSuccessfulStake(LockAction.CREATE_LOCK, stakeAmount)

                await increaseTime(ONE_WEEK.div(3).mul(2))

                for (let i =0; i < rewardTokens.length -1; i++) {
                    await rewardTokens[i].connect(owner).transfer(xEmbr.address, fundAmount)
                }
                await expectSuccesfulFunding(fundAmount)
                await increaseTime(ONE_WEEK.div(3).mul(2))
            })
            it("should revert for a non-staker", async () => {
                await expect(xEmbr.connect(owner).withdraw()).to.be.revertedWith("Must have something to withdraw")
            })
            it("should withdraw the stake and update the existing reward accrual", async () => {
                // Check that the user has earned something

                let earnedBefore: Array<BN> = []
                let rewardsBefore: Array<BN> = []
                for (let i =0; i < rewardTokens.length -1; i++) {
                    const eb = await xEmbr.earned(i, owner.address)
                    expect(eb).gt(BN.from(0))
                    const rb = await xEmbr.rewards(i, owner.address)
                    expect(rb).eq(BN.from(0))
                    earnedBefore.push(eb)
                    rewardsBefore.push(rb)
                }

                // Execute the withdrawal
                await expectStakingWithdrawal()

                let earnedAfter: Array<BN> = []
                let rewardsAfter: Array<BN> = []
                for (let i =0; i < rewardTokens.length -1; i++) {
                    // Ensure that the new awards are added + assigned to user
                    const ea = await xEmbr.earned(i, owner.address)
                    expect(ea).gte(earnedBefore[i])
                    const ra = await xEmbr.rewards(i, owner.address)
                    expect(ra).eq(earnedAfter[i])
                    earnedAfter.push(ea)
                    rewardsAfter.push(ra)
                }

                // Zoom forward now
                await increaseTime(10)

                for (let i =0; i < rewardTokens.length -1; i++) {
                    // Check that the user does not earn anything else
                    const earnedEnd = await xEmbr.earned(i, owner.address)
                    expect(earnedEnd).eq(earnedAfter[i])
                    const rewardsEnd = await xEmbr.rewards(i, owner.address)
                    expect(rewardsEnd).eq(rewardsAfter[i])
                }

                // Cannot withdraw anything else
                await expect(xEmbr.connect(owner).withdraw()).to.be.revertedWith("Must have something to withdraw")
            })
        })
        context("claiming rewards", async () => {
            const fundAmount = simpleToExactAmount(100, 21)
            const stakeAmount = simpleToExactAmount(100, DEFAULT_DECIMALS)

            before(async () => {
                xEmbr = await redeployRewards()
                await redeployRewardTokens(xEmbr)   
                
                for (let i =0; i < rewardTokens.length -1; i++) {
                    await rewardTokens[i].connect(owner).transfer(xEmbr.address, fundAmount)
                }
                await expectSuccesfulFunding(fundAmount)
                await stakingToken.connect(owner).mint(alice.address, stakeAmount)
                await expectSuccessfulStake(LockAction.CREATE_LOCK, stakeAmount, alice)
                await increaseTime(ONE_WEEK.add(1))
            })
            it("should do nothing for a non-staker", async () => {
                const beforeData = await snapshotStakingData(bob)
                for (let i =0; i < rewardTokens.length -1; i++) {
                    await xEmbr.connect(bob).claimReward(i)
                }

                const afterData = await snapshotStakingData(bob)
                expect(afterData.senderStakingTokenBalance).eq(BN.from(0))
                for (let i =0; i < rewardTokens.length -1; i++) { 
                    expect(beforeData.beneficiaryRewardsEarned[i].amount).eq(BN.from(0))
                    expect(afterData.beneficiaryRewardsEarned[i].amount).eq(BN.from(0))
                    expect(afterData.userRewardPerTokenPaid[i].amount).eq(afterData.rewardPerTokenStored)
                }
            })
            it("should send all accrued rewards to the rewardee", async () => {
                const beforeData = await snapshotStakingData(alice)

                for (let i =0; i < rewardTokens.length -1; i++) { 
                    const tx = await xEmbr.connect(alice).claimReward(i)
                    await expect(tx).to.emit(xEmbr, "RewardPaid").withArgs(alice.address, beforeData.beneficiaryRewardsUnClaimed)
                }
                const afterData = await snapshotStakingData(alice)
                for (let i =0; i < rewardTokens.length -1; i++) { 
                    await assertRewardsAssigned(beforeData, afterData, i, false, true)
                }
                // Balance transferred to the rewardee
                const rewardeeBalanceAfter = await stakingToken.balanceOf(alice.address)
                assertBNClose(rewardeeBalanceAfter, fundAmount, simpleToExactAmount(1, 16))

                // 'rewards' reset to 0
                expect(afterData.beneficiaryRewardsEarned).eq(BN.from(0), "i1")
                // Paid up until the last block
                expect(afterData.userRewardPerTokenPaid).eq(afterData.rewardPerTokenStored, "i2")
                // Token balances dont change
                for (let i =0; i < rewardTokens.length -1; i++) { 
                    expect(afterData.senderStakingTokenBalance).eq(
                        beforeData.senderStakingTokenBalance.add(await xEmbr.rewardsPaid(i, alice.address)),
                        "i3",
                    )
                }
                expect(beforeData.userStaticWeight).eq(afterData.userStaticWeight, "i4")
            })
        })
        context("completely 'exiting' the system", () => {
            const fundAmount = simpleToExactAmount(100, 21)
            const stakeAmount = simpleToExactAmount(100, DEFAULT_DECIMALS)

            before(async () => {
                xEmbr = await redeployRewards()
                await redeployRewardTokens(xEmbr)

                for (let i =0; i < rewardTokens.length -1; i++) {
                    await rewardTokens[i].connect(owner).transfer(xEmbr.address, fundAmount)
                }
                await expectSuccesfulFunding(fundAmount)
                
                await stakingToken.connect(owner).mint(owner.address, stakeAmount)
                await expectSuccessfulStake(LockAction.CREATE_LOCK, stakeAmount)
                await increaseTime(ONE_WEEK.add(1))
            })
            it("should fail if the sender has no stake", async () => {
                await expect(xEmbr.connect(ryan).exit()).to.be.revertedWith("Must have something to withdraw")
            })
            it("should withdraw all senders stake and send outstanding rewards to the staker", async () => {
                const beforeData = await snapshotStakingData()
                const rewardeeBalanceBefore = await stakingToken.balanceOf(owner.address)
                const tx = xEmbr.exit()
                const receipt = await (await tx).wait()

                await expectWithdrawEvent(xEmbr, tx, receipt, { provider: owner.address, value: stakeAmount })
                await expect(tx)
                    .to.emit(xEmbr, EVENTS.REWARD_PAID)
                    .withArgs(owner.address, beforeData.beneficiaryRewardsUnClaimed)

                const afterData = await snapshotStakingData()
                // Balance transferred to the rewardee
                const rewardeeBalanceAfter = await stakingToken.balanceOf(owner.address)
                assertBNClose(rewardeeBalanceAfter.sub(rewardeeBalanceBefore), fundAmount.add(stakeAmount), simpleToExactAmount(1, 16))

                // Expect Rewards to accrue to the beneficiary
                //    StakingToken balance of sender
                for (let i =0; i < rewardTokens.length -1; i++) { 
                    await assertRewardsAssigned(beforeData, afterData, i, false, true)
                }

                // Expect token transfer
                //    StakingToken balance of sender
                for (let i =0; i < rewardTokens.length -1; i++) { 
                    expect(beforeData.senderStakingTokenBalance.add(stakeAmount).add(await xEmbr.rewardsPaid(i, owner.address))).eq(
                        afterData.senderStakingTokenBalance,
                    )
                }

                //    Withdraws from the actual rewards wrapper token
                expect(afterData.userStaticWeight).eq(BN.from(0))

                //    Updates total supply
                expect(beforeData.totalStaticWeight.sub(beforeData.userStaticWeight)).eq(afterData.totalStaticWeight)

                await expect(xEmbr.exit()).to.be.revertedWith("Must have something to withdraw")
            })
        })
    })
    context("running a full integration test", () => {
        const fundAmount = simpleToExactAmount(100, 21)
        const stakeAmount = simpleToExactAmount(100, DEFAULT_DECIMALS)

        before(async () => {
            xEmbr = await redeployRewards()
            await redeployRewardTokens(xEmbr)
        })
        it("1. should allow the rewardsDistributor to fund the pool", async () => {
            for (let i =0; i < rewardTokens.length -1; i++) {
                await rewardTokens[i].connect(owner).transfer(xEmbr.address, fundAmount)
            }
            await expectSuccesfulFunding(fundAmount)
        })
        it("2. should allow stakers to stake and earn rewards", async () => {
            await stakingToken.connect(owner).mint(owner.address, stakeAmount)
            await expectSuccessfulStake(LockAction.CREATE_LOCK, stakeAmount)
            await increaseTime(ONE_WEEK.add(1))
        })
        it("3. should credit earnings directly to beneficiary", async () => {
            const beforeData = await snapshotStakingData()
            const beneficiaryBalanceBefore = await stakingToken.balanceOf(owner.address)

            await xEmbr.exit()

            const afterData = await snapshotStakingData()
            // Balance transferred to the rewardee
            const beneficiaryBalanceAfter = await stakingToken.balanceOf(owner.address)
            assertBNClose(beneficiaryBalanceAfter.sub(beneficiaryBalanceBefore), fundAmount.add(stakeAmount), simpleToExactAmount(1, 16))
            
            for (let i =0; i < rewardTokens.length -1; i++) { 
                await assertRewardsAssigned(beforeData, afterData, i, false, true)
            }
        })
    })*/
})