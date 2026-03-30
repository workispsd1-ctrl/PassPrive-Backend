import { Router } from "express";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import supabase from "../../database/supabase";

const router = Router();

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY!;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in env");
}

const OFFER_TABLE = "offers";
const TARGETS_TABLE = "offer_targets";
const CONDITIONS_TABLE = "offer_conditions";
const PAYMENT_RULES_TABLE = "offer_payment_rules";
const BINS_TABLE = "offer_bins";
const USAGE_LIMITS_TABLE = "offer_usage_limits";
const REDEMPTIONS_TABLE = "offer_redemptions";

const IdSchema = z.string().uuid();

const ListOffersQuerySchema = z.object({
  source_type: z.enum(["PLATFORM", "MERCHANT", "BANK"]).optional(),
  entity_type: z.enum(["STORE", "RESTAURANT"]).optional(),
  includeInactive: z
    .string()
    .optional()
    .transform((v) => v === "true"),
});

const ApplicableOfferQuerySchema = z.object({
  payment_flow: z.string().trim().optional(),
  bill_amount: z
    .string()
    .optional()
    .transform((v) => (v ? Number(v) : undefined))
    .refine((v) => v === undefined || Number.isFinite(v), "bill_amount must be numeric"),
  payment_instrument_type: z.string().trim().optional(),
  card_network: z.string().trim().optional(),
  issuer_bank_name: z.string().trim().optional(),
  bin: z.string().trim().optional(),
  user_id: z.string().uuid().optional(),
  coupon_code: z.string().trim().optional(),
});

const OfferBaseSchema = z
  .object({
    source_type: z.enum(["PLATFORM", "MERCHANT", "BANK"]),
    title: z.string().trim().min(1),
    offer_type: z.string().trim().min(1),
    subtitle: z.string().trim().nullable().optional(),
    description: z.string().trim().nullable().optional(),
    badge_text: z.string().trim().nullable().optional(),
    badge_kind: z.string().trim().nullable().optional(),
    ribbon_text: z.string().trim().nullable().optional(),
    banner_image_url: z.string().trim().nullable().optional(),
    sponsor_name: z.string().trim().nullable().optional(),
    benefit_value: z.coerce.number().nullable().optional(),
    benefit_percent: z.coerce.number().nullable().optional(),
    max_discount_amount: z.coerce.number().nullable().optional(),
    currency_code: z.string().trim().optional(),
    min_bill_amount: z.coerce.number().nullable().optional(),
    max_bill_amount: z.coerce.number().nullable().optional(),
    is_active: z.boolean().optional(),
    is_auto_apply: z.boolean().optional(),
    is_stackable: z.boolean().optional(),
    priority: z.coerce.number().int().optional(),
    starts_at: z.string().datetime().nullable().optional(),
    ends_at: z.string().datetime().nullable().optional(),
    status: z.string().trim().nullable().optional(),
    terms_and_conditions: z.any().optional(),
    metadata: z.any().optional(),
    owner_entity_type: z.string().trim().nullable().optional(),
    owner_entity_id: z.string().uuid().nullable().optional(),
    module: z.string().trim().nullable().optional(),
    payment_flow: z.string().trim().nullable().optional(),
    short_title: z.string().trim().nullable().optional(),
    badge_bg_color: z.string().trim().nullable().optional(),
    badge_text_color: z.string().trim().nullable().optional(),
    stack_group: z.string().trim().nullable().optional(),
    sponsor_type: z.string().trim().nullable().optional(),
  })
  .strict();

function applyOfferValidation<T extends z.ZodTypeAny>(schema: T) {
  return schema.superRefine((value: any, ctx) => {
    const hasOwnerType =
      value.owner_entity_type !== undefined &&
      value.owner_entity_type !== null &&
      String(value.owner_entity_type).trim().length > 0;
    const hasOwnerId =
      value.owner_entity_id !== undefined && value.owner_entity_id !== null;

    if (hasOwnerType !== hasOwnerId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: hasOwnerType ? ["owner_entity_id"] : ["owner_entity_type"],
        message: "owner_entity_type and owner_entity_id must both be provided together",
      });
    }
  });
}

const OfferBodySchema = applyOfferValidation(OfferBaseSchema);
const UpdateOfferBodySchema = applyOfferValidation(OfferBaseSchema.partial());

const TargetBodySchema = z
  .object({
    target_type: z.string().trim().min(1),
    entity_type: z.enum(["STORE", "RESTAURANT"]).nullable().optional(),
    entity_id: z.string().uuid().nullable().optional(),
    store_id: z.string().uuid().nullable().optional(),
    restaurant_id: z.string().uuid().nullable().optional(),
    city: z.string().trim().nullable().optional(),
    category: z.string().trim().nullable().optional(),
    subcategory: z.string().trim().nullable().optional(),
    tag: z.string().trim().nullable().optional(),
    metadata: z.any().optional(),
  })
  .strict();

const ConditionBodySchema = z
  .object({
    condition_type: z.string().trim().min(1),
    operator: z.string().trim().optional(),
    condition_value: z.any().optional(),
    is_required: z.boolean().optional(),
    sort_order: z.coerce.number().int().optional(),
  })
  .strict();

const UpdateConditionBodySchema = ConditionBodySchema.partial();

const PaymentRuleBodySchema = z
  .object({
    payment_flow: z.string().trim().nullable().optional(),
    payment_instrument_type: z.string().trim().nullable().optional(),
    card_network: z.string().trim().nullable().optional(),
    issuer_bank_name: z.string().trim().nullable().optional(),
    coupon_code: z.string().trim().nullable().optional(),
    metadata: z.any().optional(),
  })
  .strict();

const UpdatePaymentRuleBodySchema = PaymentRuleBodySchema.partial();

const BinBodySchema = z
  .object({
    bin: z.string().trim().min(4),
    card_network: z.string().trim().nullable().optional(),
    issuer_bank_name: z.string().trim().nullable().optional(),
    metadata: z.any().optional(),
  })
  .strict();

const UsageLimitBodySchema = z
  .object({
    total_redemption_limit: z.coerce.number().int().nullable().optional(),
    per_user_redemption_limit: z.coerce.number().int().nullable().optional(),
    per_store_redemption_limit: z.coerce.number().int().nullable().optional(),
    per_restaurant_redemption_limit: z.coerce.number().int().nullable().optional(),
    per_day_redemption_limit: z.coerce.number().int().nullable().optional(),
  })
  .strict();

const RedemptionBodySchema = z
  .object({
    entity_type: z.enum(["STORE", "RESTAURANT"]),
    store_id: z.string().uuid().nullable().optional(),
    restaurant_id: z.string().uuid().nullable().optional(),
    user_id: z.string().uuid().nullable().optional(),
    order_reference: z.string().trim().nullable().optional(),
    bill_amount: z.coerce.number().min(0),
    discount_amount: z.coerce.number().min(0),
    currency_code: z.string().trim().optional(),
    redemption_status: z.string().trim().optional(),
    redeemed_at: z.string().datetime().nullable().optional(),
    expires_at: z.string().datetime().nullable().optional(),
    metadata: z.any().optional(),
  })
  .strict();

function getBearerToken(req: any) {
  const header = req.headers.authorization || "";
  const [type, token] = header.split(" ");
  if (type !== "Bearer" || !token) return null;
  return token;
}

function supabaseAuthed(req: any) {
  const token = getBearerToken(req);
  if (!token) return null;

  return createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
}

async function requireAdmin(req: any, res: any) {
  const sb = supabaseAuthed(req);
  if (!sb) {
    return { sb: supabase, callerId: null };
  }

  const { data: userData } = await sb.auth.getUser();
  return { sb, callerId: userData?.user?.id ?? null };
}

function buildNullAwarePayload(payload: Record<string, any>) {
  return Object.fromEntries(
    Object.entries(payload)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [key, value ?? null])
  );
}

function normalizeText(value: any) {
  return String(value ?? "").trim().toLowerCase();
}

function parseNumeric(value: any) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function valueMatchesOperator(left: any, operator: string, right: any) {
  const normalizedOperator = operator.toUpperCase();

  if (normalizedOperator === "IN") {
    const values = Array.isArray(right) ? right : [right];
    return values.map(normalizeText).includes(normalizeText(left));
  }
  if (normalizedOperator === "NOT_IN") {
    const values = Array.isArray(right) ? right : [right];
    return !values.map(normalizeText).includes(normalizeText(left));
  }

  const leftNumber = parseNumeric(left);
  const rightNumber = parseNumeric(right);

  if (leftNumber !== null && rightNumber !== null) {
    if (normalizedOperator === "EQ") return leftNumber === rightNumber;
    if (normalizedOperator === "NEQ") return leftNumber !== rightNumber;
    if (normalizedOperator === "GT") return leftNumber > rightNumber;
    if (normalizedOperator === "GTE") return leftNumber >= rightNumber;
    if (normalizedOperator === "LT") return leftNumber < rightNumber;
    if (normalizedOperator === "LTE") return leftNumber <= rightNumber;
  }

  if (normalizedOperator === "EQ") return normalizeText(left) === normalizeText(right);
  if (normalizedOperator === "NEQ") return normalizeText(left) !== normalizeText(right);
  return false;
}

function mapBadgeKind(offer: any) {
  if (offer?.badge_kind) return offer.badge_kind;
  if (offer?.source_type === "PLATFORM") return "PASSPRIVE";
  if (offer?.source_type === "BANK") return "BANK";
  return offer?.metadata?.entity_type === "RESTAURANT" ? "RESTAURANT" : "STORE";
}

function mapBadgeText(offer: any) {
  if (offer?.badge_text) return offer.badge_text;
  if (offer?.source_type === "PLATFORM") return "PassPrive";
  if (offer?.source_type === "BANK") return offer?.sponsor_name ?? "Bank Offer";
  return offer?.metadata?.entity_type === "RESTAURANT" ? "Restaurant Offer" : "Store Offer";
}

function isOfferActiveNow(offer: any, now = new Date()) {
  if (offer?.is_active === false) return false;

  const status = String(offer?.status ?? "ACTIVE").trim().toUpperCase();
  if (status && !["ACTIVE", "LIVE"].includes(status)) return false;

  const startsAt = offer?.starts_at ? new Date(offer.starts_at) : null;
  const endsAt = offer?.ends_at ? new Date(offer.ends_at) : null;

  if (startsAt && startsAt > now) return false;
  if (endsAt && endsAt < now) return false;
  return true;
}

async function getOfferBundle(offerId: string) {
  const { data: offer, error: offerError } = await supabase
    .from(OFFER_TABLE)
    .select("*")
    .eq("id", offerId)
    .maybeSingle();

  if (offerError) throw offerError;
  if (!offer) return null;

  const [
    { data: targets, error: targetsError },
    { data: conditions, error: conditionsError },
    { data: payment_rules, error: paymentRulesError },
    { data: bins, error: binsError },
    { data: usage_limit, error: usageLimitError },
  ] = await Promise.all([
    supabase.from(TARGETS_TABLE).select("*").eq("offer_id", offerId),
    supabase
      .from(CONDITIONS_TABLE)
      .select("*")
      .eq("offer_id", offerId)
      .order("sort_order", { ascending: true })
      .order("created_at", { ascending: true }),
    supabase.from(PAYMENT_RULES_TABLE).select("*").eq("offer_id", offerId),
    supabase.from(BINS_TABLE).select("*").eq("offer_id", offerId),
    supabase.from(USAGE_LIMITS_TABLE).select("*").eq("offer_id", offerId).maybeSingle(),
  ]);

  if (targetsError) throw targetsError;
  if (conditionsError) throw conditionsError;
  if (paymentRulesError) throw paymentRulesError;
  if (binsError) throw binsError;
  if (usageLimitError) throw usageLimitError;

  return {
    ...offer,
    targets: targets ?? [],
    conditions: conditions ?? [],
    payment_rules: payment_rules ?? [],
    bins: bins ?? [],
    usage_limit: usage_limit ?? null,
  };
}

async function fetchApplicableContext(params: {
  entityType: "STORE" | "RESTAURANT";
  entityId: string;
}) {
  const table = params.entityType === "STORE" ? "stores" : "restaurants";
  const { data, error } = await supabase
    .from(table)
    .select("*")
    .eq("id", params.entityId)
    .maybeSingle();

  if (error) throw error;
  return data;
}

function matchesTarget(target: any, context: any) {
  const targetType = String(target?.target_type ?? "").trim().toUpperCase();
  if (!targetType) return true;

  if (target?.store_id && context.entityType === "STORE") {
    return target.store_id === context.entityId;
  }
  if (target?.restaurant_id && context.entityType === "RESTAURANT") {
    return target.restaurant_id === context.entityId;
  }
  if (target?.entity_type && target?.entity_id) {
    return (
      String(target.entity_type).trim().toUpperCase() === context.entityType &&
      target.entity_id === context.entityId
    );
  }

  if (targetType === "ALL_STORES" && context.entityType === "STORE") return true;
  if (targetType === "ALL_RESTAURANTS" && context.entityType === "RESTAURANT") return true;
  if (targetType === "STORE" && context.entityType === "STORE") return true;
  if (targetType === "RESTAURANT" && context.entityType === "RESTAURANT") return true;
  if (targetType === "CITY") return normalizeText(target.city ?? target.value) === normalizeText(context.entity?.city);
  if (targetType === "CATEGORY") {
    return normalizeText(target.category ?? target.value) === normalizeText(context.entity?.category);
  }
  if (targetType === "SUBCATEGORY") {
    return normalizeText(target.subcategory ?? target.value) === normalizeText(context.entity?.subcategory);
  }
  if (targetType === "TAG") {
    return Array.isArray(context.entity?.tags)
      ? context.entity.tags.map(normalizeText).includes(normalizeText(target.tag ?? target.value))
      : false;
  }

  return false;
}

function matchesAllTargets(targets: any[], context: any) {
  if (!targets || targets.length === 0) return true;
  return targets.some((target) => matchesTarget(target, context));
}

function matchesCondition(condition: any, context: any) {
  const conditionType = String(condition?.condition_type ?? "").trim().toUpperCase();
  const operator = String(condition?.operator ?? "EQ").trim().toUpperCase();
  const value = condition?.condition_value;

  if (!conditionType) return true;
  if (conditionType === "MIN_BILL_AMOUNT") {
    return valueMatchesOperator(context.billAmount ?? 0, "GTE", value?.amount ?? value);
  }
  if (conditionType === "MAX_BILL_AMOUNT") {
    return valueMatchesOperator(context.billAmount ?? 0, "LTE", value?.amount ?? value);
  }
  if (conditionType === "CITY") {
    return valueMatchesOperator(context.entity?.city, operator, value?.city ?? value);
  }
  if (conditionType === "CATEGORY") {
    return valueMatchesOperator(context.entity?.category, operator, value?.category ?? value);
  }
  if (conditionType === "SUBCATEGORY") {
    return valueMatchesOperator(context.entity?.subcategory, operator, value?.subcategory ?? value);
  }
  if (conditionType === "TAG") {
    const tags = Array.isArray(context.entity?.tags) ? context.entity.tags : [];
    return tags.some((tag: string) => valueMatchesOperator(tag, operator, value?.tag ?? value));
  }
  if (conditionType === "DAY_OF_WEEK") {
    const today = new Date().getDay();
    return valueMatchesOperator(today, operator, value?.day ?? value);
  }
  if (conditionType === "STORE_PLAN") {
    return valueMatchesOperator(context.entity?.pickup_mode, operator, value?.plan_code ?? value);
  }
  if (conditionType === "STORE_AD_STATUS") {
    return valueMatchesOperator(context.entity?.is_advertised, operator, value?.is_advertised ?? value);
  }

  return true;
}

function matchesAllConditions(conditions: any[], context: any) {
  if (!conditions || conditions.length === 0) return true;
  return conditions.every((condition) => matchesCondition(condition, context));
}

function matchesPaymentRule(rule: any, context: any) {
  if (rule?.payment_flow && normalizeText(rule.payment_flow) !== normalizeText(context.paymentFlow)) {
    return false;
  }
  if (
    rule?.payment_instrument_type &&
    normalizeText(rule.payment_instrument_type) !== normalizeText(context.paymentInstrumentType)
  ) {
    return false;
  }
  if (rule?.card_network && normalizeText(rule.card_network) !== normalizeText(context.cardNetwork)) {
    return false;
  }
  if (
    rule?.issuer_bank_name &&
    normalizeText(rule.issuer_bank_name) !== normalizeText(context.issuerBankName)
  ) {
    return false;
  }
  if (rule?.coupon_code && normalizeText(rule.coupon_code) !== normalizeText(context.couponCode)) {
    return false;
  }
  return true;
}

function matchesAllPaymentRules(paymentRules: any[], context: any) {
  if (!paymentRules || paymentRules.length === 0) return true;
  return paymentRules.every((rule) => matchesPaymentRule(rule, context));
}

function matchesBins(bins: any[], context: any) {
  if (!bins || bins.length === 0) return true;
  if (!context.bin) return false;

  return bins.some((binRule) => String(context.bin).startsWith(String(binRule.bin ?? "")));
}

async function isUsageLimitAvailable(offer: any, usageLimit: any, context: any) {
  if (!usageLimit) return true;

  const { count: totalCount, error: totalError } = await supabase
    .from(REDEMPTIONS_TABLE)
    .select("id", { count: "exact", head: true })
    .eq("offer_id", offer.id);

  if (totalError) throw totalError;

  if (
    usageLimit.total_redemption_limit !== null &&
    usageLimit.total_redemption_limit !== undefined &&
    (totalCount ?? 0) >= usageLimit.total_redemption_limit
  ) {
    return false;
  }

  if (context.userId && usageLimit.per_user_redemption_limit) {
    const { count, error } = await supabase
      .from(REDEMPTIONS_TABLE)
      .select("id", { count: "exact", head: true })
      .eq("offer_id", offer.id)
      .eq("user_id", context.userId);

    if (error) throw error;
    if ((count ?? 0) >= usageLimit.per_user_redemption_limit) return false;
  }

  if (context.entityType === "STORE" && usageLimit.per_store_redemption_limit) {
    const { count, error } = await supabase
      .from(REDEMPTIONS_TABLE)
      .select("id", { count: "exact", head: true })
      .eq("offer_id", offer.id)
      .eq("store_id", context.entityId);

    if (error) throw error;
    if ((count ?? 0) >= usageLimit.per_store_redemption_limit) return false;
  }

  if (context.entityType === "RESTAURANT" && usageLimit.per_restaurant_redemption_limit) {
    const { count, error } = await supabase
      .from(REDEMPTIONS_TABLE)
      .select("id", { count: "exact", head: true })
      .eq("offer_id", offer.id)
      .eq("restaurant_id", context.entityId);

    if (error) throw error;
    if ((count ?? 0) >= usageLimit.per_restaurant_redemption_limit) return false;
  }

  if (usageLimit.per_day_redemption_limit) {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    const { count, error } = await supabase
      .from(REDEMPTIONS_TABLE)
      .select("id", { count: "exact", head: true })
      .eq("offer_id", offer.id)
      .gte("redeemed_at", startOfDay.toISOString());

    if (error) throw error;
    if ((count ?? 0) >= usageLimit.per_day_redemption_limit) return false;
  }

  return true;
}

function normalizeApplicableOffer(offer: any, applicability: { is_eligible: boolean; reason: string | null }) {
  return {
    id: offer.id,
    source_type: offer.source_type,
    title: offer.title,
    subtitle: offer.subtitle ?? null,
    description: offer.description ?? null,
    badge_text: mapBadgeText(offer),
    badge_kind: mapBadgeKind(offer),
    ribbon_text: offer.ribbon_text ?? null,
    banner_image_url: offer.banner_image_url ?? null,
    offer_type: offer.offer_type,
    benefit_value: offer.benefit_value ?? null,
    benefit_percent: offer.benefit_percent ?? null,
    max_discount_amount: offer.max_discount_amount ?? null,
    currency_code: offer.currency_code ?? "MUR",
    min_bill_amount: offer.min_bill_amount ?? null,
    is_auto_apply: offer.is_auto_apply ?? false,
    is_stackable: offer.is_stackable ?? false,
    priority: offer.priority ?? 100,
    terms_and_conditions: offer.terms_and_conditions ?? [],
    sponsor_name: offer.sponsor_name ?? null,
    payment_rules: offer.payment_rules ?? [],
    applicability,
  };
}

async function evaluateApplicableOffers(params: {
  entityType: "STORE" | "RESTAURANT";
  entityId: string;
  query: z.infer<typeof ApplicableOfferQuerySchema>;
}) {
  const entity = await fetchApplicableContext({
    entityType: params.entityType,
    entityId: params.entityId,
  });

  if (!entity) {
    return { status: 404 as const, body: { error: `${params.entityType} not found` } };
  }

  const { data: offers, error } = await supabase
    .from(OFFER_TABLE)
    .select("*")
    .eq("is_active", true);

  if (error) throw error;

  const activeOffers = (offers ?? []).filter((offer) => isOfferActiveNow(offer));
  const offerIds = activeOffers.map((offer) => offer.id);

  const [
    { data: targets, error: targetsError },
    { data: conditions, error: conditionsError },
    { data: paymentRules, error: paymentRulesError },
    { data: bins, error: binsError },
    { data: usageLimits, error: usageLimitsError },
  ] = await Promise.all([
    supabase.from(TARGETS_TABLE).select("*").in("offer_id", offerIds.length > 0 ? offerIds : ["00000000-0000-0000-0000-000000000000"]),
    supabase.from(CONDITIONS_TABLE).select("*").in("offer_id", offerIds.length > 0 ? offerIds : ["00000000-0000-0000-0000-000000000000"]),
    supabase.from(PAYMENT_RULES_TABLE).select("*").in("offer_id", offerIds.length > 0 ? offerIds : ["00000000-0000-0000-0000-000000000000"]),
    supabase.from(BINS_TABLE).select("*").in("offer_id", offerIds.length > 0 ? offerIds : ["00000000-0000-0000-0000-000000000000"]),
    supabase.from(USAGE_LIMITS_TABLE).select("*").in("offer_id", offerIds.length > 0 ? offerIds : ["00000000-0000-0000-0000-000000000000"]),
  ]);

  if (targetsError) throw targetsError;
  if (conditionsError) throw conditionsError;
  if (paymentRulesError) throw paymentRulesError;
  if (binsError) throw binsError;
  if (usageLimitsError) throw usageLimitsError;

  const targetsByOfferId = new Map<string, any[]>();
  const conditionsByOfferId = new Map<string, any[]>();
  const paymentRulesByOfferId = new Map<string, any[]>();
  const binsByOfferId = new Map<string, any[]>();
  const usageByOfferId = new Map<string, any>();

  for (const target of targets ?? []) {
    const grouped = targetsByOfferId.get(target.offer_id) ?? [];
    grouped.push(target);
    targetsByOfferId.set(target.offer_id, grouped);
  }
  for (const condition of conditions ?? []) {
    const grouped = conditionsByOfferId.get(condition.offer_id) ?? [];
    grouped.push(condition);
    conditionsByOfferId.set(condition.offer_id, grouped);
  }
  for (const rule of paymentRules ?? []) {
    const grouped = paymentRulesByOfferId.get(rule.offer_id) ?? [];
    grouped.push(rule);
    paymentRulesByOfferId.set(rule.offer_id, grouped);
  }
  for (const binRule of bins ?? []) {
    const grouped = binsByOfferId.get(binRule.offer_id) ?? [];
    grouped.push(binRule);
    binsByOfferId.set(binRule.offer_id, grouped);
  }
  for (const usageLimit of usageLimits ?? []) {
    usageByOfferId.set(usageLimit.offer_id, usageLimit);
  }

  const evaluationContext = {
    entityType: params.entityType,
    entityId: params.entityId,
    entity,
    billAmount: params.query.bill_amount ?? null,
    paymentFlow: params.query.payment_flow ?? null,
    paymentInstrumentType: params.query.payment_instrument_type ?? null,
    cardNetwork: params.query.card_network ?? null,
    issuerBankName: params.query.issuer_bank_name ?? null,
    bin: params.query.bin ?? null,
    userId: params.query.user_id ?? null,
    couponCode: params.query.coupon_code ?? null,
  };

  const eligibleItems: any[] = [];

  for (const offer of activeOffers) {
    const offerTargets = targetsByOfferId.get(offer.id) ?? [];
    const offerConditions = conditionsByOfferId.get(offer.id) ?? [];
    const offerPaymentRules = paymentRulesByOfferId.get(offer.id) ?? [];
    const offerBins = binsByOfferId.get(offer.id) ?? [];
    const usageLimit = usageByOfferId.get(offer.id) ?? null;

    if (!matchesAllTargets(offerTargets, evaluationContext)) continue;
    if (!matchesAllConditions(offerConditions, evaluationContext)) continue;
    if (!matchesAllPaymentRules(offerPaymentRules, evaluationContext)) continue;
    if (offer.source_type === "BANK" && !matchesBins(offerBins, evaluationContext)) continue;

    const usageAllowed = await isUsageLimitAvailable(offer, usageLimit, evaluationContext);
    if (!usageAllowed) continue;

    eligibleItems.push(
      normalizeApplicableOffer(
        {
          ...offer,
          payment_rules: offerPaymentRules,
        },
        { is_eligible: true, reason: null }
      )
    );
  }

  eligibleItems.sort((a, b) => {
    const aPriority = Number(a.priority ?? 100);
    const bPriority = Number(b.priority ?? 100);
    if (aPriority !== bPriority) return aPriority - bPriority;

    const aBenefit = parseNumeric(a.benefit_value ?? a.benefit_percent) ?? 0;
    const bBenefit = parseNumeric(b.benefit_value ?? b.benefit_percent) ?? 0;
    return bBenefit - aBenefit;
  });

  return { status: 200 as const, body: { items: eligibleItems } };
}

router.get("/", async (req, res) => {
  const parsed = ListOffersQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid query", details: parsed.error.flatten() });
  }

  const { source_type, entity_type, includeInactive } = parsed.data;

  let query = supabase.from(OFFER_TABLE).select("*");

  if (!includeInactive) {
    query = query.eq("is_active", true);
  } else {
    const admin = await requireAdmin(req, res);
    if (!admin) return;
  }

  if (source_type) query = query.eq("source_type", source_type);
  if (entity_type) query = query.eq("entity_type", entity_type);

  const { data, error } = await query
    .order("priority", { ascending: true })
    .order("created_at", { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  return res.json({ items: data ?? [] });
});

router.get("/applicable/store/:storeId", async (req, res) => {
  const idParsed = IdSchema.safeParse(req.params.storeId);
  if (!idParsed.success) return res.status(400).json({ error: "Invalid store id" });

  const queryParsed = ApplicableOfferQuerySchema.safeParse(req.query);
  if (!queryParsed.success) {
    return res.status(400).json({ error: "Invalid query", details: queryParsed.error.flatten() });
  }

  try {
    const result = await evaluateApplicableOffers({
      entityType: "STORE",
      entityId: idParsed.data,
      query: queryParsed.data,
    });

    return res.status(result.status).json(result.body);
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

router.get("/applicable/restaurant/:restaurantId", async (req, res) => {
  const idParsed = IdSchema.safeParse(req.params.restaurantId);
  if (!idParsed.success) return res.status(400).json({ error: "Invalid restaurant id" });

  const queryParsed = ApplicableOfferQuerySchema.safeParse(req.query);
  if (!queryParsed.success) {
    return res.status(400).json({ error: "Invalid query", details: queryParsed.error.flatten() });
  }

  try {
    const result = await evaluateApplicableOffers({
      entityType: "RESTAURANT",
      entityId: idParsed.data,
      query: queryParsed.data,
    });

    return res.status(result.status).json(result.body);
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

router.get("/:id", async (req, res) => {
  const parsed = IdSchema.safeParse(req.params.id);
  if (!parsed.success) return res.status(400).json({ error: "Invalid offer id" });

  try {
    const offer = await getOfferBundle(parsed.data);
    if (!offer) return res.status(404).json({ error: "Offer not found" });
    return res.json({ offer });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

router.post("/", async (req, res) => {
  const parsed = OfferBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid body", details: parsed.error.flatten() });
  }

  const admin = await requireAdmin(req, res);
  if (!admin) return;

  const payload = buildNullAwarePayload({
    ...parsed.data,
    currency_code: parsed.data.currency_code ?? "MUR",
    is_active: parsed.data.is_active ?? true,
    is_auto_apply: parsed.data.is_auto_apply ?? true,
    is_stackable: parsed.data.is_stackable ?? false,
    priority: parsed.data.priority ?? 100,
    terms_and_conditions: parsed.data.terms_and_conditions ?? [],
    metadata: parsed.data.metadata ?? {},
    created_by: admin.callerId,
  });

  const { data, error } = await supabase
    .from(OFFER_TABLE)
    .insert(payload)
    .select("*")
    .single();

  if (error) return res.status(500).json({ error: error.message });
  return res.status(201).json({ offer: data });
});

router.put("/:id", async (req, res) => {
  const idParsed = IdSchema.safeParse(req.params.id);
  if (!idParsed.success) return res.status(400).json({ error: "Invalid offer id" });

  const parsed = UpdateOfferBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid body", details: parsed.error.flatten() });
  }

  const admin = await requireAdmin(req, res);
  if (!admin) return;

  const payload = buildNullAwarePayload(parsed.data);
  if (Object.keys(payload).length === 0) {
    return res.status(400).json({ error: "No fields to update" });
  }

  const { data, error } = await supabase
    .from(OFFER_TABLE)
    .update(payload)
    .eq("id", idParsed.data)
    .select("*")
    .single();

  if (error) return res.status(500).json({ error: error.message });
  return res.json({ offer: data });
});

router.delete("/:id", async (req, res) => {
  const parsed = IdSchema.safeParse(req.params.id);
  if (!parsed.success) return res.status(400).json({ error: "Invalid offer id" });

  const admin = await requireAdmin(req, res);
  if (!admin) return;

  const { error } = await supabase
    .from(OFFER_TABLE)
    .delete()
    .eq("id", parsed.data);

  if (error) return res.status(500).json({ error: error.message });
  return res.json({ ok: true, id: parsed.data });
});

router.get("/:id/targets", async (req, res) => {
  const parsed = IdSchema.safeParse(req.params.id);
  if (!parsed.success) return res.status(400).json({ error: "Invalid offer id" });

  const { data, error } = await supabase
    .from(TARGETS_TABLE)
    .select("*")
    .eq("offer_id", parsed.data);

  if (error) return res.status(500).json({ error: error.message });
  return res.json({ items: data ?? [] });
});

router.post("/:id/targets", async (req, res) => {
  const offerIdParsed = IdSchema.safeParse(req.params.id);
  if (!offerIdParsed.success) return res.status(400).json({ error: "Invalid offer id" });

  const parsed = TargetBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid body", details: parsed.error.flatten() });
  }

  const admin = await requireAdmin(req, res);
  if (!admin) return;

  const { data, error } = await supabase
    .from(TARGETS_TABLE)
    .insert(buildNullAwarePayload({ offer_id: offerIdParsed.data, ...parsed.data, metadata: parsed.data.metadata ?? {} }))
    .select("*")
    .single();

  if (error) return res.status(500).json({ error: error.message });
  return res.status(201).json({ item: data });
});

router.delete("/:id/targets/:targetId", async (req, res) => {
  const offerIdParsed = IdSchema.safeParse(req.params.id);
  const targetIdParsed = IdSchema.safeParse(req.params.targetId);
  if (!offerIdParsed.success || !targetIdParsed.success) {
    return res.status(400).json({ error: "Invalid id" });
  }

  const admin = await requireAdmin(req, res);
  if (!admin) return;

  const { error } = await supabase
    .from(TARGETS_TABLE)
    .delete()
    .eq("offer_id", offerIdParsed.data)
    .eq("id", targetIdParsed.data);

  if (error) return res.status(500).json({ error: error.message });
  return res.json({ ok: true, id: targetIdParsed.data });
});

router.get("/:id/conditions", async (req, res) => {
  const parsed = IdSchema.safeParse(req.params.id);
  if (!parsed.success) return res.status(400).json({ error: "Invalid offer id" });

  const { data, error } = await supabase
    .from(CONDITIONS_TABLE)
    .select("*")
    .eq("offer_id", parsed.data)
    .order("sort_order", { ascending: true })
    .order("created_at", { ascending: true });

  if (error) return res.status(500).json({ error: error.message });
  return res.json({ items: data ?? [] });
});

router.post("/:id/conditions", async (req, res) => {
  const offerIdParsed = IdSchema.safeParse(req.params.id);
  if (!offerIdParsed.success) return res.status(400).json({ error: "Invalid offer id" });

  const parsed = ConditionBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid body", details: parsed.error.flatten() });
  }

  const admin = await requireAdmin(req, res);
  if (!admin) return;

  const { data, error } = await supabase
    .from(CONDITIONS_TABLE)
    .insert(
      buildNullAwarePayload({
        offer_id: offerIdParsed.data,
        operator: parsed.data.operator ?? "EQ",
        condition_value: parsed.data.condition_value ?? {},
        is_required: parsed.data.is_required ?? true,
        sort_order: parsed.data.sort_order ?? 0,
        condition_type: parsed.data.condition_type,
      })
    )
    .select("*")
    .single();

  if (error) return res.status(500).json({ error: error.message });
  return res.status(201).json({ item: data });
});

router.put("/:id/conditions/:conditionId", async (req, res) => {
  const offerIdParsed = IdSchema.safeParse(req.params.id);
  const conditionIdParsed = IdSchema.safeParse(req.params.conditionId);
  if (!offerIdParsed.success || !conditionIdParsed.success) {
    return res.status(400).json({ error: "Invalid id" });
  }

  const parsed = UpdateConditionBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid body", details: parsed.error.flatten() });
  }

  const admin = await requireAdmin(req, res);
  if (!admin) return;

  const payload = buildNullAwarePayload(parsed.data);
  if (Object.keys(payload).length === 0) return res.status(400).json({ error: "No fields to update" });

  const { data, error } = await supabase
    .from(CONDITIONS_TABLE)
    .update(payload)
    .eq("offer_id", offerIdParsed.data)
    .eq("id", conditionIdParsed.data)
    .select("*")
    .single();

  if (error) return res.status(500).json({ error: error.message });
  return res.json({ item: data });
});

router.delete("/:id/conditions/:conditionId", async (req, res) => {
  const offerIdParsed = IdSchema.safeParse(req.params.id);
  const conditionIdParsed = IdSchema.safeParse(req.params.conditionId);
  if (!offerIdParsed.success || !conditionIdParsed.success) {
    return res.status(400).json({ error: "Invalid id" });
  }

  const admin = await requireAdmin(req, res);
  if (!admin) return;

  const { error } = await supabase
    .from(CONDITIONS_TABLE)
    .delete()
    .eq("offer_id", offerIdParsed.data)
    .eq("id", conditionIdParsed.data);

  if (error) return res.status(500).json({ error: error.message });
  return res.json({ ok: true, id: conditionIdParsed.data });
});

router.get("/:id/payment-rules", async (req, res) => {
  const parsed = IdSchema.safeParse(req.params.id);
  if (!parsed.success) return res.status(400).json({ error: "Invalid offer id" });

  const { data, error } = await supabase
    .from(PAYMENT_RULES_TABLE)
    .select("*")
    .eq("offer_id", parsed.data);

  if (error) return res.status(500).json({ error: error.message });
  return res.json({ items: data ?? [] });
});

router.post("/:id/payment-rules", async (req, res) => {
  const offerIdParsed = IdSchema.safeParse(req.params.id);
  if (!offerIdParsed.success) return res.status(400).json({ error: "Invalid offer id" });

  const parsed = PaymentRuleBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid body", details: parsed.error.flatten() });
  }

  const admin = await requireAdmin(req, res);
  if (!admin) return;

  const { data, error } = await supabase
    .from(PAYMENT_RULES_TABLE)
    .insert(buildNullAwarePayload({ offer_id: offerIdParsed.data, ...parsed.data, metadata: parsed.data.metadata ?? {} }))
    .select("*")
    .single();

  if (error) return res.status(500).json({ error: error.message });
  return res.status(201).json({ item: data });
});

router.put("/:id/payment-rules/:ruleId", async (req, res) => {
  const offerIdParsed = IdSchema.safeParse(req.params.id);
  const ruleIdParsed = IdSchema.safeParse(req.params.ruleId);
  if (!offerIdParsed.success || !ruleIdParsed.success) {
    return res.status(400).json({ error: "Invalid id" });
  }

  const parsed = UpdatePaymentRuleBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid body", details: parsed.error.flatten() });
  }

  const admin = await requireAdmin(req, res);
  if (!admin) return;

  const payload = buildNullAwarePayload(parsed.data);
  if (Object.keys(payload).length === 0) return res.status(400).json({ error: "No fields to update" });

  const { data, error } = await supabase
    .from(PAYMENT_RULES_TABLE)
    .update(payload)
    .eq("offer_id", offerIdParsed.data)
    .eq("id", ruleIdParsed.data)
    .select("*")
    .single();

  if (error) return res.status(500).json({ error: error.message });
  return res.json({ item: data });
});

router.delete("/:id/payment-rules/:ruleId", async (req, res) => {
  const offerIdParsed = IdSchema.safeParse(req.params.id);
  const ruleIdParsed = IdSchema.safeParse(req.params.ruleId);
  if (!offerIdParsed.success || !ruleIdParsed.success) {
    return res.status(400).json({ error: "Invalid id" });
  }

  const admin = await requireAdmin(req, res);
  if (!admin) return;

  const { error } = await supabase
    .from(PAYMENT_RULES_TABLE)
    .delete()
    .eq("offer_id", offerIdParsed.data)
    .eq("id", ruleIdParsed.data);

  if (error) return res.status(500).json({ error: error.message });
  return res.json({ ok: true, id: ruleIdParsed.data });
});

router.get("/:id/bins", async (req, res) => {
  const parsed = IdSchema.safeParse(req.params.id);
  if (!parsed.success) return res.status(400).json({ error: "Invalid offer id" });

  const { data, error } = await supabase
    .from(BINS_TABLE)
    .select("*")
    .eq("offer_id", parsed.data);

  if (error) return res.status(500).json({ error: error.message });
  return res.json({ items: data ?? [] });
});

router.post("/:id/bins", async (req, res) => {
  const offerIdParsed = IdSchema.safeParse(req.params.id);
  if (!offerIdParsed.success) return res.status(400).json({ error: "Invalid offer id" });

  const parsed = BinBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid body", details: parsed.error.flatten() });
  }

  const admin = await requireAdmin(req, res);
  if (!admin) return;

  const { data, error } = await supabase
    .from(BINS_TABLE)
    .insert(buildNullAwarePayload({ offer_id: offerIdParsed.data, ...parsed.data, metadata: parsed.data.metadata ?? {} }))
    .select("*")
    .single();

  if (error) return res.status(500).json({ error: error.message });
  return res.status(201).json({ item: data });
});

router.delete("/:id/bins/:binId", async (req, res) => {
  const offerIdParsed = IdSchema.safeParse(req.params.id);
  const binIdParsed = IdSchema.safeParse(req.params.binId);
  if (!offerIdParsed.success || !binIdParsed.success) {
    return res.status(400).json({ error: "Invalid id" });
  }

  const admin = await requireAdmin(req, res);
  if (!admin) return;

  const { error } = await supabase
    .from(BINS_TABLE)
    .delete()
    .eq("offer_id", offerIdParsed.data)
    .eq("id", binIdParsed.data);

  if (error) return res.status(500).json({ error: error.message });
  return res.json({ ok: true, id: binIdParsed.data });
});

router.get("/:id/usage-limit", async (req, res) => {
  const parsed = IdSchema.safeParse(req.params.id);
  if (!parsed.success) return res.status(400).json({ error: "Invalid offer id" });

  const { data, error } = await supabase
    .from(USAGE_LIMITS_TABLE)
    .select("*")
    .eq("offer_id", parsed.data)
    .maybeSingle();

  if (error) return res.status(500).json({ error: error.message });
  return res.json({ item: data ?? null });
});

router.put("/:id/usage-limit", async (req, res) => {
  const offerIdParsed = IdSchema.safeParse(req.params.id);
  if (!offerIdParsed.success) return res.status(400).json({ error: "Invalid offer id" });

  const parsed = UsageLimitBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid body", details: parsed.error.flatten() });
  }

  const admin = await requireAdmin(req, res);
  if (!admin) return;

  const { data, error } = await supabase
    .from(USAGE_LIMITS_TABLE)
    .upsert(buildNullAwarePayload({ offer_id: offerIdParsed.data, ...parsed.data }), { onConflict: "offer_id" })
    .select("*")
    .single();

  if (error) return res.status(500).json({ error: error.message });
  return res.json({ item: data });
});

router.get("/:id/redemptions", async (req, res) => {
  const parsed = IdSchema.safeParse(req.params.id);
  if (!parsed.success) return res.status(400).json({ error: "Invalid offer id" });

  const admin = await requireAdmin(req, res);
  if (!admin) return;

  const { data, error } = await supabase
    .from(REDEMPTIONS_TABLE)
    .select("*")
    .eq("offer_id", parsed.data)
    .order("redeemed_at", { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  return res.json({ items: data ?? [] });
});

router.post("/:id/redemptions", async (req, res) => {
  const offerIdParsed = IdSchema.safeParse(req.params.id);
  if (!offerIdParsed.success) return res.status(400).json({ error: "Invalid offer id" });

  const parsed = RedemptionBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid body", details: parsed.error.flatten() });
  }

  const admin = await requireAdmin(req, res);
  if (!admin) return;

  const { data, error } = await supabase
    .from(REDEMPTIONS_TABLE)
    .insert(
      buildNullAwarePayload({
        offer_id: offerIdParsed.data,
        ...parsed.data,
        currency_code: parsed.data.currency_code ?? "MUR",
        redemption_status: parsed.data.redemption_status ?? "APPLIED",
        redeemed_at: parsed.data.redeemed_at ?? new Date().toISOString(),
        metadata: parsed.data.metadata ?? {},
      })
    )
    .select("*")
    .single();

  if (error) return res.status(500).json({ error: error.message });
  return res.status(201).json({ item: data });
});

export default router;
