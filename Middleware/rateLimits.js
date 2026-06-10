const rateLimit = require("express-rate-limit");

const make = (windowMs, max, msg) =>
  rateLimit({
    windowMs, max,
    standardHeaders: true,
    legacyHeaders:   false,
    message:         { success: false, error: msg },
    skipSuccessfulRequests: false,
  });

// ── Individual limiters ──────────────────────────────────
const limiters = {
  global:      make(15 * 60 * 1000, 300,  "Too many requests. Please slow down."),
  auth:        make(15 * 60 * 1000,  10,  "Too many auth attempts. Try again in 15 minutes."),
  deposit:     make(60  * 1000,       5,  "Too many deposit requests. Wait 1 minute."),
  withdraw:    make(60  * 1000,       3,  "Too many withdrawal requests. Wait 1 minute."),
  gameJoin:    make(60  * 1000,      10,  "Too many join attempts. Wait 1 minute."),
  kyc:         make(60  * 60 * 1000,  5,  "Too many KYC attempts. Try again in 1 hour."),
  referral:    make(60  * 1000,      20,  "Too many referral requests."),
  adminRead:   make(60  * 1000,      60,  "Too many admin requests."),
  scoreUpdate: make(60  * 1000,     120,  "Score update rate too high."),
};

const applyRateLimits = (app) => {
  // Global fallback on every /api/ route
  app.use("/api/", limiters.global);

  // Auth routes
  app.use("/api/auth/login",    limiters.auth);
  app.use("/api/auth/register", limiters.auth);
  app.use("/api/auth/password", limiters.auth);

  // Payment routes (strictest)
  app.use("/api/wallet/deposit",  limiters.deposit);
  app.use("/api/wallet/withdraw", limiters.withdraw);

  // Game join
  app.use("/api/game/join", limiters.gameJoin);

  // KYC
  app.use("/api/kyc", limiters.kyc);

  // Referral
  app.use("/api/referral", limiters.referral);

  // Admin
  app.use("/api/admin", limiters.adminRead);
};

module.exports = { applyRateLimits, limiters };
