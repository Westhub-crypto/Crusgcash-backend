const jwt  = require("jsonwebtoken");
const User = require("../models/User");

// ── Protect: require valid JWT ──────────────────────────
const protect = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ success: false, error: "No token provided. Please log in." });
    }

    const token = authHeader.split(" ")[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    const user = await User.findById(decoded.id).select("-password");
    if (!user) {
      return res.status(401).json({ success: false, error: "User no longer exists." });
    }
    if (user.isBanned) {
      return res.status(403).json({ success: false, error: "Account suspended. Contact support." });
    }

    req.user = user;
    next();
  } catch (err) {
    if (err.name === "JsonWebTokenError")  return res.status(401).json({ success: false, error: "Invalid token." });
    if (err.name === "TokenExpiredError")  return res.status(401).json({ success: false, error: "Token expired. Please log in again." });
    return res.status(500).json({ success: false, error: "Authentication error." });
  }
};

// ── Admin Only ──────────────────────────────────────────
const adminOnly = (req, res, next) => {
  if (!req.user?.isAdmin) {
    return res.status(403).json({ success: false, error: "Admin access required." });
  }
  next();
};

// ── Optional Auth: attach user if token present ─────────
const optionalAuth = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith("Bearer ")) {
      const token   = authHeader.split(" ")[1];
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      req.user = await User.findById(decoded.id).select("-password");
    }
  } catch (_) { /* No user — that's fine */ }
  next();
};

module.exports = { protect, adminOnly, optionalAuth };
