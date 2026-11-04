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
    quarter: 90,
    quarterly: 90,
    "3month": 90,
    "2months": 60,
    "3months": 90,
    year: 365,
    yearly: 365,
    annual: 365,
    annually: 365,
    "1year": 365,
    "12month": 365,
    "12months": 365,
  };

  if (mapping[normalized]) return mapping[normalized];
  return 30;
}

const TIER_RANK: Record<string, number> = { free: 0, plus: 1, black: 2 };

function resolveMembershipTier(planName: any) {
  const value = String(planName ?? "").trim();
  return value || "none";
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
  const promoCode = String(params.payload.promo_code ?? "").trim();

  if (promoCode) {
    throw new MembershipPaymentValidationError(400, "Promo codes are not available for memberships yet");
  }

  const { data: planRow, error: planError } = await db
    .from("subscription")
    .select("id, plan_name, amount, type, tier, product_id, price_id, sort_order")
    .eq("id", params.payload.plan_id)
    .eq("is_active", true)
    .maybeSingle();

  if (planError) {
    throw new MembershipPaymentValidationError(500, planError.message);
  }
  if (!planRow) {
    throw new MembershipPaymentValidationError(404, "Invalid membership plan");
  }

  const { data: currentTier, error: tierError } = await db.rpc("user_tier_slug", { p_user_id: params.userId });
  if (tierError) {
    throw new MembershipPaymentValidationError(500, tierError.message);
  }
  const tierRank = (tier: any) => TIER_RANK[normalizeText(tier)] ?? 0;
  const currentRank = tierRank(currentTier);
  const targetRank = tierRank(planRow.tier);
  if (targetRank === 0) {
    throw new MembershipPaymentValidationError(400, "This plan cannot be purchased");
  }
  if (currentRank > targetRank) {
    throw new MembershipPaymentValidationError(409, "You already have a higher membership. You can switch when it ends.");
  }
  if (currentRank > 0 && currentRank === targetRank) {
    const { data: member, error: memberError } = await db
      .from("users")
      .select("membership_expiry")
      .eq("id", params.userId)
      .maybeSingle();
    if (memberError) {
      throw new MembershipPaymentValidationError(500, memberError.message);
    }
    if (!member?.membership_expiry) {
      throw new MembershipPaymentValidationError(409, "Your membership has no end date, so it does not need renewing.");
    }
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

  const discountAmount = 0;
  const finalAmount = baseAmount;
  if (finalAmount <= 0) {
    throw new MembershipPaymentValidationError(400, "Membership payable amount must be greater than zero");
  }

  const durationDays = resolveMembershipDurationDays(planRow.type);
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
    promo: null,
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
        promo_code: null,
        promo_discount_percent: null,
        validity_type: String(planRow.type ?? ""),
        validity_days: durationDays,
      },
      payload_echo: {
        payment_instrument_type: params.payload.payment_instrument_type ?? null,
        applied_promo: params.payload.applied_promo ?? null,
      },
    },
    discountDetails: {
      source: "NONE",
      code: null,
      name: null,
      meta: {},
    },
  } satisfies MembershipPaymentContext;
}

export async function finalizeMembershipPayment(params: {
  session: any;
  userId: string;
  db?: any;
}) {
  const db = params.db ?? supabase;
  if (params.session?.user_id && params.session.user_id !== params.userId) {
    throw new MembershipPaymentValidationError(403, "Access denied");
  }

  const { data, error } = await db.rpc("finalize_membership_session", { p_session_id: params.session.id });
  if (error) {
    const status = error.code === "P0002" ? 404 : error.code === "22023" ? 409 : 500;
    throw new MembershipPaymentValidationError(status, error.message);
  }

  return {
    duplicate: data?.duplicate === true,
    membership: data?.membership ?? null,
    user: data?.user ?? null,
  };
}
