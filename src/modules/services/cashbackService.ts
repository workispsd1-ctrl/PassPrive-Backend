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
  restaurantId?: string;
  storeId?: string;
  baseAmount: number;
  sessionId: string;
  db?: any;
}): Promise<{ membership: number; merchantFunded: number }> {
  const client = params.db ?? supabase;
  const credited = { membership: 0, merchantFunded: 0 };

  // Entity-agnostic: restaurants and stores share the same cashback shape,
  // just different quote RPCs and merchant tables.
  const isStore = !params.restaurantId && !!params.storeId;
  const entityId = isStore ? params.storeId! : params.restaurantId!;
  const membershipRpc = isStore ? "store_cashback_quote" : "cashback_quote";
  const membershipArg = isStore ? "in_store_id" : "in_restaurant_id";
  const merchantTable = isStore ? "stores" : "restaurants";

  if (!entityId || !(params.baseAmount > 0)) return credited;

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
        .rpc(membershipRpc, {
          [membershipArg]: entityId,
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
        .from(merchantTable)
        .select("merchant_type, merchant_reward_rate")
        .eq("id", entityId)
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
 * Validates a Privé Credits spend against the user's plan rules (min balance,
 * max per use, uses per rolling window) and the global rules, using the same
 * database check that reserves the points.
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
    const { data, error } = await client.rpc("cashback_burn_check", {
      p_user_id: userId,
      p_amount: amount,
      p_merchant_user_id: merchantUserId,
      p_bill_amount: billAmount,
    });
    if (error) {
      console.error("Error executing cashback_burn_check RPC:", error);
      return { valid: false, error: "Could not check Privé Credits right now" };
    }
    const row = Array.isArray(data) ? data[0] : data;
    if (!row?.ok) {
      return { valid: false, error: row?.message || "Privé Credits cannot be applied to this bill" };
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
