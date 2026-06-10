const jwt         = require("jsonwebtoken");
const User        = require("../models/User");
const GameSession = require("../models/GameSession");
const Transaction = require("../models/Transaction");
const squadco     = require("../services/squadco");

// ═══════════════════════════════════════════════════════
//  CRUSHCASH — REAL-TIME MULTIPLAYER GAME ENGINE
//  Socket.io events:
//    Client → Server: join_room, score_update, leave_room
//    Server → Client: room_joined, room_ready, game_start,
//                     score_broadcast, game_over, error
// ═══════════════════════════════════════════════════════

const GAME_DURATION   = Number(process.env.GAME_DURATION_SECONDS)  || 300; // 5 min
const COOLDOWN        = Number(process.env.COOLDOWN_DURATION_SECONDS) || 300; // 5 min
const MAX_SCORE_RATE  = 250; // max points per second (anti-cheat)
const SCORE_CHECK_INT = 10;  // check score rate every 10 seconds

// Room config
const ROOMS = {
  1:  { name:"Starter Arena",  entry:100,   maxP:2, prize:160,   cut:40   },
  2:  { name:"Bronze Arena",   entry:200,   maxP:2, prize:320,   cut:80   },
  3:  { name:"Silver Arena",   entry:500,   maxP:2, prize:800,   cut:200  },
  4:  { name:"Gold Arena",     entry:1000,  maxP:2, prize:1600,  cut:400  },
  5:  { name:"Platinum Arena", entry:2000,  maxP:2, prize:3200,  cut:800  },
  6:  { name:"Diamond Arena",  entry:5000,  maxP:2, prize:8000,  cut:2000 },
  7:  { name:"Elite Arena",    entry:10000, maxP:2, prize:16000, cut:4000 },
  8:  { name:"Quad Bronze",    entry:500,   maxP:4, prize:1600,  cut:400  },
  9:  { name:"Quad Gold",      entry:2000,  maxP:4, prize:6400,  cut:1600 },
  10: { name:"Quad Elite",     entry:5000,  maxP:4, prize:16000, cut:4000 },
};

// In-memory timers (gameSessionId → timeout handle)
const gameTimers = new Map();

// ── Authenticate socket via JWT ─────────────────────────
const authenticateSocket = async (socket, next) => {
  try {
    const token = socket.handshake.auth?.token || socket.handshake.headers?.authorization?.split(" ")[1];
    if (!token) return next(new Error("No token provided"));

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user    = await User.findById(decoded.id).select("-password");
    if (!user)          return next(new Error("User not found"));
    if (user.isBanned)  return next(new Error("Account suspended"));

    socket.user = user;
    next();
  } catch (err) {
    next(new Error("Authentication failed: " + err.message));
  }
};

// ── Pay out winner via SquadCo ──────────────────────────
const payoutWinner = async (session, winner) => {
  try {
    const user = await User.findById(winner.userId);
    if (!user) throw new Error("Winner not found");

    // Credit winner's balance in MongoDB
    const balanceBefore = user.balance;
    user.balance   += session.prize;
    user.totalWon  += 1;
    user.totalGames += 1;
    await user.save();

    // Record win transaction
    await Transaction.create({
      userId:        user._id,
      type:          "game_win",
      amount:        session.prize,
      description:   `🏆 Won — ${session.roomName}`,
      status:        "completed",
      gameSessionId: session._id,
      roomId:        session.roomId,
      balanceBefore,
      balanceAfter:  user.balance,
      completedAt:   new Date(),
    });

    // Update winner flag
    const playerIdx = session.players.findIndex(p => p.userId.toString() === winner.userId.toString());
    if (playerIdx !== -1) {
      session.players[playerIdx].paidOut = true;
      session.players[playerIdx].result  = "win";
    }

    // Update losing players stats
    await Promise.all(
      session.players
        .filter(p => p.userId.toString() !== winner.userId.toString())
        .map(async p => {
          await User.findByIdAndUpdate(p.userId, { $inc: { totalGames: 1 } });
        })
    );

    // If user has a bank account linked, optionally initiate bank transfer
    // (You can enable this for automatic bank payouts — disabled by default)
    // if (user.bankAccount?.accountNumber) {
    //   await squadco.transferToBank({ ... });
    // }

    console.log(`✅ Payout: ${user.name} won ₦${session.prize} in ${session.roomName}`);
    return true;
  } catch (err) {
    console.error("❌ Payout error:", err.message);
    return false;
  }
};

// ── End a game session ──────────────────────────────────
const endGame = async (io, session) => {
  try {
    // Determine winner (highest score, non-cheating)
    const validPlayers = session.players.filter(p => !p.flaggedForCheat);
    if (!validPlayers.length) {
      session.status = "cancelled";
      await session.save();
      io.to(`session:${session._id}`).emit("game_over", {
        cancelled: true,
        reason:    "All players were flagged for suspicious activity",
      });
      return;
    }

    const winner = validPlayers.reduce((best, p) => p.score > best.score ? p : best, validPlayers[0]);

    // Sort all players by score for final rankings
    const rankings = [...session.players]
      .sort((a, b) => b.score - a.score)
      .map((p, i) => ({
        rank:    i + 1,
        name:    p.name,
        score:   p.score,
        userId:  p.userId,
        isWinner: p.userId.toString() === winner.userId.toString(),
        flagged: p.flaggedForCheat,
      }));

    // Update session
    session.status      = "completed";
    session.endTime     = new Date();
    session.winnerId    = winner.userId;
    session.winnerName  = winner.name;
    session.winnerScore = winner.score;
    await session.save();

    // Clear timer
    const timer = gameTimers.get(session._id.toString());
    if (timer) { clearTimeout(timer); gameTimers.delete(session._id.toString()); }

    // Process payout
    const payoutSuccess = await payoutWinner(session, winner);

    // Notify all players
    io.to(`session:${session._id}`).emit("game_over", {
      rankings,
      winner: {
        name:  winner.name,
        score: winner.score,
        userId: winner.userId,
      },
      prize:         session.prize,
      payoutSuccess,
    });

    console.log(`🎮 Game over | Session ${session._id} | Winner: ${winner.name} | Score: ${winner.score}`);
  } catch (err) {
    console.error("endGame error:", err);
  }
};

// ═══════════════════════════════════════════════════════
//  MAIN SOCKET INITIALIZER
// ═══════════════════════════════════════════════════════
const initGameSocket = (io) => {
  // Apply JWT auth middleware to all sockets
  io.use(authenticateSocket);

  io.on("connection", (socket) => {
    const user = socket.user;
    console.log(`🔌 Socket connected: ${user.name} (${socket.id})`);

    // ─────────────────────────────────────────────────
    //  EVENT: join_room
    //  Payload: { roomId, sessionId }
    // ─────────────────────────────────────────────────
    socket.on("join_room", async ({ roomId, sessionId }) => {
      try {
        const roomConfig = ROOMS[roomId];
        if (!roomConfig) return socket.emit("error", { message: "Invalid room" });

        // Cooldown check
        const dbUser = await User.findById(user._id);
        const cooldownSecs = dbUser.cooldownRemaining(roomId);
        if (cooldownSecs > 0) {
          return socket.emit("error", {
            message:           `Cooldown active. Wait ${Math.ceil(cooldownSecs / 60)} more minute(s).`,
            cooldownRemaining: cooldownSecs,
          });
        }

        // Balance check
        if (dbUser.balance < roomConfig.entry) {
          return socket.emit("error", {
            message: `Insufficient balance. Need ₦${roomConfig.entry.toLocaleString()}.`,
          });
        }

        // Find or create session
        let session = sessionId
          ? await GameSession.findById(sessionId)
          : await GameSession.findOne({
              roomId,
              status: "waiting",
              $expr: { $lt: [{ $size: "$players" }, roomConfig.maxP] },
            });

        if (!session) {
          session = await GameSession.create({
            roomId,
            roomName:    roomConfig.name,
            entryFee:    roomConfig.entry,
            prize:       roomConfig.prize,
            platformCut: roomConfig.cut,
            maxPlayers:  roomConfig.maxP,
            totalPot:    roomConfig.entry * roomConfig.maxP,
            boardSeed:   Math.random().toString(36).slice(2),
          });
        }

        // Check if user already in session
        const alreadyIn = session.players.some(p => p.userId.toString() === user._id.toString());
        if (alreadyIn) {
          socket.join(`session:${session._id}`);
          return socket.emit("room_joined", { sessionId: session._id, players: session.players, alreadyJoined: true });
        }

        // Check session isn't full or started
        if (session.status !== "waiting") {
          return socket.emit("error", { message: "This session has already started" });
        }
        if (session.players.length >= roomConfig.maxP) {
          return socket.emit("error", { message: "Room is full" });
        }

        // Deduct entry fee
        const balanceBefore = dbUser.balance;
        dbUser.balance -= roomConfig.entry;
        await dbUser.save();

        // Record entry fee transaction
        await Transaction.create({
          userId:        user._id,
          type:          "game_entry",
          amount:        roomConfig.entry,
          description:   `Entry fee — ${roomConfig.name}`,
          status:        "completed",
          gameSessionId: session._id,
          roomId,
          balanceBefore,
          balanceAfter:  dbUser.balance,
          completedAt:   new Date(),
        });

        // Add player to session
        session.players.push({
          userId:        user._id,
          name:          user.name,
          score:         0,
          hasJoined:     true,
          socketId:      socket.id,
          lastCheckTime: new Date(),
        });
        await session.save();

        // Join socket room
        socket.join(`session:${session._id}`);
        socket.data.sessionId = session._id.toString();
        socket.data.roomId    = roomId;

        // Notify all players in the session
        io.to(`session:${session._id}`).emit("room_joined", {
          sessionId:  session._id,
          players:    session.players.map(p => ({ name: p.name, userId: p.userId, score: p.score })),
          playerCount: session.players.length,
          maxPlayers:  roomConfig.maxP,
          boardSeed:   session.boardSeed,
        });

        console.log(`🚪 ${user.name} joined session ${session._id} (${session.players.length}/${roomConfig.maxP})`);

        // ── Start game when session is full ──────────────
        if (session.players.length >= roomConfig.maxP) {
          session.status    = "starting";
          session.startTime = new Date(Date.now() + 3000); // 3s countdown
          await session.save();

          io.to(`session:${session._id}`).emit("game_start", {
            sessionId:  session._id,
            boardSeed:  session.boardSeed,
            startTime:  session.startTime,
            duration:   GAME_DURATION,
            players:    session.players.map(p => ({ name: p.name, userId: p.userId })),
            roomName:   roomConfig.name,
            prize:      roomConfig.prize,
          });

          // Set server-side game timer
          const timerId = setTimeout(async () => {
            const freshSession = await GameSession.findById(session._id);
            if (freshSession && freshSession.status === "in_progress") {
              await endGame(io, freshSession);
            }
          }, 3000 + GAME_DURATION * 1000);

          gameTimers.set(session._id.toString(), timerId);

          // Update status to in_progress after countdown
          setTimeout(async () => {
            await GameSession.findByIdAndUpdate(session._id, { status: "in_progress" });
          }, 3000);
        }
      } catch (err) {
        console.error("join_room error:", err);
        socket.emit("error", { message: "Failed to join room: " + err.message });
      }
    });

    // ─────────────────────────────────────────────────
    //  EVENT: score_update
    //  Payload: { sessionId, score }
    //  Called every few seconds by the client
    // ─────────────────────────────────────────────────
    socket.on("score_update", async ({ sessionId, score }) => {
      try {
        if (typeof score !== "number" || score < 0)
          return socket.emit("error", { message: "Invalid score" });

        const session = await GameSession.findById(sessionId);
        if (!session || session.status !== "in_progress") return;

        const playerIdx = session.players.findIndex(
          p => p.userId.toString() === user._id.toString()
        );
        if (playerIdx === -1) return;

        const player = session.players[playerIdx];

        // ── Anti-cheat: score rate validation ────────────
        const now           = new Date();
        const timeSinceCheck = (now - new Date(player.lastCheckTime || now)) / 1000;

        if (timeSinceCheck >= SCORE_CHECK_INT) {
          const scoreDelta = score - player.lastScoreCheck;
          const pointsPerSec = scoreDelta / timeSinceCheck;

          if (pointsPerSec > MAX_SCORE_RATE) {
            console.warn(`⚠️  Anti-cheat: ${user.name} scoring ${pointsPerSec.toFixed(0)} pts/sec — flagged`);
            session.players[playerIdx].flaggedForCheat = true;
            socket.emit("warning", { message: "Suspicious activity detected" });
          }

          session.players[playerIdx].lastScoreCheck = score;
          session.players[playerIdx].lastCheckTime  = now;
        }

        // Update score
        session.players[playerIdx].score = score;
        session.players[playerIdx].scoreHistory.push({ score, timestamp: now });
        await session.save();

        // Broadcast all scores to room
        const scoreboard = session.players.map(p => ({
          name:    p.name,
          userId:  p.userId,
          score:   p.score,
          flagged: p.flaggedForCheat,
        }));

        io.to(`session:${sessionId}`).emit("score_broadcast", { scoreboard });
      } catch (err) {
        console.error("score_update error:", err);
      }
    });

    // ─────────────────────────────────────────────────
    //  EVENT: leave_room
    // ─────────────────────────────────────────────────
    socket.on("leave_room", async ({ sessionId }) => {
      await handleLeave(socket, user, sessionId, io);
    });

    // ─────────────────────────────────────────────────
    //  DISCONNECT
    // ─────────────────────────────────────────────────
    socket.on("disconnect", async () => {
      console.log(`🔌 Disconnected: ${user.name} (${socket.id})`);
      if (socket.data.sessionId) {
        await handleLeave(socket, user, socket.data.sessionId, io);
      }
    });
  });

  console.log("🎮 Socket.io game engine initialized");
};

// ── Handle player leaving / disconnecting ──────────────
const handleLeave = async (socket, user, sessionId, io) => {
  try {
    if (!sessionId) return;
    const session = await GameSession.findById(sessionId);
    if (!session) return;

    if (session.status === "waiting") {
      // Refund entry fee if game hasn't started
      const playerIdx = session.players.findIndex(p => p.userId.toString() === user._id.toString());
      if (playerIdx !== -1) {
        const dbUser = await User.findById(user._id);
        dbUser.balance += session.entryFee;
        await dbUser.save();

        await Transaction.create({
          userId:        user._id,
          type:          "refund",
          amount:        session.entryFee,
          description:   `Refund — Left ${session.roomName} before start`,
          status:        "completed",
          gameSessionId: session._id,
          balanceBefore: dbUser.balance - session.entryFee,
          balanceAfter:  dbUser.balance,
          completedAt:   new Date(),
        });

        session.players.splice(playerIdx, 1);
        if (session.players.length === 0) {
          session.status = "cancelled";
        }
        await session.save();
        socket.emit("refunded", { amount: session.entryFee });
      }
    } else if (session.status === "in_progress") {
      // Game in progress: player forfeits, trigger early end if only 1 left
      const activePlayers = session.players.filter(p =>
        p.userId.toString() !== user._id.toString()
      );
      if (activePlayers.length <= 0) {
        // Cancel if everyone left
        const timer = gameTimers.get(sessionId);
        if (timer) { clearTimeout(timer); gameTimers.delete(sessionId); }
        session.status = "cancelled";
        await session.save();
      }
    }

    socket.leave(`session:${sessionId}`);
    io.to(`session:${sessionId}`).emit("player_left", { name: user.name });

    // Start cooldown
    const dbUser = await User.findById(user._id);
    dbUser.setCooldown(session.roomId, COOLDOWN);
    await dbUser.save();
  } catch (err) {
    console.error("handleLeave error:", err);
  }
};

module.exports = { initGameSocket };
