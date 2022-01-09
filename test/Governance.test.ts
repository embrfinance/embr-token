import { ethers } from "hardhat"
import { expect } from "chai"
import {  bn, deployContract, deployERC20Mock } from "./utilities"
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"
import { getTimestamp, increaseTimeTo } from "./mstableutils/time"
import { ContractTransaction, Event, ContractReceipt } from "ethers"
import { assertBNClose } from "./mstableutils/assertions"
import { BN, simpleToExactAmount, sqrt } from "./mstableutils/math"
import { ONE_WEEK, ONE_DAY, ONE_YEAR, fullScale, DEFAULT_DECIMALS } from "./mstableutils/constants"
import {
    XEmbr,
    XEmbr__factory,
    Governance__factory,
    ERC20Mock,
    Governance,
    EmbrToken
} from "../types"

const EVENTS = { DEPOSIT: "Staked", WITHDRAW: "Withdraw", REWARD_PAID: "RewardPaid" }

const oneWeekInAdvance = async (): Promise<BN> => {
    const now = await getTimestamp()
    return now.add(ONE_WEEK)
}

const oneYearInAdvance = async (): Promise<BN> => {
    const now = await getTimestamp()
    return now.add(ONE_YEAR)
}

const isContractEvent = (address: string, eventName: string) => (event: Event) => event.address === address && event.event === eventName

const findContractEvent = (receipt: ContractReceipt, address: string, eventName: string) =>
    receipt.events?.find(isContractEvent(address, eventName))

describe("Governance", () => {
    let xEMBR: XEmbr;
    let owner: SignerWithAddress
    let stakingToken: EmbrToken
    let governance: Governance;
            
    let governanceABI = [{"type":"constructor","stateMutability":"nonpayable","inputs":[{"type":"address","name":"_xEMBR","internalType":"address"}]},{"type":"event","name":"ExecutionDelayChanged","inputs":[{"type":"uint256","name":"newExecutionDelay","internalType":"uint256","indexed":false}],"anonymous":false},{"type":"event","name":"MinimumVotingPeriodChanged","inputs":[{"type":"uint256","name":"newMinimumVotingPeriod","internalType":"uint256","indexed":false}],"anonymous":false},{"type":"event","name":"NewVote","inputs":[{"type":"uint256","name":"proposalId","internalType":"uint256","indexed":false},{"type":"address","name":"voter","internalType":"address","indexed":false},{"type":"bool","name":"support","internalType":"bool","indexed":false},{"type":"uint256","name":"votes","internalType":"uint256","indexed":false}],"anonymous":false},{"type":"event","name":"ProposalCreated","inputs":[{"type":"uint256","name":"proposalId","internalType":"uint256","indexed":false},{"type":"address","name":"proposer","internalType":"address","indexed":false},{"type":"string","name":"title","internalType":"string","indexed":false}],"anonymous":false},{"type":"event","name":"ProposalExecuted","inputs":[{"type":"uint256","name":"proposalId","internalType":"uint256","indexed":false},{"type":"address","name":"executor","internalType":"address","indexed":false}],"anonymous":false},{"type":"event","name":"ProposalThresholdChanged","inputs":[{"type":"uint256","name":"newProposalThreshold","internalType":"uint256","indexed":false}],"anonymous":false},{"type":"event","name":"QuorumVotesChanges","inputs":[{"type":"uint256","name":"newQuorumVotes","internalType":"uint256","indexed":false}],"anonymous":false},{"type":"function","stateMutability":"view","outputs":[{"type":"uint256","name":"","internalType":"uint256"}],"name":"EXECUTION_DELAY_MAXIMUM","inputs":[]},{"type":"function","stateMutability":"view","outputs":[{"type":"uint256","name":"","internalType":"uint256"}],"name":"EXECUTION_DELAY_MINIMUM","inputs":[]},{"type":"function","stateMutability":"view","outputs":[{"type":"uint256","name":"","internalType":"uint256"}],"name":"EXPIRATION_PERIOD","inputs":[]},{"type":"function","stateMutability":"view","outputs":[{"type":"uint256","name":"","internalType":"uint256"}],"name":"MAXIMUM_VOTING_PERIOD","inputs":[]},{"type":"function","stateMutability":"view","outputs":[{"type":"uint256","name":"","internalType":"uint256"}],"name":"MINIMUM_VOTING_PERIOD_MAXIMUM","inputs":[]},{"type":"function","stateMutability":"view","outputs":[{"type":"uint256","name":"","internalType":"uint256"}],"name":"MINIMUM_VOTING_PERIOD_MINIMUM","inputs":[]},{"type":"function","stateMutability":"view","outputs":[{"type":"uint256","name":"","internalType":"uint256"}],"name":"PROPOSAL_THRESHOLD_MAXIMUM","inputs":[]},{"type":"function","stateMutability":"view","outputs":[{"type":"uint256","name":"","internalType":"uint256"}],"name":"PROPOSAL_THRESHOLD_MINIMUM","inputs":[]},{"type":"function","stateMutability":"view","outputs":[{"type":"uint256","name":"","internalType":"uint256"}],"name":"QUORUM_VOTES_MAXIMUM","inputs":[]},{"type":"function","stateMutability":"view","outputs":[{"type":"uint256","name":"","internalType":"uint256"}],"name":"QUORUM_VOTES_MINIMUM","inputs":[]},{"type":"function","stateMutability":"payable","outputs":[{"type":"bytes","name":"","internalType":"bytes"}],"name":"execute","inputs":[{"type":"uint256","name":"_proposalId","internalType":"uint256"}]},{"type":"function","stateMutability":"view","outputs":[{"type":"uint256","name":"","internalType":"uint256"}],"name":"executionDelay","inputs":[]},{"type":"function","stateMutability":"view","outputs":[{"type":"tuple","name":"","internalType":"struct Governance.Receipt","components":[{"type":"bool","name":"hasVoted","internalType":"bool"},{"type":"bool","name":"support","internalType":"bool"},{"type":"uint256","name":"votes","internalType":"uint256"}]}],"name":"getReceipt","inputs":[{"type":"uint256","name":"_proposalId","internalType":"uint256"},{"type":"address","name":"_voter","internalType":"address"}]},{"type":"function","stateMutability":"view","outputs":[{"type":"uint256","name":"","internalType":"uint256"}],"name":"minimumVotingPeriod","inputs":[]},{"type":"function","stateMutability":"view","outputs":[{"type":"uint256","name":"","internalType":"uint256"}],"name":"proposalCount","inputs":[]},{"type":"function","stateMutability":"view","outputs":[{"type":"uint256","name":"","internalType":"uint256"}],"name":"proposalThreshold","inputs":[]},{"type":"function","stateMutability":"view","outputs":[{"type":"uint256","name":"id","internalType":"uint256"},{"type":"string","name":"title","internalType":"string"},{"type":"string","name":"metadata","internalType":"string"},{"type":"address","name":"proposer","internalType":"address"},{"type":"address","name":"executor","internalType":"address"},{"type":"uint256","name":"startTime","internalType":"uint256"},{"type":"uint256","name":"votingPeriod","internalType":"uint256"},{"type":"uint256","name":"forVotes","internalType":"uint256"},{"type":"uint256","name":"againstVotes","internalType":"uint256"},{"type":"address","name":"target","internalType":"address"},{"type":"uint256","name":"value","internalType":"uint256"},{"type":"bytes","name":"data","internalType":"bytes"}],"name":"proposals","inputs":[{"type":"uint256","name":"","internalType":"uint256"}]},{"type":"function","stateMutability":"nonpayable","outputs":[],"name":"propose","inputs":[{"type":"string","name":"_title","internalType":"string"},{"type":"string","name":"_metadata","internalType":"string"},{"type":"uint256","name":"_votingPeriod","internalType":"uint256"},{"type":"address","name":"_target","internalType":"address"},{"type":"uint256","name":"_value","internalType":"uint256"},{"type":"bytes","name":"_data","internalType":"bytes"}]},{"type":"function","stateMutability":"view","outputs":[{"type":"uint256","name":"","internalType":"uint256"}],"name":"quorumVotes","inputs":[]},{"type":"function","stateMutability":"view","outputs":[{"type":"bool","name":"hasVoted","internalType":"bool"},{"type":"bool","name":"support","internalType":"bool"},{"type":"uint256","name":"votes","internalType":"uint256"}],"name":"receipts","inputs":[{"type":"uint256","name":"","internalType":"uint256"},{"type":"address","name":"","internalType":"address"}]},{"type":"function","stateMutability":"nonpayable","outputs":[],"name":"setExecutionDelay","inputs":[{"type":"uint256","name":"_seconds","internalType":"uint256"}]},{"type":"function","stateMutability":"nonpayable","outputs":[],"name":"setMinimumVotingPeriod","inputs":[{"type":"uint256","name":"_seconds","internalType":"uint256"}]},{"type":"function","stateMutability":"nonpayable","outputs":[],"name":"setProposalThreshold","inputs":[{"type":"uint256","name":"_votes","internalType":"uint256"}]},{"type":"function","stateMutability":"nonpayable","outputs":[],"name":"setQuorumVotes","inputs":[{"type":"uint256","name":"_votes","internalType":"uint256"}]},{"type":"function","stateMutability":"view","outputs":[{"type":"uint8","name":"","internalType":"enum Governance.ProposalState"}],"name":"state","inputs":[{"type":"uint256","name":"proposalId","internalType":"uint256"}]},{"type":"function","stateMutability":"nonpayable","outputs":[],"name":"vote","inputs":[{"type":"uint256","name":"_proposalId","internalType":"uint256"},{"type":"bool","name":"_support","internalType":"bool"}]},{"type":"function","stateMutability":"view","outputs":[{"type":"address","name":"","internalType":"contract IxEMBR"}],"name":"xEMBR","inputs":[]}];
    let validProposal: ValidPurposal;
    let rewardTokens: Array<ERC20Mock> = []

    before("Init contract", async () => {
        const signers = await ethers.getSigners()
        owner = signers[0]
    })


    const redeployGovernance = async (): Promise<Governance> => {
        stakingToken = await deployContract("EmbrToken", [])

        // Deploy sample xEMBR
        xEMBR = await new XEmbr__factory(owner).deploy(
            stakingToken.address,
            "xEMBR",
            "xEMBR"
        )

        const rewardUnits = simpleToExactAmount(100, DEFAULT_DECIMALS)
        rewardTokens = []
        for(let i =0; i< 10; i++) {
            const rt = await deployERC20Mock("TK"+i, "TK"+i, bn(10000000000000))
            await xEMBR.add(rt.address)
            rewardTokens.push(rt)
            await rewardTokens[i].connect(owner).transfer(xEMBR.address, rewardUnits)
        }
        await expectSuccesfulFunding(rewardUnits)

        // add 10m so we have enough weigh to add a purposal
        const stakeAmount = simpleToExactAmount(1000000, DEFAULT_DECIMALS)
        await stakingToken.connect(owner).mint(owner.address, stakeAmount)
        await expectSuccessfulStake(LockAction.CREATE_LOCK, stakeAmount)

        return new Governance__factory(owner).deploy(
            xEMBR.address
        )
    }

    const getValidPurposal = async(): Promise<ValidPurposal> => { 
        const vPrd = await governance.minimumVotingPeriod()
        return {      
            title: "Sample Title",
            metadata: "/ipfs/metadata",
            votingPeriod: vPrd,
            target: ethers.constants.AddressZero,
            value: bn(0),
            data: ethers.constants.HashZero
        }
    }


    interface ValidPurposal {
        title: string
        metadata: string
        votingPeriod: BN
        target: string
        value: BN
        data: string
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
        lastUpdateTime: Reward[]
        lastTimeRewardApplicable: Reward[]
        periodFinishTime: Reward[]
    }

    enum LockAction {
        CREATE_LOCK,
        INCREASE_LOCK_AMOUNT,
        INCREASE_LOCK_TIME,
    }

    const snapshotStakingData = async (sender = owner): Promise<StakingData> => {
        const locked = await xEMBR.locked(sender.address)
        const lastPoint = await xEMBR.getLastUserPoint(sender.address)
        let userRewardPerTokenPaid = []
        let senderStakingTokenBalance = await stakingToken.balanceOf(sender.address)
        let contractStakingTokenBalance = await stakingToken.balanceOf(xEMBR.address)
        let beneficiaryRewardsEarned = []
        let beneficiaryRewardsUnClaimed = []
        let rewardPerTokenStored = []
        let rewardRate = []
        let lastUpdateTime = []
        let lastTimeRewardApplicable = []
        let periodFinishTime = []



        for (let i =0; i < rewardTokens.length; i++) {
            let urptp = await xEMBR.userRewardPerTokenPaid(i, sender.address)
            let bre = await xEMBR.rewards(i, sender.address)
            let bruc = await xEMBR.earned(i, sender.address)
            let rpts = await xEMBR.rewardPerTokenStored(i)
            let rr = await xEMBR.rewardRate(i)
            let lpt = await xEMBR.lastUpdateTime(i)
            let ltta = await xEMBR.lastTimeRewardApplicable(i)
            let pft = await xEMBR.periodFinish(i)
            lastUpdateTime.push({amount: lpt})
            lastTimeRewardApplicable.push({amount: ltta})
            periodFinishTime.push({amount: pft})
            userRewardPerTokenPaid.push({amount: urptp})
            beneficiaryRewardsEarned.push({amount: bre})
            beneficiaryRewardsUnClaimed.push({amount: bruc})
            rewardPerTokenStored.push({amount: rpts})
            rewardRate.push({amount: rr})
        }

        return {
            totalStaticWeight: await xEMBR.totalStaticWeight(),
            userStaticWeight: await xEMBR.staticBalanceOf(sender.address),
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
        const periodIsFinished = timeAfter.gt(beforeData.periodFinishTime[rewardTokenId].amount)
        const lastUpdateTokenTime =
            beforeData.rewardPerTokenStored[rewardTokenId].amount.eq(0) && beforeData.totalStaticWeight.eq(0) ? beforeData.lastUpdateTime[rewardTokenId].amount : timeAfter
        //    LastUpdateTime
        expect(periodIsFinished ? beforeData.periodFinishTime[rewardTokenId].amount : lastUpdateTokenTime).eq(afterData.lastUpdateTime[rewardTokenId].amount)

        //    RewardRate does not change
        expect(beforeData.rewardRate[rewardTokenId].amount).eq(afterData.rewardRate[rewardTokenId].amount)
        //    RewardPerTokenStored goes up
        expect(afterData.rewardPerTokenStored[rewardTokenId].amount).gte(beforeData.rewardPerTokenStored[rewardTokenId].amount)
       
        //      Calculate exact expected 'rewardPerToken' increase since last update
        const timeApplicableToRewards = periodIsFinished
            ? beforeData.periodFinishTime[rewardTokenId].amount.sub(beforeData.lastUpdateTime[rewardTokenId].amount)
            : timeAfter.sub(beforeData.lastUpdateTime[rewardTokenId].amount)
        const increaseInRewardPerToken = beforeData.totalStaticWeight.eq(BN.from(0))
            ? BN.from(0)
            : beforeData.rewardRate[rewardTokenId].amount.mul(timeApplicableToRewards).mul(fullScale).div(beforeData.totalStaticWeight)
       
       
        //console.log(beforeData.rewardPerTokenStored[rewardTokenId].amount.toString(), increaseInRewardPerToken.toString(), afterData.rewardPerTokenStored[rewardTokenId].amount.toString())
        expect(beforeData.rewardPerTokenStored[rewardTokenId].amount.add(increaseInRewardPerToken)).eq(afterData.rewardPerTokenStored[rewardTokenId].amount)

        // Expect updated personal state
        //    userRewardPerTokenPaid(beneficiary) should update
        expect(afterData.userRewardPerTokenPaid[rewardTokenId].amount).eq(afterData.rewardPerTokenStored[rewardTokenId].amount)

        //    If existing staker, then rewards Should increase
        if (shouldResetRewards) {
            expect(afterData.beneficiaryRewardsEarned[rewardTokenId].amount).eq(BN.from(0))
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

    /**
     * @dev Ensures a stake is successful, updates the rewards for the beneficiary and
     * collects the stake
     * @param lockAction The lock action to perform (CREATE_LOCK, INCREASE_LOCK_AMOUNT, INCREASE_LOCK_TIME)
     * @param stakeAmount Exact units to stake
     * @param sender Sender of the tx
     */
    const expectSuccessfulStake = async (lockAction: LockAction, stakeAmount: BN, sender = owner): Promise<void> => {
        // 1. Get data from the contract
        const beforeData = await snapshotStakingData(sender)

        const isExistingStaker = beforeData.userStaticWeight.gt(BN.from(0))
        // 2. Approve staking token spending and send the TX
        await stakingToken.connect(sender).approve(xEMBR.address, stakeAmount)

        let tx: Promise<ContractTransaction>
        let expectedLocktime: BN
        let expectedAmount = stakeAmount

        const floorToWeek = (t: number) => Math.trunc(Math.trunc(t / ONE_WEEK.toNumber()) * ONE_WEEK.toNumber())
        switch (lockAction) {
            case LockAction.CREATE_LOCK:
                tx = xEMBR.connect(sender).createLock(stakeAmount, await oneYearInAdvance())
                expectedLocktime = BN.from(floorToWeek((await oneYearInAdvance()).toNumber()))
                break
            case LockAction.INCREASE_LOCK_AMOUNT:
                expect(isExistingStaker).eq(true)
                tx = xEMBR.connect(sender).increaseLockAmount(stakeAmount)
                expectedLocktime = await getTimestamp()
                break
            default:
                // INCREASE_LOCK_TIME
                tx = xEMBR.connect(sender).increaseLockLength((await oneYearInAdvance()).add(ONE_WEEK))
                expectedLocktime = BN.from(floorToWeek((await oneYearInAdvance()).add(ONE_WEEK).toNumber()))
                expectedAmount = BN.from(0)
                break
        }

        const receipt = await (await tx).wait()
        await expect(tx).to.emit(xEMBR, EVENTS.DEPOSIT)
        const depositEvent = findContractEvent(receipt, xEMBR.address, EVENTS.DEPOSIT)
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
        //    StakingToken balance of xEMBR
        expect(shouldIncreaseTime ? beforeData.contractStakingTokenBalance : beforeData.contractStakingTokenBalance.add(stakeAmount)).eq(
            afterData.contractStakingTokenBalance,
        )
        //    totalStaticWeight of xEMBR
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

        const tx = await xEMBR.connect(owner).notifyRewardAmount(notify)
        await expect(tx).to.emit(xEMBR, "RewardsAdded").withArgs(notify)

        const cur = BN.from(await getTimestamp())
            
        const afterData = await snapshotStakingData()
        // Sets lastTimeRewardApplicable to latest
        for (let i =0; i < rewardTokens.length; i++) {
            expect(cur).eq(afterData.lastTimeRewardApplicable[i].amount)
            // Sets lastUpdateTime to latest
            expect(cur).eq(afterData.lastUpdateTime[i].amount)
            // Sets periodFinish to 1 week from now
            expect(cur.add(ONE_WEEK)).eq(afterData.periodFinishTime[i].amount)

            const leftOverRewards = beforeData.rewardRate[i].amount.mul(beforeData.periodFinishTime[i].amount.sub(beforeData.lastTimeRewardApplicable[i].amount))

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

    context('Initial Setup', async function() {
        before(async () => {
            governance = await redeployGovernance()
        })
        it("Should return the same xEMBR address used at contract creation", async function() {
            expect(await governance.xEMBR()).to.equal(xEMBR.address);
        });

        it("Should have no proposals at contract creation", async function() {
            expect(await governance.proposalCount()).to.equal(0);
        });
    })

    
    context('Proposing', async function() {
        beforeEach(async () => {
            governance = await redeployGovernance()
            validProposal = await getValidPurposal()
        })
        
        it("Cannot submit proposal with 0 xEMBR", async function() {
            const [owner, wallet1] = await ethers.getSigners();
            expect(await xEMBR.balanceOf(wallet1.address)).to.equal(0);

            await expect(governance.connect(wallet1).propose(
                validProposal.title, validProposal.metadata, validProposal.votingPeriod, validProposal.target, validProposal.value, validProposal.data
            )).to.be.revertedWith('Governance::propose: proposer votes below proposal threshold');
        });

        it("Cannot submit proposal with low voting period", async function() {
            const invalidProposal = { title:validProposal.title, metadata:validProposal.metadata, votingPeriod:validProposal.votingPeriod, target:validProposal.target, value:validProposal.value, data:validProposal.data };
            invalidProposal.votingPeriod = (await governance.minimumVotingPeriod()).sub(1);

            await expect(governance.propose(
                invalidProposal.title, invalidProposal.metadata, invalidProposal.votingPeriod, invalidProposal.target, invalidProposal.value, invalidProposal.data,
            )).to.be.revertedWith('Governance::propose: voting period too short');
        });

        it("Cannot submit proposal with high voting period", async function() {
            const invalidProposal = { title:validProposal.title, metadata:validProposal.metadata, votingPeriod:validProposal.votingPeriod, target:validProposal.target, value:validProposal.value, data:validProposal.data };
            invalidProposal.votingPeriod = (await governance.VOTING_PERIOD_MAXIMUM()).add(1);

            await expect(governance.propose(
                invalidProposal.title, invalidProposal.metadata, invalidProposal.votingPeriod, invalidProposal.target, invalidProposal.value, invalidProposal.data,
            )).to.be.revertedWith('Governance::propose: voting period too long');
        });

        it("Can submit proposal", async function() {
            await governance.propose(validProposal.title, validProposal.metadata, validProposal.votingPeriod, validProposal.target, validProposal.value, validProposal.data);

            const proposal1 = await governance.proposals(1);
            expect(proposal1.proposer).to.equal(owner.address);
            expect(proposal1.forVotes).to.equal(0);
            expect(proposal1.againstVotes).to.equal(0);
            expect(proposal1.executor).to.equal(ethers.constants.AddressZero);
            expect(proposal1.title).to.equal(validProposal.title);
            expect(proposal1.metadata).to.equal(validProposal.metadata);
            expect(proposal1.votingPeriod).to.equal(validProposal.votingPeriod);

            const proposalExecutionContext1 = await governance.proposalExecutionContexts(1);

            expect(proposalExecutionContext1.target).to.equal(validProposal.target);
            expect(proposalExecutionContext1.value).to.equal(validProposal.value);
            expect(proposalExecutionContext1.data).to.equal(validProposal.data);

            expect(await governance.proposalCount()).to.equal(1);
            expect(await governance.state(1)).to.equal(0); // Active
        });

        it("Cannot have two proposals when previous is active", async function() {
            await governance.propose(validProposal.title, validProposal.metadata, validProposal.votingPeriod, validProposal.target, validProposal.value, validProposal.data);

            expect(await governance.state(1)).to.equal(0); // Active

            await expect(governance.propose(
                validProposal.title, validProposal.metadata, validProposal.votingPeriod, validProposal.target, validProposal.value, validProposal.data,
            )).to.be.revertedWith('Governance::propose: proposer already has a proposal in progress');
        });

        it("Cannot have two proposals when previous is pending execution", async function() {
            await governance.propose(validProposal.title, validProposal.metadata, validProposal.votingPeriod, validProposal.target, validProposal.value, validProposal.data);
            await governance.vote(1, true);
            const proposal1 = await governance.proposals(1);

            const votingPeriodEnd = proposal1.startTime.add(proposal1.votingPeriod);

            await ethers.provider.send("evm_setNextBlockTimestamp", [votingPeriodEnd.add(1).toNumber()]);
            await ethers.provider.send("evm_mine", []);

            expect(await governance.state(1)).to.equal(2); // Pending Execution

            await expect(governance.propose(
                validProposal.title, validProposal.metadata, validProposal.votingPeriod, validProposal.target, validProposal.value, validProposal.data,
            )).to.be.revertedWith('Governance::propose: proposer already has a proposal in progress');
        });

        it("Cannot have two proposals when previous is ready for execution", async function() {
            await governance.propose(validProposal.title, validProposal.metadata, validProposal.votingPeriod, validProposal.target, validProposal.value, validProposal.data);
            await governance.vote(1, true);

            const proposal1 = await governance.proposals(1);
            const executionDelay = await governance.executionDelay();

            const executionPeriodStarts = proposal1.startTime.add(proposal1.votingPeriod).add(executionDelay);

            await ethers.provider.send("evm_setNextBlockTimestamp", [executionPeriodStarts.add(1).toNumber()]);
            await ethers.provider.send("evm_mine", []);

            expect(await governance.state(1)).to.equal(3); // Ready for execution

            console.log("b")
            await expect(governance.propose(
                validProposal.title, validProposal.metadata, validProposal.votingPeriod, validProposal.target, validProposal.value, validProposal.data,
            )).to.be.revertedWith('Governance::propose: proposer already has a proposal in progress');
        });
    });
    

    context('Voting', async function() {
        let xEMBR_balance: BN;

        beforeEach(async () => {
            governance = await redeployGovernance()
            validProposal = await getValidPurposal()

            await governance.propose(validProposal.title, validProposal.metadata, validProposal.votingPeriod, validProposal.target, validProposal.value, validProposal.data);
        })

        it("Can vote yes", async function() {
            await governance.vote(1, true);
            xEMBR_balance = await xEMBR.balanceOf(owner.address);
            expect((await governance.proposals(1)).forVotes).to.equal(xEMBR_balance);
            expect((await governance.proposals(1)).againstVotes).to.equal(0);
        });

        it("Can vote no", async function() {
            await governance.vote(1, false);
            expect((await governance.proposals(1)).forVotes).to.equal(0);
            xEMBR_balance = await xEMBR.balanceOf(owner.address);
            expect((await governance.proposals(1)).againstVotes).to.equal(xEMBR_balance);
        });

        it("Can vote yes and change to no", async function() {
            await governance.vote(1, true);

            xEMBR_balance = await xEMBR.balanceOf(owner.address);
            expect((await governance.proposals(1)).forVotes).to.equal(xEMBR_balance);
            expect((await governance.proposals(1)).againstVotes).to.equal(0);

            await governance.vote(1, false);

            expect((await governance.proposals(1)).forVotes).to.equal(0);
            xEMBR_balance = await xEMBR.balanceOf(owner.address);
            expect((await governance.proposals(1)).againstVotes).to.equal(xEMBR_balance);
            });

            it("Can vote no and change to yes", async function() {
            await governance.vote(1, false);

            expect((await governance.proposals(1)).forVotes).to.equal(0);
            xEMBR_balance = await xEMBR.balanceOf(owner.address);
            expect((await governance.proposals(1)).againstVotes).to.equal(xEMBR_balance);

            await governance.vote(1, true);

            xEMBR_balance = await xEMBR.balanceOf(owner.address);
            expect((await governance.proposals(1)).forVotes).to.equal(xEMBR_balance);
            expect((await governance.proposals(1)).againstVotes).to.equal(0);
        });

        it('Cannot vote yes after voting period ends', async function() {
            const proposal1 = await governance.proposals(1);
            const votingEndTime = proposal1.startTime.add(proposal1.votingPeriod);

            await ethers.provider.send("evm_setNextBlockTimestamp", [votingEndTime.add(1).toNumber()]);
            await ethers.provider.send("evm_mine", []);

            expect(await governance.state(1)).not.to.equal(0); // Not Active

            await expect(governance.vote(1, true)).to.be.revertedWith('Governance::vote: voting is closed');

            expect((await governance.proposals(1)).forVotes).to.equal(proposal1.forVotes);
            expect((await governance.proposals(1)).againstVotes).to.equal(proposal1.againstVotes);
        });

        it('Cannot vote no after voting period ends', async function() {
            const proposal1 = await governance.proposals(1);
            const votingEndTime = proposal1.startTime.add(proposal1.votingPeriod);

            await ethers.provider.send("evm_setNextBlockTimestamp", [votingEndTime.add(1).toNumber()]);
            await ethers.provider.send("evm_mine", []);

            expect(await governance.state(1)).not.to.equal(0); // Not Active

            await expect(governance.vote(1, false)).to.be.revertedWith('Governance::vote: voting is closed');

            expect((await governance.proposals(1)).forVotes).to.equal(proposal1.forVotes);
            expect((await governance.proposals(1)).againstVotes).to.equal(proposal1.againstVotes);
        });
    });
    
    context('Execution', async function() {
        let xEMBR_balance;

        beforeEach(async function () {
            governance = await redeployGovernance()
            validProposal = await getValidPurposal()

            await governance.propose(validProposal.title, validProposal.metadata, validProposal.votingPeriod, validProposal.target, validProposal.value, validProposal.data);   
        });

        it('Cannot execute a proposal with 0 votes', async function() {
            const proposal1 = await governance.proposals(1);
            const executionDelay = await governance.executionDelay();

            const executionTime = proposal1.startTime.add(proposal1.votingPeriod).add(executionDelay);

            await ethers.provider.send("evm_setNextBlockTimestamp", [executionTime.add(1).toNumber()]);
            await ethers.provider.send("evm_mine", []);

            expect((await governance.proposals(1)).forVotes).to.equal(0);
            expect((await governance.proposals(1)).againstVotes).to.equal(0);
            expect(await governance.state(1)).to.equal(1); // Defeated

            await expect(governance.execute(1)).to.be.revertedWith('Governance::execute: cannot be executed');

            expect((await governance.proposals(1)).executor).to.equal(ethers.constants.AddressZero);
            });

            it('Cannot execute a proposal proposal id of 0', async function() {
            await expect(governance.execute(0)).to.be.revertedWith('Governance::state: invalid proposal id');
        });

        it('Cannot execute a defeated proposal', async function() {
            const proposal1 = await governance.proposals(1);
            const executionDelay = await governance.executionDelay();

            const executionTime = proposal1.startTime.add(proposal1.votingPeriod).add(executionDelay);

            await governance.vote(1, false);

            await ethers.provider.send("evm_setNextBlockTimestamp", [executionTime.add(1).toNumber()]);
            await ethers.provider.send("evm_mine", []);

            expect(await governance.state(1)).to.equal(1); // Defeated

            await expect(governance.execute(1)).to.be.revertedWith('Governance::execute: cannot be executed');

            expect((await governance.proposals(1)).executor).to.equal(ethers.constants.AddressZero);
        });

        it('Cannot execute a proposal pending execution', async function() {
            const proposal1 = await governance.proposals(1);

            const votingPeriodEnd = proposal1.startTime.add(proposal1.votingPeriod);

            await governance.vote(1, true);

            await ethers.provider.send("evm_setNextBlockTimestamp", [votingPeriodEnd.add(1).toNumber()]);
            await ethers.provider.send("evm_mine", []);

            expect(await governance.state(1)).to.equal(2); // Pending Execution

            await expect(governance.execute(1)).to.be.revertedWith('Governance::execute: cannot be executed');

            expect((await governance.proposals(1)).executor).to.equal(ethers.constants.AddressZero);
        });

        it('Cannot execute an expired proposal', async function() {
            const proposal1 = await governance.proposals(1);
            const executionDelay = await governance.executionDelay();
            const expirationPeriod = await governance.EXPIRATION_PERIOD();

            const proposalExpired = proposal1.startTime.add(proposal1.votingPeriod).add(executionDelay).add(expirationPeriod);

            await governance.vote(1, true);

            await ethers.provider.send("evm_setNextBlockTimestamp", [proposalExpired.add(1).toNumber()]);
            await ethers.provider.send("evm_mine", []);

            expect(await governance.state(1)).to.equal(5); // Pending Execution

            await expect(governance.execute(1)).to.be.revertedWith('Governance::execute: cannot be executed');

            expect((await governance.proposals(1)).executor).to.equal(ethers.constants.AddressZero);
        });

        it('Can execute a proposal', async function() {
            const proposal1 = await governance.proposals(1);
            const executionDelay = await governance.executionDelay();

            const executionTime = proposal1.startTime.add(proposal1.votingPeriod).add(executionDelay);

            await governance.vote(1, true);

            await ethers.provider.send("evm_setNextBlockTimestamp", [executionTime.add(1).toNumber()]);
            await ethers.provider.send("evm_mine", []);

            expect(await governance.state(1)).to.equal(3); // Ready for Execution

            await governance.execute(1);

            expect(await governance.state(1)).to.equal(4); // Executed

            expect((await governance.proposals(1)).executor).to.equal(owner.address);
        });

        it('Cannot execute an already executed proposal', async function() {
            const proposal1 = await governance.proposals(1);
            const executionDelay = await governance.executionDelay();

            const executionTime = proposal1.startTime.add(proposal1.votingPeriod).add(executionDelay);

            await governance.vote(1, true);

            await ethers.provider.send("evm_setNextBlockTimestamp", [executionTime.add(1).toNumber()]);
            await ethers.provider.send("evm_mine", []);

            await governance.execute(1);

            expect(await governance.state(1)).to.equal(4); // Executed

            await expect(governance.execute(1)).to.be.revertedWith('Governance::execute: cannot be executed');
        });
    });

    
    context('Parameters', async function() {
        let govInterface: any;
        let executionDelay: BN;
        let parameterProposal: ValidPurposal;

        beforeEach(async function() {
            governance = await redeployGovernance()
            
            govInterface = new ethers.utils.Interface(governanceABI);
            executionDelay = await governance.executionDelay();
            parameterProposal = { title:validProposal.title, metadata:validProposal.metadata, votingPeriod:validProposal.votingPeriod, target:validProposal.target, value:validProposal.value, data:validProposal.data };
            parameterProposal.target = governance.address;
        });

        it("Cannot set minimum voting period as an end user", async function() {
            const validValue = (await governance.minimumVotingPeriod()).add(1);
            await expect(governance.setMinimumVotingPeriod(validValue))
                .to.be.revertedWith('Governance: insufficient privileges');
        });

        it("Cannot set minimum voting period too low", async function() {
            const threshold = await governance.VOTING_PERIOD_MINIMUM();
            const newValue = threshold.sub(1);

            parameterProposal.data = govInterface.encodeFunctionData('setMinimumVotingPeriod(uint256)', [newValue.toString()]);

            await governance.propose(parameterProposal.title, parameterProposal.metadata, parameterProposal.votingPeriod, parameterProposal.target, parameterProposal.value, parameterProposal.data);
            await governance.vote(1, true);

            const proposal1 = await governance.proposals(1);
            const executionTime = proposal1.startTime.add(proposal1.votingPeriod).add(executionDelay);
            await ethers.provider.send("evm_setNextBlockTimestamp", [executionTime.add(1).toNumber()]);
            await ethers.provider.send("evm_mine", []);

            await expect(governance.execute(1)).to.be.reverted;
        });

        it("Cannot set minimum voting period too high", async function() {
            const threshold = await governance.VOTING_PERIOD_MAXIMUM();
            const newValue = threshold.add(1);

            parameterProposal.data = govInterface.encodeFunctionData('setMinimumVotingPeriod(uint256)', [newValue.toString()]);

            await governance.propose(parameterProposal.title, parameterProposal.metadata, parameterProposal.votingPeriod, parameterProposal.target, parameterProposal.value, parameterProposal.data);
            await governance.vote(1, true);

            const proposal1 = await governance.proposals(1);
            const executionTime = proposal1.startTime.add(proposal1.votingPeriod).add(executionDelay);
            await ethers.provider.send("evm_setNextBlockTimestamp", [executionTime.add(1).toNumber()]);
            await ethers.provider.send("evm_mine", []);

            await expect(governance.execute(1)).to.be.reverted;
        });

        it("Can set minimum voting period", async function() {
            const threshold = await governance.minimumVotingPeriod();
            const newValue = threshold.add(1);

            parameterProposal.data = govInterface.encodeFunctionData('setMinimumVotingPeriod(uint256)', [newValue.toString()]);

            await governance.propose(parameterProposal.title, parameterProposal.metadata, parameterProposal.votingPeriod, parameterProposal.target, parameterProposal.value, parameterProposal.data);
            await governance.vote(1, true);

            const proposal1 = await governance.proposals(1);
            const executionTime = proposal1.startTime.add(proposal1.votingPeriod).add(executionDelay);
            await ethers.provider.send("evm_setNextBlockTimestamp", [executionTime.add(1).toNumber()]);
            await ethers.provider.send("evm_mine", []);

            await expect(governance.execute(1)).not.to.be.reverted;
            expect(await governance.minimumVotingPeriod()).to.equal(newValue);
        });

        it("Cannot set execution delay as an end user", async function() {
            const validValue = (await governance.EXECUTION_DELAY_MINIMUM()).add(1);
            await expect(governance.setExecutionDelay(validValue))
                .to.be.revertedWith('Governance: insufficient privileges');
        });

        it("Cannot set execution delay too low", async function() {
            const threshold = await governance.EXECUTION_DELAY_MINIMUM();
            const newValue = threshold.sub(1);

            parameterProposal.data = govInterface.encodeFunctionData('setExecutionDelay(uint256)', [newValue.toString()]);

            await governance.propose(parameterProposal.title, parameterProposal.metadata, parameterProposal.votingPeriod, parameterProposal.target, parameterProposal.value, parameterProposal.data);
            await governance.vote(1, true);

            const proposal1 = await governance.proposals(1);
            const executionTime = proposal1.startTime.add(proposal1.votingPeriod).add(executionDelay);
            await ethers.provider.send("evm_setNextBlockTimestamp", [executionTime.add(1).toNumber()]);
            await ethers.provider.send("evm_mine", []);

            await expect(governance.execute(1)).to.be.reverted;
        });

        it("Cannot set execution delay too high", async function() {
            const threshold = await governance.EXECUTION_DELAY_MAXIMUM();
            const newValue = threshold.add(1);

            parameterProposal.data = govInterface.encodeFunctionData('setExecutionDelay(uint256)', [newValue.toString()]);

            await governance.propose(parameterProposal.title, parameterProposal.metadata, parameterProposal.votingPeriod, parameterProposal.target, parameterProposal.value, parameterProposal.data);
            await governance.vote(1, true);

            const proposal1 = await governance.proposals(1);
            const executionTime = proposal1.startTime.add(proposal1.votingPeriod).add(executionDelay);
            await ethers.provider.send("evm_setNextBlockTimestamp", [executionTime.add(1).toNumber()]);
            await ethers.provider.send("evm_mine", []);

            await expect(governance.execute(1)).to.be.reverted;
        });

        it("Can set execution delay", async function() {
            const threshold = await governance.EXECUTION_DELAY_MINIMUM();
            const newValue = threshold.add(1);

            parameterProposal.data = govInterface.encodeFunctionData('setExecutionDelay(uint256)', [newValue.toString()]);

            await governance.propose(parameterProposal.title, parameterProposal.metadata, parameterProposal.votingPeriod, parameterProposal.target, parameterProposal.value, parameterProposal.data);
            await governance.vote(1, true);

            const proposal1 = await governance.proposals(1);
            const executionTime = proposal1.startTime.add(proposal1.votingPeriod).add(executionDelay);
            await ethers.provider.send("evm_setNextBlockTimestamp", [executionTime.add(1).toNumber()]);
            await ethers.provider.send("evm_mine", []);

            await expect(governance.execute(1)).not.to.be.reverted;
            expect(await governance.executionDelay()).to.equal(newValue);
            });

            it("Cannot set quorum votes as an end user", async function() {
            const validValue = (await governance.QUORUM_VOTES_MINIMUM()).add(1);
            await expect(governance.setQuorumVotes(validValue))
                .to.be.revertedWith('Governance: insufficient privileges');
            });

            it("Cannot set quorum votes too low", async function() {
            const threshold = await governance.QUORUM_VOTES_MINIMUM();
            const newValue = threshold.sub(1);

            parameterProposal.data = govInterface.encodeFunctionData('setQuorumVotes(uint256)', [newValue.toString()]);

            await governance.propose(parameterProposal.title, parameterProposal.metadata, parameterProposal.votingPeriod, parameterProposal.target, parameterProposal.value, parameterProposal.data);
            await governance.vote(1, true);

            const proposal1 = await governance.proposals(1);
            const executionTime = proposal1.startTime.add(proposal1.votingPeriod).add(executionDelay);
            await ethers.provider.send("evm_setNextBlockTimestamp", [executionTime.add(1).toNumber()]);
            await ethers.provider.send("evm_mine", []);

            await expect(governance.execute(1)).to.be.reverted;
        });

        it("Cannot set quorum votes too high", async function() {
            const threshold = await governance.QUORUM_VOTES_MAXIMUM();
            const newValue = threshold.add(1);

            parameterProposal.data = govInterface.encodeFunctionData('setQuorumVotes(uint256)', [newValue.toString()]);

            await governance.propose(parameterProposal.title, parameterProposal.metadata, parameterProposal.votingPeriod, parameterProposal.target, parameterProposal.value, parameterProposal.data);
            await governance.vote(1, true);

            const proposal1 = await governance.proposals(1);
            const executionTime = proposal1.startTime.add(proposal1.votingPeriod).add(executionDelay);
            await ethers.provider.send("evm_setNextBlockTimestamp", [executionTime.add(1).toNumber()]);
            await ethers.provider.send("evm_mine", []);

            await expect(governance.execute(1)).to.be.reverted;
        });

        it("Can set quorum votes", async function() {
            const threshold = await governance.quorumVotes();
            const newValue = threshold.add(1);

            parameterProposal.data = govInterface.encodeFunctionData('setQuorumVotes(uint256)', [newValue.toString()]);

            await governance.propose(parameterProposal.title, parameterProposal.metadata, parameterProposal.votingPeriod, parameterProposal.target, parameterProposal.value, parameterProposal.data);
            await governance.vote(1, true);

            const proposal1 = await governance.proposals(1);
            const executionTime = proposal1.startTime.add(proposal1.votingPeriod).add(executionDelay);
            await ethers.provider.send("evm_setNextBlockTimestamp", [executionTime.add(1).toNumber()]);
            await ethers.provider.send("evm_mine", []);

            await expect(governance.execute(1)).not.to.be.reverted;
            expect(await governance.quorumVotes()).to.equal(newValue);
        });

        it("Cannot set proposal threshold as an end user", async function() {
            const validValue = (await governance.PROPOSAL_THRESHOLD_MINIMUM()).add(1);
            await expect(governance.setProposalThreshold(validValue))
                .to.be.revertedWith('Governance: insufficient privileges');
        });

        it("Cannot set proposal threshold too low", async function() {
            const threshold = await governance.PROPOSAL_THRESHOLD_MINIMUM();
            const newValue = threshold.sub(1);

            parameterProposal.data = govInterface.encodeFunctionData('setProposalThreshold(uint256)', [newValue.toString()]);

            await governance.propose(parameterProposal.title, parameterProposal.metadata, parameterProposal.votingPeriod, parameterProposal.target, parameterProposal.value, parameterProposal.data);
            await governance.vote(1, true);

            const proposal1 = await governance.proposals(1);
            const executionTime = proposal1.startTime.add(proposal1.votingPeriod).add(executionDelay);
            await ethers.provider.send("evm_setNextBlockTimestamp", [executionTime.add(1).toNumber()]);
            await ethers.provider.send("evm_mine", []);

            await expect(governance.execute(1)).to.be.reverted;
        });

        it("Cannot set proposal threshold too high", async function() {
            const threshold = await governance.PROPOSAL_THRESHOLD_MAXIMUM();
            const newValue = threshold.add(1);

            parameterProposal.data = govInterface.encodeFunctionData('setProposalThreshold(uint256)', [newValue.toString()]);

            await governance.propose(parameterProposal.title, parameterProposal.metadata, parameterProposal.votingPeriod, parameterProposal.target, parameterProposal.value, parameterProposal.data);
            await governance.vote(1, true);

            const proposal1 = await governance.proposals(1);
            const executionTime = proposal1.startTime.add(proposal1.votingPeriod).add(executionDelay);
            await ethers.provider.send("evm_setNextBlockTimestamp", [executionTime.add(1).toNumber()]);
            await ethers.provider.send("evm_mine", []);

            await expect(governance.execute(1)).to.be.reverted;
        });

        it("Can set proposal threshold", async function() {
            const threshold = await governance.proposalThreshold();
            const newValue = threshold.add(1);

            parameterProposal.data = govInterface.encodeFunctionData('setProposalThreshold(uint256)', [newValue.toString()]);

            await governance.propose(parameterProposal.title, parameterProposal.metadata, parameterProposal.votingPeriod, parameterProposal.target, parameterProposal.value, parameterProposal.data);
            await governance.vote(1, true);

            const proposal1 = await governance.proposals(1);
            const executionTime = proposal1.startTime.add(proposal1.votingPeriod).add(executionDelay);
            await ethers.provider.send("evm_setNextBlockTimestamp", [executionTime.add(1).toNumber()]);
            await ethers.provider.send("evm_mine", []);

            await expect(governance.execute(1)).not.to.be.reverted;
            expect(await governance.proposalThreshold()).to.equal(newValue);
        })

    })
    
})