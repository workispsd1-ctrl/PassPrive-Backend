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
    const idempotencyKey = paymentSessionId
      ? `credit_cashback_session_${paymentSessionId}`
      : `credit_cashback_random_${Math.random().toString(36).substring(2, 15)}`;

    const { data: rpcResult, error: rpcErr } = await client.rpc(
      "credit_cashback_points_secure",
      {
        p_user_id: userId,
        p_amount: amount,
        p_payment_session_id: paymentSessionId ?? null,
        p_idempotency_key: idempotencyKey,
      }
    );

    if (rpcErr) {
      console.error("Error executing credit_cashback_points_secure RPC:", rpcErr);
      return { success: false, lot: null, transaction: null, error: rpcErr.message };
    }

    const { success, lot_id, transaction_id, message } = rpcResult as {
      success: boolean;
      lot_id?: string;
      transaction_id?: string;
      message?: string;
    };

    if (!success) {
      return { success: false, lot: null, transaction: null, error: message || "Failed to credit cashback" };
    }

    // Fetch the inserted lot and transaction for backward compatibility in parallel
    const [lotResult, txResult] = await Promise.all([
      lot_id
        ? client.from("cashback_lots").select("*").eq("id", lot_id).maybeSingle()
        : Promise.resolve({ data: null, error: null }),
      transaction_id
        ? client.from("cashback_transactions").select("*").eq("id", transaction_id).maybeSingle()
        : Promise.resolve({ data: null, error: null }),
    ]);

    const lot = lotResult.data;
    const transaction = txResult.data;

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

  const tasks: Array<Promise<void>> = [];

  // ── Membership cashback (canonical matrix, shown == credited) ──────────────
  if (!already.has("membership")) {
    tasks.push(
      client
        .rpc("cashback_quote", {
          in_restaurant_id: params.restaurantId,
          in_user_id: params.userId,
          in_bill_amount: params.baseAmount,
        })
        .then(async (res: any) => {
          const quote = res.data;
          const quoteErr = res.error;
          if (quoteErr) {
            console.error("[cashback] cashback_quote failed", { sessionId: params.sessionId, error: quoteErr.message });
            return;
          }
          const row = Array.isArray(quote) ? quote[0] : quote;
          const amount = Number(row?.cashback_amount) || 0;
          if (row?.applicable && amount > 0) {
            const resCredit = await creditCashback(params.userId, amount, params.sessionId, client, {
              source: "membership",
            });
            if (resCredit.success) credited.membership = amount;
            else console.error("[cashback] membership credit failed", { sessionId: params.sessionId, error: resCredit.error });
          }
        })
    );
  }

  // ── Merchant-funded cashback (Preferred partners, 14-day expiry) ───────────
  if (!already.has("merchant_funded")) {
    tasks.push(
      client
        .from("restaurants")
        .select("merchant_type, merchant_reward_rate")
        .eq("id", params.restaurantId)
        .maybeSingle()
        .then(async (res: any) => {
          const rest = res.data;
          const restErr = res.error;
          if (restErr) {
            console.error("[cashback] merchant lookup failed", { sessionId: params.sessionId, error: restErr.message });
            return;
          }
          const mtype = String(rest?.merchant_type ?? "").trim().toLowerCase();
          const rewardRate = Number(rest?.merchant_reward_rate) || 0;
          if (mtype === "preferred" && rewardRate > 0) {
            const amount = Number(((params.baseAmount * rewardRate) / 100).toFixed(2));
            if (amount > 0) {
              const resCredit = await creditCashback(params.userId, amount, params.sessionId, client, {
                source: "merchant_funded",
                expiryDays: MERCHANT_FUNDED_EXPIRY_DAYS,
              });
              if (resCredit.success) credited.merchantFunded = amount;
              else console.error("[cashback] merchant-funded credit failed", { sessionId: params.sessionId, error: resCredit.error });
            }
          }
        })
    );
  }

  if (tasks.length > 0) {
    await Promise.all(tasks);
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
    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);

    // Fetch all validation data concurrently
    const [rulesResult, merchantResult, txsResult, balanceResult] = await Promise.all([
      client
        .from("cashback_rules")
        .select("*")
        .eq("is_active", true)
        .maybeSingle(),
      client
        .from("users")
        .select("cashback_enabled")
        .eq("id", merchantUserId)
        .maybeSingle(),
      client
        .from("cashback_transactions")
        .select("amount")
        .eq("user_id", userId)
        .eq("type", "spend")
        .gte("created_at", startOfMonth.toISOString()),
      client
        .from("cashback_lots")
        .select("remaining_amount")
        .eq("user_id", userId)
        .gt("remaining_amount", 0.00)
        .gt("expires_at", new Date().toISOString()),
    ]);

    const { data: rules, error: rulesErr } = rulesResult;
    const { data: merchant, error: merchantErr } = merchantResult;
    const { data: txs, error: txsErr } = txsResult;
    const { data: balanceRows, error: balanceErr } = balanceResult;

    if (rulesErr || !rules) {
      return { valid: false, error: "Active cashback rules configuration not found" };
    }

    if (merchantErr || !merchant || !merchant.cashback_enabled) {
      return { valid: false, error: "Merchant is not whitelisted or eligible for cashback" };
    }

    if (billAmount < Number(rules.min_purchase_amount)) {
      return {
        valid: false,
        error: `Purchase amount ${billAmount} is below the minimum required amount of ${rules.min_purchase_amount} to use cashback`,
      };
    }

    if (amount > Number(rules.max_use_per_transaction)) {
      return {
        valid: false,
        error: `Requested cashback amount ${amount} exceeds single transaction limit of ${rules.max_use_per_transaction}`,
      };
    }

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
