import supabase from "../../database/supabase";
import { randomBytes } from "crypto";

export type PaymentContext = "BOOKING" | "BILL_PAYMENT" | "MEMBERSHIP";
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
  discount_source?: "NONE" | "BANK" | "PLATFORM" | "PARTNER";
  discount_code?: string | null;
  discount_name?: string | null;
  discount_meta?: Record<string, any>;
  cashback_amount?: number;
  original_amount?: number;
  status?: PaymentStatus;
  gateway_payload?: Record<string, any>;
}

function sanitizePayload(payload: Record<string, any>) {
  return Object.fromEntries(Object.entries(payload).filter(([, value]) => value !== undefined));
}

function generateTrackingId(length = 8) {
  if (length < 2) {
    throw new Error("tracking_id length must be at least 2");
  }

  const letters = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const digits = "123456789";
  const all = `${letters}${digits}`;
  const bytes = randomBytes(length + 2);
  const out = new Array<string>(length);

  // Force first character to be alphabetic (never 0).
  out[0] = letters[bytes[0] % letters.length];
  // Force at least one numeric character.
  const numericIndex = 1 + (bytes[1] % (length - 1));
  out[numericIndex] = digits[bytes[2] % digits.length];

  let cursor = 3;
  for (let i = 1; i < length; i += 1) {
    if (i === numericIndex) continue;
    out[i] = all[bytes[cursor % bytes.length] % all.length];
    cursor += 1;
  }

  return out.join("");
}

function isTrackingIdCollision(error: any) {
  return (
    String(error?.code ?? "") === "23505" &&
    `${String(error?.message ?? "")} ${String(error?.details ?? "")}`.toLowerCase().includes("tracking_id")
  );
}

export async function createPaymentSession(input: CreatePaymentSessionInput) {
  let lastError: any = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const payload = sanitizePayload({
      payment_provider: "IVERI",
      payment_context: input.payment_context,
      context_reference_id: input.context_reference_id ?? null,
      user_id: input.user_id,
      restaurant_id: input.restaurant_id ?? null,
      store_id: input.store_id ?? null,
      merchant_trace: input.merchant_trace,
      merchant_application_id: input.merchant_application_id,
      tracking_id: generateTrackingId(8),
      amount_major: input.amount_major,
      amount_minor: input.amount_minor,
      currency_code: input.currency_code,
      discount_amount: input.discount_amount ?? 0,
      discount_source: input.discount_source ?? "NONE",
      discount_code: input.discount_code ?? null,
      discount_name: input.discount_name ?? null,
      discount_meta: input.discount_meta ?? {},
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

    if (!error) return data;
    if (!isTrackingIdCollision(error)) throw error;
    lastError = error;
  }

  throw lastError ?? new Error("Failed to allocate unique tracking id");
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

export async function updatePaymentSessionIfStatusIn(params: {
  sessionId: string;
  allowedCurrentStatuses: PaymentStatus[];
  updates: Record<string, any>;
}) {
  const payload = sanitizePayload({
    ...params.updates,
    updated_at: new Date().toISOString(),
  });

  const { data, error } = await supabase
    .from("payment_sessions")
    .update(payload)
    .eq("id", params.sessionId)
    .in("status", params.allowedCurrentStatuses)
    .select("*")
    .maybeSingle();

  if (error) throw error;
  return data;
}
