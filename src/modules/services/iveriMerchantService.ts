import { postForm } from "./iveriService";
import { normalizeIveriPayload } from "./iveriPayloadService";
import { supabaseServiceRole } from "./supabaseServiceRole";
import { generateMerchantTrace } from "./iveriService";

export interface IveriMerchantConfig {
  mode: "TEST" | "LIVE";
  applicationId: string;
  enterpriseAuthoriseUrl: string;
}

export function getIveriMerchantConfig(): IveriMerchantConfig {
  const mode = String(process.env.IVERI_MODE ?? "TEST").trim().toUpperCase() === "LIVE" ? "LIVE" : "TEST";
  const applicationId =
    (mode === "LIVE"
      ? process.env.IVERI_MERCHANT_APPLICATION_ID_LIVE ?? process.env.IVERI_APPLICATION_ID_LIVE
      : process.env.IVERI_MERCHANT_APPLICATION_ID_TEST ?? process.env.IVERI_APPLICATION_ID_TEST)?.trim() ?? "";

  if (!applicationId) {
    throw new Error(`Missing iVeri Merchant application ID for ${mode} mode`);
  }

  const configuredBaseUrl = process.env.IVERI_GATEWAY_BASE_URL?.trim().replace(/\/+$/, "") ?? "";
  const baseUrl = configuredBaseUrl || "https://portal.merchant.cim.mu";

  const enterpriseAuthoriseUrl =
    process.env.IVERI_ENTERPRISE_AUTHORISE_URL?.trim() || `${baseUrl}/Enterprise/Authorise.aspx`;

  return {
    mode,
    applicationId,
    enterpriseAuthoriseUrl,
  };
}

function toMinor(amountMajor: number): number {
  return Math.round(amountMajor * 100);
}

export interface SaveCardTokenParams {
  userId: string;
  partnerType: "RESTAURANT" | "STORE" | "GLOBAL";
  restaurantId?: string | null;
  storeId?: string | null;
  transactionIndex: string;
  initialTransactionIndex?: string | null;
  maskedPan: string;
  cardBrand?: string | null;
  expMonth?: string | null;
  expYear?: string | null;
  metadata?: Record<string, any>;
}

export async function saveUserCardToken(params: SaveCardTokenParams) {
  const partnerType = params.partnerType ?? "GLOBAL";
  const restaurantId = partnerType === "RESTAURANT" ? params.restaurantId ?? null : null;
  const storeId = partnerType === "STORE" ? params.storeId ?? null : null;

  if (partnerType === "RESTAURANT" && !restaurantId) {
    throw new Error("restaurant_id is required when partner_type is RESTAURANT");
  }
  if (partnerType === "STORE" && !storeId) {
    throw new Error("store_id is required when partner_type is STORE");
  }

  const initialToken = params.initialTransactionIndex || params.transactionIndex;

  const { data, error } = await supabaseServiceRole
    .from("user_card_tokens")
    .insert({
      user_id: params.userId,
      partner_type: partnerType,
      restaurant_id: restaurantId,
      store_id: storeId,
      payment_provider: "IVERI_MERCHANT",
      transaction_index: params.transactionIndex,
      initial_transaction_index: initialToken,
      masked_pan: params.maskedPan,
      card_brand: params.cardBrand ?? null,
      exp_month: params.expMonth ?? null,
      exp_year: params.expYear ?? null,
      is_active: true,
      metadata: params.metadata ?? {},
    })
    .select("*")
    .single();

  if (error) {
    throw error;
  }

  return data;
}

export async function getUserCardTokens(params: {
  userId: string;
  restaurantId?: string | null;
  storeId?: string | null;
}) {
  let query = supabaseServiceRole
    .from("user_card_tokens")
    .select("*")
    .eq("user_id", params.userId)
    .eq("is_active", true)
    .order("created_at", { ascending: false });

  if (params.restaurantId) {
    query = query.or(`restaurant_id.eq.${params.restaurantId},partner_type.eq.GLOBAL`);
  } else if (params.storeId) {
    query = query.or(`store_id.eq.${params.storeId},partner_type.eq.GLOBAL`);
  }

  const { data, error } = await query;
  if (error) throw error;
  return data ?? [];
}

export async function deactivateUserCardToken(tokenId: string, userId: string) {
  const { data, error } = await supabaseServiceRole
    .from("user_card_tokens")
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq("id", tokenId)
    .eq("user_id", userId)
    .select("*")
    .maybeSingle();

  if (error) throw error;
  return data;
}

/**
 * Single-Row UPSERT helper for restaurant_subscriptions and store_subscriptions.
 * Updates cell values (starts_at, expires_at, status) without inserting duplicate rows.
 */
export async function syncPartnerSubscription(params: {
  partnerType: "RESTAURANT" | "STORE";
  restaurantId?: string | null;
  storeId?: string | null;
  planCode?: string;
  durationMonths?: number;
}) {
  const durationMonths = params.durationMonths && params.durationMonths > 0 ? params.durationMonths : 1;
  const now = new Date();
  const expiresAt = new Date(now);
  expiresAt.setMonth(expiresAt.getMonth() + durationMonths);

  if (params.partnerType === "RESTAURANT" && params.restaurantId) {
    const { data: existing, error: findErr } = await supabaseServiceRole
      .from("restaurant_subscriptions")
      .select("id")
      .eq("restaurant_id", params.restaurantId)
      .maybeSingle();

    if (findErr) throw findErr;

    if (existing) {
      const { data: updated, error: updateErr } = await supabaseServiceRole
        .from("restaurant_subscriptions")
        .update({
          status: "active",
          plan_code: params.planCode ?? "PREMIUM",
          starts_at: now.toISOString(),
          expires_at: expiresAt.toISOString(),
        })
        .eq("id", existing.id)
        .select("*")
        .single();
      if (updateErr) throw updateErr;
      return updated;
    } else {
      const { data: inserted, error: insertErr } = await supabaseServiceRole
        .from("restaurant_subscriptions")
        .insert({
          restaurant_id: params.restaurantId,
          plan_code: params.planCode ?? "PREMIUM",
          status: "active",
          unlock_all: true,
          time_slot_enabled: true,
          repeat_rewards_enabled: true,
          dish_discounts_enabled: true,
          starts_at: now.toISOString(),
          expires_at: expiresAt.toISOString(),
        })
        .select("*")
        .single();
      if (insertErr) throw insertErr;
      return inserted;
    }
  }

  if (params.partnerType === "STORE" && params.storeId) {
    const { data: existing, error: findErr } = await supabaseServiceRole
      .from("store_subscriptions")
      .select("id")
      .eq("store_id", params.storeId)
      .maybeSingle();

    if (findErr) throw findErr;

    if (existing) {
      const { data: updated, error: updateErr } = await supabaseServiceRole
        .from("store_subscriptions")
        .update({
          status: "active",
          plan_code: params.planCode ?? "PREMIUM",
          starts_at: now.toISOString(),
          expires_at: expiresAt.toISOString(),
        })
        .eq("id", existing.id)
        .select("*")
        .single();
      if (updateErr) throw updateErr;
      return updated;
    } else {
      const { data: inserted, error: insertErr } = await supabaseServiceRole
        .from("store_subscriptions")
        .insert({
          store_id: params.storeId,
          plan_code: params.planCode ?? "PREMIUM",
          status: "active",
          starts_at: now.toISOString(),
          expires_at: expiresAt.toISOString(),
        })
        .select("*")
        .single();
      if (insertErr) throw insertErr;
      return inserted;
    }
  }

  return null;
}

function extractEnterpriseFields(body: string): Record<string, string> {
  const fields: Record<string, string> = {};
  if (!body) return fields;

  try {
    const json = JSON.parse(body);
    for (const [key, value] of Object.entries(json)) {
      if (value !== undefined && value !== null) {
        fields[key] = String(value);
      }
    }
    return fields;
  } catch {
    // Fallback URLSearchParams & KV parsing
    const queryParams = new URLSearchParams(body);
    for (const [key, value] of queryParams.entries()) {
      fields[key] = value;
    }

    const kvRegex = /(Lite_[A-Za-z0-9_]+|MerchantReference|Ecom_[A-Za-z0-9_]+|TransactionIndex|Status|StatusCode|ResultDescription)\s*[:=]\s*([^\r\n<]+)/g;
    for (const match of body.matchAll(kvRegex)) {
      fields[match[1]] = match[2].trim();
    }
    return fields;
  }
}

export async function executeIveriMerchantCharge(params: {
  userId: string;
  tokenId: string;
  partnerType: "RESTAURANT" | "STORE";
  restaurantId?: string | null;
  storeId?: string | null;
  amountMajor: number;
  currencyCode?: string;
  description?: string;
  planCode?: string;
  durationMonths?: number;
}) {
  const config = getIveriMerchantConfig();

  const { data: tokenRecord, error: tokenErr } = await supabaseServiceRole
    .from("user_card_tokens")
    .select("*")
    .eq("id", params.tokenId)
    .eq("user_id", params.userId)
    .eq("is_active", true)
    .maybeSingle();

  if (tokenErr || !tokenRecord) {
    throw new Error("Active card token not found");
  }

  const currencyCode = (params.currencyCode ?? "MUR").trim().toUpperCase();
  const amountMinor = toMinor(params.amountMajor);
  const merchantTrace = generateMerchantTrace("MERCHANT_CHARGE");

  // Create payment session
  const { data: session, error: sessionErr } = await supabaseServiceRole
    .from("payment_sessions")
    .insert({
      payment_provider: "IVERI_MERCHANT",
      payment_context: "BILL_PAYMENT",
      user_id: params.userId,
      restaurant_id: params.partnerType === "RESTAURANT" ? params.restaurantId ?? tokenRecord.restaurant_id : null,
      store_id: params.partnerType === "STORE" ? params.storeId ?? tokenRecord.store_id : null,
      merchant_trace: merchantTrace,
      merchant_application_id: config.applicationId,
      amount_major: params.amountMajor,
      amount_minor: amountMinor,
      currency_code: currencyCode,
      original_amount: params.amountMajor,
      discount_amount: 0,
      cashback_amount: 0,
      status: "PENDING",
      gateway_payload: {
        source: "iveri_merchant",
        token_id: tokenRecord.id,
        initial_transaction_index: tokenRecord.initial_transaction_index,
      },
    })
    .select("*")
    .single();

  if (sessionErr || !session) {
    throw sessionErr ?? new Error("Failed to create payment session for merchant charge");
  }

  // Construct iVeri Enterprise Server-to-Server Request
  const formPayload: Record<string, string> = {
    Command: "Debit",
    Lite_Merchant_ApplicationId: config.applicationId,
    Lite_Order_Amount: String(amountMinor),
    Lite_Currency_AlphaCode: currencyCode,
    Lite_Merchant_Trace: merchantTrace,
    MerchantReference: session.id.slice(0, 20),
    Lite_PanFormat: "TransactionIndex",
    Lite_TransactionIndex: tokenRecord.transaction_index,
    Ecom_Payment_Card_Number: tokenRecord.masked_pan,
    Ecom_Payment_Card_Protocols: "IVERI",
    Lite_Version: "4.0",
    Ecom_SchemaVersion: "1.0",
  };

  const response = await postForm(config.enterpriseAuthoriseUrl, formPayload);
  const fields = extractEnterpriseFields(response.body);
  const normalized = normalizeIveriPayload(fields);

  const cardStatus = fields.StatusCode ?? fields.Lite_Payment_Card_Status ?? normalized.canonical.card_status ?? "";
  const isApproved = cardStatus === "0" || cardStatus === "00" || response.statusCode === 200;

  const newTransactionIndex = fields.TransactionIndex ?? fields.Lite_TransactionIndex ?? normalized.canonical.transaction_index;

  if (isApproved) {
    // 1. Update session to VERIFIED_SUCCESS
    const { data: updatedSession, error: updateErr } = await supabaseServiceRole
      .from("payment_sessions")
      .update({
        status: "VERIFIED_SUCCESS",
        gateway_status: cardStatus,
        transaction_index: newTransactionIndex || tokenRecord.transaction_index,
        verified_at: new Date().toISOString(),
        gateway_payload: {
          ...(session.gateway_payload ?? {}),
          enterprise_response: fields,
          raw_status_code: response.statusCode,
        },
      })
      .eq("id", session.id)
      .select("*")
      .single();

    if (updateErr) throw updateErr;

    // 2. Daisy-chain token in user_card_tokens with the new TransactionIndex GUID
    if (newTransactionIndex && newTransactionIndex !== tokenRecord.transaction_index) {
      await supabaseServiceRole
        .from("user_card_tokens")
        .update({
          transaction_index: newTransactionIndex,
          last_used_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", tokenRecord.id);
    } else {
      await supabaseServiceRole
        .from("user_card_tokens")
        .update({
          last_used_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", tokenRecord.id);
    }

    // 3. Update single-row subscription cells
    const subscriptionResult = await syncPartnerSubscription({
      partnerType: params.partnerType,
      restaurantId: session.restaurant_id,
      storeId: session.store_id,
      planCode: params.planCode,
      durationMonths: params.durationMonths,
    });

    return {
      ok: true,
      session: updatedSession,
      subscription: subscriptionResult,
      transaction_index: newTransactionIndex || tokenRecord.transaction_index,
    };
  } else {
    // Declined / Failure
    const { data: failedSession } = await supabaseServiceRole
      .from("payment_sessions")
      .update({
        status: "VERIFIED_FAILED",
        gateway_status: cardStatus,
        gateway_result_description: fields.ResultDescription ?? fields.Lite_Result_Description ?? "Enterprise Charge Refused",
        gateway_payload: {
          ...(session.gateway_payload ?? {}),
          enterprise_response: fields,
          raw_status_code: response.statusCode,
        },
      })
      .eq("id", session.id)
      .select("*")
      .maybeSingle();

    return {
      ok: false,
      session: failedSession || session,
      error: fields.ResultDescription ?? fields.Lite_Result_Description ?? "Enterprise charge refused",
    };
  }
}
