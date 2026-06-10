const express     = require("express");
const { v4: uuid} = require("uuid");
const User        = require("../models/User");
const Transaction = require("../models/Transaction");
const { protect } = require("../middleware/auth");
const squadco     = require("../services/squadco");

const router = express.Router();

// ═══════════════════════════════════════════════
//  POST /api/wallet/deposit/initiate
//  Step 1: Generate SquadCo checkout URL
// ═══════════════════════════════════════════════
router.post("/deposit/initiate", protect, async (req, res) => {
  try {
    const { amount } = req.body;
    const amountNaira = Number(amount);

    if (!amountNaira || amountNaira < 100)
      return res.status(400).json({ success: false, error: "Minimum deposit is ₦100" });
    if (amountNaira > 500000)
      return res.status(400).json({ success: false, error: "Maximum deposit is ₦500,000" });

    const reference = `DEP_${uuid().replace(/-/g, "").toUpperCase().slice(0, 16)}`;

    // Create a pending transaction first
    await Transaction.create({
      userId:        req.user._id,
      type:          "deposit",
      amount:        amountNaira,
      description:   `Deposit via SquadCo`,
      status:        "pending",
      reference,
      balanceBefore: req.user.balance,
    });

    // Get checkout URL from SquadCo
    const result = await squadco.initiatePayment({
      email:        req.user.email,
      amountNaira,
      reference,
      callbackUrl:  `${process.env.CLIENT_URL}/wallet?ref=${reference}`,
      metadata:     { name: req.user.name, userId: req.user._id },
    });

    res.json({
      success:     true,
      checkoutUrl: result.checkoutUrl,
      reference,
    });
  } catch (err) {
    console.error("Deposit initiate error:", err);
    res.status(500).json({ success: false, error: err.message || "Failed to initiate deposit" });
  }
});

// ═══════════════════════════════════════════════
//  POST /api/wallet/deposit/verify
//  Step 2: Verify payment after user returns
// ═══════════════════════════════════════════════
router.post("/deposit/verify", protect, async (req, res) => {
  try {
    const { reference } = req.body;
    if (!reference)
      return res.status(400).json({ success: false, error: "Reference is required" });

    // Find the pending transaction
    const txn = await Transaction.findOne({ reference, userId: req.user._id });
    if (!txn)
      return res.status(404).json({ success: false, error: "Transaction not found" });
    if (txn.status === "completed")
      return res.json({ success: true, message: "Already credited", alreadyCredited: true });

    // Verify with SquadCo
    const result = await squadco.verifyPayment(reference);

    if (!result.isSuccess) {
      txn.status = "failed";
      await txn.save();
      return res.status(400).json({ success: false, error: "Payment was not successful" });
    }

    // Credit user wallet atomically
    const user = await User.findById(req.user._id);
    const balanceBefore = user.balance;
    user.balance += result.amountNaira;
    await user.save();

    // Update transaction record
    txn.status        = "completed";
    txn.squadcoRef    = result.reference;
    txn.balanceBefore = balanceBefore;
    txn.balanceAfter  = user.balance;
    txn.completedAt   = new Date();
    await txn.save();

    res.json({
      success:        true,
      message:        `₦${result.amountNaira.toLocaleString()} credited to your wallet`,
      newBalance:     user.balance,
      amountCredited: result.amountNaira,
    });
  } catch (err) {
    console.error("Deposit verify error:", err);
    res.status(500).json({ success: false, error: err.message || "Verification failed" });
  }
});

// ═══════════════════════════════════════════════
//  POST /api/wallet/webhook
//  SquadCo webhook — auto-credit on payment success
//  ⚠️  Must use express.raw() — set in server.js
// ═══════════════════════════════════════════════
router.post("/webhook", async (req, res) => {
  try {
    // 1. Verify webhook signature
    const signature = req.headers["x-squad-encrypted-body"];
    const rawBody   = req.body; // raw Buffer from express.raw()

    const isValid = squadco.verifyWebhookSignature(rawBody, signature);
    if (!isValid) {
      console.warn("⚠️  Invalid SquadCo webhook signature");
      return res.status(401).json({ error: "Invalid signature" });
    }

    const event = JSON.parse(rawBody.toString());
    console.log("📩 SquadCo webhook received:", event.Event);

    // 2. Handle successful charge event
    if (event.Event === "charge_completed" && event.Body?.transaction_status === "success") {
      const ref       = event.Body.transaction_ref;
      const amountKob = event.Body.amount;
      const amountNaira = squadco.toNaira(amountKob);

      const txn = await Transaction.findOne({ reference: ref });
      if (!txn || txn.status === "completed") {
        return res.sendStatus(200); // Already handled
      }

      const user = await User.findById(txn.userId);
      if (!user) return res.sendStatus(200);

      const balanceBefore = user.balance;
      user.balance += amountNaira;
      await user.save();

      txn.status        = "completed";
      txn.squadcoRef    = ref;
      txn.squadcoStatus = "success";
      txn.balanceBefore = balanceBefore;
      txn.balanceAfter  = user.balance;
      txn.completedAt   = new Date();
      await txn.save();

      console.log(`✅ Webhook: Credited ₦${amountNaira} to user ${user.email}`);
    }

    res.sendStatus(200);
  } catch (err) {
    console.error("Webhook error:", err);
    res.sendStatus(500);
  }
});

// ═══════════════════════════════════════════════
//  POST /api/wallet/withdraw
//  Request a bank withdrawal
// ═══════════════════════════════════════════════
router.post("/withdraw", protect, async (req, res) => {
  try {
    const { amount } = req.body;
    const amountNaira = Number(amount);

    if (!amountNaira || amountNaira < 500)
      return res.status(400).json({ success: false, error: "Minimum withdrawal is ₦500" });

    const user = await User.findById(req.user._id);
    if (user.balance < amountNaira)
      return res.status(400).json({ success: false, error: "Insufficient balance" });
    if (!user.bankAccount?.accountNumber)
      return res.status(400).json({ success: false, error: "Please add a bank account first" });

    const reference = `WDR_${uuid().replace(/-/g, "").toUpperCase().slice(0, 16)}`;

    // Deduct immediately to prevent double-withdrawal
    const balanceBefore = user.balance;
    user.balance -= amountNaira;
    await user.save();

    // Create processing transaction
    const txn = await Transaction.create({
      userId:        user._id,
      type:          "withdrawal",
      amount:        amountNaira,
      description:   `Withdrawal to ${user.bankAccount.bankName} ${user.bankAccount.accountNumber}`,
      status:        "processing",
      reference,
      balanceBefore,
      balanceAfter:  user.balance,
      metadata: {
        bankName:      user.bankAccount.bankName,
        bankCode:      user.bankAccount.bankCode,
        accountNumber: user.bankAccount.accountNumber,
        accountName:   user.bankAccount.accountName,
      },
    });

    // Initiate transfer via SquadCo
    try {
      const result = await squadco.transferToBank({
        bankCode:      user.bankAccount.bankCode,
        accountNumber: user.bankAccount.accountNumber,
        accountName:   user.bankAccount.accountName,
        amountNaira,
        reference,
        narration:     "CrushCash Withdrawal",
      });

      txn.status     = "completed";
      txn.squadcoRef = result.reference;
      txn.completedAt = new Date();
      await txn.save();

      res.json({
        success:    true,
        message:    `₦${amountNaira.toLocaleString()} withdrawal initiated to ${user.bankAccount.bankName}`,
        newBalance: user.balance,
        reference,
      });
    } catch (transferErr) {
      // Reverse deduction if SquadCo fails
      user.balance += amountNaira;
      await user.save();
      txn.status = "failed";
      await txn.save();
      throw transferErr;
    }
  } catch (err) {
    console.error("Withdrawal error:", err);
    res.status(500).json({ success: false, error: err.message || "Withdrawal failed" });
  }
});

// ═══════════════════════════════════════════════
//  GET /api/wallet/balance
// ═══════════════════════════════════════════════
router.get("/balance", protect, async (req, res) => {
  try {
    const user = await User.findById(req.user._id).select("balance");
    res.json({ success: true, balance: user.balance });
  } catch (err) {
    res.status(500).json({ success: false, error: "Failed to fetch balance" });
  }
});

// ═══════════════════════════════════════════════
//  GET /api/wallet/transactions
// ═══════════════════════════════════════════════
router.get("/transactions", protect, async (req, res) => {
  try {
    const { page = 1, limit = 20, type } = req.query;
    const query = { userId: req.user._id };
    if (type) query.type = type;

    const [transactions, total] = await Promise.all([
      Transaction.find(query)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(Number(limit))
        .lean(),
      Transaction.countDocuments(query),
    ]);

    res.json({
      success: true,
      transactions,
      pagination: { page: Number(page), limit: Number(limit), total, pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: "Failed to fetch transactions" });
  }
});

// ═══════════════════════════════════════════════
//  GET /api/wallet/banks  — list supported banks
// ═══════════════════════════════════════════════
router.get("/banks", protect, async (req, res) => {
  try {
    const banks = await squadco.getSupportedBanks();
    res.json({ success: true, banks });
  } catch (err) {
    res.status(500).json({ success: false, error: "Failed to fetch banks" });
  }
});

// ═══════════════════════════════════════════════
//  POST /api/wallet/verify-account
//  Verify bank account number before withdrawal
// ═══════════════════════════════════════════════
router.post("/verify-account", protect, async (req, res) => {
  try {
    const { bankCode, accountNumber } = req.body;
    if (!bankCode || !accountNumber)
      return res.status(400).json({ success: false, error: "Bank code and account number required" });

    const result = await squadco.lookupBankAccount(bankCode, accountNumber);
    res.json({ success: true, accountName: result.accountName });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
