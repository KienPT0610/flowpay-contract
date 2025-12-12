import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";
import dotenv from "dotenv";

dotenv.config();

const FlowPayModule = buildModule("FlowPayModule", (m) => {
  // --- Step 1: DEPLOY MOCK TOKEN ---
  const token = m.contract("MockERC20");

  // --- Step 2: CONFIGURE AUDITOR ---
  // Define the 'auditor' parameter. 
  // The default value below is the address of Account #1 on the Hardhat Local network.
  // When deploying to a real network (Sepolia/Mainnet), you can override this value.
  const defaultAuditor = process.env.AUDITOR_ADDRESS || "0xbac2b69c092d8f9d5a102d1762a197a90947dcbb";
  const auditor = m.getParameter("auditor", defaultAuditor);

  // --- Step 3: DEPLOY FLOWPAY ---
  // Constructor: FlowPay(address _paymentToken, address _auditor)
  // Ignition automatically takes the address of the 'token' deployed in step 1 and passes it here
  const flowPay = m.contract("FlowPay", [token, auditor]);

  // Return the deployed contracts for later interaction
  return { token, flowPay };
});

export default FlowPayModule;