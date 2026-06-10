const mongoose = require("mongoose");

const playerSchema = new mongoose.Schema({
  userId:          { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  name:            String,
  score:           { type: Number, default: 0 },
  scoreHistory:    [{ score: Number, ts: Date }],
  lastScoreCheck:  { type: Number, default: 0 },
  lastCheckTime:   Date,
  flaggedForCheat: { type: Boolean, default: false },
  hasJoined:       { type: Boolean, default: false },
  result:          { type: String, enum: ["win","loss","pending"], default: "pending" },
  paidOut:         { type: Boolean, default: false },
  socketId:        String,
}, { _id: false });

const emojiEventSchema = new mongoose.Schema({
  fromName: String,
  emoji:    String,
  ts:       { type: Date, default: Date.now },
}, { _id: false });

const gameSessionSchema = new mongoose.Schema({
  roomId:      { type: Number, required: true },
  roomName:    String,
  entryFee:    Number,
  prize:       Number,
  platformCut: Number,
  maxPlayers:  Number,
  totalPot:    Number,
  players:     [playerSchema],
  emojiLog:    [emojiEventSchema],
  status: {
    type: String,
    enum: ["waiting","starting","in_progress","completed","cancelled"],
    default: "waiting",
  },
  startTime:   Date,
  endTime:     Date,
  winnerId:    { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  winnerName:  String,
  winnerScore: Number,
  winnerPaid:  { type: Boolean, default: false },
  boardSeed:   String,
  createdAt:   { type: Date, default: Date.now },
});

gameSessionSchema.index({ roomId: 1, status: 1 });
gameSessionSchema.index({ "players.userId": 1 });

module.exports = mongoose.model("GameSession", gameSessionSchema);
