const axios = require("axios");

// ═══════════════════════════════════════════════════════
//  NIN VERIFICATION SERVICE
//  Provider: Youverify (https://youverify.co)
//  Alternative: Smile Identity / NIBSS
//  Sign up at: https://dashboard.youverify.co
// ═══════════════════════════════════════════════════════

const BASE_URL = process.env.NIN_VERIFY_BASE_URL || "https://api.youverify.co/v2";
const API_KEY  = process.env.NIN_VERIFY_API_KEY;

const client = axios.create({
  baseURL: BASE_URL,
  headers: { token: API_KEY, "Content-Type": "application/json" },
  timeout: 20000,
});

// ── Validate NIN format locally (fast, free) ─────────────
const validateNINFormat = (nin) => {
  if (!nin) return { valid: false, error: "NIN is required" };
  const cleaned = nin.replace(/\s/g, "");
  if (!/^\d{11}$/.test(cleaned))
    return { valid: false, error: "NIN must be exactly 11 digits" };
  return { valid: true, nin: cleaned };
};

// ── Verify NIN with Youverify API ────────────────────────
const verifyNIN = async ({ nin, firstName, lastName }) => {
  // 1. Validate format first
  const fmt = validateNINFormat(nin);
  if (!fmt.valid) return { success: false, error: fmt.error };

  // 2. If no API key, run in development mode (format-only)
  if (!API_KEY || process.env.NODE_ENV === "development") {
    console.warn("⚠️  NIN_VERIFY_API_KEY not set — using dev mode (format check only)");
    return {
      success:   true,
      verified:  true,
      devMode:   true,
      message:   "NIN format valid (dev mode — not verified with NIMC)",
      data: { nin: fmt.nin, firstName, lastName },
    };
  }

  // 3. Call Youverify API
  try {
    const { data } = await client.post("/identity/ng/nin", {
      id:          fmt.nin,
      isSubjectConsent: true,
    });

    if (!data.success || !data.data)
      return { success: false, error: data.message || "NIN verification failed" };

    const result = data.data;

    // Optional: name match check
    const firstMatch = result.firstName?.toLowerCase().includes(firstName.toLowerCase());
    const lastMatch  = result.lastName?.toLowerCase().includes(lastName.toLowerCase());
    if (!firstMatch || !lastMatch) {
      return {
        success: false,
        error:   "NIN does not match the name on your account. Please check your details.",
      };
    }

    return {
      success:  true,
      verified: true,
      data: {
        nin:       fmt.nin,
        firstName: result.firstName,
        lastName:  result.lastName,
        dob:       result.dateOfBirth,
        gender:    result.gender,
        photo:     result.photo,
      },
    };
  } catch (err) {
    console.error("NIN verification error:", err?.response?.data || err.message);
    const msg = err?.response?.data?.message || "NIN verification service unavailable";
    return { success: false, error: msg };
  }
};

// ── Mask NIN for storage (show only last 4 digits) ────────
const maskNIN = (nin) => `*******${nin.slice(-4)}`;

module.exports = { verifyNIN, validateNINFormat, maskNIN };
