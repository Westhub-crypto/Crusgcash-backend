const axios  = require("axios");
const crypto = require("crypto");

// ═══════════════════════════════════════════════════════
//  SQUADCO PAYMENT SERVICE
//  Docs: https://squadinc.gitbook.io/squad-api-documentation
// ═══════════════════════════════════════════════════════

const BASE_URL    = process.env.SQUADCO_BASE_URL    || "https://sandbox-api-d.squadco.com";
const SECRET_KEY  = process.env.SQUADCO_SECRET_KEY;
const WEBHOOK_SEC = process.env.SQUADCO_WEBHOOK_SECRET;

// ── Axios instance with auth header ────────────────────
const squadco = axios.create({
  baseURL: BASE_URL,
  headers: {
    Authorization: `Bearer ${SECRET_KEY}`,
    "Content-Type": "application/json",
  },
  timeout: 30000,
});

// ── Convert ₦ Naira → kobo (SquadCo uses kobo) ─────────
const toKobo  = (naira)  => Math.round(naira * 100);
const toNaira = (kobo)   => kobo / 100;

// ═══════════════════════════════════════════════════════
//  1. INITIATE PAYMENT (Deposit)
//     Returns a payment URL for the frontend to open
// ═══════════════════════════════════════════════════════
const initiatePayment = async ({ email, amountNaira, reference, callbackUrl, metadata = {} }) => {
  try {
    const payload = {
      email,
      amount:           toKobo(amountNaira),
      currency:         "NGN",
      initiate_type:    "inline",                // Opens SquadCo inline checkout
      transaction_ref:  reference,
      callback_url:     callbackUrl || `${process.env.CLIENT_URL}/wallet?status=success`,
      pass_charge:      false,                   // Platform absorbs the transaction fee
      customer_name:    metadata.name || email,
    };

    const { data } = await squadco.post("/transaction/initiate", payload);

    if (data.success && data.data) {
      return {
        success:        true,
        checkoutUrl:    data.data.checkout_url,
        transactionRef: data.data.transaction_ref,
        amountKobo:     data.data.amount,
      };
    }
    throw new Error(data.message || "Failed to initiate payment");
  } catch (err) {
    console.error("SquadCo initiatePayment error:", err?.response?.data || err.message);
    throw new Error(err?.response?.data?.message || "Payment initiation failed");
  }
};

// ═══════════════════════════════════════════════════════
//  2. VERIFY PAYMENT
//     Call after user returns from checkout page
// ═══════════════════════════════════════════════════════
const verifyPayment = async (transactionRef) => {
  try {
    const { data } = await squadco.get(`/transaction/verify/${transactionRef}`);

    if (data.success && data.data) {
      const tx = data.data;
      return {
        success:        true,
        reference:      tx.transaction_ref,
        status:         tx.transaction_status,   // "success" | "failed" | "pending"
        amountNaira:    toNaira(tx.amount),
        email:          tx.email,
        isSuccess:      tx.transaction_status === "success",
      };
    }
    throw new Error(data.message || "Verification failed");
  } catch (err) {
    console.error("SquadCo verifyPayment error:", err?.response?.data || err.message);
    throw new Error(err?.response?.data?.message || "Payment verification failed");
  }
};

// ═══════════════════════════════════════════════════════
//  3. TRANSFER TO BANK (Withdrawal / Prize Payout)
//     Used to send winnings directly to a player's bank
// ═══════════════════════════════════════════════════════
const transferToBank = async ({
  bankCode,
  accountNumber,
  accountName,
  amountNaira,
  reference,
  narration = "CrushCash Payout",
}) => {
  try {
    const payload = {
      bank_code:             bankCode,
      account_number:        accountNumber,
      account_name:          accountName,
      amount:                toKobo(amountNaira),
      transaction_reference: reference,
      narration,
      currency_id:           "NGN",
    };

    const { data } = await squadco.post("/payout/transfer", payload);

    if (data.success) {
      return {
        success:   true,
        reference: data.data?.transaction_reference,
        status:    data.data?.status,
      };
    }
    throw new Error(data.message || "Transfer failed");
  } catch (err) {
    console.error("SquadCo transferToBank error:", err?.response?.data || err.message);
    throw new Error(err?.response?.data?.message || "Bank transfer failed");
  }
};

// ═══════════════════════════════════════════════════════
//  4. VERIFY WEBHOOK SIGNATURE
//     SquadCo signs every webhook with HMAC-SHA512
//     Call this at the start of your webhook handler
// ═══════════════════════════════════════════════════════
const verifyWebhookSignature = (rawBody, signatureHeader) => {
  if (!WEBHOOK_SEC) {
    console.warn("⚠️  SQUADCO_WEBHOOK_SECRET not set — skipping signature check");
    return true;
  }
  const expected = crypto
    .createHmac("sha512", WEBHOOK_SEC)
    .update(rawBody)
    .digest("hex");

  return crypto.timingSafeEqual(
    Buffer.from(expected),
    Buffer.from(signatureHeader || "")
  );
};

// ═══════════════════════════════════════════════════════
//  5. GET ACCOUNT NAME (Verify bank account before withdraw)
// ═══════════════════════════════════════════════════════
const lookupBankAccount = async (bankCode, accountNumber) => {
  try {
    const { data } = await squadco.post("/payout/account/lookup", {
      bank_code:      bankCode,
      account_number: accountNumber,
    });
    if (data.success && data.data) {
      return { success: true, accountName: data.data.account_name };
    }
    throw new Error("Lookup failed");
  } catch (err) {
    console.error("SquadCo lookupBankAccount error:", err?.response?.data || err.message);
    throw new Error("Could not verify bank account");
  }
};

// ═══════════════════════════════════════════════════════
//  6. GET SUPPORTED BANKS
// ═══════════════════════════════════════════════════════
const getSupportedBanks = async () => {
  try {
    const { data } = await squadco.get("/payout/banks");
    if (data.success) {
      return data.data.map((b) => ({
        name: b.bank_name,
        code: b.bank_code,
      }));
    }
    return [];
  } catch (err) {
    console.error("SquadCo getSupportedBanks error:", err?.response?.data || err.message);
    return [];
  }
};

module.exports = {
  initiatePayment,
  verifyPayment,
  transferToBank,
  verifyWebhookSignature,
  lookupBankAccount,
  getSupportedBanks,
  toKobo,
  toNaira,
};
