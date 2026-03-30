import { Router } from "express";
import { z } from "zod";
import { createClient } from "@supabase/supabase-js";
import supabase from "../../database/supabase";
import {
  buildStoreSlotConfig,
  getProductCataloguePayload,
  getServiceCataloguePayload,
} from "./storeCatalogue";

const router = Router();

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY!;

function supabaseAuthed(req: any) {
  const h = req.headers.authorization || "";
  const [type, token] = h.split(" ");
  if (type !== "Bearer" || !token) return null;

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

  const { data: { user }, error: userErr } = await sb.auth.getUser();
  if (userErr || !user) {
    res.status(401).json({ error: "Invalid session" });
    return null;
  }

  // Check the 'users' table for the role using the authed client
  const { data: row, error: roleErr } = await sb
    .from("users")
    .select("role")
    .eq("id", user.id)
    .maybeSingle();

  const role = row?.role?.toLowerCase();
  
  if (roleErr || !role || !["admin", "superadmin"].includes(role)) {
    res.status(403).json({ error: "Access denied" });
    return null;
  }

  return { sb, callerId: user.id };
}

const IdSchema = z.string().uuid();

const ListQuerySchema = z.object({
  // search across name/slug/category/subcategory/city/region/tags
  search: z.string().trim().min(1).optional(),

  // filters
  city: z.string().trim().min(1).optional(),
  region: z.string().trim().min(1).optional(),
  country: z.string().trim().min(1).optional(),
  category: z.string().trim().min(1).optional(),
  subcategory: z.string().trim().min(1).optional(),
  tag: z.string().trim().min(1).optional(), // single tag filter
  is_featured: z
    .string()
    .optional()
    .transform((v) => (v === undefined ? undefined : v === "true")),

  // status maps to is_active
  status: z.enum(["active", "inactive"]).optional(),
  includeInactive: z
    .string()
    .optional()
    .transform((v) => v === "true"),

  // pagination
  limit: z
    .string()
    .optional()
    .transform((v) => (v ? Number(v) : 20))
    .refine((n) => Number.isFinite(n) && n > 0 && n <= 100, "limit 1-100"),
  offset: z
    .string()
    .optional()
    .transform((v) => (v ? Number(v) : 0))
    .refine((n) => Number.isFinite(n) && n >= 0, "offset must be >= 0"),

  // sorting (safe allowlist)
  sort: z
    .enum(["created_at", "updated_at", "name", "sort_order"])
    .optional()
    .default("created_at"),
  order: z.enum(["asc", "desc"]).optional().default("desc"),
});

const DeleteQuerySchema = z.object({
  hard: z
    .string()
    .optional()
    .transform((v) => v === "true"),
});

function isStoreAdvertisementActive(store: any, now = new Date()) {
  if (!store?.is_advertised) return false;

  const startsAt = store.ad_starts_at ? new Date(store.ad_starts_at) : null;
  const endsAt = store.ad_ends_at ? new Date(store.ad_ends_at) : null;

  if (startsAt && startsAt > now) return false;
  if (endsAt && endsAt < now) return false;

  return true;
}

function isStorePremiumActive(store: any, now = new Date()) {
  if (!store?.pickup_premium_enabled) return false;

  const startedAt = store.pickup_premium_started_at
    ? new Date(store.pickup_premium_started_at)
    : null;
  const expiresAt = store.pickup_premium_expires_at
    ? new Date(store.pickup_premium_expires_at)
    : null;

  if (startedAt && startedAt > now) return false;
  if (expiresAt && expiresAt < now) return false;

  return true;
}

function comparePrimitiveValues(aValue: any, bValue: any, ascending: boolean) {
  if (aValue === bValue) return 0;

  if (aValue === null || aValue === undefined) return 1;
  if (bValue === null || bValue === undefined) return -1;

  if (typeof aValue === "number" && typeof bValue === "number") {
    return ascending ? aValue - bValue : bValue - aValue;
  }

  const aText = String(aValue).toLowerCase();
  const bText = String(bValue).toLowerCase();

  if (aText < bText) return ascending ? -1 : 1;
  if (aText > bText) return ascending ? 1 : -1;
  return 0;
}

function compareStoresForFeed(a: any, b: any, sort: string, order: "asc" | "desc") {
  const aAdvertised = isStoreAdvertisementActive(a);
  const bAdvertised = isStoreAdvertisementActive(b);

  if (aAdvertised !== bAdvertised) {
    return aAdvertised ? -1 : 1;
  }

  if (aAdvertised && bAdvertised) {
    const aPriority = typeof a.ad_priority === "number" ? a.ad_priority : 100;
    const bPriority = typeof b.ad_priority === "number" ? b.ad_priority : 100;

    if (aPriority !== bPriority) {
      return aPriority - bPriority;
    }
  }

  const aPremium = isStorePremiumActive(a);
  const bPremium = isStorePremiumActive(b);

  if (aPremium !== bPremium) {
    return aPremium ? -1 : 1;
  }

  const primarySort = comparePrimitiveValues(a?.[sort], b?.[sort], order === "asc");
  if (primarySort !== 0) return primarySort;

  return comparePrimitiveValues(a?.created_at, b?.created_at, false);
}

// GET /api/stores
// /api/stores?search=&city=&category=&tag=&status=&includeInactive=&limit=&offset=&sort=&order=&is_featured=
router.get("/", async (req, res) => {
  const parsed = ListQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res
      .status(400)
      .json({ error: "Invalid query", details: parsed.error.flatten() });
  }

  const {
    search,
    city,
    region,
    country,
    category,
    subcategory,
    tag,
    is_featured,
    status,
    includeInactive,
    limit,
    offset,
    sort,
    order,
  } = parsed.data;

  let query = supabase.from("stores").select("*", { count: "exact" });

  // default: only active stores
  if (!includeInactive && !status) {
    query = query.eq("is_active", true);
  }
  if (status) {
    query = query.eq("is_active", status === "active");
  }

  // filters
  if (city) query = query.ilike("city", `%${city}%`);
  if (region) query = query.ilike("region", `%${region}%`);
  if (country) query = query.ilike("country", `%${country}%`);

  if (category) query = query.eq("category", category);
  if (subcategory) query = query.eq("subcategory", subcategory);

  if (typeof is_featured === "boolean") {
    query = query.eq("is_featured", is_featured);
  }

  // tag filter (array contains)
  if (tag) {
    // tags is text[]
    query = query.contains("tags", [tag]);
  }

  // search (OR)
  if (search) {
    const s = search.replace(/"/g, '\\"');

    // NOTE: PostgREST "or" string. Also includes tags with ilike via cast might not be allowed directly.
    // We'll cover common text fields. Tags search can be done via tag=... filter above.
    query = query.or(
      [
        `name.ilike.%${s}%`,
        `slug.ilike.%${s}%`,
        `category.ilike.%${s}%`,
        `subcategory.ilike.%${s}%`,
        `city.ilike.%${s}%`,
        `region.ilike.%${s}%`,
        `location_name.ilike.%${s}%`,
      ].join(",")
    );
  }

  const { data, error, count } = await query;

  if (error) return res.status(500).json({ error: error.message });

  const orderedItems = (data ?? []).sort((a: any, b: any) =>
    compareStoresForFeed(a, b, sort, order)
  );

  const from = offset;
  const to = offset + limit;

  return res.json({
    items: orderedItems.slice(from, to),
    page: { limit, offset, total: count ?? 0 },
  });
});

// GET /api/stores/:id
// Optional: ?include=payment,catalogue,services,slots to fetch related tables in one response
router.get("/:id", async (req, res) => {
  const idParsed = IdSchema.safeParse(req.params.id);
  if (!idParsed.success) return res.status(400).json({ error: "Invalid store id" });

  const include = String(req.query.include ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const includePayment = include.includes("payment");
  const includeCatalogue = include.includes("catalogue");
  const includeServices = include.includes("services");
  const includeSlots = include.includes("slots");

  // main store
  const { data: store, error } = await supabase
    .from("stores")
    .select("*")
    .eq("id", idParsed.data)
    .maybeSingle();

  if (error) return res.status(500).json({ error: error.message });
  if (!store) return res.status(404).json({ error: "Store not found" });

  // related (optional)
  let payment: any = null;
  let catalogue: any = null;
  let services: any = null;
  let slots: any = null;

  if (includePayment) {
    const resp = await supabase
      .from("store_payment_details")
      .select("*")
      .eq("store_id", store.id)
      .maybeSingle();

    if (resp.error) return res.status(500).json({ error: resp.error.message });
    payment = resp.data ?? null;
  }

  if (includeCatalogue) {
    try {
      catalogue = await getProductCataloguePayload(store.id);
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  }

  if (includeServices) {
    try {
      services = await getServiceCataloguePayload(store.id);
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  }

  if (includeSlots) {
    slots = buildStoreSlotConfig(store);
  }

  return res.json({
    item: store,
    ...(includePayment ? { payment } : {}),
    ...(includeCatalogue ? { catalogue } : {}),
    ...(includeServices ? { services } : {}),
    ...(includeSlots ? { slots } : {}),
  });
});

// DELETE /api/stores/:id?hard=true
router.delete("/:id", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  const idParsed = IdSchema.safeParse(req.params.id);
  if (!idParsed.success) return res.status(400).json({ error: "Invalid store id" });

  const qParsed = DeleteQuerySchema.safeParse(req.query);
  if (!qParsed.success) {
    return res
      .status(400)
      .json({ error: "Invalid query", details: qParsed.error.flatten() });
  }

  const id = idParsed.data;
  const { hard } = qParsed.data;

  // Confirm exists
  const exists = await admin.sb
    .from("stores")
    .select("id,is_active")
    .eq("id", id)
    .maybeSingle();

  if (exists.error) return res.status(500).json({ error: exists.error.message });
  if (!exists.data) return res.status(404).json({ error: "Store not found" });

  if (hard) {
    const { error } = await admin.sb.from("stores").delete().eq("id", id);
    if (error) return res.status(500).json({ error: error.message });
    return res.json({ ok: true, deleted: "hard", id });
  }

  // Soft delete
  const { error } = await admin.sb
    .from("stores")
    .update({ is_active: false })
    .eq("id", id);

  if (error) return res.status(500).json({ error: error.message });

  return res.json({ ok: true, deleted: "soft", id });
});

export default router;
