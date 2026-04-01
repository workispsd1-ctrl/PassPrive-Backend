import supabase from "../../database/supabase";

export type PaymentContext = "BOOKING" | "BILL_PAYMENT";
export type PaymentStatus =
  | "CREATED"
  | "PENDING"
  | "RETURNED"
  | "VERIFIED_SUCCESS"
  | "VERIFIED_FAILED"
  | "FINALIZED"
  | "CANCELLED"
  | "ERROR";

export interface CreatePaymentSessionInput {
  payment_context: PaymentContext;
  context_reference_id?: string | null;
  user_id: string;
  restaurant_id?: string | null;
  store_id?: string | null;
  merchant_trace: string;
  merchant_application_id: string;
  amount_major: number;
  amount_minor: number;
  currency_code: string;
  discount_amount?: number;
  cashback_amount?: number;
  original_amount?: number;
  status?: PaymentStatus;
  gateway_payload?: Record<string, any>;
}

function sanitizePayload(payload: Record<string, any>) {
  return Object.fromEntries(Object.entries(payload).filter(([, value]) => value !== undefined));
}

export async function createPaymentSession(input: CreatePaymentSessionInput) {
  const payload = sanitizePayload({
    payment_provider: "IVERI",
    payment_context: input.payment_context,
    context_reference_id: input.context_reference_id ?? null,
    user_id: input.user_id,
    restaurant_id: input.restaurant_id ?? null,
    store_id: input.store_id ?? null,
    merchant_trace: input.merchant_trace,
    merchant_application_id: input.merchant_application_id,
    amount_major: input.amount_major,
    amount_minor: input.amount_minor,
    currency_code: input.currency_code,
    discount_amount: input.discount_amount ?? 0,
    cashback_amount: input.cashback_amount ?? 0,
    original_amount: input.original_amount ?? input.amount_major,
    status: input.status ?? "CREATED",
    gateway_payload: input.gateway_payload ?? {},
  });

  const { data, error } = await supabase
    .from("payment_sessions")
    .insert(payload)
    .select("*")
    .single();

  if (error) throw error;
  return data;
}

export async function getPaymentSessionById(sessionId: string) {
  const { data, error } = await supabase
    .from("payment_sessions")
    .select("*")
    .eq("id", sessionId)
    .maybeSingle();

  if (error) throw error;
  return data;
}

export async function getPaymentSessionByMerchantTrace(merchantTrace: string) {
  const { data, error } = await supabase
    .from("payment_sessions")
    .select("*")
    .eq("merchant_trace", merchantTrace)
    .maybeSingle();

  if (error) throw error;
  return data;
}

export async function updatePaymentSession(sessionId: string, updates: Record<string, any>) {
  const payload = sanitizePayload({
    ...updates,
    updated_at: new Date().toISOString(),
  });

  const { data, error } = await supabase
    .from("payment_sessions")
    .update(payload)
    .eq("id", sessionId)
    .select("*")
    .single();

  if (error) throw error;
  return data;
}
