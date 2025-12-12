import {
  time,
  loadFixture,
} from "@nomicfoundation/hardhat-toolbox-viem/network-helpers";
import { expect } from "chai";
import hre from "hardhat";
import { getAddress, parseEther, zeroAddress } from "viem";

describe("FlowPay", function () {
  // Setup môi trường chuẩn cho mỗi bài test
  async function deployFlowPayFixture() {
    // 1. Lấy danh sách ví
    const [admin, creator, employee, auditor, other] = await hre.viem.getWalletClients();
    const publicClient = await hre.viem.getPublicClient();

    // 2. Deploy Mock Token
    // Lưu ý: MockERC20 phải có trong thư mục contracts
    const token = await hre.viem.deployContract("MockERC20", []);

    // 3. Deploy FlowPay
    const flowPay = await hre.viem.deployContract("FlowPay", [
      token.address,
      auditor.account.address,
    ]);

    // 4. Setup Quyền hạn (Roles)
    const CREATOR_ROLE = await flowPay.read.CREATOR_ROLE();
    // Admin cấp quyền Creator cho ví 'creator'
    await flowPay.write.grantRole([CREATOR_ROLE, creator.account.address]);

    // 5. Setup Tiền tệ
    // Chuyển 10,000 token cho Creator
    const initialBalance = parseEther("10000");
    await token.write.transfer([creator.account.address, initialBalance]);

    // 6. Creator Approve cho FlowPay
    // Để creator gọi hàm approve, ta cần lấy contract instance gắn với ví creator
    const tokenAsCreator = await hre.viem.getContractAt(
      "MockERC20",
      token.address,
      { client: { wallet: creator } }
    );
    await tokenAsCreator.write.approve([flowPay.address, initialBalance]);

    // Trả về các biến cần thiết
    return {
      flowPay,
      token,
      admin,
      creator,
      employee,
      auditor,
      other,
      publicClient,
    };
  }

  // --- TEST CASES ---

  describe("Deployment", function () {
    it("Should set the right roles", async function () {
      const { flowPay, admin, auditor, creator } = await loadFixture(deployFlowPayFixture);

      const DEFAULT_ADMIN_ROLE = await flowPay.read.DEFAULT_ADMIN_ROLE();
      const AUDITOR_ROLE = await flowPay.read.AUDITOR_ROLE();
      const CREATOR_ROLE = await flowPay.read.CREATOR_ROLE();

      expect(await flowPay.read.hasRole([DEFAULT_ADMIN_ROLE, admin.account.address])).to.be.true;
      expect(await flowPay.read.hasRole([AUDITOR_ROLE, auditor.account.address])).to.be.true;
      expect(await flowPay.read.hasRole([CREATOR_ROLE, creator.account.address])).to.be.true;
    });
  });

  describe("Creating Streams", function () {
    it("Should create a stream successfully and emit event", async function () {
      const { flowPay, creator, employee } = await loadFixture(deployFlowPayFixture);
      
      // Lấy contract instance với ví creator
      const flowPayAsCreator = await hre.viem.getContractAt(
        "FlowPay",
        flowPay.address,
        { client: { wallet: creator } }
      );

      const now = BigInt(await time.latest());
      const params = {
        recipient: employee.account.address,
        depositAmount: parseEther("100"),
        milestoneAmount: parseEther("50"),
        startTime: now + 100n,
        stopTime: now + 1100n,
      };

      // Gọi hàm write
      const hash = await flowPayAsCreator.write.createStream([params]);

      // Kiểm tra Event
      const streamCreatedEvents = await flowPay.getEvents.StreamCreated();
      expect(streamCreatedEvents).to.have.lengthOf(1);
      
      // Kiểm tra args trong event (Lưu ý: Viem trả về địa chỉ đã checksum hoặc lowercase, nên dùng getAddress để so sánh chuẩn)
      expect(getAddress(streamCreatedEvents[0].args.sender!)).to.equal(getAddress(creator.account.address));
      expect(getAddress(streamCreatedEvents[0].args.recipient!)).to.equal(getAddress(employee.account.address));
    });

    it("Should revert if deposit amount is 0", async function () {
      const { flowPay, creator, employee } = await loadFixture(deployFlowPayFixture);
      const flowPayAsCreator = await hre.viem.getContractAt("FlowPay", flowPay.address, { client: { wallet: creator } });

      const now = BigInt(await time.latest());
      const params = {
        recipient: employee.account.address,
        depositAmount: 0n, // 0
        milestoneAmount: 0n,
        startTime: now + 100n,
        stopTime: now + 200n,
      };

      // Kiểm tra lỗi custom error
      await expect(flowPayAsCreator.write.createStream([params])).to.be.rejectedWith("InvalidDepositAmount");
    });
  });

  describe("Withdrawal Logic", function () {
    // Helper tạo stream nhanh
    async function createStandardStream(flowPay: any, creator: any, employee: any) {
      const flowPayAsCreator = await hre.viem.getContractAt("FlowPay", flowPay.address, { client: { wallet: creator } });
      const now = BigInt(await time.latest());
      const startTime = now + 60n;
      const duration = 100n;
      
      const params = {
        recipient: employee.account.address,
        depositAmount: parseEther("1000"), // 1000 tokens
        milestoneAmount: parseEther("500"),
        startTime: startTime,
        stopTime: startTime + duration,
      };

      await flowPayAsCreator.write.createStream([params]);
      return { startTime, streamId: 1n };
    }

    it("Should allow employee to withdraw correct amount", async function () {
      const { flowPay, creator, employee, token } = await loadFixture(deployFlowPayFixture);
      const { startTime, streamId } = await createStandardStream(flowPay, creator, employee);

      // Time travel: Trôi qua 50% thời gian (50s)
      // Rate = 1000 / 100 = 10 token/s -> Kiếm được 500 token
      await time.increaseTo(startTime + 50n);

      // Check view function
      const claimable = await flowPay.read.claimableAmount([streamId]);
      expect(claimable).to.equal(parseEther("500"));

      // Employee rút tiền
      const flowPayAsEmployee = await hre.viem.getContractAt("FlowPay", flowPay.address, { client: { wallet: employee } });
      await flowPayAsEmployee.write.withdraw([streamId, parseEther("500")]);

      // Check balance trong Token
      const balance = await token.read.balanceOf([employee.account.address]);
      expect(balance).to.equal(parseEther("500"));
    });
  });

  describe("Auditor & Milestone", function () {
    it("Should allow Auditor to release milestone", async function () {
      const { flowPay, creator, employee, auditor, token } = await loadFixture(deployFlowPayFixture);
      
      const flowPayAsCreator = await hre.viem.getContractAt("FlowPay", flowPay.address, { client: { wallet: creator } });
      const now = BigInt(await time.latest());
      
      const params = {
        recipient: employee.account.address,
        depositAmount: parseEther("100"),
        milestoneAmount: parseEther("50"),
        startTime: now,
        stopTime: now + 100n,
      };
      await flowPayAsCreator.write.createStream([params]);
      const streamId = 1n;

      // Auditor release
      const flowPayAsAuditor = await hre.viem.getContractAt("FlowPay", flowPay.address, { client: { wallet: auditor } });
      await flowPayAsAuditor.write.releaseMilestone([streamId]);

      // Check event
      const events = await flowPay.getEvents.MilestoneReleased();
      expect(events[0].args.amount).to.equal(parseEther("50"));

      // Check balance employee
      const balance = await token.read.balanceOf([employee.account.address]);
      expect(balance).to.equal(parseEther("50"));
    });
  });

  describe("Cancellation", function () {
    it("Should refund sender correctly", async function () {
      const { flowPay, creator, employee, token } = await loadFixture(deployFlowPayFixture);
      const flowPayAsCreator = await hre.viem.getContractAt("FlowPay", flowPay.address, { client: { wallet: creator } });
      
      const now = BigInt(await time.latest());
      // Deposit 1000, Milestone 500
      const params = {
        recipient: employee.account.address,
        depositAmount: parseEther("1000"),
        milestoneAmount: parseEther("500"),
        startTime: now,
        stopTime: now + 1000n, // 1 token/s
      };
      await flowPayAsCreator.write.createStream([params]);
      const streamId = 1n;

      // Chạy 500s -> Employee kiếm được 500
      const targetCancelTime = now + 500n;

      await time.setNextBlockTimestamp(targetCancelTime);

      // Ghi lại balance trước khi cancel
      const balCreatorBefore = await token.read.balanceOf([creator.account.address]);

      // Cancel
      await flowPayAsCreator.write.cancelStream([streamId]);

      // Refund logic:
      // Tổng nạp: 1500.
      // Employee lấy: 500.
      // Creator nhận lại: 500 (phần lương chưa chạy) + 500 (milestone) = 1000.
      const balCreatorAfter = await token.read.balanceOf([creator.account.address]);

      expect(balCreatorAfter - balCreatorBefore).to.equal(parseEther("1000"));
    });
  });

  describe("Security & Access Control", function () {
    it("Should revert if a creator attempts to pause a stream they do not own", async function () {
      const { flowPay, creator, other, employee } = await loadFixture(deployFlowPayFixture);
      const flowPayAsCreator = await hre.viem.getContractAt("FlowPay", flowPay.address, { client: { wallet: creator } });
      const now = BigInt(await time.latest());
      
      const params = {
        recipient: employee.account.address,
        depositAmount: parseEther("100"),
        milestoneAmount: parseEther("50"),
        startTime: now,
        stopTime: now + 1000n,
      };
      await flowPayAsCreator.write.createStream([params]);
      const streamId = 1n;
      const flowPayAsOther = await hre.viem.getContractAt("FlowPay", flowPay.address, { client: { wallet: other } });

      // Kiểm tra lỗi
      await expect(flowPayAsOther.write.setPaused([streamId, true])).to.be.rejectedWith("Unauthorized");
    });

    it("Should revert if a creator attempts to cancel a stream they do not own", async function () {
      const { flowPay, creator, other, employee } = await loadFixture(deployFlowPayFixture);
      const flowPayAsCreator = await hre.viem.getContractAt("FlowPay", flowPay.address, { client: { wallet: creator } });
      const now = BigInt(await time.latest());
      const params = {
        recipient: employee.account.address,
        depositAmount: parseEther("100"),
        milestoneAmount: parseEther("50"),
        startTime: now,
        stopTime: now + 1000n,
      };
      await flowPayAsCreator.write.createStream([params]);
      const streamId = 1n;
      const flowPayAsOther = await hre.viem.getContractAt("FlowPay", flowPay.address, { client: { wallet: other } });
      await expect(flowPayAsOther.write.cancelStream([streamId])).to.be.rejectedWith("Unauthorized");
    });

    it("Should revert if a non-auditor attempts to release a milestone", async function () {
      const { flowPay, creator, employee, other } = await loadFixture(deployFlowPayFixture);
      const flowPayAsCreator = await hre.viem.getContractAt("FlowPay", flowPay.address, { client: { wallet: creator } });
      const now = BigInt(await time.latest());
      const params = {
        recipient: employee.account.address,
        depositAmount: parseEther("100"),
        milestoneAmount: parseEther("50"),
        startTime: now,
        stopTime: now + 1000n,
      };
      await flowPayAsCreator.write.createStream([params]);
      const streamId = 1n;
      const flowPayAsOther = await hre.viem.getContractAt("FlowPay", flowPay.address, { client: { wallet: other } });
      await expect(flowPayAsOther.write.releaseMilestone([streamId])).to.be.rejectedWith("Unauthorized");
    });

    it("Should revert if an account without CREATOR_ROLE attempts to create a stream", async function () {
      const { flowPay, other, employee } = await loadFixture(deployFlowPayFixture);
      const flowPayAsOther = await hre.viem.getContractAt("FlowPay", flowPay.address, { client: { wallet: other } });
      const now = BigInt(await time.latest());
      const params = {
        recipient: employee.account.address,
        depositAmount: parseEther("100"),
        milestoneAmount: parseEther("50"),
        startTime: now,
        stopTime: now + 1000n,
      };
      await expect(flowPayAsOther.write.createStream([params])).to.be.rejectedWith("Unauthorized");
    });

    it("Should revert if an unauthorized wallet (not recipient) attempts to withdraw funds", async function () {
      const { flowPay, creator, other, employee } = await loadFixture(deployFlowPayFixture);
      const flowPayAsCreator = await hre.viem.getContractAt("FlowPay", flowPay.address, { client: { wallet: creator } });
      const now = BigInt(await time.latest());
      const params = {
        recipient: employee.account.address,
        depositAmount: parseEther("100"),
        milestoneAmount: parseEther("50"),
        startTime: now,
        stopTime: now + 1000n,  
      };
      await flowPayAsCreator.write.createStream([params]);
      const streamId = 1n;
      const flowPayAsOther = await hre.viem.getContractAt("FlowPay", flowPay.address, { client: { wallet: other } });
      await expect(flowPayAsOther.write.withdraw([streamId, parseEther("10")])).to.be.rejectedWith("Unauthorized");
    });
  });

  describe("Pause & Resume Logic", function () {
    it("Should accurately shift the stopTime forward by the paused duration upon resumption", async function () {
      const { flowPay, creator, employee, token } = await loadFixture(deployFlowPayFixture);
      const flowPayAsCreator = await hre.viem.getContractAt("FlowPay", flowPay.address, { client: { wallet: creator } });
      const now = BigInt(await time.latest());
      const params = {
        recipient: employee.account.address,
        depositAmount: parseEther("1000"),
        milestoneAmount: parseEther("500"),
        startTime: now + 60n,
        stopTime: now + 1060n, // 1000s duration
      };
      await flowPayAsCreator.write.createStream([params]);
      const streamId = 1n;

      // Time travel to startTime + 200s
      await time.increaseTo(params.startTime + 200n);
      // Pause the stream
      await flowPayAsCreator.write.setPaused([streamId, true]);
      // Time travel 300s while paused
      await time.increase(300);
      // Resume the stream
      await flowPayAsCreator.write.setPaused([streamId, false]);
      // Time travel another 500s
      await time.increase(500);
      // Total active time = 200 + 500 = 700s
      const claimable = await flowPay.read.claimableAmount([streamId]);
      // Rate = 1000 / 1000 = 1 token/s -> Kiếm được 700<claim<705 token (reason: block time slight variations)
      expect(claimable).to.be.equal(parseEther("701"));
    });

    it("Should allow recipient to withdraw previously vested earnings even while the stream is PAUSED", async function () {
      const { flowPay, creator, employee, token } = await loadFixture(deployFlowPayFixture);
      const flowPayAsCreator = await hre.viem.getContractAt("FlowPay", flowPay.address, { client: { wallet: creator } });
      const now = BigInt(await time.latest());
      const params = {
        recipient: employee.account.address,
        depositAmount: parseEther("1000"),
        milestoneAmount: parseEther("500"),
        startTime: now + 60n,
        stopTime: now + 1060n, // 1000s duration
      };
      await flowPayAsCreator.write.createStream([params]);
      const streamId = 1n;
      // Time travel to startTime + 300s
      await time.increaseTo(params.startTime + 300n);
      // Check claimable amount
      const claimableBefore = await flowPay.read.claimableAmount([streamId]);
      // Pause the stream
      await flowPayAsCreator.write.setPaused([streamId, true]);
      expect(claimableBefore).to.equal(parseEther("300"));
      // Employee withdraws while paused
      const flowPayAsEmployee = await hre.viem.getContractAt("FlowPay", flowPay.address, { client: { wallet: employee } });
      await flowPayAsEmployee.write.withdraw([streamId, parseEther("300")]);
      // Check employee balance
      const balance = await token.read.balanceOf([employee.account.address]);
      expect(balance).to.equal(parseEther("300"));
    });

    it("Should revert when attempting to pause a stream that is already PAUSED", async function () {
      const { flowPay, creator, employee } = await loadFixture(deployFlowPayFixture);
      const flowPayAsCreator = await hre.viem.getContractAt("FlowPay", flowPay.address, { client: { wallet: creator } });
      const now = BigInt(await time.latest());
      const params = {
        recipient: employee.account.address,
        depositAmount: parseEther("100"),
        milestoneAmount: parseEther("50"),
        startTime: now,
        stopTime: now + 1000n,
      };
      await flowPayAsCreator.write.createStream([params]);
      const streamId = 1n;
      await flowPayAsCreator.write.setPaused([streamId, true]);
      await expect(flowPayAsCreator.write.setPaused([streamId, true])).to.be.rejectedWith("StreamAlreadyPaused");
    });

    it("Should revert when attempting to resume a stream that is NOT paused", async function () {
      const { flowPay, creator, employee } = await loadFixture(deployFlowPayFixture);
      const flowPayAsCreator = await hre.viem.getContractAt("FlowPay", flowPay.address, { client: { wallet: creator } });
      const now = BigInt(await time.latest());
      const params = {
        recipient: employee.account.address,
        depositAmount: parseEther("100"),
        milestoneAmount: parseEther("50"),
        startTime: now,
        stopTime: now + 1000n,
      };
      await flowPayAsCreator.write.createStream([params]);
      const streamId = 1n;
      await expect(flowPayAsCreator.write.setPaused([streamId, false])).to.be.rejectedWith("StreamNotPaused");
    });

    it("Should not accumulate vested tokens during the paused period", async function () {
      const { flowPay, creator, employee } = await loadFixture(deployFlowPayFixture);
      const flowPayAsCreator = await hre.viem.getContractAt("FlowPay", flowPay.address, { client: { wallet: creator } });
      const now = BigInt(await time.latest());
      const params = {
        recipient: employee.account.address,
        depositAmount: parseEther("1000"),
        milestoneAmount: parseEther("500"),
        startTime: now + 60n,
        stopTime: now + 1060n, // 1000s duration
      };
      await flowPayAsCreator.write.createStream([params]);
      const streamId = 1n;
      // Time travel to startTime + 400s
      await time.increaseTo(params.startTime + 400n);
      // Pause the stream
      await flowPayAsCreator.write.setPaused([streamId, true]);
      // Time travel 500s while paused
      await time.increase(500);
      // Resume the stream
      await flowPayAsCreator.write.setPaused([streamId, false]);
      // Time travel another 200s
      await time.increase(200);
      // Total active time = 400 + 200 = 600s + 1s (delay) = 601s
      const claimable = await flowPay.read.claimableAmount([streamId]);
      expect(claimable).to.equal(parseEther("601"));
    });
  });
  describe("Edge Cases", function () {
    it("Should revert with InvalidDepositAmount if deposit is too small for duration (resulting in rate = 0)", async function () {
      const { flowPay, creator, employee } = await loadFixture(deployFlowPayFixture);
      const flowPayAsCreator = await hre.viem.getContractAt("FlowPay", flowPay.address, { client: { wallet: creator } });
      const now = BigInt(await time.latest());
      const params = {
        recipient: employee.account.address,
        depositAmount: 1n, // Quá nhỏ
        milestoneAmount: 0n,
        startTime: now,
        stopTime: now + 2000n, // 2000s duration
      };
      await expect(flowPayAsCreator.write.createStream([params])).to.be.rejectedWith("InvalidDepositAmount");
    });

    it("Should return 0 claimable amount if the stream startTime is in the future", async function () {
      const { flowPay, creator, employee } = await loadFixture(deployFlowPayFixture);
      const flowPayAsCreator = await hre.viem.getContractAt("FlowPay", flowPay.address, { client: { wallet: creator } });
      const now = BigInt(await time.latest());
      const params = {
        recipient: employee.account.address,
        depositAmount: parseEther("1000"),
        milestoneAmount: parseEther("500"),
        startTime: now + 1000n, // Tương lai
        stopTime: now + 2000n,
      };
      await flowPayAsCreator.write.createStream([params]);
      const streamId = 1n;
      const claimable = await flowPay.read.claimableAmount([streamId]);
      expect(claimable).to.equal(0n);
    });

    it("Should allow withdrawing the full remaining balance (including dust) after the stream has ended", async function () {
      const { flowPay, creator, employee, token } = await loadFixture(deployFlowPayFixture);
      const flowPayAsCreator = await hre.viem.getContractAt("FlowPay", flowPay.address, { client: { wallet: creator } });
      const now = BigInt(await time.latest());
      const params = {
        recipient: employee.account.address,
        depositAmount: parseEther("1000"),
        milestoneAmount: parseEther("500"),
        startTime: now + 60n,
        stopTime: now + 1060n, // 1000s duration
      };
      await flowPayAsCreator.write.createStream([params]);
      const streamId = 1n;
      // Time travel to after stopTime
      await time.increaseTo(params.stopTime + 10n);
      const claimable = await flowPay.read.claimableAmount([streamId]);
      expect(claimable).to.equal(parseEther("1000"));
    });

    it("Should automatically transition to COMPLETED status after full withdrawal if milestoneAmount is 0", async function () {
      const { flowPay, creator, employee } = await loadFixture(deployFlowPayFixture);
      const flowPayAsCreator = await hre.viem.getContractAt("FlowPay", flowPay.address, { client: { wallet: creator } });
      const now = BigInt(await time.latest());
      const params = {
        recipient: employee.account.address,
        depositAmount: parseEther("1000"),
        milestoneAmount: 0n,
        startTime: now + 60n,
        stopTime: now + 1060n, // 1000s duration
      };
      await flowPayAsCreator.write.createStream([params]);
      const streamId = 1n;
      // Time travel to after stopTime
      await time.increaseTo(params.stopTime + 10n);
      // Withdraw full amount
      const flowPayAsEmployee = await hre.viem.getContractAt("FlowPay", flowPay.address, { client: { wallet: employee } });
      await flowPayAsEmployee.write.withdraw([streamId, parseEther("1000")]);
      const stream = await flowPay.read.getStream([streamId]);
      expect(stream.status).to.equal(2); // COMPLETED
    });

    it("Should correctly handle streams with 0 duration (if allowed) or revert invalid timeframe", async function () {
      const { flowPay, creator, employee } = await loadFixture(deployFlowPayFixture);
      const flowPayAsCreator = await hre.viem.getContractAt("FlowPay", flowPay.address, { client: { wallet: creator } });
      const now = BigInt(await time.latest());
      const params = {
        recipient: employee.account.address,
        depositAmount: parseEther("1000"),
        milestoneAmount: parseEther("500"),
        startTime: now + 100n,
        stopTime: now + 100n, // 0 duration
      };
      await expect(flowPayAsCreator.write.createStream([params])).to.be.rejectedWith("InvalidTimeframe");
    });
  });
  describe("Input Validation", function () {
    it("Should revert with InvalidTimeframe if stopTime is less than or equal to startTime", async function () {
      const { flowPay, creator, employee } = await loadFixture(deployFlowPayFixture);
      const flowPayAsCreator = await hre.viem.getContractAt("FlowPay", flowPay.address, { client: { wallet: creator } });
      const now = BigInt(await time.latest());
      const params = {
        recipient: employee.account.address,
        depositAmount: parseEther("100"),
        milestoneAmount: parseEther("50"),
        startTime: now + 200n,
        stopTime: now + 100n, // stopTime < startTime
      };
      await expect(flowPayAsCreator.write.createStream([params])).to.be.rejectedWith("InvalidTimeframe");
    });

    it("Should revert with InsufficientBalance if creator has not approved enough tokens", async function () {
      const { flowPay, creator, employee, token } = await loadFixture(deployFlowPayFixture);
      const flowPayAsCreator = await hre.viem.getContractAt("FlowPay", flowPay.address, { client: { wallet: creator } });
      const now = BigInt(await time.latest());
      // Creator approve 100 tokens
      const approvedAmount = parseEther("100");
      const tokenAsCreator = await hre.viem.getContractAt(
        "MockERC20",
        token.address,
        { client: { wallet: creator } }
      );
      await tokenAsCreator.write.approve([flowPay.address, approvedAmount]);

      // But creating a stream requires 200 tokens
      const params = {
        recipient: employee.account.address,
        depositAmount: parseEther("200"), // Requires 200 tokens
        milestoneAmount: parseEther("50"),
        startTime: now + 100n,
        stopTime: now + 1100n,
      };
      await expect(flowPayAsCreator.write.createStream([params])).to.be.rejectedWith("ERC20InsufficientAllowance");
    });

    it("Should revert with InvalidRecipientAddress if recipient is the zero address", async function () {
      const { flowPay, creator } = await loadFixture(deployFlowPayFixture);
      const flowPayAsCreator = await hre.viem.getContractAt("FlowPay", flowPay.address, { client: { wallet: creator } });
      const now = BigInt(await time.latest());
      const params = {
        recipient: zeroAddress, // Zero address
        depositAmount: parseEther("100"),
        milestoneAmount: parseEther("50"),
        startTime: now + 100n,
        stopTime: now + 1100n,
      };
      await expect(flowPayAsCreator.write.createStream([params])).to.be.rejectedWith("InvalidRecipientAddress");

    });
    it("Should revert if total amount (deposit + milestone) exceeds creator's balance", async function () {
      const { flowPay, creator, employee, token } = await loadFixture(deployFlowPayFixture);
      const flowPayAsCreator = await hre.viem.getContractAt("FlowPay", flowPay.address, { client: { wallet: creator } });
      const now = BigInt(await time.latest());
      // Creator has 10,000 tokens, try to create stream requiring 15,000
      const params = {
        recipient: employee.account.address,
        depositAmount: parseEther("12000"),
        milestoneAmount: parseEther("3000"),
        startTime: now + 100n,
        stopTime: now + 1100n,
      };
      await expect(flowPayAsCreator.write.createStream([params])).to.be.rejectedWith("InsufficientBalance");
    });
  });
  describe("State Transitions", function () {
    it("Should revert with MilestoneAlreadyReleased if auditor tries to release milestone twice", async function () {
      const { flowPay, creator, employee, auditor } = await loadFixture(deployFlowPayFixture);
      const flowPayAsCreator = await hre.viem.getContractAt("FlowPay", flowPay.address, { client: { wallet: creator } });
      const now = BigInt(await time.latest());
      const params = {
        recipient: employee.account.address,
        depositAmount: parseEther("100"),
        milestoneAmount: parseEther("50"),
        startTime: now,
        stopTime: now + 1000n,
      };
      await flowPayAsCreator.write.createStream([params]);
      const streamId = 1n;
      const flowPayAsAuditor = await hre.viem.getContractAt("FlowPay", flowPay.address, { client: { wallet: auditor } });
      await flowPayAsAuditor.write.releaseMilestone([streamId]);
      await expect(flowPayAsAuditor.write.releaseMilestone([streamId])).to.be.rejectedWith("MilestoneAlreadyReleased");
    });

    it("Should revert with StreamNotActive when attempting to cancel a stream that is already COMPLETED", async function() {
      const { flowPay, creator, employee } = await loadFixture(deployFlowPayFixture);
      const flowPayAsCreator = await hre.viem.getContractAt("FlowPay", flowPay.address, { client: { wallet: creator } });
      const now = BigInt(await time.latest());
      const params = {
        recipient: employee.account.address,
        depositAmount: parseEther("100"),
        milestoneAmount: parseEther("0"),
        startTime: now,
        stopTime: now + 100n,
      };
      await flowPayAsCreator.write.createStream([params]);
      const streamId = 1n;
      // Time travel to after stopTime
      await time.increaseTo(params.stopTime + 10n);
      // Withdraw full amount to complete the stream
      const flowPayAsEmployee = await hre.viem.getContractAt("FlowPay", flowPay.address, { client: { wallet: employee } });
      await flowPayAsEmployee.write.withdraw([streamId, parseEther("100")]);
      await expect(flowPayAsCreator.write.cancelStream([streamId])).to.be.rejectedWith("StreamNotActive");
    });

    it("Should revert with StreamNotActive when attempting to cancel a stream that is already CANCELLED", async function() {
      const { flowPay, creator, employee } = await loadFixture(deployFlowPayFixture);
      const flowPayAsCreator = await hre.viem.getContractAt("FlowPay", flowPay.address, { client: { wallet: creator } });
      const now = BigInt(await time.latest());
      const params = {
        recipient: employee.account.address,
        depositAmount: parseEther("100"),
        milestoneAmount: parseEther("0"),
        startTime: now,
        stopTime: now + 100n,
      };
      await flowPayAsCreator.write.createStream([params]);
      const streamId = 1n;
      await flowPayAsCreator.write.cancelStream([streamId]);
      await expect(flowPayAsCreator.write.cancelStream([streamId])).to.be.rejectedWith("StreamNotActive");
    });

    it("Should revert with StreamIsCancelled if auditor tries to release milestone on a CANCELLED stream", async function() {
      const { flowPay, creator, employee, auditor } = await loadFixture(deployFlowPayFixture);
      const flowPayAsCreator = await hre.viem.getContractAt("FlowPay", flowPay.address, { client: { wallet: creator } });
      const now = BigInt(await time.latest());
      const params = {
        recipient: employee.account.address,
        depositAmount: parseEther("100"),
        milestoneAmount: parseEther("50"),
        startTime: now,
        stopTime: now + 1000n,
      };
      await flowPayAsCreator.write.createStream([params]);
      const streamId = 1n;
      await flowPayAsCreator.write.cancelStream([streamId]);
      const flowPayAsAuditor = await hre.viem.getContractAt("FlowPay", flowPay.address, { client: { wallet: auditor } });
      await expect(flowPayAsAuditor.write.releaseMilestone([streamId])).to.be.rejectedWith("StreamIsCancelled");
    });

    it("Should revert with MilestoneNotSet if auditor tries to release milestone on a stream with milestoneAmount set to 0", async function() {
      const { flowPay, creator, employee, auditor } = await loadFixture(deployFlowPayFixture);
      const flowPayAsCreator = await hre.viem.getContractAt("FlowPay", flowPay.address, { client: { wallet: creator } });
      const now = BigInt(await time.latest());
      const params = {
        recipient: employee.account.address,
        depositAmount: parseEther("100"),
        milestoneAmount: 0n,
        startTime: now,
        stopTime: now + 1000n,
      };
      await flowPayAsCreator.write.createStream([params]);
      const streamId = 1n;
      const flowPayAsAuditor = await hre.viem.getContractAt("FlowPay", flowPay.address, { client: { wallet: auditor } });
      await expect(flowPayAsAuditor.write.releaseMilestone([streamId])).to.be.rejectedWith("MilestoneNotSet");
    });
  });
});