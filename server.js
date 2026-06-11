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
  cors: {
    origin: process.env.CLIENT_URL || "*",
    methods: ["GET","POST"],
    credentials: true,
  },
  pingTimeout: 60000,
});

// ── Force HTTPS in production ────────────────────────────
app.use((req, res, next) => {
  if (
    process.env.NODE_ENV === "production" &&
    req.headers["x-forwarded-proto"] !== "https"
  ) {
    return res.redirect(301, `https://${req.headers.host}${req.url}`);
  }
  next();
});

// ── Security headers ─────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));

// ── CORS ─────────────────────────────────────────────────
app.use(cors({
  origin: process.env.CLIENT_URL || "*",
  credentials: true,
  methods: ["GET","POST","PUT","PATCH","DELETE"],
}));

// ── Raw body for SquadCo webhook only ────────────────────
app.use("/api/wallet/webhook", express.raw({ type: "application/json" }));

// ── JSON for all other routes ─────────────────────────────
app.use(express.json({ limit: "10kb" }));
app.use(express.urlencoded({ extended: true, limit: "10kb" }));

// ── Rate limiting ─────────────────────────────────────────
applyRateLimits(app);

// ── Routes ───────────────────────────────────────────────
app.use("/api/auth",     authRoutes);
app.use("/api/wallet",   walletRoutes);
app.use("/api/game",     gameRoutes);
app.use("/api/admin",    adminRoutes);
app.use("/api/kyc",      kycRoutes);
app.use("/api/referral", referralRoutes);

// ── Health check ──────────────────────────────────────────
app.get("/api/health", (req, res) =>
  res.json({
    success:   true,
    service:   "CrushCash API v2",
    status:    "online",
    timestamp: new Date().toISOString(),
  })
);

// ── 404 ───────────────────────────────────────────────────
app.use((req, res) =>
  res.status(404).json({ success: false, error: "Route not found" })
);

// ── Global error handler ──────────────────────────────────
app.use((err, req, res, _next) => {
  console.error("Server error:", err.message);
  res.status(err.statusCode || 500).json({
    success: false,
    error: process.env.NODE_ENV === "production"
      ? "Internal server error"
      : err.message,
  });
});

// ── Socket.io game engine ─────────────────────────────────
initGameSocket(io);

// ── Start server ──────────────────────────────────────────
const PORT = process.env.PORT || 5000;

mongoose
  .connect(process.env.MONGODB_URI)
  .then(() => {
    console.log("✅ MongoDB connected");
    server.listen(PORT, () => {
      console.log(`🍬 CrushCash API running on :${PORT} [${process.env.NODE_ENV}]`);
    });
  })
  .catch((err) => {
    console.error("❌ MongoDB connection failed:", err.message);
    process.exit(1);
  });

// ── Graceful shutdown (FIXED for Node 26 + Mongoose 7+) ──
// Old code used mongoose.connection.close(callback) which is removed.
// New code uses Promise-based close.
process.on("SIGTERM", () => {
  console.log("⚠️  SIGTERM received — shutting down gracefully");
  server.close(() => {
    mongoose.connection
      .close()
      .then(() => {
        console.log("✅ MongoDB disconnected");
        process.exit(0);
      })
      .catch(() => {
        process.exit(1);
      });
  });
});

module.exports = { app, io };
