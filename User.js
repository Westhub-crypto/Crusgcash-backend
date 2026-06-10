const mongoose = require("mongoose");
const bcrypt   = require("bcryptjs");

const userSchema = new mongoose.Schema({
  name:     { type: String, required: true, trim: true, maxlength: 60 },
  email:    { type: String, required: true, unique: true, lowercase: true, trim: true },
  password: { type: String, required: true, minlength: 6, select: false },
  phone:    { type: String, trim: true },

  // Wallet
  balance: { type: Number, default: 0, min: 0 },

  // Stats
  totalWon:   { type: Number, default: 0 },
  totalGames: { type: Number, default: 0 },

  // Account flags
  isAdmin:  { type: Boolean, default: false },
  isBanned: { type: Boolean, default: false },
  banReason:{ type: String },

  // ── KYC (NIN only) ──────────────────────────────────
  kycStatus: {
    type: String,
    enum: ["none", "pending", "verified", "rejected"],
    default: "none",
  },
  kycData: {
    nin:           { type: String, select: false }, // store masked or hashed
    verifiedAt:    { type: Date },
    rejectedReason:{ type: String },
  },

  // ── Referral System ─────────────────────────────────
  referralCode: { type: String, unique: true, sparse: true },
  referredBy:   { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  referralEarnings: { type: Number, default: 0 },
  firstGamePlayed:  { type: Boolean, default: false },

  // ── Promo ────────────────────────────────────────────
  promoApplied: { type: Boolean, default: false },

  // ── Fraud detection ──────────────────────────────────
  fraudFlags:   { type: Number, default: 0 },
  fraudFlagged: { type: Boolean, default: false },
  fraudHistory: [{
    reason:    String,
    sessionId: mongoose.Schema.Types.ObjectId,
    score:     Number,
    timestamp: { type: Date, default: Date.now },
  }],

  // Bank account for withdrawals
  bankAccount: {
    bankName:      String,
    bankCode:      String,
    accountNumber: String,
    accountName:   String,
  },

  // Per-room cooldown: roomId → expiry Date
  cooldowns: { type: Map, of: Date, default: {} },

  lastActive: { type: Date, default: Date.now },
  createdAt:  { type: Date, default: Date.now },
});

userSchema.index({ email: 1 });
userSchema.index({ referralCode: 1 });

// ── Pre-save hooks ───────────────────────────────────────
userSchema.pre("save", async function (next) {
  // Hash password if changed
  if (this.isModified("password")) {
    this.password = await bcrypt.hash(this.password, 12);
  }
  // Generate unique referral code on first save
  if (this.isNew && !this.referralCode) {
    const { nanoid } = require("nanoid");
    this.referralCode = nanoid(8).toUpperCase();
  }
  next();
});

// ── Instance methods ─────────────────────────────────────
userSchema.methods.comparePassword = function (candidate) {
  return bcrypt.compare(candidate, this.password);
};

userSchema.methods.toSafeJSON = function () {
  const o = this.toObject();
  delete o.password;
  if (o.kycData) delete o.kycData.nin;
  return o;
};

userSchema.methods.cooldownRemaining = function (roomId) {
  const exp = this.cooldowns.get(String(roomId));
  if (!exp || exp <= new Date()) return 0;
  return Math.ceil((exp - Date.now()) / 1000);
};

userSchema.methods.setCooldown = function (roomId, seconds) {
  this.cooldowns.set(String(roomId), new Date(Date.now() + seconds * 1000));
};

module.exports = mongoose.model("User", userSchema);
