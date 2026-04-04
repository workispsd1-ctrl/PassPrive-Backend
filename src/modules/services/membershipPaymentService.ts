import { z } from "zod";
import supabase from "../../database/supabase";

export class MembershipPaymentValidationError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "MembershipPaymentValidationError";
  }
}

export const MembershipPayloadSchema = z.object({
  plan_id: z.string().uuid(),
  plan_name: z.string().trim().min(1),
  price_id: z.string().trim().min(1),
  product_id: z.string().trim().min(1),
  amount: z.coerce.number().nonnegative(),
  original_amount: z.coerce.number().nonnegative().optional(),
  discount_amount: z.coerce.number().nonnegative().optional(),
  promo_code: z.string().trim().nullable().optional(),
  payment_instrument_type: z.string().trim().nullable().optional(),
  applied_promo: z.record(z.string(), z.any()).optional(),
  validity_days: z.coerce.number().int().positive().optional(),
  subscription_type: z.string().trim().nullable().optional(),
});

function roundMoney(value: number) {
  return Number((Math.round(value * 100) / 100).toFixed(2));
}

function normalizeText(value: any) {
  return String(value ?? "").trim().toLowerCase();
}

function parseMaybeDate(value: any) {
  if (!value) return null;
  const parsed = new Date(String(value));
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
}

function parseMinutesFromTimeString(value: string) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return hours * 60 + minutes;
}

function isPromoTimeWindowValid(validTime: any, now: Date) {
  if (!validTime) return true;

  const raw = String(validTime).trim();
  if (!raw) return true;

  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  const rangeParts = raw.split("-").map((part) => part.trim());
  if (rangeParts.length === 2) {
    const start = parseMinutesFromTimeString(rangeParts[0]);
    const end = parseMinutesFromTimeString(rangeParts[1]);
    if (start === null || end === null) return true;

    if (start <= end) {
      return currentMinutes >= start && currentMinutes <= end;
    }
    // Overnight window e.g. 22:00-02:00
    return currentMinutes >= start || currentMinutes <= end;
  }

  const latest = parseMinutesFromTimeString(raw);
  if (latest === null) return true;
  return currentMinutes <= latest;
}

function isPromoDateValid(validDate: any, now: Date) {
  if (!validDate) return true;
  const parsed = parseMaybeDate(validDate);
  if (!parsed) return true;
  return now.getTime() <= parsed.getTime();
}

export function resolveMembershipDurationDays(typeValue: any) {
  const normalized = normalizeText(typeValue).replace(/\s+/g, "");
  const mapping: Record<string, number> = {
    "2": 2,
    "2days": 2,
    week: 7,
    "7days": 7,
    "10days": 10,
    "15days": 15,
    "20days": 20,
    month: 30,
    "1month": 30,
    "2months": 60,
    "3months": 90,
  };

  if (mapping[normalized]) return mapping[normalized];
  return 30;
}

function resolveMembershipTier(planName: any) {
  const normalized = normalizeText(planName);
  if (normalized.includes("platinum")) return "platinum";
  if (normalized.includes("gold")) return "gold";
  if (normalized.includes("silver")) return "silver";
  return "premium";
}

function normalizeDiscountSource(value: any): "NONE" | "BANK" | "PLATFORM" | "PARTNER" {
  const normalized = normalizeText(value);
  if (normalized === "bank") return "BANK";
  if (normalized === "partner" || normalized === "merchant") return "PARTNER";
  if (normalized === "platform") return "PLATFORM";
  return "NONE";
}

function toMoney(value: any, fallback = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return roundMoney(parsed);
}

function isPromoEligibleForPlan(plans: any, plan: { id: string; plan_name: string; price_id?: string | null; product_id?: string | null }) {
  if (!Array.isArray(plans) || plans.length === 0) return false;
  const normalizedCandidates = new Set(
    plans.map((item) => normalizeText(item)).filter((item) => item.length > 0)
  );

  const checks = [
    normalizeText(plan.id),
    normalizeText(plan.plan_name),
    normalizeText(plan.price_id ?? ""),
    normalizeText(plan.product_id ?? ""),
  ].filter((item) => item.length > 0);

  return checks.some((item) => normalizedCandidates.has(item));
}

export interface MembershipPaymentContext {
  plan: {
    id: string;
    plan_name: string;
    amount: number;
    type: string | null;
    product_id: string | null;
    price_id: string | null;
  };
  promo: null | {
    code: string;
    discount_percent: number;
    valid_date: string | null;
    valid_time: string | null;
    metadata: Record<string, any>;
  };
  originalAmount: number;
  discountAmount: number;
  finalAmount: number;
  durationDays: number;
  membershipTier: string;
  lineItemDescription: string;
  metadata: Record<string, any>;
  discountDetails: {
    source: "NONE" | "BANK" | "PLATFORM" | "PARTNER";
    code: string | null;
    name: string | null;
    meta: Record<string, any>;
  };
}

export async function buildMembershipPaymentContext(params: {
  userId: string;
  payload: z.infer<typeof MembershipPayloadSchema>;
  db?: any;
}) {
  const db = params.db ?? supabase;
  const { data: planRow, error: planError } = await db
    .from("subscription")
    .select("id, plan_name, amount, type, product_id, price_id, sort_order")
    .eq("id", params.payload.plan_id)
    .maybeSingle();

  if (planError) {
    throw new MembershipPaymentValidationError(500, planError.message);
  }
  if (!planRow) {
    throw new MembershipPaymentValidationError(404, "Invalid membership plan");
  }

  const baseAmount = roundMoney(Number(planRow.amount ?? 0));
  if (!Number.isFinite(baseAmount) || baseAmount <= 0) {
    throw new MembershipPaymentValidationError(400, "Membership plan amount is invalid");
  }

  if (
    params.payload.price_id &&
    String(planRow.price_id ?? "").trim() &&
    String(params.payload.price_id).trim() !== String(planRow.price_id).trim()
  ) {
    throw new MembershipPaymentValidationError(400, "Provided price_id does not match selected plan");
  }

  if (
    params.payload.product_id &&
    String(planRow.product_id ?? "").trim() &&
    String(params.payload.product_id).trim() !== String(planRow.product_id).trim()
  ) {
    throw new MembershipPaymentValidationError(400, "Provided product_id does not match selected plan");
  }

  const promoCode = String(params.payload.promo_code ?? "").trim();
  let promo: MembershipPaymentContext["promo"] = null;
  let discountAmount = 0;
  let discountSource: "NONE" | "BANK" | "PLATFORM" | "PARTNER" = "NONE";
  let discountName: string | null = null;
  let discountMeta: Record<string, any> = {};

  if (promoCode) {
    const { data: promoRow, error: promoError } = await db
      .from("promos")
      .select("*")
      .eq("code", promoCode)
      .maybeSingle();

    if (promoError) {
      throw new MembershipPaymentValidationError(500, promoError.message);
    }
    if (!promoRow) {
      throw new MembershipPaymentValidationError(400, "Invalid promo code");
    }

    if (!isPromoEligibleForPlan(promoRow.plans, {
      id: String(planRow.id),
      plan_name: String(planRow.plan_name ?? ""),
      price_id: planRow.price_id ?? null,
      product_id: planRow.product_id ?? null,
    })) {
      throw new MembershipPaymentValidationError(400, "Promo code is not applicable to selected plan");
    }

    const now = new Date();
    if (!isPromoDateValid(promoRow.valid_date, now) || !isPromoTimeWindowValid(promoRow.valid_time, now)) {
      throw new MembershipPaymentValidationError(400, "Promo code has expired");
    }

    const discountPercent = Number(promoRow.discount ?? 0);
    if (!Number.isFinite(discountPercent) || discountPercent < 0 || discountPercent > 100) {
      throw new MembershipPaymentValidationError(400, "Promo discount is invalid");
    }

    discountAmount = roundMoney((baseAmount * discountPercent) / 100);
    promo = {
      code: String(promoRow.code ?? promoCode),
      discount_percent: discountPercent,
      valid_date: promoRow.valid_date ? String(promoRow.valid_date) : null,
      valid_time: promoRow.valid_time ? String(promoRow.valid_time) : null,
      metadata:
        typeof promoRow.metadata === "object" && promoRow.metadata !== null
          ? (promoRow.metadata as Record<string, any>)
          : {},
    };
    discountSource = normalizeDiscountSource(
      promoRow.discount_source ??
        promoRow.source_type ??
        promoRow.sponsor_type ??
        promoRow.metadata?.discount_source ??
        promoRow.metadata?.source_type ??
        "PLATFORM"
    );
    discountName = String(
      promoRow.name ??
        promoRow.title ??
        promoRow.promo_name ??
        promoRow.code ??
        "Membership Promo"
    );
    discountMeta = {
      promo_id: promoRow.id ?? null,
      promo_code: promo?.code ?? promoCode,
      promo_discount_percent: discountPercent,
      source_hint:
        promoRow.source_type ?? promoRow.sponsor_type ?? promoRow.metadata?.source_type ?? null,
    };
  }

  const finalAmount = roundMoney(Math.max(baseAmount - discountAmount, 0));
  if (finalAmount <= 0) {
    throw new MembershipPaymentValidationError(400, "Membership payable amount must be greater than zero");
  }

  const durationDays =
    params.payload.validity_days ??
    resolveMembershipDurationDays(params.payload.subscription_type ?? planRow.type);
  const membershipTier = resolveMembershipTier(planRow.plan_name);

  return {
    plan: {
      id: String(planRow.id),
      plan_name: String(planRow.plan_name ?? params.payload.plan_name),
      amount: baseAmount,
      type: planRow.type ? String(planRow.type) : null,
      product_id: planRow.product_id ? String(planRow.product_id) : null,
      price_id: planRow.price_id ? String(planRow.price_id) : null,
    },
    promo,
    originalAmount: baseAmount,
    discountAmount,
    finalAmount,
    durationDays,
    membershipTier,
    lineItemDescription: `Membership purchase - ${String(planRow.plan_name ?? "PassPrive Membership")}`,
    metadata: {
      user_id: params.userId,
      validated_at: new Date().toISOString(),
      membership_purchase: {
        plan_id: String(planRow.id),
        plan_name: String(planRow.plan_name ?? params.payload.plan_name),
        price_id: String(planRow.price_id ?? params.payload.price_id ?? ""),
        product_id: String(planRow.product_id ?? params.payload.product_id ?? ""),
        base_amount: baseAmount,
        final_amount: finalAmount,
        discount_amount: discountAmount,
        promo_code: promo?.code ?? null,
        promo_discount_percent: promo?.discount_percent ?? null,
        validity_type: String(planRow.type ?? params.payload.subscription_type ?? ""),
        validity_days: durationDays,
      },
      payload_echo: {
        payment_instrument_type: params.payload.payment_instrument_type ?? null,
        applied_promo: params.payload.applied_promo ?? null,
      },
    },
    discountDetails: {
      source: discountSource,
      code: promo?.code ?? null,
      name: discountName,
      meta: discountMeta,
    },
  } satisfies MembershipPaymentContext;
}

function addDays(from: Date, days: number) {
  const date = new Date(from.getTime());
  date.setUTCDate(date.getUTCDate() + days);
  return date;
}

export async function finalizeMembershipPayment(params: {
  session: any;
  userId: string;
  db?: any;
}) {
  const db = params.db ?? supabase;
  const existingFinalize = params.session.gateway_payload?.finalized_membership;
  if (existingFinalize?.applied === true) {
    return {
      duplicate: true,
      membership: existingFinalize,
    };
  }

  const purchaseMeta =
    params.session.gateway_payload?.membership_purchase ??
    params.session.gateway_payload?.context_payload?.membership_payload ??
    params.session.gateway_payload?.context_payload?.membership_purchase ??
    null;

  if (!purchaseMeta || typeof purchaseMeta !== "object") {
    throw new MembershipPaymentValidationError(500, "Membership metadata is missing in payment session");
  }

  const planId = String(
    purchaseMeta.plan_id ??
      params.session.gateway_payload?.context_payload?.membership_payload?.plan_id ??
      ""
  ).trim();
  if (!planId) {
    throw new MembershipPaymentValidationError(500, "Membership plan_id is missing in payment metadata");
  }

  const { data: planRow, error: planError } = await db
    .from("subscription")
    .select("id, plan_name, type")
    .eq("id", planId)
    .maybeSingle();
  if (planError) {
    throw new MembershipPaymentValidationError(500, planError.message);
  }
  if (!planRow) {
    throw new MembershipPaymentValidationError(404, "Membership plan not found for finalization");
  }

  const now = new Date();
  const durationDays = resolveMembershipDurationDays(
    purchaseMeta.validity_type ?? purchaseMeta.subscription_type ?? planRow.type
  );
  const membershipStarted = now.toISOString();
  const membershipExpiry = addDays(now, durationDays).toISOString();
  const promoCode = String(purchaseMeta.promo_code ?? "").trim() || null;
  const membershipTier = resolveMembershipTier(purchaseMeta.plan_name ?? planRow.plan_name);
  const baseAmount = toMoney(purchaseMeta.base_amount, 0);
  const finalAmount = toMoney(purchaseMeta.final_amount, 0);
  const discountAmount = toMoney(purchaseMeta.discount_amount, 0);
  const promoDiscountPercent = toMoney(purchaseMeta.promo_discount_percent, 0);

  const { data: updatedUser, error: userUpdateError } = await db
    .from("users")
    .update({
      membership: "active",
      membership_tier: membershipTier,
      membership_started: membershipStarted,
      membership_expiry: membershipExpiry,
      promo_code_used: promoCode,
      updated_at: new Date().toISOString(),
    })
    .eq("id", params.userId)
    .select(
      "id,membership,membership_tier,membership_started,membership_expiry,promo_code_used,updated_at"
    )
    .single();

  if (userUpdateError) {
    throw new MembershipPaymentValidationError(500, userUpdateError.message);
  }

  return {
    duplicate: false,
    membership: {
      applied: true,
      user_id: updatedUser.id,
      plan_id: String(planRow.id),
      plan_name: String(planRow.plan_name ?? purchaseMeta.plan_name ?? "Membership"),
      membership_tier: membershipTier,
      membership_started: membershipStarted,
      membership_expiry: membershipExpiry,
      duration_days: durationDays,
      promo_code_used: promoCode,
      payment_reference:
        params.session.transaction_index ??
        params.session.bank_reference ??
        params.session.merchant_trace,
      amount_breakdown: {
        base_amount: baseAmount,
        discount_amount: discountAmount,
        final_amount: finalAmount,
        promo_discount_percent: promoDiscountPercent,
      },
    },
    user: updatedUser,
  };
}
