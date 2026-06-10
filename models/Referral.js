const mongoose = require("mongoose");

const referralSchema = new mongoose.Schema({
  referrerId:    { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  referredId:    { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  referralCode:  { type: String, required: true },

  // Bonuses
  signupBonus:   { type: Number, default: 500  }, // ₦500 given to new user on signup
  referrerBonus: { type: Number, default: 50   }, // ₦50 given to referrer when friend plays first game

  // Status
  status: {
    type: String,
    enum: ["registered", "played", "rewarded"],
    default: "registered",
  },

  signupBonusPaid:  { type: Boolean, default: false },
  referrerPaid:     { type: Boolean, default: false },
  referrerPaidAt:   { type: Date },

  createdAt: { type: Date, default: Date.now },
});

referralSchema.index({ referrerId: 1 });
referralSchema.index({ referredId: 1, unique: true });

module.exports = mongoose.model("Referral", referralSchema);
