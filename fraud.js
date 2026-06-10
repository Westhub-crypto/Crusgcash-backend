const User = require("../models/User");

// ═══════════════════════════════════════════════════════
//  FRAUD DETECTION SERVICE
//  Monitors: score velocity, impossible scores, repeat offenders
// ═══════════════════════════════════════════════════════

const MAX_RATE       = Number(process.env.MAX_SCORE_RATE)        || 300; // pts/sec
const MAX_FLAGS      = Number(process.env.MAX_FLAGS_BEFORE_BAN)  || 3;
const MAX_GAME_SCORE = 80000; // Absolute cap — impossible to exceed legitimately
const CHECK_INTERVAL = 10;    // Check score rate every 10 seconds

// ── Analyse a score update ────────────────────────────────
const analyseScore = ({ player, newScore, elapsedSeconds }) => {
  const issues = [];

  // 1. Absolute maximum check
  if (newScore > MAX_GAME_SCORE) {
    issues.push({ type: "IMPOSSIBLE_SCORE", detail: `Score ${newScore} exceeds absolute max ${MAX_GAME_SCORE}` });
  }

  // 2. Score rate check (every CHECK_INTERVAL seconds)
  if (player.lastCheckTime) {
    const timeSince = (Date.now() - new Date(player.lastCheckTime).getTime()) / 1000;
    if (timeSince >= CHECK_INTERVAL) {
      const delta      = newScore - (player.lastScoreCheck || 0);
      const rate       = delta / timeSince;
      if (rate > MAX_RATE) {
        issues.push({ type: "HIGH_SCORE_RATE", detail: `${rate.toFixed(0)} pts/sec > max ${MAX_RATE}` });
      }
    }
  }

  // 3. Score must never decrease (sanity check)
  if (newScore < (player.score || 0)) {
    issues.push({ type: "SCORE_DECREASED", detail: `Score dropped from ${player.score} to ${newScore}` });
  }

  return {
    suspicious: issues.length > 0,
    issues,
    shouldDisqualify: issues.some(i => i.type === "IMPOSSIBLE_SCORE" || i.type === "HIGH_SCORE_RATE"),
  };
};

// ── Flag a user in the database ───────────────────────────
const flagUser = async ({ userId, sessionId, score, reason }) => {
  try {
    const user = await User.findById(userId);
    if (!user) return;

    user.fraudFlags += 1;
    user.fraudHistory.push({ reason, sessionId, score, timestamp: new Date() });

    // Auto-ban after threshold
    if (user.fraudFlags >= MAX_FLAGS && !user.isBanned) {
      user.isBanned   = true;
      user.banReason  = `Auto-banned: ${user.fraudFlags} fraud flags. Last: ${reason}`;
      user.fraudFlagged = true;
      console.warn(`🚨 AUTO-BAN: ${user.name} (${user.email}) — ${user.fraudFlags} flags`);
    }

    await user.save();
    console.warn(`⚠️  Fraud flag #${user.fraudFlags} for ${user.name}: ${reason}`);
    return { flagCount: user.fraudFlags, autoBanned: user.isBanned };
  } catch (err) {
    console.error("flagUser error:", err.message);
  }
};

// ── Check if user is already flagged (pre-game) ───────────
const isSuspectUser = async (userId) => {
  const user = await User.findById(userId).select("fraudFlags fraudFlagged isBanned");
  return user?.fraudFlagged || user?.isBanned || false;
};

// ── Generate a fraud report for admin ────────────────────
const getFraudReport = async () => {
  const flagged = await User.find({ fraudFlags: { $gt: 0 } })
    .select("name email fraudFlags fraudFlagged isBanned fraudHistory createdAt")
    .sort({ fraudFlags: -1 })
    .limit(50);
  return flagged;
};

module.exports = { analyseScore, flagUser, isSuspectUser, getFraudReport, MAX_RATE, CHECK_INTERVAL };
