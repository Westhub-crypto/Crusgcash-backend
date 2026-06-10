const express     = require("express");
const User        = require("../models/User");
const GameSession = require("../models/GameSession");
const Transaction = require("../models/Transaction");
const { protect } = require("../middleware/auth");

const router = express.Router();

// ── Room configuration (mirrors the frontend) ───────────
const ROOMS = [
  { id:1,  name:"Starter Arena",  entry:100,   maxP:2, prize:160,   cut:40   },
  { id:2,  name:"Bronze Arena",   entry:200,   maxP:2, prize:320,   cut:80   },
  { id:3,  name:"Silver Arena",   entry:500,   maxP:2, prize:800,   cut:200  },
  { id:4,  name:"Gold Arena",     entry:1000,  maxP:2, prize:1600,  cut:400  },
  { id:5,  name:"Platinum Arena", entry:2000,  maxP:2, prize:3200,  cut:800  },
  { id:6,  name:"Diamond Arena",  entry:5000,  maxP:2, prize:8000,  cut:2000 },
  { id:7,  name:"Elite Arena",    entry:10000, maxP:2, prize:16000, cut:4000 },
  { id:8,  name:"Quad Bronze",    entry:500,   maxP:4, prize:1600,  cut:400  },
  { id:9,  name:"Quad Gold",      entry:2000,  maxP:4, prize:6400,  cut:1600 },
  { id:10, name:"Quad Elite",     entry:5000,  maxP:4, prize:16000, cut:4000 },
];

const getRoomById = (id) => ROOMS.find((r) => r.id === Number(id));

// ═══════════════════════════════════════════════
//  GET /api/game/rooms  — list all rooms + status
// ═══════════════════════════════════════════════
router.get("/rooms", async (req, res) => {
  try {
    // Count active sessions per room
    const activeSessions = await GameSession.aggregate([
      { $match: { status: { $in: ["waiting", "in_progress"] } } },
      { $group: { _id: "$roomId", count: { $sum: 1 }, playerCount: { $sum: { $size: "$players" } } } },
    ]);

    const sessionMap = {};
    activeSessions.forEach((s) => { sessionMap[s._id] = s; });

    const rooms = ROOMS.map((r) => {
      const session = sessionMap[r.id];
      return {
        ...r,
        totalPot:     r.entry * r.maxP,
        activePlayers: session?.playerCount || 0,
        activeSessions: session?.count || 0,
      };
    });

    res.json({ success: true, rooms });
  } catch (err) {
    res.status(500).json({ success: false, error: "Failed to fetch rooms" });
  }
});

// ═══════════════════════════════════════════════
//  GET /api/game/cooldown/:roomId
//  Check if the current user has an active cooldown
// ═══════════════════════════════════════════════
router.get("/cooldown/:roomId", protect, async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    const remaining = user.cooldownRemaining(req.params.roomId);
    res.json({ success: true, hasCooldown: remaining > 0, remainingSeconds: remaining });
  } catch (err) {
    res.status(500).json({ success: false, error: "Failed to check cooldown" });
  }
});

// ═══════════════════════════════════════════════
//  POST /api/game/join/:roomId
//  Pre-join validation — socket.io handles actual joining
//  Returns a session token the socket uses to authenticate
// ═══════════════════════════════════════════════
router.post("/join/:roomId", protect, async (req, res) => {
  try {
    const room = getRoomById(req.params.roomId);
    if (!room) return res.status(404).json({ success: false, error: "Room not found" });

    const user = await User.findById(req.user._id);

    // Cooldown check
    const cooldownSecs = user.cooldownRemaining(room.id);
    if (cooldownSecs > 0) {
      return res.status(429).json({
        success: false,
        error: `You're in cooldown for this room. Try again in ${Math.ceil(cooldownSecs / 60)} minute(s).`,
        cooldownRemaining: cooldownSecs,
      });
    }

    // Balance check
    if (user.balance < room.entry) {
      return res.status(400).json({
        success: false,
        error: `Insufficient balance. You need ₦${room.entry.toLocaleString()} to join.`,
      });
    }

    // Check if user is already in an active session for this room
    const existing = await GameSession.findOne({
      roomId: room.id,
      status: { $in: ["waiting", "in_progress"] },
      "players.userId": user._id,
    });
    if (existing) {
      return res.json({ success: true, sessionId: existing._id, alreadyJoined: true });
    }

    // Find a waiting session or create one
    let session = await GameSession.findOne({
      roomId: room.id,
      status: "waiting",
      $expr: { $lt: [{ $size: "$players" }, room.maxP] },
    });

    if (!session) {
      session = await GameSession.create({
        roomId:      room.id,
        roomName:    room.name,
        entryFee:    room.entry,
        prize:       room.prize,
        platformCut: room.cut,
        maxPlayers:  room.maxP,
        totalPot:    room.entry * room.maxP,
        players:     [],
        boardSeed:   Math.random().toString(36).slice(2),
      });
    }

    res.json({ success: true, sessionId: session._id, roomId: room.id });
  } catch (err) {
    console.error("Join room error:", err);
    res.status(500).json({ success: false, error: "Failed to join room" });
  }
});

// ═══════════════════════════════════════════════
//  GET /api/game/history
//  Get current user's game history
// ═══════════════════════════════════════════════
router.get("/history", protect, async (req, res) => {
  try {
    const { page = 1, limit = 10 } = req.query;

    const sessions = await GameSession.find({
      "players.userId": req.user._id,
      status: "completed",
    })
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(Number(limit))
      .lean();

    const history = sessions.map((s) => {
      const me = s.players.find((p) => p.userId.toString() === req.user._id.toString());
      return {
        sessionId:   s._id,
        roomId:      s.roomId,
        roomName:    s.roomName,
        entryFee:    s.entryFee,
        prize:       s.prize,
        myScore:     me?.score || 0,
        myResult:    me?.result || "pending",
        winner:      s.winnerName,
        winnerScore: s.winnerScore,
        playedAt:    s.createdAt,
        duration:    s.startTime && s.endTime
          ? Math.round((new Date(s.endTime) - new Date(s.startTime)) / 1000)
          : null,
      };
    });

    const total = await GameSession.countDocuments({
      "players.userId": req.user._id,
      status: "completed",
    });

    res.json({
      success: true,
      history,
      pagination: { page: Number(page), limit: Number(limit), total },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: "Failed to fetch game history" });
  }
});

// ═══════════════════════════════════════════════
//  GET /api/game/leaderboard
//  Top 20 players by total winnings
// ═══════════════════════════════════════════════
router.get("/leaderboard", async (req, res) => {
  try {
    const leaders = await User.find({ isBanned: false })
      .select("name totalWon totalGames")
      .sort({ totalWon: -1 })
      .limit(20)
      .lean();

    const leaderboard = leaders.map((u, i) => ({
      rank:       i + 1,
      name:       u.name,
      totalWon:   u.totalWon,
      totalGames: u.totalGames,
      winRate:    u.totalGames > 0 ? Math.round((u.totalWon / u.totalGames) * 100) : 0,
    }));

    res.json({ success: true, leaderboard });
  } catch (err) {
    res.status(500).json({ success: false, error: "Failed to fetch leaderboard" });
  }
});

module.exports = router;
