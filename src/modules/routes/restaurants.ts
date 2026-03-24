// src/modules/routes/restaurants.ts
import { Router } from "express";
import { z } from "zod";
import { createClient } from "@supabase/supabase-js";
import supabase from "../../database/supabase";

const router = Router();

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_ANON_KEY = process.env.SUPABASE_SERVICE_KEY!;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  throw new Error("Missing SUPABASE_URL or SUPABASE_ANON_KEY in env");
}

const RESTAURANT_REVIEW_AGGREGATE_FIELDS = [
  "rating",
  "total_ratings",
  "food_rating",
  "drinks_rating",
  "service_rating",
  "ambience_rating",
  "crowd_rating",
];

/* ---------------------------------------------
   Helpers
--------------------------------------------- */
function getBearerToken(req: any) {
  const h = req.headers.authorization || "";
  const [type, token] = h.split(" ");
  if (type !== "Bearer" || !token) return null;
  return token;
}

// JWT-scoped client (RLS applies as logged-in user)
function supabaseAuthed(req: any) {
  const token = getBearerToken(req);
  if (!token) return null;

  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
}

async function requireAuth(req: any, res: any) {
  const sb = supabaseAuthed(req);
  if (!sb) {
    res.status(401).json({ error: "Missing Authorization token" });
    return null;
  }

  const { data: userData, error: userErr } = await sb.auth.getUser();
  if (userErr || !userData?.user) {
    res.status(401).json({ error: "Invalid session" });
    return null;
  }

  return { sb, user: userData.user };
}

async function getCallerRole(sb: any, callerId: string) {
  const { data, error } = await sb
    .from("users")
    .select("id,role")
    .eq("id", callerId)
    .maybeSingle();

  if (error) return { error };
  return { row: data as null | { id: string; role: string } };
}

function isAdminRole(role?: string | null) {
  return role === "admin" || role === "superadmin";
}

function isPartnerRole(role?: string | null) {
  return role === "restaurantpartner" || role === "storepartner";
}

/**
 * ✅ Admin-only guard (for CREATE)
 */
async function requireAdmin(req: any, res: any) {
  const auth = await requireAuth(req, res);
  if (!auth) return null;

  const callerId = auth.user.id;

  const { row, error } = await getCallerRole(auth.sb, callerId);
  if (error) {
    res.status(500).json({ error: error.message });
    return null;
  }

  if (!row?.role || !isAdminRole(row.role)) {
    res.status(403).json({ error: "Access denied" });
    return null;
  }

  return { sb: auth.sb, callerId, role: row.role };
}

/**
 * ✅ Get caller info if token exists, but don't fail if guest
 */
async function getCallerInfoOptional(req: any) {
  const sb = supabaseAuthed(req);
  if (!sb) return null;

  const { data: userData } = await sb.auth.getUser();
  if (!userData?.user) return null;

  const { row } = await getCallerRole(sb, userData.user.id);
  return { sb, user: userData.user, role: row?.role || null };
}

/**
 * ✅ Write guard for restaurant updates/deletes:
 * admin/superadmin => allow
 * restaurantpartner/storepartner => allow only if owner_user_id == caller
 */
async function requireRestaurantWriteAccess(
  req: any,
  res: any,
  restaurantId: string
) {
  const auth = await requireAuth(req, res);
  if (!auth) return null;

  const callerId = auth.user.id;

  const { row, error } = await getCallerRole(auth.sb, callerId);
  if (error) {
    res.status(500).json({ error: error.message });
    return null;
  }

  const role = row?.role || null;

  // admin/superadmin can edit any restaurant
  if (isAdminRole(role)) return { sb: auth.sb, callerId, role };

  // partners can edit only their own restaurant
  if (isPartnerRole(role)) {
    const { data: rest, error: restErr } = await auth.sb
      .from("restaurants")
      .select("id,owner_user_id")
      .eq("id", restaurantId)
      .maybeSingle();

    if (restErr) {
      res.status(500).json({ error: restErr.message });
      return null;
    }
    if (!rest) {
      res.status(404).json({ error: "Restaurant not found" });
      return null;
    }

    if (rest.owner_user_id !== callerId) {
      res.status(403).json({ error: "Access denied" });
      return null;
    }

    return { sb: auth.sb, callerId, role };
  }

  res.status(403).json({ error: "Access denied" });
  return null;
}

/* ---------------------------------------------
   Schemas
--------------------------------------------- */
const IdSchema = z.string().uuid();

const ListQuerySchema = z.object({
  search: z.string().trim().min(1).optional(),
  city: z.string().trim().min(1).optional(),
  area: z.string().trim().min(1).optional(),
  mood_tag: z.string().trim().min(1).optional(),
  is_pure_veg: z
    .string()
    .optional()
    .transform((v) => {
      if (v === undefined) return undefined;
      const normalized = v.trim().toLowerCase();
      if (normalized === "true" || normalized === "veg") return true;
      if (normalized === "false" || normalized === "nonveg") return false;
      return undefined;
    }),
  owner_user_id: z.string().uuid().optional(),

  status: z.enum(["active", "inactive"]).optional(),
  includeInactive: z.string().optional().transform((v) => v === "true"),

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

  sort: z
    .enum(["created_at", "name", "rating", "distance"])
    .optional()
    .default("created_at"),
  order: z.enum(["asc", "desc"]).optional().default("desc"),
});

const DeleteQuerySchema = z.object({
  hard: z.string().optional().transform((v) => v === "true"),
});

const InTheLimelightQuerySchema = z.object({
  city: z.string().trim().min(1),
});

const GrabYourDealQuerySchema = z.object({
  city: z.string().trim().min(1).optional(),
  limit: z
    .string()
    .optional()
    .transform((v) => (v ? Number(v) : 12))
    .refine((n) => Number.isFinite(n) && n > 0 && n <= 50, "limit 1-50"),
});

const FeaturedInYourLocationQuerySchema = z.object({
  city: z.string().trim().min(1).optional(),
  area: z.string().trim().min(1).optional(),
  limit: z
    .string()
    .optional()
    .transform((v) => (v ? Number(v) : 12))
    .refine((n) => Number.isFinite(n) && n > 0 && n <= 50, "limit 1-50"),
});

const FoodieFrontrowQuerySchema = z.object({
  city: z.string().trim().min(1).optional(),
  area: z.string().trim().min(1).optional(),
  limit: z
    .string()
    .optional()
    .transform((v) => (v ? Number(v) : 12))
    .refine((n) => Number.isFinite(n) && n > 0 && n <= 50, "limit 1-50"),
});

function hasUsableOffer(offer: any) {
  if (offer === null || offer === undefined) return false;
  if (typeof offer === "string") return offer.trim().length > 0;
  if (Array.isArray(offer)) return offer.length > 0;
  if (typeof offer === "object") return Object.keys(offer).length > 0;
  return true;
}

function isAdvertisementActive(restaurant: any, now = new Date()) {
  if (!restaurant?.is_advertised) return false;

  const startsAt = restaurant.ad_starts_at ? new Date(restaurant.ad_starts_at) : null;
  const endsAt = restaurant.ad_ends_at ? new Date(restaurant.ad_ends_at) : null;

  if (startsAt && startsAt > now) return false;
  if (endsAt && endsAt < now) return false;

  return true;
}

function isPremiumActive(restaurant: any, now = new Date()) {
  const hasPremiumSignal =
    restaurant?.subscribed === true ||
    restaurant?.premium_unlock_all === true ||
    restaurant?.premium_time_slot_enabled === true ||
    restaurant?.premium_repeat_rewards_enabled === true ||
    restaurant?.premium_dish_discounts_enabled === true;

  if (!hasPremiumSignal) return false;

  const premiumExpiresAt = restaurant?.premium_expires_at
    ? new Date(restaurant.premium_expires_at)
    : null;

  if (premiumExpiresAt && premiumExpiresAt < now) return false;

  return true;
}

function compareGrabYourDealRestaurants(a: any, b: any) {
  const aAdvertised = isAdvertisementActive(a);
  const bAdvertised = isAdvertisementActive(b);

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

  const aPremium = isPremiumActive(a);
  const bPremium = isPremiumActive(b);

  if (aPremium !== bPremium) {
    return aPremium ? -1 : 1;
  }

  const aRating = Number(a.rating ?? 0);
  const bRating = Number(b.rating ?? 0);
  if (aRating !== bRating) {
    return bRating - aRating;
  }

  const aTotalRatings = Number(a.total_ratings ?? 0);
  const bTotalRatings = Number(b.total_ratings ?? 0);
  if (aTotalRatings !== bTotalRatings) {
    return bTotalRatings - aTotalRatings;
  }

  const aCreatedAt = a.created_at ? new Date(a.created_at).getTime() : 0;
  const bCreatedAt = b.created_at ? new Date(b.created_at).getTime() : 0;
  return bCreatedAt - aCreatedAt;
}

function normalizeCanonicalCity(value?: string | null) {
  const normalized = String(value || "").trim().toLowerCase();

  const aliases: Record<string, string> = {
    hyderabad: "hyderabad",
    secunderabad: "hyderabad",
    "secunderabad, hyderabad": "hyderabad",
    "hyderabad, secunderabad": "hyderabad",
    mumbai: "mumbai",
    bombay: "mumbai",
    bengaluru: "bengaluru",
    bangalore: "bengaluru",
  };

  return aliases[normalized] || normalized;
}

function hasUsableVisualMedia(restaurant: any) {
  const hasCoverImage =
    typeof restaurant?.cover_image === "string" &&
    restaurant.cover_image.trim().length > 0;

  const hasAmbienceImages =
    Array.isArray(restaurant?.ambience_images) &&
    restaurant.ambience_images.some((item: any) => typeof item === "string" && item.trim().length > 0);

  const hasFoodImages =
    Array.isArray(restaurant?.food_images) &&
    restaurant.food_images.some((item: any) => typeof item === "string" && item.trim().length > 0);

  return (
    hasCoverImage ||
    hasAmbienceImages ||
    hasFoodImages
  );
}


function dedupeRestaurantsById(restaurants: any[]) {
  const seen = new Set<string>();
  const deduped: any[] = [];

  for (const restaurant of restaurants) {
    if (!restaurant?.id || seen.has(restaurant.id)) continue;
    seen.add(restaurant.id);
    deduped.push(restaurant);
  }

  return deduped;
}

// ✅ FIX: z.record(keySchema, valueSchema)
const OpeningHoursSchema = z.record(
  z.string(),
  z.object({
    open: z.string(),
    close: z.string(),
  })
);

/**
 * ✅ POST create restaurant ONLY (NO partner creation here)
 * owner_user_id can be passed from frontend after /api/auth/create-user returns id
 */
const CreateRestaurantSchema = z.object({
  name: z.string().trim().min(1),
  phone: z.union([z.string().trim(), z.null(), z.undefined()]).optional().nullable(),
  city: z.string().trim().optional().nullable(),
  area: z.string().trim().optional().nullable(),
  full_address: z.string().trim().optional().nullable(),

  cuisines: z.array(z.string()).optional().default([]),
  cost_for_two: z.coerce.number().int().optional().nullable(),
  distance: z.coerce.number().optional().nullable(),
  offer: z.record(z.string(), z.any()).optional().nullable(),

  facilities: z.array(z.string()).optional().default([]),
  highlights: z.array(z.string()).optional().default([]),
  worth_visit: z.array(z.string()).optional().default([]),
  mood_tags: z.array(z.string()).optional().default([]),
  is_pure_veg: z.boolean().optional().default(false),

  opening_hours: OpeningHoursSchema.optional().default({}),

  reviews: z.any().optional().default([]),
  menu: z.any().optional().default([]),

  food_images: z.array(z.string()).optional().default([]),
  ambience_images: z.array(z.string()).optional().default([]),
  cover_image: z.string().optional().nullable(),

  is_active: z.boolean().optional().default(true),

  slug: z.string().trim().min(1),
  latitude: z.coerce.number().optional().nullable(),
  longitude: z.coerce.number().optional().nullable(),

  booking_enabled: z.boolean().optional().default(true),
  avg_duration_minutes: z.coerce.number().int().optional().default(90),
  max_bookings_per_slot: z.coerce.number().int().optional().nullable(),
  advance_booking_days: z.coerce.number().int().optional().default(30),

  // ✅ optional: allow admin to set owner_user_id at creation time
  owner_user_id: z.string().uuid().optional().nullable(),
});

const UpdateRestaurantSchema = z.object({
  name: z.string().trim().min(1).optional(),
  phone: z.union([z.string().trim(), z.null(), z.undefined()]).optional().nullable(),
  city: z.string().trim().nullable().optional(),
  area: z.string().trim().nullable().optional(),
  full_address: z.string().trim().nullable().optional(),

  cuisines: z.array(z.string()).optional(),
  cost_for_two: z.coerce.number().int().nullable().optional(),
  distance: z.coerce.number().nullable().optional(),
  offer: z.record(z.string(), z.any()).nullable().optional(),

  facilities: z.array(z.string()).optional(),
  highlights: z.array(z.string()).optional(),
  worth_visit: z.array(z.string()).optional(),
  mood_tags: z.array(z.string()).optional(),
  is_pure_veg: z.boolean().optional(),

  opening_hours: OpeningHoursSchema.nullable().optional(),

  reviews: z.any().optional(),
  menu: z.any().optional(),

  food_images: z.array(z.string()).optional(),
  ambience_images: z.array(z.string()).optional(),
  cover_image: z.string().nullable().optional(),

  is_active: z.boolean().optional(),

  slug: z.string().trim().min(1).optional(),
  latitude: z.coerce.number().nullable().optional(),
  longitude: z.coerce.number().nullable().optional(),

  booking_enabled: z.boolean().optional(),
  avg_duration_minutes: z.coerce.number().int().optional(),
  max_bookings_per_slot: z.coerce.number().int().nullable().optional(),
  advance_booking_days: z.coerce.number().int().optional(),

  // ✅ allow admin to relink owner if needed
  owner_user_id: z.string().uuid().nullable().optional(),
});

/* ---------------------------------------------
   ROUTES
--------------------------------------------- */

// ✅ Public/Role-aware: GET /api/restaurants
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
    area,
    mood_tag,
    is_pure_veg,
    owner_user_id,
    status,
    includeInactive,
    limit,
    offset,
    sort,
    order,
  } =
    parsed.data;

  // 🛡️ SECURITY: get caller info if available
  const caller = await getCallerInfoOptional(req);
  const isAdmin = isAdminRole(caller?.role);
  const isPartner = isPartnerRole(caller?.role);

  let query = supabase.from("restaurants").select("*", { count: "exact" });

  // 1. Filter by owner
  if (isPartner) {
    // Partners only see their own restaurants
    query = query.eq("owner_user_id", caller!.user.id);
  } else if (isAdmin && owner_user_id) {
    // Admins can filter by a specific owner
    query = query.eq("owner_user_id", owner_user_id);
  }

  // 2. Filter by status
  if (!includeInactive && !status) query = query.eq("is_active", true);
  if (status) query = query.eq("is_active", status === "active");

  // 3. Search and locations
  if (city) query = query.ilike("city", `%${city}%`);
  if (area) query = query.ilike("area", `%${area}%`);
  if (mood_tag) query = query.contains("mood_tags", [mood_tag]);
  if (typeof is_pure_veg === "boolean") query = query.eq("is_pure_veg", is_pure_veg);

  if (search) {
    const s = search.replace(/"/g, '\\"');
    query = query.or(
      [
        `name.ilike.%${s}%`,
        `phone.ilike.%${s}%`,
        `area.ilike.%${s}%`,
        `city.ilike.%${s}%`,
        `full_address.ilike.%${s}%`,
        `slug.ilike.%${s}%`,
      ].join(",")
    );
  }

  query = query.order(sort, { ascending: order === "asc" });

  const from = offset;
  const to = offset + limit - 1;

  const { data, error, count } = await query.range(from, to);
  if (error) return res.status(500).json({ error: error.message });

  return res.json({ items: data ?? [], page: { limit, offset, total: count ?? 0 } });
});

// ✅ Public: GET /api/restaurants/in-the-limelight?city=Hyderabad
router.get("/in-the-limelight", async (req, res) => {
  const parsed = InTheLimelightQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res
      .status(400)
      .json({ error: "Invalid query", details: parsed.error.flatten() });
  }

  const { city } = parsed.data;
  const normalizedCity = normalizeCanonicalCity(city);

  let query = supabase
    .from("restaurants")
    .select("*")
    .eq("is_active", true)
    .gte("rating", 4.2)
    .gte("total_ratings", 50)
    .eq("booking_enabled", true)
    .eq("subscribed", true)
    .not("cover_image", "is", null)
    .not("offer", "is", null)
    .order("rating", { ascending: false })
    .order("total_ratings", { ascending: false });

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });

  const items = (data ?? []).filter(
    (restaurant: any) =>
      normalizeCanonicalCity(restaurant.city) === normalizedCity &&
      typeof restaurant.cover_image === "string" &&
      restaurant.cover_image.trim() !== "" &&
      restaurant.offer !== null
  )
  .sort(compareGrabYourDealRestaurants);

  return res.json({
    items,
    city,
    derived_collection: "in_the_limelight",
  });
});

// ✅ Public: GET /api/restaurants/grab-your-deal
router.get("/grab-your-deal", async (req, res) => {
  const parsed = GrabYourDealQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res
      .status(400)
      .json({ error: "Invalid query", details: parsed.error.flatten() });
  }

  try {
    const { city, limit } = parsed.data;
    const normalizedCity = normalizeCanonicalCity(city);

    const baseQuery = supabase
      .from("restaurants")
      .select("*")
      .eq("is_active", true)
      .not("offer", "is", null);

    const { data: allCandidateRows, error } = await baseQuery;
    if (error) {
      return res.status(500).json({ error: error.message });
    }

    const allCandidates = (allCandidateRows ?? []).filter((restaurant: any) =>
      hasUsableOffer(restaurant.offer)
    );

    const cityMatchedCandidates =
      normalizedCity && normalizedCity.length > 0
        ? allCandidates.filter(
            (restaurant: any) =>
              normalizeCanonicalCity(restaurant.city) === normalizedCity
          )
        : [];

    const sourceItems =
      cityMatchedCandidates.length > 0 ? cityMatchedCandidates : allCandidates;

    const items = sourceItems
      .filter((restaurant: any) => hasUsableOffer(restaurant.offer))
      .sort(compareGrabYourDealRestaurants)
      .slice(0, limit);

    return res.json({ items });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// ✅ Public: GET /api/restaurants/featured-in-your-location
router.get("/featured-in-your-location", async (req, res) => {
  const parsed = FeaturedInYourLocationQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res
      .status(400)
      .json({ error: "Invalid query", details: parsed.error.flatten() });
  }

  try {
    const { city, area, limit } = parsed.data;

    const { data, error } = await supabase
      .from("restaurants")
      .select(
        [
          "id",
          "name",
          "area",
          "city",
          "full_address",
          "cuisines",
          "distance",
          "offer",
          "food_images",
          "ambience_images",
          "cover_image",
          "latitude",
          "longitude",
          "is_active",
          "is_advertised",
          "ad_badge_text",
          "ad_priority",
          "ad_starts_at",
          "ad_ends_at",
          "subscribed",
          "premium_unlock_all",
          "premium_time_slot_enabled",
          "premium_repeat_rewards_enabled",
          "premium_dish_discounts_enabled",
          "premium_expires_at",
          "created_at",
          ...RESTAURANT_REVIEW_AGGREGATE_FIELDS,
        ].join(",")
      )
      .eq("is_active", true);

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    const allActiveRestaurants = dedupeRestaurantsById(data ?? []);

    const normalizedArea = area?.trim().toLowerCase();
    const normalizedCity = normalizeCanonicalCity(city);

    const areaMatchedRestaurants =
      normalizedArea && normalizedArea.length > 0
        ? allActiveRestaurants.filter(
            (restaurant: any) =>
              typeof restaurant.area === "string" &&
              restaurant.area.trim().toLowerCase() === normalizedArea
          )
        : [];

    const cityMatchedRestaurants =
      normalizedCity && normalizedCity.length > 0
        ? allActiveRestaurants.filter(
            (restaurant: any) =>
              normalizeCanonicalCity(restaurant.city) === normalizedCity
          )
        : [];

    const areaRanked = dedupeRestaurantsById(areaMatchedRestaurants)
      .sort(compareGrabYourDealRestaurants);

    const cityOnlyRanked = dedupeRestaurantsById(
      cityMatchedRestaurants.filter(
        (restaurant: any) =>
          !areaRanked.some((areaRestaurant: any) => areaRestaurant.id === restaurant.id)
      )
    ).sort(compareGrabYourDealRestaurants);

    const overallFallbackRanked = dedupeRestaurantsById(
      allActiveRestaurants.filter(
        (restaurant: any) =>
          !areaRanked.some((areaRestaurant: any) => areaRestaurant.id === restaurant.id) &&
          !cityOnlyRanked.some((cityRestaurant: any) => cityRestaurant.id === restaurant.id)
      )
    ).sort(compareGrabYourDealRestaurants);

    const items = [...areaRanked, ...cityOnlyRanked, ...overallFallbackRanked].slice(0, limit);

    return res.json({ items });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// ✅ Public: GET /api/restaurants/foodie-frontrow
router.get("/foodie-frontrow", async (req, res) => {
  const parsed = FoodieFrontrowQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res
      .status(400)
      .json({ error: "Invalid query", details: parsed.error.flatten() });
  }

  try {
    const { city, area, limit } = parsed.data;

    const { data, error } = await supabase
      .from("restaurants")
      .select(
        [
          "id",
          "name",
          "area",
          "city",
          "cover_image",
          "ambience_images",
          "food_images",
          "cuisines",
          "distance",
          "offer",
          "slug",
          "latitude",
          "longitude",
          "is_advertised",
          "ad_badge_text",
          "ad_priority",
          "ad_starts_at",
          "ad_ends_at",
          "subscribed",
          "premium_unlock_all",
          "premium_time_slot_enabled",
          "premium_repeat_rewards_enabled",
          "premium_dish_discounts_enabled",
          "premium_expires_at",
          "created_at",
          "description",
          ...RESTAURANT_REVIEW_AGGREGATE_FIELDS,
        ].join(",")
      )
      .eq("is_active", true);

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    const eligibleRestaurants = dedupeRestaurantsById(
      (data ?? []).filter((restaurant: any) => hasUsableVisualMedia(restaurant))
    );

    const normalizedArea = area?.trim().toLowerCase();
    const normalizedCity = normalizeCanonicalCity(city);

    const areaMatchedRestaurants =
      normalizedArea && normalizedArea.length > 0
        ? eligibleRestaurants.filter(
            (restaurant: any) =>
              typeof restaurant.area === "string" &&
              restaurant.area.trim().toLowerCase() === normalizedArea
          )
        : [];

    const cityMatchedRestaurants =
      normalizedCity && normalizedCity.length > 0
        ? eligibleRestaurants.filter(
            (restaurant: any) =>
              normalizeCanonicalCity(restaurant.city) === normalizedCity
          )
        : [];

    let sourceItems = eligibleRestaurants;

    if (areaMatchedRestaurants.length >= limit) {
      sourceItems = areaMatchedRestaurants;
    } else if (cityMatchedRestaurants.length > 0) {
      sourceItems = cityMatchedRestaurants;
    } else if (areaMatchedRestaurants.length > 0) {
      sourceItems = areaMatchedRestaurants;
    }

    const items = dedupeRestaurantsById(sourceItems)
      .sort(compareGrabYourDealRestaurants)
      .slice(0, limit);

    return res.json({ items });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// ✅ Public: GET /api/restaurants/:id
router.get("/:id", async (req, res) => {
  const idParsed = IdSchema.safeParse(req.params.id);
  if (!idParsed.success) return res.status(400).json({ error: "Invalid restaurant id" });

  const { data, error } = await supabase
    .from("restaurants")
    .select("*")
    .eq("id", idParsed.data)
    .maybeSingle();

  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: "Restaurant not found" });

  return res.json({ item: data });
});

/**
 * ✅ Admin-only: POST /api/restaurants
 * Creates restaurant ONLY (no signup/users insert here)
 */
router.post("/", async (req, res) => {
  const parsed = CreateRestaurantSchema.safeParse(req.body);
  if (!parsed.success) {
    return res
      .status(400)
      .json({ error: "Invalid body", details: parsed.error.flatten() });
  }

  const admin = await requireAdmin(req, res);
  if (!admin) return;

  const { sb } = admin;
  const body = parsed.data;

  const { data, error } = await sb
    .from("restaurants")
    .insert({
      name: body.name,
      phone: body.phone ?? null,
      city: body.city ?? null,
      area: body.area ?? null,
      full_address: body.full_address ?? null,

      cuisines: body.cuisines ?? [],
      cost_for_two: body.cost_for_two ?? null,
      distance: body.distance ?? null,
      offer: body.offer ?? null,

      facilities: body.facilities ?? [],
      highlights: body.highlights ?? [],
      worth_visit: body.worth_visit ?? [],
      mood_tags: body.mood_tags ?? [],
      is_pure_veg: body.is_pure_veg ?? false,

      opening_hours: body.opening_hours ?? {},
      reviews: body.reviews ?? [],
      menu: body.menu ?? [],

      food_images: body.food_images ?? [],
      ambience_images: body.ambience_images ?? [],
      cover_image: body.cover_image ?? null,

      is_active: body.is_active ?? true,

      slug: body.slug,
      latitude: body.latitude ?? null,
      longitude: body.longitude ?? null,

      booking_enabled: body.booking_enabled ?? true,
      avg_duration_minutes: body.avg_duration_minutes ?? 90,
      max_bookings_per_slot: body.max_bookings_per_slot ?? null,
      advance_booking_days: body.advance_booking_days ?? 30,

      owner_user_id: body.owner_user_id ?? null,
    })
    .select()
    .single();

  if (error) {
    if ((error as any)?.code === "23505") return res.status(400).json({ error: "Slug already exists" });
    return res.status(500).json({ error: error.message });
  }

  return res.status(201).json({ restaurant: data });
});

/**
 * ✅ PUT /api/restaurants/:id
 * Allowed:
 * - admin/superadmin => any restaurant
 * - restaurantpartner/storepartner => only if owner_user_id === caller
 */
router.put("/:id", async (req, res) => {
  const idParsed = IdSchema.safeParse(req.params.id);
  if (!idParsed.success) return res.status(400).json({ error: "Invalid restaurant id" });

  const bodyParsed = UpdateRestaurantSchema.safeParse(req.body);
  if (!bodyParsed.success) {
    // 🛡️ DETAILED ERROR: Log which fields failed for easier debugging
    const flatErrors = bodyParsed.error.flatten();
    console.error("[PUT /restaurants/:id] Schema validation failed:", {
      fieldErrors: flatErrors.fieldErrors,
      formErrors: flatErrors.formErrors,
      receivedBody: req.body,
    });
    return res
      .status(400)
      .json({ 
        error: "Invalid body", 
        details: flatErrors,
        hint: "Check field types: numeric fields should be numbers (not strings)" 
      });
  }

  const id = idParsed.data;

  const access = await requireRestaurantWriteAccess(req, res, id);
  if (!access) return;

  const payload: any = { ...bodyParsed.data };

  // 🛡️ SECURITY: Only allow admins to change owner_user_id
  if (payload.owner_user_id !== undefined && !isAdminRole(access.role)) {
    delete payload.owner_user_id;
  }

  console.log("[PUT /restaurants/:id] Updating restaurant:", { id, role: access.role, payload });

  const { data, error } = await access.sb
    .from("restaurants")
    .update(payload)
    .eq("id", id)
    .select()
    .single();

  if (error) {
    console.error("[PUT /restaurants/:id] Database error:", error);
    if ((error as any)?.code === "23505") return res.status(400).json({ error: "Slug already exists" });
    return res.status(500).json({ error: error.message });
  }

  console.log("[PUT /restaurants/:id] Update successful:", { id });
  return res.json({ item: data });
});

/**
 * ✅ DELETE /api/restaurants/:id?hard=true
 * Allowed:
 * - admin/superadmin => any restaurant
 * - restaurantpartner/storepartner => only if owner_user_id === caller
 */
router.delete("/:id", async (req, res) => {
  const idParsed = IdSchema.safeParse(req.params.id);
  if (!idParsed.success) return res.status(400).json({ error: "Invalid restaurant id" });

  const qParsed = DeleteQuerySchema.safeParse(req.query);
  if (!qParsed.success) {
    return res
      .status(400)
      .json({ error: "Invalid query", details: qParsed.error.flatten() });
  }

  const id = idParsed.data;
  const { hard } = qParsed.data;

  const access = await requireRestaurantWriteAccess(req, res, id);
  if (!access) return;

  const exists = await access.sb
    .from("restaurants")
    .select("id,is_active")
    .eq("id", id)
    .maybeSingle();

  if (exists.error) return res.status(500).json({ error: exists.error.message });
  if (!exists.data) return res.status(404).json({ error: "Restaurant not found" });

  if (hard) {
    const { error } = await access.sb.from("restaurants").delete().eq("id", id);
    if (error) return res.status(500).json({ error: error.message });
    return res.json({ ok: true, deleted: "hard", id });
  }

  const { error } = await access.sb
    .from("restaurants")
    .update({ is_active: false })
    .eq("id", id);

  if (error) return res.status(500).json({ error: error.message });

  return res.json({ ok: true, deleted: "soft", id });
});

export default router;
