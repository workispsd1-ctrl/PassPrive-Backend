import supabase from "../../database/supabase";

export interface CashbackValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * Credits cashback points to a user by creating a new expiration lot.
 *
 * `source` distinguishes the credit ('membership' | 'merchant_funded' | 'manual')
 * so a single payment session can carry more than one lot (see the
 * (payment_session_id, source) idempotency index). `expiryDays` overrides the
 * active cashback_rules expiry (e.g. 14 days for merchant-funded credits).
 */
export async function creditCashback(
  userId: string,
  amount: number,
  paymentSessionId?: string,
  db?: any,
  opts?: { source?: string; expiryDays?: number }
): Promise<{ success: boolean; lot: any; transaction: any; error?: string }> {
  const client = db ?? supabase;
  const source = opts?.source ?? "membership";
  try {
    let expiryDays = opts?.expiryDays ?? null;

    // Fall back to the active rule's expiry when not explicitly overridden.
    if (expiryDays == null) {
      const { data: rules, error: rulesErr } = await client
        .from("cashback_rules")
        .select("expiry_days")
        .eq("is_active", true)
        .maybeSingle();

      if (rulesErr) {
        console.error("Error fetching active cashback rules:", rulesErr);
        return { success: false, lot: null, transaction: null, error: rulesErr.message };
      }

      expiryDays = Number(rules?.expiry_days ?? 30);
    }

    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + Number(expiryDays ?? 30));

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
        source,
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
 * Earns cashback for a completed restaurant transaction (bill or booking) and
 * credits it to the customer's wallet. This is the loop that turns the cashback
 * the app SHOWS (via the same cashback_quote RPC) into a real wallet credit.
 *
 * - Membership cashback: cashback_quote(restaurant, user, base) → 0.5/2/4% by
 *   tier × merchant_type. Standard (cashback_rules) expiry.
 * - Merchant-funded cashback (Preferred only): restaurants.merchant_reward_rate %
 *   of the base, credited as a separate lot with a 14-day expiry.
 *
 * Idempotent per (session, source) via the DB unique index and a pre-check, and
 * NON-FATAL: a hiccup here must never fail an already-captured payment — the
 * caller logs and moves on (mirrors repeat_reward_redeem).
 */
const MERCHANT_FUNDED_EXPIRY_DAYS = 14;

export async function earnTransactionCashback(params: {
  userId: string;
  restaurantId: string;
  baseAmount: number;
  sessionId: string;
  db?: any;
}): Promise<{ membership: number; merchantFunded: number }> {
  const client = params.db ?? supabase;
  const credited = { membership: 0, merchantFunded: 0 };

  if (!params.restaurantId || !(params.baseAmount > 0)) return credited;

  // Which sources have already been credited for this session? (retry safety)
  const { data: existingTx } = await client
    .from("cashback_transactions")
    .select("source")
    .eq("payment_session_id", params.sessionId)
    .eq("type", "credit");
  const already = new Set((existingTx ?? []).map((t: any) => t.source));

  // ── Membership cashback (canonical matrix, shown == credited) ──────────────
  if (!already.has("membership")) {
    const { data: quote, error: quoteErr } = await client.rpc("cashback_quote", {
      in_restaurant_id: params.restaurantId,
      in_user_id: params.userId,
      in_bill_amount: params.baseAmount,
    });
    if (quoteErr) {
      console.error("[cashback] cashback_quote failed", { sessionId: params.sessionId, error: quoteErr.message });
    } else {
      const row = Array.isArray(quote) ? quote[0] : quote;
      const amount = Number(row?.cashback_amount) || 0;
      if (row?.applicable && amount > 0) {
        const res = await creditCashback(params.userId, amount, params.sessionId, client, {
          source: "membership",
        });
        if (res.success) credited.membership = amount;
        else console.error("[cashback] membership credit failed", { sessionId: params.sessionId, error: res.error });
      }
    }
  }

  // ── Merchant-funded cashback (Preferred partners, 14-day expiry) ───────────
  if (!already.has("merchant_funded")) {
    const { data: rest, error: restErr } = await client
      .from("restaurants")
      .select("merchant_type, merchant_reward_rate")
      .eq("id", params.restaurantId)
      .maybeSingle();
    if (restErr) {
      console.error("[cashback] merchant lookup failed", { sessionId: params.sessionId, error: restErr.message });
    } else {
      const mtype = String(rest?.merchant_type ?? "").trim().toLowerCase();
      const rewardRate = Number(rest?.merchant_reward_rate) || 0;
      if (mtype === "preferred" && rewardRate > 0) {
        const amount = Number(((params.baseAmount * rewardRate) / 100).toFixed(2));
        if (amount > 0) {
          const res = await creditCashback(params.userId, amount, params.sessionId, client, {
            source: "merchant_funded",
            expiryDays: MERCHANT_FUNDED_EXPIRY_DAYS,
          });
          if (res.success) credited.merchantFunded = amount;
          else console.error("[cashback] merchant-funded credit failed", { sessionId: params.sessionId, error: res.error });
        }
      }
    }
  }

  return credited;
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
