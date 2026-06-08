import { Router } from "express";
import { getAuthenticatedCustomer } from "../services/authService";
import supabase from "../../database/supabase";

const router = Router();

// 1. GET /api/gifts/summary
router.get("/summary", async (req, res) => {
  const customer = await getAuthenticatedCustomer(req, res);
  if (!customer) return;

  try {
    const { data: wallet, error: walletError } = await supabase
      .from("gift_balances")
      .select("balance")
      .eq("user_id", customer.userId)
      .maybeSingle();

    if (walletError) {
      console.error("Error fetching gift balance:", walletError);
      return res.status(500).json({ success: false, error: "Database error" });
    }

    const { data: transactions, error: txError } = await supabase
      .from("gift_transactions")
      .select("*")
      .eq("user_id", customer.userId)
      .order("created_at", { ascending: false });

    if (txError) {
      console.error("Error fetching gift transactions:", txError);
      return res.status(500).json({ success: false, error: "Database error" });
    }

    return res.json({
      success: true,
      balance: wallet?.balance ?? 0.00,
      transactions: transactions || [],
    });
  } catch (err: any) {
    console.error("Get summary unexpected error:", err);
    return res.status(500).json({ success: false, error: "Internal server error" });
  }
});

// 2. GET /api/gifts/balance
router.get("/balance", async (req, res) => {
  const customer = await getAuthenticatedCustomer(req, res);
  if (!customer) return;

  try {
    const { data: wallet, error } = await supabase
      .from("gift_balances")
      .select("balance")
      .eq("user_id", customer.userId)
      .maybeSingle();

    if (error) {
      console.error("Error fetching gift balance:", error);
      return res.status(500).json({ success: false, error: "Database error" });
    }

    return res.json({
      success: true,
      balance: wallet?.balance ?? 0.00,
    });
  } catch (err: any) {
    console.error("Get balance unexpected error:", err);
    return res.status(500).json({ success: false, error: "Internal server error" });
  }
});

// 2. GET /api/gifts/my-codes
router.get("/my-codes", async (req, res) => {
  const customer = await getAuthenticatedCustomer(req, res);
  if (!customer) return;

  try {
    const { data: codes, error } = await supabase
      .from("gift_codes")
      .select("*")
      .eq("created_by", customer.userId)
      .order("created_at", { ascending: false });

    if (error) {
      console.error("Error fetching gift codes:", error);
      return res.status(500).json({ success: false, error: "Database error" });
    }

    return res.json({
      success: true,
      gift_codes: codes || [],
    });
  } catch (err: any) {
    console.error("Get my-codes unexpected error:", err);
    return res.status(500).json({ success: false, error: "Internal server error" });
  }
});

// 3. POST /api/gifts/redeem
router.post("/redeem", async (req, res) => {
  const { code } = req.body;

  if (!code || typeof code !== "string" || !code.trim()) {
    return res.status(400).json({ success: false, error: "Gift code is required" });
  }

  const customer = await getAuthenticatedCustomer(req, res);
  if (!customer) return;

  try {
    // Call the postgres atomic RPC function to handle the redemption
    const { data, error } = await supabase.rpc("redeem_gift_code", {
      p_code: code.trim(),
      p_user_id: customer.userId,
    });

    if (error) {
      console.error("Error calling redeem_gift_code RPC:", error);
      return res.status(500).json({ success: false, error: "Database transaction failed" });
    }

    const result = data as { success: boolean; message: string; amount?: number; new_balance?: number };

    if (!result.success) {
      return res.status(400).json({ success: false, error: result.message });
    }

    return res.json({
      success: true,
      message: result.message,
      amount: result.amount,
      new_balance: result.new_balance,
    });
  } catch (err: any) {
    console.error("Redeem code unexpected error:", err);
    return res.status(500).json({ success: false, error: "Internal server error" });
  }
});

// 4. GET /api/gifts/discounts
router.get("/discounts", async (req, res) => {
  try {
    const now = new Date().toISOString();
    const { data: discounts, error } = await supabase
      .from("running_discounts")
      .select("*")
      .eq("is_active", true);

    if (error) {
      console.error("Error fetching running discounts:", error);
      return res.status(500).json({ success: false, error: "Database error" });
    }

    // Filter discounts based on validity dates if set
    const activeDiscounts = (discounts || []).filter((discount) => {
      if (discount.start_date && new Date(discount.start_date) > new Date(now)) {
        return false;
      }
      if (discount.end_date && new Date(discount.end_date) < new Date(now)) {
        return false;
      }
      return true;
    });

    return res.json({
      success: true,
      discounts: activeDiscounts,
    });
  } catch (err: any) {
    console.error("Get discounts unexpected error:", err);
    return res.status(500).json({ success: false, error: "Internal server error" });
  }
});

export default router;
