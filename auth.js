const express     = require("express");
const jwt         = require("jsonwebtoken");
const User        = require("../models/User");
const Transaction = require("../models/Transaction");
const { protect } = require("../middleware/auth");

const router = express.Router();

const signToken = (id) =>
  jwt.sign({ id }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || "7d",
  });

// ═══════════════════════════════════════════════
//  POST /api/auth/register
// ═══════════════════════════════════════════════
router.post("/register", async (req, res) => {
  try {
    const { name, email, password, phone } = req.body;

    if (!name || !email || !password)
      return res.status(400).json({ success: false, error: "Name, email and password are required" });

    if (password.length < 6)
      return res.status(400).json({ success: false, error: "Password must be at least 6 characters" });

    const existing = await User.findOne({ email: email.toLowerCase() });
    if (existing)
      return res.status(409).json({ success: false, error: "Email already registered" });

    const WELCOME_BONUS = Number(process.env.WELCOME_BONUS) || 5000;
    const user = await User.create({ name, email, password, phone, balance: WELCOME_BONUS });

    // Record welcome bonus transaction
    await Transaction.create({
      userId:        user._id,
      type:          "bonus",
      amount:        WELCOME_BONUS,
      description:   "Welcome Bonus 🎉",
      status:        "completed",
      reference:     `WELCOME_${user._id}`,
      balanceBefore: 0,
      balanceAfter:  WELCOME_BONUS,
      completedAt:   new Date(),
    });

    const token = signToken(user._id);
    res.status(201).json({ success: true, token, user: user.toSafeJSON() });
  } catch (err) {
    console.error("Register error:", err);
    res.status(500).json({ success: false, error: "Registration failed" });
  }
});

// ═══════════════════════════════════════════════
//  POST /api/auth/login
// ═══════════════════════════════════════════════
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password)
      return res.status(400).json({ success: false, error: "Email and password required" });

    // Include password for comparison
    const user = await User.findOne({ email: email.toLowerCase() }).select("+password");
    if (!user)
      return res.status(401).json({ success: false, error: "Invalid email or password" });

    if (user.isBanned)
      return res.status(403).json({ success: false, error: "Account suspended. Contact support@crushcash.ng" });

    const isMatch = await user.comparePassword(password);
    if (!isMatch)
      return res.status(401).json({ success: false, error: "Invalid email or password" });

    user.lastActive = new Date();
    await user.save();

    const token = signToken(user._id);
    res.json({ success: true, token, user: user.toSafeJSON() });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ success: false, error: "Login failed" });
  }
});

// ═══════════════════════════════════════════════
//  GET /api/auth/me  — get current user profile
// ═══════════════════════════════════════════════
router.get("/me", protect, async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    if (!user) return res.status(404).json({ success: false, error: "User not found" });
    res.json({ success: true, user: user.toSafeJSON() });
  } catch (err) {
    res.status(500).json({ success: false, error: "Failed to fetch profile" });
  }
});

// ═══════════════════════════════════════════════
//  PUT /api/auth/bank  — save bank account details
// ═══════════════════════════════════════════════
router.put("/bank", protect, async (req, res) => {
  try {
    const { bankName, bankCode, accountNumber, accountName } = req.body;
    if (!bankName || !bankCode || !accountNumber || !accountName)
      return res.status(400).json({ success: false, error: "All bank fields required" });

    const user = await User.findByIdAndUpdate(
      req.user._id,
      { bankAccount: { bankName, bankCode, accountNumber, accountName } },
      { new: true }
    );
    res.json({ success: true, user: user.toSafeJSON() });
  } catch (err) {
    res.status(500).json({ success: false, error: "Failed to update bank account" });
  }
});

// ═══════════════════════════════════════════════
//  PUT /api/auth/password  — change password
// ═══════════════════════════════════════════════
router.put("/password", protect, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword)
      return res.status(400).json({ success: false, error: "Both passwords are required" });
    if (newPassword.length < 6)
      return res.status(400).json({ success: false, error: "New password must be 6+ characters" });

    const user = await User.findById(req.user._id).select("+password");
    const isMatch = await user.comparePassword(currentPassword);
    if (!isMatch)
      return res.status(401).json({ success: false, error: "Current password is incorrect" });

    user.password = newPassword;
    await user.save();
    res.json({ success: true, message: "Password updated successfully" });
  } catch (err) {
    res.status(500).json({ success: false, error: "Failed to update password" });
  }
});

module.exports = router;
