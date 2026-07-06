import supabase from "../../database/supabase";

export interface GiftSpendResult {
  success: boolean;
  message: string;
  amount?: number;
  new_balance?: number;
}

/**
 * Deducts gift wallet balance (general or brand-restricted) atomically and idempotently.
 */
export async function spendGiftBalance(params: {
  userId: string;
  amount: number;
  storeId?: string | null;
  restaurantId?: string | null;
  paymentSessionId?: string | null;
  idempotencyKey?: string | null;
  db?: any;
}): Promise<GiftSpendResult> {
  const client = params.db ?? supabase;
  try {
    const key = params.idempotencyKey ?? (params.paymentSessionId
      ? `spend_gift_session_${params.paymentSessionId}`
      : `spend_gift_random_${Math.random().toString(36).substring(2, 15)}`);

    const { data, error } = await client.rpc("spend_gift_balance", {
      p_user_id: params.userId,
      p_amount: params.amount,
      p_store_id: params.storeId ?? null,
      p_restaurant_id: params.restaurantId ?? null,
      p_payment_session_id: params.paymentSessionId ?? null,
      p_idempotency_key: key,
    });

    if (error) {
      console.error("Error executing spend_gift_balance RPC:", error);
      return { success: false, message: error.message };
    }

    return data as GiftSpendResult;
  } catch (err: any) {
    console.error("Unexpected error in spendGiftBalance service:", err);
    return { success: false, message: err.message || "Internal server error" };
  }
}
