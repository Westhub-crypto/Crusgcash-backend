const mongoose = require("mongoose");
const { v4: uuidv4 } = require("uuid");

const transactionSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },

  type: {
    type: String,
    enum: ["deposit", "withdrawal", "game_entry", "game_win", "refund", "bonus"],
    required: true,
  },

  amount:      { type: Number, required: true, min: 0 },
  description: { type: String, required: true },

  status: {
    type: String,
    enum: ["pending", "completed", "failed", "processing"],
    default: "pending",
  },

  // Internal unique reference
  reference: {
    type: String,
    unique: true,
    default: () => `CC_${uuidv4().replace(/-/g, "").toUpperCase().slice(0, 16)}`,
  },

  // SquadCo transaction ref (for deposits/withdrawals)
  squadcoRef:    { type: String, index: true },
  squadcoStatus: { type: String },

  // Game context
  gameSessionId: { type: mongoose.Schema.Types.ObjectId, ref: "GameSession" },
  roomId:        { type: Number },

  // Balance snapshot
  balanceBefore: { type: Number },
  balanceAfter:  { type: Number },

  // Extra metadata (bank details for withdrawals, etc.)
  metadata: { type: Object, default: {} },

  createdAt:   { type: Date, default: Date.now },
  completedAt: { type: Date },
});

// ── Indexes ─────────────────────────────────────────────
transactionSchema.index({ userId: 1, createdAt: -1 });
transactionSchema.index({ reference: 1 });
transactionSchema.index({ status: 1, type: 1 });

module.exports = mongoose.model("Transaction", transactionSchema);
