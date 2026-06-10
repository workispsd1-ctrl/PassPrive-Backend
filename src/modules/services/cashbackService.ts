import supabase from "../../database/supabase";

export interface CashbackValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * Credits cashback points to a user by creating a new expiration lot.
 */
export async function creditCashback(
  userId: string,
  amount: number,
  paymentSessionId?: string,
  db?: any
): Promise<{ success: boolean; lot: any; transaction: any; error?: string }> {
  const client = db ?? supabase;
  try {
    // 1. Fetch current active rule to determine expiration days
    const { data: rules, error: rulesErr } = await client
      .from("cashback_rules")
      .select("expiry_days")
      .eq("is_active", true)
      .maybeSingle();

    if (rulesErr) {
      console.error("Error fetching active cashback rules:", rulesErr);
      return { success: false, lot: null, transaction: null, error: rulesErr.message };
    }

    const expiryDays = rules?.expiry_days ?? 30;
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + expiryDays);

    // 2. Create the cashback lot
    const { data: lot, error: lotErr } = await client
      .from("cashback_lots")
      .insert({
        user_id: userId,
        amount,
        remaining_amount: amount,
        expires_at: expiresAt.toISOString(),
      })
      .select()
      .single();

    if (lotErr) {
      console.error("Error creating cashback lot:", lotErr);
      return { success: false, lot: null, transaction: null, error: lotErr.message };
    }

    // 3. Create the audit transaction log
    const { data: transaction, error: txErr } = await client
      .from("cashback_transactions")
      .insert({
        user_id: userId,
        amount,
        type: "credit",
        payment_session_id: paymentSessionId ?? null,
      })
      .select()
      .single();

    if (txErr) {
      console.error("Error logging cashback credit transaction:", txErr);
      return { success: false, lot, transaction: null, error: txErr.message };
    }

    return { success: true, lot, transaction };
  } catch (err: any) {
    console.error("Unexpected error in creditCashback:", err);
    return { success: false, lot: null, transaction: null, error: err.message };
  }
}

/**
 * Validates whether a user can spend a specific cashback amount on a merchant's transaction.
 */
export async function validateCashbackSpend(
  userId: string,
  amount: number,
  merchantUserId: string,
  billAmount: number,
  db?: any
): Promise<CashbackValidationResult> {
  const client = db ?? supabase;
  try {
    // 1. Get current active config rules
    const { data: rules, error: rulesErr } = await client
      .from("cashback_rules")
      .select("*")
      .eq("is_active", true)
      .maybeSingle();

    if (rulesErr || !rules) {
      return { valid: false, error: "Active cashback rules configuration not found" };
    }

    // 2. Validate merchant applicability
    const { data: merchant, error: merchantErr } = await client
      .from("users")
      .select("cashback_enabled")
      .eq("id", merchantUserId)
      .maybeSingle();

    if (merchantErr || !merchant || !merchant.cashback_enabled) {
      return { valid: false, error: "Merchant is not whitelisted or eligible for cashback" };
    }

    // 3. Validate minimum purchase amount
    if (billAmount < Number(rules.min_purchase_amount)) {
      return {
        valid: false,
        error: `Purchase amount ${billAmount} is below the minimum required amount of ${rules.min_purchase_amount} to use cashback`,
      };
    }

    // 4. Validate transaction single-use limit
    if (amount > Number(rules.max_use_per_transaction)) {
      return {
        valid: false,
        error: `Requested cashback amount ${amount} exceeds single transaction limit of ${rules.max_use_per_transaction}`,
      };
    }

    // 5. Validate user's monthly limits (monthly usage count and total amount used)
    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);

    const { data: txs, error: txsErr } = await client
      .from("cashback_transactions")
      .select("amount")
      .eq("user_id", userId)
      .eq("type", "spend")
      .gte("created_at", startOfMonth.toISOString());

    if (txsErr) {
      console.error("Error fetching monthly transactions:", txsErr);
      return { valid: false, error: "Database error checking monthly usage limits" };
    }

    const monthlyCount = txs.length;
    const monthlyAmount = txs.reduce((sum: number, tx: any) => sum + Math.abs(Number(tx.amount)), 0);

    if (monthlyCount >= rules.max_transactions_per_month) {
      return {
        valid: false,
        error: `Monthly cashback transaction limit of ${rules.max_transactions_per_month} uses has been reached`,
      };
    }

    if (monthlyAmount + amount > Number(rules.max_use_per_month)) {
      return {
        valid: false,
        error: `Monthly cashback spend limit of ${rules.max_use_per_month} has been exceeded (already used ${monthlyAmount} this month)`,
      };
    }

    // 6. Check user's available active balance
    const { data: balanceRows, error: balanceErr } = await client
      .from("cashback_lots")
      .select("remaining_amount")
      .eq("user_id", userId)
      .gt("remaining_amount", 0.00)
      .gt("expires_at", new Date().toISOString());

    if (balanceErr) {
      console.error("Error fetching active balance rows:", balanceErr);
      return { valid: false, error: "Database error checking active balance" };
    }

    const availableBalance = (balanceRows ?? []).reduce(
      (sum: number, row: any) => sum + Number(row.remaining_amount),
      0
    );

    if (availableBalance < amount) {
      return {
        valid: false,
        error: `Insufficient cashback balance (requested ${amount}, available ${availableBalance})`,
      };
    }

    return { valid: true };
  } catch (err: any) {
    console.error("Unexpected error in validateCashbackSpend:", err);
    return { valid: false, error: err.message };
  }
}

/**
 * Deducts cashback points atomically using the PL/pgSQL stored function.
 */
export async function spendCashback(
  userId: string,
  amount: number,
  merchantUserId: string,
  billAmount: number,
  paymentSessionId?: string,
  db?: any
): Promise<{ success: boolean; message: string; amount?: number; new_balance?: number }> {
  const client = db ?? supabase;
  try {
    const { data, error } = await client.rpc("redeem_cashback_points", {
      p_user_id: userId,
      p_amount: amount,
      p_merchant_user_id: merchantUserId,
      p_bill_amount: billAmount,
      p_payment_session_id: paymentSessionId ?? null,
    });

    if (error) {
      console.error("Error executing redeem_cashback_points RPC:", error);
      return { success: false, message: error.message };
    }

    return data;
  } catch (err: any) {
    console.error("Unexpected error in spendCashback:", err);
    return { success: false, message: err.message || "Internal server error" };
  }
}
