import { expect } from "chai";
import { ethers } from "hardhat";
import { time, loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { ContractTransactionResponse, Signer } from "ethers";
import { FlowPay, MockERC20 } from "../typechain-types"; // Nếu bạn đã chạy npx hardhat typechain

// Định nghĩa kiểu dữ liệu cho tham số đầu vào để code clean hơn
interface StreamParams {
  recipient: string;
  depositAmount: bigint;
  milestoneAmount: bigint;
  startTime: number;
  stopTime: number;
}

describe("FlowPay Smart Contract (TypeScript)", function () {
  
  // --- FIXTURE SETUP ---
  async function deployFlowPayFixture() {
    // 1. Get Signers
    const [admin, creator, employee, auditor, other] = await ethers.getSigners();

    // 2. Deploy Mock Token
    const TokenFactory = await ethers.getContractFactory("MockERC20");
    const token = (await TokenFactory.deploy()) as MockERC20;
    const tokenAddress = await token.getAddress();

    // 3. Deploy FlowPay
    const FlowPayFactory = await ethers.getContractFactory("FlowPay");
    const flowPay = (await FlowPayFactory.deploy(tokenAddress, auditor.address)) as FlowPay;
    const flowPayAddress = await flowPay.getAddress();

    // 4. Setup Roles
    const CREATOR_ROLE = await flowPay.CREATOR_ROLE();
    await flowPay.connect(admin).grantRole(CREATOR_ROLE, creator.address);

    // 5. Mint & Approve Token cho Creator
    // Mint 10,000 token cho creator
    // Lưu ý: MockERC20 cần có hàm mint hoặc logic mint trong constructor
    // Ở đây giả sử MockERC20 mint cho msg.sender (admin), nên admin chuyển cho creator
    const initialBalance = ethers.parseEther("10000");
    await token.transfer(creator.address, initialBalance);
    
    // Creator approve cho FlowPay
    await token.connect(creator).approve(flowPayAddress, initialBalance);

    return { flowPay, token, admin, creator, employee, auditor, other, flowPayAddress };
  }

  // --- TEST CASES ---

  describe("Deployment", function () {
    it("Should set the right roles", async function () {
      const { flowPay, admin, auditor } = await loadFixture(deployFlowPayFixture);
      
      const DEFAULT_ADMIN_ROLE = await flowPay.DEFAULT_ADMIN_ROLE();
      const AUDITOR_ROLE = await flowPay.AUDITOR_ROLE();

      expect(await flowPay.hasRole(DEFAULT_ADMIN_ROLE, admin.address)).to.be.true;
      expect(await flowPay.hasRole(AUDITOR_ROLE, auditor.address)).to.be.true;
    });
  });

  describe("Creating Streams", function () {
    it("Should create a stream successfully", async function () {
      const { flowPay, creator, employee } = await loadFixture(deployFlowPayFixture);
      
      const now = await time.latest();
      const params: StreamParams = {
        recipient: employee.address,
        depositAmount: ethers.parseEther("100"),
        milestoneAmount: ethers.parseEther("50"),
        startTime: now + 100,
        stopTime: now + 1100
      };

      await expect(flowPay.connect(creator).createStream(params))
        .to.emit(flowPay, "StreamCreated")
        .withArgs(1, creator.address, employee.address);
    });

    it("Should revert if deposit amount is 0", async function () {
      const { flowPay, creator, employee } = await loadFixture(deployFlowPayFixture);
      const now = await time.latest();
      
      const params: StreamParams = {
        recipient: employee.address,
        depositAmount: BigInt(0),
        milestoneAmount: BigInt(0),
        startTime: now + 100,
        stopTime: now + 200
      };

      await expect(flowPay.connect(creator).createStream(params))
        .to.be.revertedWithCustomError(flowPay, "InvalidDepositAmount");
    });
  });

  describe("Withdrawal Logic (Core Math)", function () {
    // Helper function để tạo stream chuẩn
    async function createStandardStream(flowPay: FlowPay, creator: Signer & { address: string }, employee: Signer & { address: string }) {
      const now = await time.latest();
      const startTime = now + 60; // Start sau 1 phút
      const duration = 100;       // Kéo dài 100s
      
      // Rate = 1000 / 100 = 10 tokens/sec
      const params: StreamParams = {
        recipient: employee.address,
        depositAmount: ethers.parseEther("1000"), 
        milestoneAmount: ethers.parseEther("500"),
        startTime: startTime,
        stopTime: startTime + duration
      };

      await flowPay.connect(creator).createStream(params);
      return { startTime, duration, streamId: 1 };
    }

    it("Should allow employee to withdraw correct amount over time", async function () {
      const { flowPay, creator, employee, token } = await loadFixture(deployFlowPayFixture);
      const { startTime } = await createStandardStream(flowPay, creator, employee);

      // 1. Time travel đến 50% thời gian (50s trôi qua)
      await time.increaseTo(startTime + 50); 

      // 2. Check claimable: 50s * 10 token/s = 500 tokens
      const claimable = await flowPay.claimableAmount(1);
      expect(claimable).to.equal(ethers.parseEther("500"));

      // 3. Thực hiện rút tiền & Kiểm tra thay đổi số dư
      await expect(flowPay.connect(employee).withdraw(1, ethers.parseEther("500")))
        .to.changeTokenBalances(token, [flowPay, employee], [ethers.parseEther("-500"), ethers.parseEther("500")]);
    });

    it("Should revert if trying to withdraw more than available", async function () {
      const { flowPay, creator, employee } = await loadFixture(deployFlowPayFixture);
      const { startTime } = await createStandardStream(flowPay, creator, employee);

      await time.increaseTo(startTime + 10); // Mới trôi qua 10s (được 100 token)

      // Cố rút 500 token
      await expect(flowPay.connect(employee).withdraw(1, ethers.parseEther("500")))
        .to.be.revertedWithCustomError(flowPay, "InsufficientBalance");
    });
  });

  describe("Auditor & Milestone", function () {
    it("Should allow Auditor to release milestone", async function () {
        const { flowPay, creator, employee, auditor, token } = await loadFixture(deployFlowPayFixture);
        const now = await time.latest();
        
        const params: StreamParams = {
            recipient: employee.address,
            depositAmount: ethers.parseEther("100"),
            milestoneAmount: ethers.parseEther("50"),
            startTime: now,
            stopTime: now + 100
        };
        await flowPay.connect(creator).createStream(params);

        // Auditor release
        await expect(flowPay.connect(auditor).releaseMilestone(1))
            .to.emit(flowPay, "MilestoneReleased")
            .withArgs(1, ethers.parseEther("50"));
        
        // Kiểm tra employee nhận được tiền milestone
        expect(await token.balanceOf(employee.address)).to.equal(ethers.parseEther("50"));
    });

    it("Should fail if Creator tries to release milestone", async function () {
        const { flowPay, creator, employee } = await loadFixture(deployFlowPayFixture);
        const now = await time.latest();
        
        await flowPay.connect(creator).createStream({
            recipient: employee.address,
            depositAmount: ethers.parseEther("100"),
            milestoneAmount: ethers.parseEther("50"),
            startTime: now,
            stopTime: now + 100
        });

        const AUDITOR_ROLE = await flowPay.AUDITOR_ROLE();
        await expect(flowPay.connect(creator).releaseMilestone(1))
            .to.be.revertedWithCustomError(flowPay, "AccessControlUnauthorizedAccount")
            .withArgs(creator.address, AUDITOR_ROLE);
    });
  });

  describe("Cancellation & Refund", function () {
    it("Should refund correct amounts on cancel", async function () {
        const { flowPay, creator, employee, token } = await loadFixture(deployFlowPayFixture);
        const now = await time.latest();
        
        // 1000 stream, 500 milestone. 1 token/sec
        await flowPay.connect(creator).createStream({
            recipient: employee.address,
            depositAmount: ethers.parseEther("1000"),
            milestoneAmount: ethers.parseEther("500"),
            startTime: now,
            stopTime: now + 1000
        });

        // Chạy 500s -> Employee được hưởng 500 tokens
        await time.increase(500);

        // Cancel
        // Employee nhận: 500 (lương đã làm)
        // Creator nhận lại: 500 (lương chưa làm) + 500 (milestone) = 1000 refund
        await expect(flowPay.connect(creator).cancelStream(1))
            .to.changeTokenBalances(
                token, 
                [creator, employee], 
                [ethers.parseEther("1000"), ethers.parseEther("500")]
            );
    });
  });
});