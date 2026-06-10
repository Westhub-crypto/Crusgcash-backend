const express             = require("express");
const User                = require("../models/User");
const Transaction         = require("../models/Transaction");
const GameSession         = require("../models/GameSession");
const { protect, adminOnly } = require("../middleware/auth");

const router = express.Router();

// All admin routes require auth + admin flag
router.use(protect, adminOnly);

// ═══════════════════════════════════════════════
//  GET /api/admin/stats  — platform overview
// ═══════════════════════════════════════════════
router.get("/stats", async (req, res) => {
  try {
    const now        = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const weekStart  = new Date(now - 7 * 24 * 60 * 60 * 1000);

    const [
      totalUsers,
      activeToday,
      totalDeposits,
      totalWithdrawals,
      totalEntryFees,
      totalPrizesPaid,
      todayDeposits,
      todayGames,
      totalGames,
      pendingWithdrawals,
    ] = await Promise.all([
      User.countDocuments(),
      User.countDocuments({ lastActive: { $gte: todayStart } }),
      Transaction.aggregate([{ $match: { type: "deposit",    status: "completed" } }, { $group: { _id: null, total: { $sum: "$amount" } } }]),
      Transaction.aggregate([{ $match: { type: "withdrawal", status: "completed" } }, { $group: { _id: null, total: { $sum: "$amount" } } }]),
      Transaction.aggregate([{ $match: { type: "game_entry", status: "completed" } }, { $group: { _id: null, total: { $sum: "$amount" } } }]),
      Transaction.aggregate([{ $match: { type: "game_win",   status: "completed" } }, { $group: { _id: null, total: { $sum: "$amount" } } }]),
      Transaction.aggregate([{ $match: { type: "deposit", status: "completed", createdAt: { $gte: todayStart } } }, { $group: { _id: null, total: { $sum: "$amount" } } }]),
      GameSession.countDocuments({ status: "completed", createdAt: { $gte: todayStart } }),
      GameSession.countDocuments({ status: "completed" }),
      Transaction.countDocuments({ type: "withdrawal", status: "processing" }),
    ]);

    const entryTotal  = totalEntryFees[0]?.total  || 0;
    const prizesTotal = totalPrizesPaid[0]?.total  || 0;
    const platformRevenue = entryTotal * 0.20; // 20% of all entry fees

    res.json({
      success: true,
      stats: {
        users: {
          total:       totalUsers,
          activeToday,
        },
        revenue: {
          totalDeposits:      totalDeposits[0]?.total    || 0,
          totalWithdrawals:   totalWithdrawals[0]?.total || 0,
          totalEntryFees:     entryTotal,
          totalPrizesPaid:    prizesTotal,
          platformRevenue,
          todayDeposits:      todayDeposits[0]?.total    || 0,
        },
        games: {
          totalCompleted:    totalGames,
          completedToday:    todayGames,
          pendingWithdrawals,
        },
      },
    });
  } catch (err) {
    console.error("Admin stats error:", err);
    res.status(500).json({ success: false, error: "Failed to fetch stats" });
  }
});

// ═══════════════════════════════════════════════
//  GET /api/admin/users  — paginated user list
// ═══════════════════════════════════════════════
router.get("/users", async (req, res) => {
  try {
    const { page = 1, limit = 20, search, status } = req.query;
    const query = {};
    if (search) query.$or = [{ name: new RegExp(search, "i") }, { email: new RegExp(search, "i") }];
    if (status === "banned") query.isBanned = true;
    if (status === "active") query.isBanned = false;

    const [users, total] = await Promise.all([
      User.find(query)
        .select("-password")
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(Number(limit))
        .lean(),
      User.countDocuments(query),
    ]);

    res.json({
      success: true,
      users,
      pagination: { page: Number(page), limit: Number(limit), total, pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: "Failed to fetch users" });
  }
});

// ═══════════════════════════════════════════════
//  GET /api/admin/users/:id  — single user detail
// ═══════════════════════════════════════════════
router.get("/users/:id", async (req, res) => {
  try {
    const [user, transactions, games] = await Promise.all([
      User.findById(req.params.id).select("-password").lean(),
      Transaction.find({ userId: req.params.id }).sort({ createdAt: -1 }).limit(20).lean(),
      GameSession.find({ "players.userId": req.params.id }).sort({ createdAt: -1 }).limit(10).lean(),
    ]);
    if (!user) return res.status(404).json({ success: false, error: "User not found" });
    res.json({ success: true, user, transactions, games });
  } catch (err) {
    res.status(500).json({ success: false, error: "Failed to fetch user" });
  }
});

// ═══════════════════════════════════════════════
//  PATCH /api/admin/users/:id/ban  — ban/unban user
// ═══════════════════════════════════════════════
router.patch("/users/:id/ban", async (req, res) => {
  try {
    const { ban, reason } = req.body;
    const user = await User.findByIdAndUpdate(
      req.params.id,
      { isBanned: ban, banReason: ban ? reason : undefined },
      { new: true }
    ).select("-password");
    if (!user) return res.status(404).json({ success: false, error: "User not found" });
    res.json({ success: true, user, message: ban ? "User banned" : "User unbanned" });
  } catch (err) {
    res.status(500).json({ success: false, error: "Failed to update user status" });
  }
});

// ═══════════════════════════════════════════════
//  POST /api/admin/users/:id/credit
//  Manually credit a user's balance (e.g. dispute resolution)
// ═══════════════════════════════════════════════
router.post("/users/:id/credit", async (req, res) => {
  try {
    const { amount, reason } = req.body;
    if (!amount || amount <= 0)
      return res.status(400).json({ success: false, error: "Valid amount required" });

    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ success: false, error: "User not found" });

    const balanceBefore = user.balance;
    user.balance += Number(amount);
    await user.save();

    await Transaction.create({
      userId:        user._id,
      type:          "bonus",
      amount:        Number(amount),
      description:   reason || "Admin manual credit",
      status:        "completed",
      balanceBefore,
      balanceAfter:  user.balance,
      completedAt:   new Date(),
      metadata:      { adminId: req.user._id },
    });

    res.json({ success: true, message: `₦${Number(amount).toLocaleString()} credited`, newBalance: user.balance });
  } catch (err) {
    res.status(500).json({ success: false, error: "Failed to credit user" });
  }
});

// ═══════════════════════════════════════════════
//  GET /api/admin/transactions  — all transactions
// ═══════════════════════════════════════════════
router.get("/transactions", async (req, res) => {
  try {
    const { page = 1, limit = 25, type, status } = req.query;
    const query = {};
    if (type)   query.type   = type;
    if (status) query.status = status;

    const [transactions, total] = await Promise.all([
      Transaction.find(query)
        .populate("userId", "name email")
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
//  GET /api/admin/sessions  — all game sessions
// ═══════════════════════════════════════════════
router.get("/sessions", async (req, res) => {
  try {
    const { page = 1, limit = 20, status, roomId } = req.query;
    const query = {};
    if (status) query.status = status;
    if (roomId) query.roomId = Number(roomId);

    const [sessions, total] = await Promise.all([
      GameSession.find(query)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(Number(limit))
        .lean(),
      GameSession.countDocuments(query),
    ]);

    res.json({ success: true, sessions, pagination: { page: Number(page), limit: Number(limit), total } });
  } catch (err) {
    res.status(500).json({ success: false, error: "Failed to fetch sessions" });
  }
});

module.exports = router;
