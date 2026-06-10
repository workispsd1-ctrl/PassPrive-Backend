import { Router, Request, Response } from "express";
import { getAuthenticatedCustomer, requireAdmin } from "../services/authService";
import supabase from "../../database/supabase";
import { creditCashback, validateCashbackSpend } from "../services/cashbackService";

const router = Router();

// ==========================================
// USER ENDPOINTS
// ==========================================

/**
 * GET /api/cashback/balance
 * Returns the current active, non-expired cashback balance for the authenticated user.
 */
router.get("/balance", async (req: Request, res: Response) => {
  const customer = await getAuthenticatedCustomer(req, res);
  if (!customer) return;

  try {
    const { data: balanceRows, error: balanceErr } = await supabase
      .from("cashback_lots")
      .select("remaining_amount")
      .eq("user_id", customer.userId)
      .gt("remaining_amount", 0.00)
      .gt("expires_at", new Date().toISOString());

    if (balanceErr) {
      console.error("Error fetching active balance:", balanceErr);
      return res.status(500).json({ success: false, error: "Database error" });
    }

    const balance = (balanceRows ?? []).reduce(
      (sum, row) => sum + Number(row.remaining_amount),
      0
    );

    return res.json({
      success: true,
      balance: Number(balance.toFixed(2)),
    });
  } catch (err: any) {
    console.error("Get balance unexpected error:", err);
    return res.status(500).json({ success: false, error: "Internal server error" });
  }
});

/**
 * GET /api/cashback/summary
 * Returns the current active balance and the audit log of transactions.
 */
router.get("/summary", async (req: Request, res: Response) => {
  const customer = await getAuthenticatedCustomer(req, res);
  if (!customer) return;

  try {
    // 1. Fetch active balance
    const { data: balanceRows, error: balanceErr } = await supabase
      .from("cashback_lots")
      .select("remaining_amount")
      .eq("user_id", customer.userId)
      .gt("remaining_amount", 0.00)
      .gt("expires_at", new Date().toISOString());

    if (balanceErr) {
      console.error("Error fetching active balance:", balanceErr);
      return res.status(500).json({ success: false, error: "Database error" });
    }

    const balance = (balanceRows ?? []).reduce(
      (sum, row) => sum + Number(row.remaining_amount),
      0
    );

    // 2. Fetch transaction history
    const { data: transactions, error: txError } = await supabase
      .from("cashback_transactions")
      .select("*")
      .eq("user_id", customer.userId)
      .order("created_at", { ascending: false });

    if (txError) {
      console.error("Error fetching cashback transactions:", txError);
      return res.status(500).json({ success: false, error: "Database error" });
    }

    return res.json({
      success: true,
      balance: Number(balance.toFixed(2)),
      transactions: transactions || [],
    });
  } catch (err: any) {
    console.error("Get summary unexpected error:", err);
    return res.status(500).json({ success: false, error: "Internal server error" });
  }
});

/**
 * POST /api/cashback/validate
 * Validates spend requirements without executing any deduction.
 */
router.post("/validate", async (req: Request, res: Response) => {
  const customer = await getAuthenticatedCustomer(req, res);
  if (!customer) return;

  const { amount, merchant_user_id, bill_amount } = req.body;

  if (amount === undefined || merchant_user_id === undefined || bill_amount === undefined) {
    return res.status(400).json({
      success: false,
      error: "Fields 'amount', 'merchant_user_id', and 'bill_amount' are required in request body",
    });
  }

  const parseAmount = Number(amount);
  const parseBillAmount = Number(bill_amount);

  if (isNaN(parseAmount) || parseAmount <= 0) {
    return res.status(400).json({ success: false, error: "Invalid spend 'amount' value" });
  }

  if (isNaN(parseBillAmount) || parseBillAmount <= 0) {
    return res.status(400).json({ success: false, error: "Invalid 'bill_amount' value" });
  }

  try {
    const check = await validateCashbackSpend(
      customer.userId,
      parseAmount,
      merchant_user_id,
      parseBillAmount
    );

    return res.json({
      success: true,
      valid: check.valid,
      error: check.error || null,
    });
  } catch (err: any) {
    console.error("Validate cashback spend unexpected error:", err);
    return res.status(500).json({ success: false, error: "Internal server error" });
  }
});

// ==========================================
// ADMIN ENDPOINTS
// ==========================================

/**
 * GET /api/cashback/admin/rules
 * Fetch current active configuration rules.
 */
router.get("/admin/rules", async (req: Request, res: Response) => {
  const admin = await requireAdmin(req, res);
  if (!admin || !admin.callerId) {
    return res.status(401).json({ error: "Unauthorized access" });
  }

  try {
    const { data: rules, error } = await supabase
      .from("cashback_rules")
      .select("*")
      .eq("is_active", true)
      .maybeSingle();

    if (error) {
      console.error("Error getting active cashback rules:", error);
      return res.status(500).json({ error: "Database error" });
    }

    return res.json({
      success: true,
      rules: rules || null,
    });
  } catch (err: any) {
    console.error("Get rules unexpected error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * POST /api/cashback/admin/rules
 * Updates the active configurations (creates new row version).
 */
router.post("/admin/rules", async (req: Request, res: Response) => {
  const admin = await requireAdmin(req, res);
  if (!admin || !admin.callerId) {
    return res.status(401).json({ error: "Unauthorized access" });
  }

  const {
    min_purchase_amount,
    max_use_per_transaction,
    max_use_per_month,
    max_transactions_per_month,
    expiry_days,
  } = req.body;

  if (
    min_purchase_amount === undefined ||
    max_use_per_transaction === undefined ||
    max_use_per_month === undefined ||
    max_transactions_per_month === undefined ||
    expiry_days === undefined
  ) {
    return res.status(400).json({
      error: "Missing fields. All rule configuration parameters must be supplied.",
    });
  }

  try {
    // 1. Mark existing active rules as inactive
    const { error: updateErr } = await supabase
      .from("cashback_rules")
      .update({ is_active: false })
      .eq("is_active", true);

    if (updateErr) {
      console.error("Error deactivating old rules:", updateErr);
      return res.status(500).json({ error: "Database transaction failed" });
    }

    // 2. Insert new rule configuration
    const { data: newRules, error: insertErr } = await supabase
      .from("cashback_rules")
      .insert({
        min_purchase_amount: Number(min_purchase_amount),
        max_use_per_transaction: Number(max_use_per_transaction),
        max_use_per_month: Number(max_use_per_month),
        max_transactions_per_month: Number(max_transactions_per_month),
        expiry_days: Number(expiry_days),
        is_active: true,
        created_by: admin.callerId,
      })
      .select()
      .single();

    if (insertErr) {
      console.error("Error creating new rules version:", insertErr);
      return res.status(500).json({ error: "Database insert failed" });
    }

    return res.json({
      success: true,
      rules: newRules,
    });
  } catch (err: any) {
    console.error("Post rules unexpected error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * GET /api/cashback/admin/merchants
 * Lists all merchants (users) where cashback is enabled.
 */
router.get("/admin/merchants", async (req: Request, res: Response) => {
  const admin = await requireAdmin(req, res);
  if (!admin || !admin.callerId) {
    return res.status(401).json({ error: "Unauthorized access" });
  }

  try {
    const { data: merchants, error } = await supabase
      .from("users")
      .select("id, email, full_name, role, cashback_enabled")
      .eq("cashback_enabled", true)
      .order("full_name", { ascending: true });

    if (error) {
      console.error("Error listing cashback whitelisted merchants:", error);
      return res.status(500).json({ error: "Database error" });
    }

    return res.json({
      success: true,
      merchants: merchants || [],
    });
  } catch (err: any) {
    console.error("Get merchants unexpected error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * POST /api/cashback/admin/merchants
 * Whitelists or disables a user/merchant for cashback points.
 */
router.post("/admin/merchants", async (req: Request, res: Response) => {
  const admin = await requireAdmin(req, res);
  if (!admin || !admin.callerId) {
    return res.status(401).json({ error: "Unauthorized access" });
  }

  const { merchant_id, cashback_enabled } = req.body;

  if (!merchant_id || cashback_enabled === undefined) {
    return res.status(400).json({
      error: "Fields 'merchant_id' and 'cashback_enabled' are required in request body",
    });
  }

  try {
    // Check if target user exists
    const { data: user, error: userErr } = await supabase
      .from("users")
      .select("id, full_name")
      .eq("id", merchant_id)
      .maybeSingle();

    if (userErr || !user) {
      return res.status(404).json({ error: "Merchant user not found" });
    }

    const { error: updateErr } = await supabase
      .from("users")
      .update({ cashback_enabled: Boolean(cashback_enabled) })
      .eq("id", merchant_id);

    if (updateErr) {
      console.error("Error setting cashback whitelisting:", updateErr);
      return res.status(500).json({ error: "Database update failed" });
    }

    return res.json({
      success: true,
      message: `Cashback points has been ${cashback_enabled ? "enabled" : "disabled"} for merchant ${user.full_name || merchant_id}`,
    });
  } catch (err: any) {
    console.error("Post merchants unexpected error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * POST /api/cashback/admin/credit
 * Debug/Testing API endpoint to credit cashback to any user directly.
 */
router.post("/admin/credit", async (req: Request, res: Response) => {
  const admin = await requireAdmin(req, res);
  if (!admin || !admin.callerId) {
    return res.status(401).json({ error: "Unauthorized access" });
  }

  const { user_id, amount, payment_session_id } = req.body;

  if (!user_id || amount === undefined) {
    return res.status(400).json({ error: "Fields 'user_id' and 'amount' are required" });
  }

  const parseAmount = Number(amount);
  if (isNaN(parseAmount) || parseAmount <= 0) {
    return res.status(400).json({ error: "Credit amount must be positive" });
  }

  try {
    const result = await creditCashback(user_id, parseAmount, payment_session_id);

    if (!result.success) {
      return res.status(500).json({ error: result.error || "Failed to credit cashback" });
    }

    return res.json({
      success: true,
      message: `Successfully credited ${parseAmount} cashback points to user ${user_id}`,
      lot: result.lot,
      transaction: result.transaction,
    });
  } catch (err: any) {
    console.error("Admin credit cashback unexpected error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
