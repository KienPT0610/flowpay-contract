// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

error Unauthorized();
error OnlyAuditor();
error OnlyCreator();
error InvalidTokenAddress();
error InsufficientBalance();
error InvalidRecipientAddress();
error InvalidDepositAmount();
error InvalidMilestoneAmount();
error InvalidTimeframe();
error StreamNotActive();
error MilestoneAlreadyReleased();
error MilestoneNotSet();
error StreamAlreadyPaused();
error StreamNotPaused();
error StreamIsCancelled();

contract FlowPay is AccessControl, ReentrancyGuard {
  using SafeERC20 for IERC20;

  /*
    CREATOR_ROLE: Role assigned to creators who can create payment streams.
    AUDITOR_ROLE: Role assigned to auditors who can release milestones.
  */
  bytes32 public constant CREATOR_ROLE = keccak256("CREATOR_ROLE");
  bytes32 public constant AUDITOR_ROLE = keccak256("AUDITOR_ROLE");

  // Enums
  enum StreamStatus {
    ACTIVE, // when stream is active
    MILESTONE_UNLOCKED, // when milestone is released but stream is still active
    COMPLETED, // when full amount has been withdrawn
    PAUSED,
    CANCELLED
  }

  struct Stream {
    address sender;
    address recipient;
    uint256 depositAmount; // total amount deposited for the stream
    uint256 milestoneAmount; // amount to be released at each milestone
    uint256 startTime;
    uint256 stopTime;
    uint256 ratePerSecond; // calculated rate per second
    uint256 withdrawnAmount; // salary amount withdrawn to wallet
    uint256 remainingBalance; // remaining balance in the stream (excluding milestone amount)
    bool isPaused;
    bool isMilestoneReleased; // indicates if the milestone has been released
    uint256 pauseTime; // timestamp when the stream was paused
    StreamStatus status; // current status of the stream
  }

  struct StreamParams {
    address recipient; 
    uint256 depositAmount;
    uint256 milestoneAmount;
    uint256 startTime;
    uint256 stopTime;
  }

	// storage layout
	struct FlowPayStorageStruct {
  	IERC20 paymentToken; // ERC20 token used for payments
  	uint256 nextStreamId;
  	mapping (uint256 => Stream) streams;
		bool initialized;
	}

	uint256 private constant FLOWPAY_STORAGE_SLOT = uint256(keccak256("flowpay.contracts.storage")) - 1;

	function _flowPayStorage() internal pure returns (FlowPayStorageStruct storage fps) {
		uint256 slot = FLOWPAY_STORAGE_SLOT;
		assembly {
			fps.slot := slot
		}
	}

  // Events
  event StreamCreated(uint256 indexed streamId, address indexed sender, address indexed recipient);
  event Withdraw(uint256 indexed streamId, address indexed recipient, uint256 amount);
  event MilestoneReleased(uint256 indexed streamId, uint256 amount);
  event StreamPaused(uint256 indexed streamId);
  event StreamResumed(uint256 indexed streamId);
  event StreamCancelled(uint256 indexed streamId, uint256 senderRefund, uint256 recipientBalance);

  constructor(address _paymentToken, address _auditor) {
    if (_paymentToken == address(0)) {
      revert InvalidTokenAddress();
    }
    
		FlowPayStorageStruct storage fps = _flowPayStorage();
		fps.paymentToken = IERC20(_paymentToken);
		fps.nextStreamId = 1;

		_grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
		_grantRole(CREATOR_ROLE, msg.sender);
		_grantRole(AUDITOR_ROLE, _auditor);
  }

  // =================================== HELPERS =========================================
  function _checkStreamParams(StreamParams calldata params) internal pure {
    if (params.recipient == address(0)) revert InvalidRecipientAddress();
    if (params.depositAmount == 0) revert InvalidDepositAmount();
    
    // check time
    uint256 duration = params.stopTime - params.startTime;
    if (duration <= 0) revert InvalidTimeframe();
  }

  // ================================== CORE LOGIC ===================================
  /*
    * @notice Calculate the claimable amount for a given stream
    * @param streamId The ID of the stream
    * @return claimableAmount The amount that can be claimed by the recipient
  */
  function claimableAmount(uint256 streamId) public view returns (uint256) {
    FlowPayStorageStruct storage fps = _flowPayStorage();
		Stream storage s = fps.streams[streamId];
  
    if (block.timestamp <= s.startTime || s.status == StreamStatus.CANCELLED) {
      return 0;
    }

    uint256 currentTime = block.timestamp;
    if(s.isPaused) {
      currentTime = s.pauseTime;
    }

    if(currentTime > s.stopTime) {
      currentTime = s.stopTime;
    }

    if (currentTime >= s.stopTime) {
      return s.remainingBalance; 
    }

    // calculate elapsed time and total earned amount
    uint256 elapsedTime = currentTime - s.startTime;
    uint256 totalEarned = elapsedTime * s.ratePerSecond;

    // cap totalEarned to depositAmount
    if (totalEarned > s.depositAmount) {
      totalEarned = s.depositAmount;
    }

    // if already withdrawn amount is greater than or equal to total earned, nothing is claimable
    if (totalEarned <= s.withdrawnAmount) {
      return 0;
    }

    // claimable amount is total earned minus already withdrawn amount
    return totalEarned - s.withdrawnAmount;
  }

  // =================================== ADMIN FUNCTIONS ===================================
  function addRole(bytes32 role, address account) external onlyRole(DEFAULT_ADMIN_ROLE) {
    _grantRole(role, account);
  }

  function removeRole(bytes32 role, address account) external onlyRole(DEFAULT_ADMIN_ROLE) {
    _revokeRole(role, account);
  }

  // =================================== CREATOR FUNCTIONS ===================================
  function createStream(StreamParams calldata params) external nonReentrant onlyRole(CREATOR_ROLE) {
    _checkStreamParams(params);
		FlowPayStorageStruct storage fps = _flowPayStorage();
		IERC20 paymentToken = fps.paymentToken;

    uint256 totalAmount = params.depositAmount + params.milestoneAmount;
    if (paymentToken.balanceOf(msg.sender) < totalAmount) {
      revert InsufficientBalance();
    }

    uint256 duration = params.stopTime - params.startTime;
    uint256 rate = params.depositAmount / duration; // rate per second for deposit amount
    if (rate == 0) {
      revert InvalidDepositAmount();
    }
    
		uint256 nextStreamId = fps.nextStreamId;

    fps.streams[nextStreamId] = Stream({
      sender: msg.sender,
      recipient: params.recipient,
      depositAmount: params.depositAmount,
      milestoneAmount: params.milestoneAmount,
      startTime: params.startTime,
      stopTime: params.stopTime,
      ratePerSecond: rate,
      withdrawnAmount: 0,
      remainingBalance: params.depositAmount, // initially set to deposit amount
      isPaused: false,
      isMilestoneReleased: false,
      pauseTime: 0,
      status: StreamStatus.ACTIVE
    });

    // Transfer total amount from sender to contract
    paymentToken.safeTransferFrom(msg.sender, address(this), totalAmount);

    emit StreamCreated(nextStreamId, msg.sender, params.recipient);
    fps.nextStreamId ++;
  }

  /*
    * @notice Pause a given stream
    * @param streamId The ID of the stream to pause
    * @param paused Boolean indicating whether to pause or resume the stream
  */
  function setPaused(uint256 streamId, bool paused) external nonReentrant onlyRole(CREATOR_ROLE) {
		FlowPayStorageStruct storage fps = _flowPayStorage();
		Stream storage stream = fps.streams[streamId];
    if (msg.sender != stream.sender) {
      revert Unauthorized();
    }
    if (stream.status == StreamStatus.CANCELLED || stream.status == StreamStatus.COMPLETED) {
      revert StreamNotActive();
    }
    if( paused ) {
      if (stream.isPaused) {
        revert StreamAlreadyPaused();
      }
      // Pause the stream
      stream.isPaused = true;
      stream.pauseTime = block.timestamp;
      stream.status = StreamStatus.PAUSED;
      emit StreamPaused(streamId);
    } else {
      if (!stream.isPaused) {
        revert StreamNotPaused();
      }
      // Resume the stream
      uint256 pausedDuration = block.timestamp - stream.pauseTime;
      stream.startTime += pausedDuration;
      stream.stopTime += pausedDuration;
      stream.isPaused = false;
      stream.pauseTime = 0;
      stream.status = StreamStatus.ACTIVE;
      emit StreamResumed(streamId);
    }
  }

  function cancelStream(uint256 streamId) external nonReentrant onlyRole(CREATOR_ROLE) {
		FlowPayStorageStruct storage fps = _flowPayStorage();
		IERC20 paymentToken = fps.paymentToken;
		Stream storage stream = fps.streams[streamId];
    if (msg.sender != stream.sender) {
      revert Unauthorized();
    }
    if (stream.status == StreamStatus.CANCELLED || stream.status == StreamStatus.COMPLETED) revert StreamNotActive();

    uint256 recipientAmount = claimableAmount(streamId); // amount owed to recipient
    uint256 senderRefund = stream.remainingBalance - recipientAmount; // amount to refund sender

    // check is milestone released
    if (!stream.isMilestoneReleased) {
      senderRefund += stream.milestoneAmount;
      stream.milestoneAmount = 0;
    } 

    // Update stream status
    stream.status = StreamStatus.CANCELLED;
    stream.stopTime = block.timestamp;
    stream.ratePerSecond = 0;
    stream.withdrawnAmount += recipientAmount;
    stream.remainingBalance = 0;

    // Transfer funds
    if (recipientAmount > 0) {
      paymentToken.safeTransfer(stream.recipient, recipientAmount);
    }
    if (senderRefund > 0) {
      paymentToken.safeTransfer(stream.sender, senderRefund);
    }
    emit StreamCancelled(streamId, senderRefund, recipientAmount);
  }


  // =================================== AUDITOR FUNCTIONS ===================================
  /*
    * @notice Release milestone for a given stream
    * @example: If the milestone amount is 100 tokens, calling this function will transfer 100 tokens to the recipient.
  */
  function releaseMilestone(uint256 streamId) external nonReentrant onlyRole(AUDITOR_ROLE) {
		FlowPayStorageStruct storage fps = _flowPayStorage();
    IERC20 paymentToken = fps.paymentToken;
    Stream storage stream = fps.streams[streamId];
    
    if (stream.isMilestoneReleased) {
      revert MilestoneAlreadyReleased();
    }
    if (stream.milestoneAmount == 0) {
      revert MilestoneNotSet();
    }
    if (stream.status == StreamStatus.CANCELLED) {
      revert StreamIsCancelled();
    }

    stream.isMilestoneReleased = true;
    if (stream.remainingBalance == 0) {
      stream.status = StreamStatus.COMPLETED;
    } else {
      stream.status = StreamStatus.MILESTONE_UNLOCKED;
    }

    // Transfer milestone amount to recipient
    paymentToken.safeTransfer(stream.recipient, stream.milestoneAmount);
  
    emit MilestoneReleased(streamId, stream.milestoneAmount);
  }

  // =================================== EMPLOYEE FUNCTIONS ===================================

  /*
    * @notice Withdraw available funds from the stream
    * @param streamId The ID of the stream to withdraw from
    * @param amount The amount to withdraw
  */
  function withdraw(uint256 streamId, uint256 amount) external nonReentrant{
		FlowPayStorageStruct storage fps = _flowPayStorage();
    IERC20 paymentToken = fps.paymentToken;
		Stream storage stream = fps.streams[streamId];
    if (msg.sender != stream.recipient) {
      revert Unauthorized();
    }
    if (stream.status == StreamStatus.CANCELLED || stream.status == StreamStatus.COMPLETED) {
      revert StreamNotActive();
    }

    uint256 claimable = claimableAmount(streamId);
    if (amount > claimable) {
      revert InsufficientBalance();
    }

    // update stream state
    stream.withdrawnAmount += amount;
    stream.remainingBalance -= amount;

    // check if stream is completed
    if (stream.remainingBalance == 0 && (stream.isMilestoneReleased || stream.milestoneAmount == 0)) {
      stream.status = StreamStatus.COMPLETED;
    }

    // Transfer funds to recipient
    paymentToken.safeTransfer(stream.recipient, amount);
    emit Withdraw(streamId, stream.recipient, amount);
  }

}