// SPDX-License-Identifier: MIT
pragma solidity 0.8.7;


import "../interfaces/IxEMBR.sol";
import "@openzeppelin/contracts/utils/Address.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";

contract Governance is ReentrancyGuard {

    /// @notice Lower bound for the voting period
    uint256 public minimumVotingPeriod = 3 days;
    uint256 public constant VOTING_PERIOD_MINIMUM = 1 days;
    uint256 public constant VOTING_PERIOD_MAXIMUM = 30 days;

    /// @notice Seconds since the end of the voting period before the proposal can be executed
    uint256 public executionDelay = 24 hours;
    uint256 public constant EXECUTION_DELAY_MINIMUM = 30 seconds;
    uint256 public constant EXECUTION_DELAY_MAXIMUM = 30 days;

    /// @notice Seconds since the proposal could be executed until it is considered expired
    uint256 public constant EXPIRATION_PERIOD = 14 days;

    /// @notice The required minimum number of votes in support of a proposal for it to succeed
    uint256 public quorumVotes = 300_000e18;
    uint256 public constant QUORUM_VOTES_MINIMUM = 100_000e18;
    uint256 public constant QUORUM_VOTES_MAXIMUM = 18_000_000e18;

    /// @notice The minimum number of votes required for an account to create a proposal
    uint256 public proposalThreshold = 100_000e18;
    uint256 public constant PROPOSAL_THRESHOLD_MINIMUM = 50_000e18;
    uint256 public constant PROPOSAL_THRESHOLD_MAXIMUM = 10_000_000e18;

    /// @notice The total number of proposals
    uint256 public proposalCount;

    /// @notice The record of all proposals ever proposed
    mapping(uint256 => Proposal) public proposals;
    mapping(uint256 => ProposalExecutionContext) public proposalExecutionContexts;
    mapping(uint256 => mapping(address => Receipt)) public receipts;
    mapping(address => uint256) public lastProposalByAddress;

    /// @notice Non-tradeable xEMBR used to represent votes
    IxEMBR public xEMBR;

    struct Proposal {
        string title;
        string metadata;
        address proposer;
        address executor;
        uint256 startTime;
        uint256 votingPeriod;
        uint256 quorumVotes;
        uint256 executionDelay;
        uint256 forVotes;
        uint256 againstVotes;
    }

    struct ProposalExecutionContext {
        address target;
        uint256 value;
        bytes data;
    }

    struct Receipt {
        bool hasVoted;
        bool support;
        uint256 votes;
    }

    enum ProposalState {
        Active,
        Defeated,
        PendingExecution,
        ReadyForExecution,
        Executed,
        Expired
    }

    event NewVote(
        uint256 proposalId,
        address voter,
        bool support,
        uint256 votes
    );
    event ProposalCreated(uint256 proposalId, address proposer, string title);
    event ProposalExecuted(uint256 proposalId, address executor);
    event MinimumVotingPeriodChanged(uint256 newMinimumVotingPeriod);
    event ExecutionDelayChanged(uint256 newExecutionDelay);
    event QuorumVotesChanges(uint256 newQuorumVotes);
    event ProposalThresholdChanged(uint256 newProposalThreshold);

    /// @dev This token must not be tradeable
    constructor(address _xEMBR) {
        xEMBR = IxEMBR(_xEMBR);
    }

    modifier onlyGovernor() {
        require(
            msg.sender == address(this),
            "Governance: insufficient privileges"
        );
        _;
    }

    function state(uint256 _proposalId) public view returns (ProposalState) {
        require(
            _proposalId <= proposalCount && _proposalId != 0,
            "Governance::state: invalid proposal id"
        );

        Proposal storage proposal = proposals[_proposalId];

        if (block.timestamp <= proposal.startTime + proposal.votingPeriod) {
            return ProposalState.Active;
        } else if (proposal.executor != address(0)) {
            return ProposalState.Executed;
        } else if (proposal.forVotes <= proposal.againstVotes || proposal.forVotes < proposal.quorumVotes) {
            return ProposalState.Defeated;
        } else if (block.timestamp < proposal.startTime + proposal.votingPeriod + proposal.executionDelay) {
            return ProposalState.PendingExecution;
        } else if (block.timestamp < proposal.startTime + proposal.votingPeriod + proposal.executionDelay + EXPIRATION_PERIOD) {
            return ProposalState.ReadyForExecution;
        } else {
            return ProposalState.Expired;
        }
    }

    function getReceipt(uint256 _proposalId, address _voter) public view returns (Receipt memory) {
        return receipts[_proposalId][_voter];
    }

    function propose(
        string calldata _title,
        string calldata _metadata,
        uint256 _votingPeriod,
        address _target,
        uint256 _value,
        bytes memory _data
    ) public {
        require(
            _votingPeriod >= minimumVotingPeriod,
            "Governance::propose: voting period too short"
        );

        require(
            _votingPeriod <= VOTING_PERIOD_MAXIMUM,
            "Governance::propose: voting period too long"
        );

        uint256 lastProposalId = lastProposalByAddress[msg.sender];

        if (lastProposalId > 0) {
            ProposalState proposalState = state(lastProposalId);
            require(
                proposalState == ProposalState.Executed ||
                proposalState == ProposalState.Defeated ||
                proposalState == ProposalState.Expired,
                "Governance::propose: proposer already has a proposal in progress"
            );
        }

        uint256 votes = xEMBR.balanceOf(msg.sender);

        require(
            votes > proposalThreshold,
            "Governance::propose: proposer votes below proposal threshold"
        );

        proposalCount++;

        Proposal memory newProposal = Proposal({
            title: _title,
            metadata: _metadata,
            proposer: msg.sender,
            executor: address(0),
            startTime: block.timestamp,
            votingPeriod: _votingPeriod,
            quorumVotes: quorumVotes,
            executionDelay: executionDelay,
            forVotes: 0,
            againstVotes: 0
        });

        proposals[proposalCount] = newProposal;
        lastProposalByAddress[msg.sender] = proposalCount;

        ProposalExecutionContext memory newProposalExecutionContext = ProposalExecutionContext({
            target: _target,
            value: _value,
            data: _data
        });

        proposalExecutionContexts[proposalCount] = newProposalExecutionContext;

        emit ProposalCreated(proposalCount, newProposal.proposer, newProposal.title);
    }

    function vote(uint256 _proposalId, bool _support) public {
        require(
            state(_proposalId) == ProposalState.Active,
            "Governance::vote: voting is closed"
        );

        Proposal storage proposal = proposals[_proposalId];
        Receipt storage receipt = receipts[_proposalId][msg.sender];

        uint256 votes = xEMBR.balanceOf(msg.sender);

        if (receipt.hasVoted) {
            if (receipt.support) {
                proposal.forVotes = proposal.forVotes - receipt.votes;
            } else {
                proposal.againstVotes = proposal.againstVotes - receipt.votes;
            }
        }

        if (_support) {
            proposal.forVotes = proposal.forVotes + votes;
        } else {
            proposal.againstVotes = proposal.againstVotes + votes;
        }

        receipt.hasVoted = true;
        receipt.support = _support;
        receipt.votes = votes;

        emit NewVote(_proposalId, msg.sender, _support, votes);
    }

    function execute(uint256 _proposalId) public payable nonReentrant returns (bytes memory) {
        require(
            state(_proposalId) == ProposalState.ReadyForExecution,
            "Governance::execute: cannot be executed"
        );

        Proposal storage proposal = proposals[_proposalId];

        ProposalExecutionContext storage proposalExecutionContext = proposalExecutionContexts[_proposalId];

        (bool success, bytes memory returnData) = proposalExecutionContext.target.call{value: proposalExecutionContext.value}(proposalExecutionContext.data);
        require(
            success,
            "Governance::execute: transaction execution reverted."
        );
        proposal.executor = msg.sender;

        emit ProposalExecuted(_proposalId, proposal.executor);

        return returnData;
    }

    // Setters

    function setMinimumVotingPeriod(uint256 _seconds) public onlyGovernor {
        require(
            _seconds >= VOTING_PERIOD_MINIMUM,
            "Governance::setMinimumVotingPeriod: TOO_SMALL"
        );
        require(
            _seconds <= VOTING_PERIOD_MAXIMUM,
            "Governance::setMinimumVotingPeriod: TOO_LARGE"
        );
        minimumVotingPeriod = _seconds;
        emit MinimumVotingPeriodChanged(_seconds);
    }

    function setExecutionDelay(uint256 _seconds) public onlyGovernor {
        require(
            _seconds >= EXECUTION_DELAY_MINIMUM,
            "Governance::setExecutionDelay: TOO_SMALL"
        );
        require(
            _seconds <= EXECUTION_DELAY_MAXIMUM,
            "Governance::setExecutionDelay: TOO_LARGE"
        );
        executionDelay = _seconds;
        emit ExecutionDelayChanged(_seconds);
    }

    function setQuorumVotes(uint256 _votes) public onlyGovernor {
        require(
            _votes >= QUORUM_VOTES_MINIMUM,
            "Governance::setQuorumVotes: TOO_SMALL"
        );
        require(
            _votes <= QUORUM_VOTES_MAXIMUM,
            "Governance::setQuorumVotes: TOO_LARGE"
        );
        quorumVotes = _votes;
        emit QuorumVotesChanges(_votes);
    }

    function setProposalThreshold(uint256 _votes) public onlyGovernor {
        require(
            _votes >= PROPOSAL_THRESHOLD_MINIMUM,
            "Governance::setProposalThreshold: TOO_SMALL"
        );
        require(
            _votes <= PROPOSAL_THRESHOLD_MAXIMUM,
            "Governance::setProposalThreshold: TOO_LARGE"
        );
        proposalThreshold = _votes;
        emit ProposalThresholdChanged(_votes);
    }
}