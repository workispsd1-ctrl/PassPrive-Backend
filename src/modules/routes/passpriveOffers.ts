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

const OFFER_TABLE = "passprive_offers";
const STORE_TARGETS_TABLE = "passprive_offer_store_targets";
const PLAN_TARGETS_TABLE = "passprive_offer_plan_targets";
const CONDITIONS_TABLE = "passprive_offer_conditions";
const USAGE_LIMITS_TABLE = "passprive_offer_usage_limits";
const REDEMPTIONS_TABLE = "passprive_offer_redemptions";
const STORE_SUBSCRIPTIONS_TABLE = "passprive_offer_store_subscriptions";

const IdSchema = z.string().uuid();

const ListOffersQuerySchema = z.object({
  is_active: z
    .string()
    .optional()
    .transform((v) => (v === undefined ? undefined : v === "true")),
  applies_to_scope: z
    .enum(["ALL_STORES", "AD_SUBSCRIBED_STORES", "PLAN_SUBSCRIBED_STORES", "SELECTED_STORES"])
    .optional(),
  includeInactive: z
    .string()
    .optional()
    .transform((v) => v === "true"),
});

const OfferBodySchema = z.object({
  title: z.string().trim().min(1),
  subtitle: z.string().trim().nullable().optional(),
  description: z.string().trim().nullable().optional(),
  offer_type: z.enum(["PERCENTAGE", "FLAT"]),
  discount_value: z.coerce.number().positive(),
  currency: z.string().trim().min(1).optional(),
  max_discount_amount: z.coerce.number().nullable().optional(),
  applies_to_scope: z
    .enum(["ALL_STORES", "AD_SUBSCRIBED_STORES", "PLAN_SUBSCRIBED_STORES", "SELECTED_STORES"])
    .optional(),
  eligibility_type: z
    .enum(["NONE", "NEW_USERS_ONLY", "EXISTING_USERS_ONLY", "MEMBERS_ONLY"])
    .optional(),
  is_active: z.boolean().optional(),
  is_stackable: z.boolean().optional(),
  auto_apply: z.boolean().optional(),
  priority: z.coerce.number().int().optional(),
  starts_at: z.string().datetime().nullable().optional(),
  ends_at: z.string().datetime().nullable().optional(),
  banner_text: z.string().trim().nullable().optional(),
  badge_text: z.string().trim().nullable().optional(),
  terms_and_conditions: z.any().optional(),
  metadata: z.any().optional(),
});

const UpdateOfferBodySchema = OfferBodySchema.partial();

const StoreTargetBodySchema = z.object({
  store_id: z.string().uuid(),
});

const PlanTargetBodySchema = z.object({
  plan_code: z.string().trim().min(1),
});

const ConditionBodySchema = z.object({
  condition_type: z.enum([
    "MIN_BILL_AMOUNT",
    "MAX_BILL_AMOUNT",
    "MAX_DISCOUNT_AMOUNT",
    "FIRST_ORDER_ONLY",
    "NEW_USER_ONLY",
    "PAYMENT_METHOD",
    "DAY_OF_WEEK",
    "TIME_WINDOW",
    "CITY",
    "CATEGORY",
    "SUBCATEGORY",
    "TAG",
    "STORE_PLAN",
    "STORE_AD_STATUS",
    "USER_SEGMENT",
  ]),
  operator: z.enum(["EQ", "NEQ", "GT", "GTE", "LT", "LTE", "IN", "NOT_IN"]).optional(),
  condition_value: z.any().optional(),
  is_required: z.boolean().optional(),
  sort_order: z.coerce.number().int().optional(),
});

const UpdateConditionBodySchema = ConditionBodySchema.partial();

const UsageLimitBodySchema = z.object({
  total_redemption_limit: z.coerce.number().int().nullable().optional(),
  per_user_redemption_limit: z.coerce.number().int().nullable().optional(),
  per_store_redemption_limit: z.coerce.number().int().nullable().optional(),
  per_day_redemption_limit: z.coerce.number().int().nullable().optional(),
});

const RedemptionBodySchema = z.object({
  store_id: z.string().uuid(),
  user_id: z.string().uuid().nullable().optional(),
  order_reference: z.string().trim().nullable().optional(),
  bill_amount: z.coerce.number().min(0),
  discount_amount: z.coerce.number().min(0),
  currency: z.string().trim().min(1).optional(),
  redemption_status: z.enum(["APPLIED", "REDEEMED", "CANCELLED", "REVERSED"]).optional(),
  redeemed_at: z.string().datetime().nullable().optional(),
  expires_at: z.string().datetime().nullable().optional(),
  metadata: z.any().optional(),
});

const UpdateRedemptionBodySchema = z.object({
  order_reference: z.string().trim().nullable().optional(),
  bill_amount: z.coerce.number().min(0).optional(),
  discount_amount: z.coerce.number().min(0).optional(),
  currency: z.string().trim().min(1).optional(),
  redemption_status: z.enum(["APPLIED", "REDEEMED", "CANCELLED", "REVERSED"]).optional(),
  redeemed_at: z.string().datetime().nullable().optional(),
  expires_at: z.string().datetime().nullable().optional(),
  metadata: z.any().optional(),
});

const StoreSubscriptionBodySchema = z.object({
  store_id: z.string().uuid(),
  subscription_type: z.enum(["AD", "PLAN"]),
  plan_code: z.string().trim().nullable().optional(),
  is_active: z.boolean().optional(),
  starts_at: z.string().datetime().nullable().optional(),
  ends_at: z.string().datetime().nullable().optional(),
  metadata: z.any().optional(),
});

const UpdateStoreSubscriptionBodySchema = StoreSubscriptionBodySchema.partial();

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
    res.status(401).json({ error: "Missing token" });
    return null;
  }

  const { data: userData, error: userErr } = await sb.auth.getUser();
  if (userErr || !userData?.user) {
    res.status(401).json({ error: "Invalid session" });
    return null;
  }

  const { data: roleRow, error: roleErr } = await sb
    .from("users")
    .select("role")
    .eq("id", userData.user.id)
    .maybeSingle();

  const role = roleRow?.role?.toLowerCase();
  if (roleErr || !role || !["admin", "superadmin"].includes(role)) {
    res.status(403).json({ error: "Access denied" });
    return null;
  }

  return { sb, callerId: userData.user.id };
}

function buildNullAwarePayload(payload: Record<string, any>) {
  return Object.fromEntries(
    Object.entries(payload)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [key, value ?? null])
  );
}

async function ensureOfferExists(offerId: string) {
  const { data, error } = await supabase
    .from(OFFER_TABLE)
    .select("id")
    .eq("id", offerId)
    .maybeSingle();

  if (error) throw error;
  return !!data;
}

async function getOfferWithRelations(offerId: string) {
  const { data: offer, error: offerError } = await supabase
    .from(OFFER_TABLE)
    .select("*")
    .eq("id", offerId)
    .maybeSingle();

  if (offerError) throw offerError;
  if (!offer) return null;

  const [
    { data: store_targets, error: storeTargetsError },
    { data: plan_targets, error: planTargetsError },
    { data: conditions, error: conditionsError },
    { data: usage_limit, error: usageLimitError },
  ] = await Promise.all([
    supabase
      .from(STORE_TARGETS_TABLE)
      .select("*")
      .eq("offer_id", offerId)
      .order("created_at", { ascending: true }),
    supabase
      .from(PLAN_TARGETS_TABLE)
      .select("*")
      .eq("offer_id", offerId)
      .order("created_at", { ascending: true }),
    supabase
      .from(CONDITIONS_TABLE)
      .select("*")
      .eq("offer_id", offerId)
      .order("sort_order", { ascending: true })
      .order("created_at", { ascending: true }),
    supabase
      .from(USAGE_LIMITS_TABLE)
      .select("*")
      .eq("offer_id", offerId)
      .maybeSingle(),
  ]);

  if (storeTargetsError) throw storeTargetsError;
  if (planTargetsError) throw planTargetsError;
  if (conditionsError) throw conditionsError;
  if (usageLimitError) throw usageLimitError;

  return {
    ...offer,
    store_targets: store_targets ?? [],
    plan_targets: plan_targets ?? [],
    conditions: conditions ?? [],
    usage_limit: usage_limit ?? null,
  };
}

router.get("/", async (req, res) => {
  const parsed = ListOffersQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid query", details: parsed.error.flatten() });
  }

  const { is_active, applies_to_scope, includeInactive } = parsed.data;

  let query = supabase.from(OFFER_TABLE).select("*");

  if (!includeInactive) {
    query = query.eq("is_active", true);
  } else {
    const admin = await requireAdmin(req, res);
    if (!admin) return;
  }

  if (typeof is_active === "boolean") {
    query = query.eq("is_active", is_active);
  }

  if (applies_to_scope) {
    query = query.eq("applies_to_scope", applies_to_scope);
  }

  const { data, error } = await query
    .order("priority", { ascending: true })
    .order("created_at", { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  return res.json({ items: data ?? [] });
});

router.get("/active", async (_req, res) => {
  const nowIso = new Date().toISOString();

  const { data, error } = await supabase
    .from(OFFER_TABLE)
    .select("*")
    .eq("is_active", true)
    .or(`starts_at.is.null,starts_at.lte.${nowIso}`)
    .or(`ends_at.is.null,ends_at.gte.${nowIso}`)
    .order("priority", { ascending: true })
    .order("created_at", { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  return res.json({ items: data ?? [] });
});

router.get("/store-subscriptions", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  const { data, error } = await supabase
    .from(STORE_SUBSCRIPTIONS_TABLE)
    .select("*, store:stores(id,name,city,category)")
    .order("created_at", { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  return res.json({ items: data ?? [] });
});

router.post("/store-subscriptions", async (req, res) => {
  const parsed = StoreSubscriptionBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid body", details: parsed.error.flatten() });
  }

  const admin = await requireAdmin(req, res);
  if (!admin) return;

  const payload = buildNullAwarePayload({
    ...parsed.data,
    is_active: parsed.data.is_active ?? true,
    metadata: parsed.data.metadata ?? {},
  });

  const { data, error } = await supabase
    .from(STORE_SUBSCRIPTIONS_TABLE)
    .insert(payload)
    .select("*")
    .single();

  if (error) return res.status(500).json({ error: error.message });
  return res.status(201).json({ item: data });
});

router.put("/store-subscriptions/:id", async (req, res) => {
  const idParsed = IdSchema.safeParse(req.params.id);
  if (!idParsed.success) return res.status(400).json({ error: "Invalid subscription id" });

  const parsed = UpdateStoreSubscriptionBodySchema.safeParse(req.body);
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
    .from(STORE_SUBSCRIPTIONS_TABLE)
    .update(payload)
    .eq("id", idParsed.data)
    .select("*")
    .single();

  if (error) return res.status(500).json({ error: error.message });
  return res.json({ item: data });
});

router.delete("/store-subscriptions/:id", async (req, res) => {
  const idParsed = IdSchema.safeParse(req.params.id);
  if (!idParsed.success) return res.status(400).json({ error: "Invalid subscription id" });

  const admin = await requireAdmin(req, res);
  if (!admin) return;

  const { error } = await supabase
    .from(STORE_SUBSCRIPTIONS_TABLE)
    .delete()
    .eq("id", idParsed.data);

  if (error) return res.status(500).json({ error: error.message });
  return res.json({ ok: true, id: idParsed.data });
});

router.get("/:id", async (req, res) => {
  const parsed = IdSchema.safeParse(req.params.id);
  if (!parsed.success) return res.status(400).json({ error: "Invalid offer id" });

  try {
    const offer = await getOfferWithRelations(parsed.data);
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

  const body = parsed.data;
  const payload = buildNullAwarePayload({
    ...body,
    currency: body.currency ?? "MUR",
    applies_to_scope: body.applies_to_scope ?? "ALL_STORES",
    eligibility_type: body.eligibility_type ?? "NONE",
    is_active: body.is_active ?? true,
    is_stackable: body.is_stackable ?? false,
    auto_apply: body.auto_apply ?? true,
    priority: body.priority ?? 100,
    terms_and_conditions: body.terms_and_conditions ?? [],
    metadata: body.metadata ?? {},
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

router.get("/:id/store-targets", async (req, res) => {
  const parsed = IdSchema.safeParse(req.params.id);
  if (!parsed.success) return res.status(400).json({ error: "Invalid offer id" });

  const { data, error } = await supabase
    .from(STORE_TARGETS_TABLE)
    .select("*, store:stores(*)")
    .eq("offer_id", parsed.data)
    .order("created_at", { ascending: true });

  if (error) return res.status(500).json({ error: error.message });
  return res.json({ items: data ?? [] });
});

router.post("/:id/store-targets", async (req, res) => {
  const offerIdParsed = IdSchema.safeParse(req.params.id);
  if (!offerIdParsed.success) return res.status(400).json({ error: "Invalid offer id" });

  const parsed = StoreTargetBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid body", details: parsed.error.flatten() });
  }

  const admin = await requireAdmin(req, res);
  if (!admin) return;

  try {
    const offerExists = await ensureOfferExists(offerIdParsed.data);
    if (!offerExists) return res.status(404).json({ error: "Offer not found" });

    const { data: store, error: storeError } = await supabase
      .from("stores")
      .select("id")
      .eq("id", parsed.data.store_id)
      .maybeSingle();

    if (storeError) return res.status(500).json({ error: storeError.message });
    if (!store) return res.status(404).json({ error: "Store not found" });

    const { data, error } = await supabase
      .from(STORE_TARGETS_TABLE)
      .insert({
        offer_id: offerIdParsed.data,
        store_id: parsed.data.store_id,
      })
      .select("*")
      .single();

    if (error) return res.status(500).json({ error: error.message });
    return res.status(201).json({ item: data });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

router.delete("/:id/store-targets/:targetId", async (req, res) => {
  const offerIdParsed = IdSchema.safeParse(req.params.id);
  const targetIdParsed = IdSchema.safeParse(req.params.targetId);
  if (!offerIdParsed.success || !targetIdParsed.success) {
    return res.status(400).json({ error: "Invalid id" });
  }

  const admin = await requireAdmin(req, res);
  if (!admin) return;

  const { error } = await supabase
    .from(STORE_TARGETS_TABLE)
    .delete()
    .eq("offer_id", offerIdParsed.data)
    .eq("id", targetIdParsed.data);

  if (error) return res.status(500).json({ error: error.message });
  return res.json({ ok: true, id: targetIdParsed.data });
});

router.get("/:id/plan-targets", async (req, res) => {
  const parsed = IdSchema.safeParse(req.params.id);
  if (!parsed.success) return res.status(400).json({ error: "Invalid offer id" });

  const { data, error } = await supabase
    .from(PLAN_TARGETS_TABLE)
    .select("*")
    .eq("offer_id", parsed.data)
    .order("created_at", { ascending: true });

  if (error) return res.status(500).json({ error: error.message });
  return res.json({ items: data ?? [] });
});

router.post("/:id/plan-targets", async (req, res) => {
  const offerIdParsed = IdSchema.safeParse(req.params.id);
  if (!offerIdParsed.success) return res.status(400).json({ error: "Invalid offer id" });

  const parsed = PlanTargetBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid body", details: parsed.error.flatten() });
  }

  const admin = await requireAdmin(req, res);
  if (!admin) return;

  const { data, error } = await supabase
    .from(PLAN_TARGETS_TABLE)
    .insert({
      offer_id: offerIdParsed.data,
      plan_code: parsed.data.plan_code,
    })
    .select("*")
    .single();

  if (error) return res.status(500).json({ error: error.message });
  return res.status(201).json({ item: data });
});

router.delete("/:id/plan-targets/:targetId", async (req, res) => {
  const offerIdParsed = IdSchema.safeParse(req.params.id);
  const targetIdParsed = IdSchema.safeParse(req.params.targetId);
  if (!offerIdParsed.success || !targetIdParsed.success) {
    return res.status(400).json({ error: "Invalid id" });
  }

  const admin = await requireAdmin(req, res);
  if (!admin) return;

  const { error } = await supabase
    .from(PLAN_TARGETS_TABLE)
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
    .insert({
      offer_id: offerIdParsed.data,
      condition_type: parsed.data.condition_type,
      operator: parsed.data.operator ?? "EQ",
      condition_value: parsed.data.condition_value ?? {},
      is_required: parsed.data.is_required ?? true,
      sort_order: parsed.data.sort_order ?? 0,
    })
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
  if (Object.keys(payload).length === 0) {
    return res.status(400).json({ error: "No fields to update" });
  }

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

  const payload = buildNullAwarePayload({
    offer_id: offerIdParsed.data,
    ...parsed.data,
  });

  const { data, error } = await supabase
    .from(USAGE_LIMITS_TABLE)
    .upsert(payload, { onConflict: "offer_id" })
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
    .select("*, store:stores(id,name,city,category)")
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

  const payload = buildNullAwarePayload({
    offer_id: offerIdParsed.data,
    ...parsed.data,
    currency: parsed.data.currency ?? "MUR",
    redemption_status: parsed.data.redemption_status ?? "APPLIED",
    redeemed_at: parsed.data.redeemed_at ?? new Date().toISOString(),
    metadata: parsed.data.metadata ?? {},
  });

  const { data, error } = await supabase
    .from(REDEMPTIONS_TABLE)
    .insert(payload)
    .select("*")
    .single();

  if (error) return res.status(500).json({ error: error.message });
  return res.status(201).json({ item: data });
});

router.put("/redemptions/:redemptionId", async (req, res) => {
  const redemptionIdParsed = IdSchema.safeParse(req.params.redemptionId);
  if (!redemptionIdParsed.success) return res.status(400).json({ error: "Invalid redemption id" });

  const parsed = UpdateRedemptionBodySchema.safeParse(req.body);
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
    .from(REDEMPTIONS_TABLE)
    .update(payload)
    .eq("id", redemptionIdParsed.data)
    .select("*")
    .single();

  if (error) return res.status(500).json({ error: error.message });
  return res.json({ item: data });
});

export default router;
