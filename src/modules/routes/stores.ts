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
const LIST_QUERY_TIMEOUT_MS = Number(process.env.LIST_QUERY_TIMEOUT_MS ?? 5000);

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

const FeedQuerySchema = z.object({
  search: z.string().trim().min(1).optional(),
  city: z.string().trim().min(1).optional(),
  region: z.string().trim().min(1).optional(),
  country: z.string().trim().min(1).optional(),
  category: z.string().trim().min(1).optional(),
  subcategory: z.string().trim().min(1).optional(),
  tag: z.string().trim().min(1).optional(),
  includeInactive: z
    .string()
    .optional()
    .transform((v) => v === "true"),
  lat: z
    .string()
    .optional()
    .transform((v) => (v ? Number(v) : null))
    .refine((n) => n === null || Number.isFinite(n), "lat must be numeric"),
  lng: z
    .string()
    .optional()
    .transform((v) => (v ? Number(v) : null))
    .refine((n) => n === null || Number.isFinite(n), "lng must be numeric"),
  limit: z
    .string()
    .optional()
    .transform((v) => (v ? Number(v) : 24))
    .refine((n) => Number.isFinite(n) && n > 0 && n <= 100, "limit 1-100"),
  offset: z
    .string()
    .optional()
    .transform((v) => (v ? Number(v) : 0))
    .refine((n) => Number.isFinite(n) && n >= 0, "offset must be >= 0"),
});

function summarizeStoreFeedRows(rows: any[]) {
  const summary = {
    total: Array.isArray(rows) ? rows.length : 0,
    advertised: 0,
    premium: 0,
    sameCity: 0,
    hasDistance: 0,
  };

  for (const row of rows || []) {
    if (isStoreAdvertisementActive(row)) summary.advertised += 1;
    if (isStorePremiumActive(row)) summary.premium += 1;
    if (String(row?.city || "").trim()) summary.sameCity += 1;
    if (row?.lat != null && row?.lng != null) summary.hasDistance += 1;
  }

  return summary;
}

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

function isStoreLocationMatch(store: any, feedLocation: any) {
  if (!feedLocation) return 0;

  const storeCity = String(store?.city || "").trim().toLowerCase();
  const storeRegion = String(store?.region || "").trim().toLowerCase();
  const storeCountry = String(store?.country || "").trim().toLowerCase();

  const feedCity = String(feedLocation?.city || "").trim().toLowerCase();
  const feedRegion = String(feedLocation?.region || "").trim().toLowerCase();
  const feedCountry = String(feedLocation?.country || "").trim().toLowerCase();

  if (feedCity && storeCity && storeCity === feedCity) return 3;
  if (feedRegion && storeRegion && storeRegion === feedRegion) return 2;
  if (feedCountry && storeCountry && storeCountry === feedCountry) return 1;
  return 0;
}

function getStoreDistanceKm(store: any, userLat: number | null, userLng: number | null) {
  if (userLat == null || userLng == null) return null;
  if (store?.lat == null || store?.lng == null) return null;

  const lat = Number(store.lat);
  const lng = Number(store.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  const toRad = (value: number) => (value * Math.PI) / 180;
  const earthRadiusKm = 6371;
  const dLat = toRad(lat - userLat);
  const dLng = toRad(lng - userLng);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(userLat)) * Math.cos(toRad(lat)) *
    Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return earthRadiusKm * c;
}

function compareStoresForSmartFeed(a: any, b: any, feedLocation: any, userLat: number | null, userLng: number | null) {
  const aLocation = isStoreLocationMatch(a, feedLocation);
  const bLocation = isStoreLocationMatch(b, feedLocation);
  if (aLocation !== bLocation) {
    return bLocation - aLocation;
  }

  const aAd = isStoreAdvertisementActive(a);
  const bAd = isStoreAdvertisementActive(b);
  if (aAd !== bAd) {
    return aAd ? -1 : 1;
  }

  if (aAd && bAd) {
    const aPriority = typeof a.ad_priority === "number" ? a.ad_priority : 100;
    const bPriority = typeof b.ad_priority === "number" ? b.ad_priority : 100;
    if (aPriority !== bPriority) {
      return aPriority - bPriority;
    }
  }

  const aCreatedAt = a?.created_at ? new Date(a.created_at).getTime() : 0;
  const bCreatedAt = b?.created_at ? new Date(b.created_at).getTime() : 0;
  if (aCreatedAt !== bCreatedAt) {
    return bCreatedAt - aCreatedAt;
  }

  const aFeatured = !!a?.is_featured;
  const bFeatured = !!b?.is_featured;
  if (aFeatured !== bFeatured) {
    return aFeatured ? -1 : 1;
  }

  const aPremium = isStorePremiumActive(a);
  const bPremium = isStorePremiumActive(b);
  if (aPremium !== bPremium) {
    return aPremium ? -1 : 1;
  }

  const aDistance = getStoreDistanceKm(a, userLat, userLng);
  const bDistance = getStoreDistanceKm(b, userLat, userLng);
  if (aDistance != null && bDistance != null && aDistance !== bDistance) {
    return aDistance - bDistance;
  }
  if (aDistance != null && bDistance == null) return -1;
  if (aDistance == null && bDistance != null) return 1;

  const aRating = Number(a?.rating ?? 0);
  const bRating = Number(b?.rating ?? 0);
  if (aRating !== bRating) {
    return bRating - aRating;
  }

  const aRatings = Number(a?.total_ratings ?? 0);
  const bRatings = Number(b?.total_ratings ?? 0);
  if (aRatings !== bRatings) {
    return bRatings - aRatings;
  }

  const aSortOrder = Number.isFinite(Number(a?.sort_order)) ? Number(a.sort_order) : 9999;
  const bSortOrder = Number.isFinite(Number(b?.sort_order)) ? Number(b.sort_order) : 9999;
  if (aSortOrder !== bSortOrder) {
    return aSortOrder - bSortOrder;
  }

  return String(a?.name || "").localeCompare(String(b?.name || ""));
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

async function withTimeout<T>(promise: PromiseLike<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    Promise.resolve(promise)
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
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

  // DB-side ordering + pagination for better tail latency under load.
  query = query
    .order("is_advertised", { ascending: false })
    .order("ad_priority", { ascending: true, nullsFirst: false })
    .order("pickup_premium_enabled", { ascending: false })
    .order(sort, { ascending: order === "asc" });

  if (sort !== "created_at") {
    query = query.order("created_at", { ascending: false });
  }

  const from = offset;
  const to = offset + limit - 1;

  let data: any[] | null = null;
  let count: number | null = null;
  try {
    const result = await withTimeout(
      query.range(from, to),
      LIST_QUERY_TIMEOUT_MS,
      "GET /api/stores query"
    );

    const { data: rows, error, count: total } = result as any;
    if (error) return res.status(500).json({ error: error.message });
    data = rows ?? [];
    count = total ?? 0;
  } catch (error: any) {
    const isTimeout = String(error?.message ?? "").includes("timed out");
    if (isTimeout) {
      console.error("[GET /api/stores] Timed out", {
        timeout_ms: LIST_QUERY_TIMEOUT_MS,
        offset,
        limit,
        sort,
        order,
      });
      return res.status(503).json({ error: "Request timed out. Please retry." });
    }
    return res.status(500).json({ error: error?.message ?? "Unexpected error" });
  }

  return res.json({
    items: data ?? [],
    page: { limit, offset, total: count ?? 0 },
  });
});

// GET /api/stores/feed
// Smart store feed sorted by location, ad, recency and rating.
router.get("/feed", async (req, res) => {
  const parsed = FeedQuerySchema.safeParse(req.query);
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
    includeInactive,
    lat,
    lng,
    limit,
    offset,
  } = parsed.data;

  console.info("[GET /api/stores/feed] query", {
    search: search || null,
    city: city || null,
    region: region || null,
    country: country || null,
    category: category || null,
    subcategory: subcategory || null,
    tag: tag || null,
    includeInactive,
    lat,
    lng,
    limit,
    offset,
  });

  let query = supabase.from("stores").select("*", { count: "exact" });

  if (!includeInactive) {
    query = query.eq("is_active", true);
  }
  if (city) query = query.ilike("city", `%${city}%`);
  if (region) query = query.ilike("region", `%${region}%`);
  if (country) query = query.ilike("country", `%${country}%`);
  if (category) query = query.eq("category", category);
  if (subcategory) query = query.eq("subcategory", subcategory);
  if (tag) query = query.contains("tags", [tag]);

  if (search) {
    const s = search.replace(/"/g, '\\"');
    query = query.or(
      [
        `name.ilike.%${s}%`,
        `slug.ilike.%${s}%`,
        `category.ilike.%${s}%`,
        `subcategory.ilike.%${s}%`,
        `city.ilike.%${s}%`,
        `region.ilike.%${s}%`,
        `location_name.ilike.%${s}%`,
        `full_address.ilike.%${s}%`,
      ].join(",")
    );
  }

  const scanLimit = Math.min(Math.max(limit + offset + Math.max(limit, 1) * 4, 120), 500);

  try {
    const result = await withTimeout(
      query.range(0, scanLimit - 1),
      LIST_QUERY_TIMEOUT_MS,
      "GET /api/stores/feed query"
    );

    const { data: rows, error, count: total } = result as any;
    if (error) return res.status(500).json({ error: error.message });

    const rawRows = rows ?? [];
    console.info("[GET /api/stores/feed] raw result", {
      count: rawRows.length,
      total: total ?? null,
      scanLimit,
      sample: summarizeStoreFeedRows(rawRows),
    });

    const ranked = rawRows
      .slice()
      .sort((a: any, b: any) => compareStoresForSmartFeed(a, b, { city, region, country }, lat, lng));
    console.info("[GET /api/stores/feed] ranked result", {
      count: ranked.length,
      topIds: ranked.slice(0, 8).map((row: any) => row?.id || row?.store_id || null),
      topCities: ranked.slice(0, 8).map((row: any) => row?.city || null),
    });

    const pageItems = ranked.slice(offset, offset + limit);

    console.info("[GET /api/stores/feed] page result", {
      count: pageItems.length,
      limit,
      offset,
      returnedIds: pageItems.map((row: any) => row?.id || row?.store_id || null),
    });

    return res.json({
      items: pageItems,
      page: { limit, offset, total: total ?? ranked.length },
    });
  } catch (error: any) {
    const isTimeout = String(error?.message ?? "").includes("timed out");
    if (isTimeout) {
      console.error("[GET /api/stores/feed] Timed out", {
        timeout_ms: LIST_QUERY_TIMEOUT_MS,
        offset,
        limit,
        city,
        region,
        country,
      });
      return res.status(503).json({ error: "Request timed out. Please retry." });
    }
    return res.status(500).json({ error: error?.message ?? "Unexpected error" });
  }
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
