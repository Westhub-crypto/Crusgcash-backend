require("dotenv").config();
const express    = require("express");
const http       = require("http");
const { Server } = require("socket.io");
const mongoose   = require("mongoose");
const cors       = require("cors");
const helmet     = require("helmet");
const { applyRateLimits } = require("./middleware/rateLimits");

const authRoutes     = require("./routes/auth");
const walletRoutes   = require("./routes/wallet");
const gameRoutes     = require("./routes/game");
const adminRoutes    = require("./routes/admin");
const kycRoutes      = require("./routes/kyc");
const referralRoutes = require("./routes/referral");
const { initGameSocket } = require("./socket/gameSocket");

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: process.env.CLIENT_URL || "*", methods: ["GET","POST"], credentials: true },
  pingTimeout: 60000,
});

// ── Force HTTPS in production ───────────────────────────
app.use((req, res, next) => {
  if (process.env.NODE_ENV === "production" && req.headers["x-forwarded-proto"] !== "https") {
    return res.redirect(301, `https://${req.headers.host}${req.url}`);
  }
  next();
});

// ── Security headers ────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: false, // Adjust if serving HTML
  crossOriginEmbedderPolicy: false,
}));

// ── CORS ────────────────────────────────────────────────
app.use(cors({
  origin: process.env.CLIENT_URL || "*",
  credentials: true,
  methods: ["GET","POST","PUT","PATCH","DELETE"],
}));

// ── Raw body ONLY for SquadCo webhook ───────────────────
app.use("/api/wallet/webhook", express.raw({ type: "application/json" }));

// ── JSON for all other routes ───────────────────────────
app.use(express.json({ limit: "10kb" }));
app.use(express.urlencoded({ extended: true, limit: "10kb" }));

// ── Rate limiting (comprehensive) ───────────────────────
applyRateLimits(app);

// ── Routes ──────────────────────────────────────────────
app.use("/api/auth",     authRoutes);
app.use("/api/wallet",   walletRoutes);
app.use("/api/game",     gameRoutes);
app.use("/api/admin",    adminRoutes);
app.use("/api/kyc",      kycRoutes);
app.use("/api/referral", referralRoutes);

// ── Health check ─────────────────────────────────────────
app.get("/api/health", (req, res) =>
  res.json({ success: true, service: "CrushCash API v2", ts: new Date().toISOString() })
);

// ── 404 ─────────────────────────────────────────────────
app.use((req, res) => res.status(404).json({ success: false, error: "Not found" }));

// ── Global error handler ─────────────────────────────────
app.use((err, req, res, _next) => {
  console.error("Server error:", err.message);
  res.status(err.statusCode || 500).json({
    success: false,
    error: process.env.NODE_ENV === "production" ? "Server error" : err.message,
  });
});

// ── Socket.io ────────────────────────────────────────────
initGameSocket(io);

// ── Start ────────────────────────────────────────────────
const PORT = process.env.PORT || 5000;
mongoose.connect(process.env.MONGODB_URI)
  .then(() => {
    console.log("✅ MongoDB connected");
    server.listen(PORT, () => console.log(`🍬 CrushCash API running on :${PORT} [${process.env.NODE_ENV}]`));
  })
  .catch(err => { console.error("❌ MongoDB error:", err.message); process.exit(1); });

process.on("SIGTERM", () => {
  server.close(() => mongoose.connection.close(false, () => process.exit(0)));
});

module.exports = { app, io };
