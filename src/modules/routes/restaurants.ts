// src/modules/routes/restaurants.ts
import { Router } from "express";
import { z } from "zod";
import { createClient } from "@supabase/supabase-js";
import supabase from "../../database/supabase";

const router = Router();

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_ANON_KEY = process.env.SUPABASE_SERVICE_KEY!;
const LIST_QUERY_TIMEOUT_MS = Number(process.env.LIST_QUERY_TIMEOUT_MS ?? 5000);

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

const RESTAURANT_BASE_SELECT = [
  "id",
  "name",
  "phone",
  "area",
  "city",
  "full_address",
  "slug",
  "cover_image",
  "latitude",
  "longitude",
  "description",
  "cost_for_two",
  "is_active",
  "owner_user_id",
  "is_pure_veg",
  "booking_enabled",
  "avg_duration_minutes",
  "max_bookings_per_slot",
  "advance_booking_days",
  "modification_available",
  "modification_cutoff_minutes",
  "cancellation_available",
  "cancellation_cutoff_minutes",
  "cover_charge_enabled",
  "cover_charge_amount",
  "created_at",
  "updated_at",
  "is_advertised",
  "ad_priority",
  "ad_starts_at",
  "ad_ends_at",
  "ad_badge_text",
  "booking_terms",
].join(",");

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

const PickerQuerySchema = z.object({
  search: z.string().trim().min(1).optional(),
  city: z.string().trim().min(1).optional(),
  area: z.string().trim().min(1).optional(),
  status: z.enum(["active", "inactive", "all"]).optional().default("active"),
  owner_user_id: z.string().uuid().optional(),
  limit: z
    .string()
    .optional()
    .transform((v) => (v ? Number(v) : 50))
    .refine((n) => Number.isFinite(n) && n > 0 && n <= 200, "limit 1-200"),
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

function getFoodieFrontrowLocationScore(
  restaurant: any,
  normalizedArea?: string | null,
  normalizedCity?: string | null
) {
  const restaurantArea = String(restaurant?.area || "").trim().toLowerCase();
  const restaurantCity = normalizeCanonicalCity(restaurant?.city);

  if (normalizedArea && restaurantArea && restaurantArea === normalizedArea) {
    return 2;
  }

  if (normalizedCity && restaurantCity && restaurantCity === normalizedCity) {
    return 1;
  }

  return 0;
}

function compareFoodieFrontrowRestaurants(
  a: any,
  b: any,
  normalizedArea?: string | null,
  normalizedCity?: string | null
) {
  const aAdvertised = isAdvertisementActive(a);
  const bAdvertised = isAdvertisementActive(b);

  if (aAdvertised !== bAdvertised) {
    return aAdvertised ? -1 : 1;
  }

  const aLocationScore = getFoodieFrontrowLocationScore(a, normalizedArea, normalizedCity);
  const bLocationScore = getFoodieFrontrowLocationScore(b, normalizedArea, normalizedCity);

  if (aLocationScore !== bLocationScore) {
    return bLocationScore - aLocationScore;
  }

  const aCreatedAt = a.created_at ? new Date(a.created_at).getTime() : 0;
  const bCreatedAt = b.created_at ? new Date(b.created_at).getTime() : 0;
  if (aCreatedAt !== bCreatedAt) {
    return bCreatedAt - aCreatedAt;
  }

  if (aAdvertised && bAdvertised) {
    const aPriority = typeof a.ad_priority === "number" ? a.ad_priority : 100;
    const bPriority = typeof b.ad_priority === "number" ? b.ad_priority : 100;

    if (aPriority !== bPriority) {
      return aPriority - bPriority;
    }
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

  return String(a?.id ?? "").localeCompare(String(b?.id ?? ""));
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

function sortByOrderAndCreatedAt<T extends { sort_order?: number | null; created_at?: string | null }>(
  items: T[]
) {
  return [...items].sort((a, b) => {
    const sortDelta = Number(a.sort_order ?? 100) - Number(b.sort_order ?? 100);
    if (sortDelta !== 0) return sortDelta;
    const aCreatedAt = a.created_at ? new Date(a.created_at).getTime() : 0;
    const bCreatedAt = b.created_at ? new Date(b.created_at).getTime() : 0;
    return aCreatedAt - bCreatedAt;
  });
}

function getDayKey(dayOfWeek: number) {
  return String(dayOfWeek);
}

function getWeekdayName(dayOfWeek: number) {
  const names = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  return names[dayOfWeek] ?? null;
}

function addOpeningHourEntry(
  bucket: Record<string, { open: string; close: string; is_closed?: boolean }>,
  dayOfWeek: number,
  value: { open: string; close: string; is_closed?: boolean }
) {
  bucket[String(dayOfWeek)] = value;
  const weekdayName = getWeekdayName(dayOfWeek);
  if (weekdayName) {
    bucket[weekdayName] = value;
    bucket[weekdayName.slice(0, 3)] = value;
  }
}

function extractRestaurantStoragePath(value: unknown) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;

  if (!/^https?:\/\//i.test(raw)) {
    const normalized = raw.replace(/^\/+/, "");
    const marker = "restaurant/";
    const markerIndex = normalized.indexOf(marker);
    return markerIndex >= 0 ? normalized.slice(markerIndex + marker.length) : normalized;
  }

  const objectPublicMatch = raw.match(/\/object\/public\/restaurant\/(.+)$/i);
  if (objectPublicMatch?.[1]) return objectPublicMatch[1];

  const fallbackMatch = raw.match(/\/restaurant\/(.+)$/i);
  return fallbackMatch?.[1] ?? null;
}

function normalizeLegacyOfferTitle(item: any) {
  if (typeof item === "string") return item.trim();
  if (!item || typeof item !== "object") return "";
  return String(item.title ?? item.text ?? item.label ?? item.name ?? "").trim();
}

function normalizeLegacyOfferForStorage(item: any) {
  if (item === null || item === undefined) return null;

  if (typeof item === "string") {
    const title = item.trim();
    if (!title) return null;
    return {
      title,
      description: null,
      badge_text: null,
      offer_type: "custom",
      discount_value: null,
      min_spend: null,
      start_at: null,
      end_at: null,
      is_active: true,
      metadata: {},
    };
  }

  if (typeof item === "object" && !Array.isArray(item)) {
    const title = normalizeLegacyOfferTitle(item);
    if (!title) return null;

    const normalizedType = String(item.offer_type ?? item.type ?? "custom").trim().toLowerCase();
    const offerType = ["flat", "percentage", "bogo", "free_item", "cover_discount", "custom"].includes(
      normalizedType
    )
      ? normalizedType
      : "custom";

    const { title: _title, text: _text, label: _label, name: _name, offer_type: _offerType, type: _type, ...rest } =
      item;

    return {
      title,
      description: typeof item.description === "string" ? item.description : null,
      badge_text: typeof item.badge_text === "string" ? item.badge_text : null,
      offer_type: offerType,
      discount_value: normalizeOfferMinimumBillAmount(item.discount_value),
      min_spend: normalizeOfferMinimumBillAmount(item.minimum_bill_amount ?? item.min_spend),
      start_at: item.start_at ?? null,
      end_at: item.end_at ?? null,
      is_active: item.is_active !== false,
      metadata: rest,
    };
  }

  return null;
}

function normalizeOpeningHoursForStorage(value: Record<string, { open: string; close: string }> | null | undefined) {
  if (value === undefined) return undefined;
  if (value === null) return [];

  return Object.entries(value)
    .map(([day, hours]) => {
      const dayOfWeek = Number(day);
      if (!Number.isInteger(dayOfWeek) || dayOfWeek < 0 || dayOfWeek > 6) return null;
      const open = typeof hours?.open === "string" ? hours.open : null;
      const close = typeof hours?.close === "string" ? hours.close : null;
      if (!open || !close) {
        return { day_of_week: dayOfWeek, open_time: null, close_time: null, is_closed: true };
      }
      return { day_of_week: dayOfWeek, open_time: open, close_time: close, is_closed: false };
    })
    .filter(Boolean) as Array<{ day_of_week: number; open_time: string | null; close_time: string | null; is_closed: boolean }>;
}

async function hydrateRestaurants(baseRestaurants: any[]) {
  if (!baseRestaurants.length) return [];

  const restaurantIds = baseRestaurants.map((restaurant) => restaurant.id);

  const [
    tagsResp,
    mediaResp,
    hoursResp,
    offersResp,
    reviewsResp,
    subscriptionsResp,
  ] = await Promise.all([
    supabase
      .from("restaurant_tags")
      .select("restaurant_id,tag_type,tag_value,sort_order,created_at")
      .in("restaurant_id", restaurantIds),
    supabase
      .from("restaurant_media_assets")
      .select("restaurant_id,asset_type,file_url,sort_order,created_at,is_active")
      .in("restaurant_id", restaurantIds)
      .eq("is_active", true),
    supabase
      .from("restaurant_opening_hours")
      .select("restaurant_id,day_of_week,open_time,close_time,is_closed,created_at")
      .in("restaurant_id", restaurantIds),
    supabase
      .from("restaurant_offers")
      .select("id,restaurant_id,title,description,badge_text,offer_type,discount_value,min_spend,start_at,end_at,is_active,metadata,created_at")
      .in("restaurant_id", restaurantIds),
    supabase
      .from("restaurant_reviews")
      .select("restaurant_id,rating,food_rating,service_rating,ambience_rating,drinks_rating,crowd_rating,is_approved")
      .in("restaurant_id", restaurantIds)
      .eq("is_approved", true),
    supabase
      .from("restaurant_subscriptions")
      .select("restaurant_id,plan_code,status,unlock_all,time_slot_enabled,repeat_rewards_enabled,dish_discounts_enabled,starts_at,expires_at,created_at")
      .in("restaurant_id", restaurantIds),
  ]);

  for (const response of [tagsResp, mediaResp, hoursResp, offersResp, reviewsResp, subscriptionsResp]) {
    if (response.error) throw response.error;
  }

  const tagsByRestaurant = new Map<string, Record<string, string[]>>();
  for (const tag of sortByOrderAndCreatedAt(tagsResp.data ?? [])) {
    const bucket = tagsByRestaurant.get(tag.restaurant_id) ?? {};
    const values = bucket[tag.tag_type] ?? [];
    values.push(tag.tag_value);
    bucket[tag.tag_type] = values;
    tagsByRestaurant.set(tag.restaurant_id, bucket);
  }

  const mediaByRestaurant = new Map<string, Record<string, string[]>>();
  for (const asset of sortByOrderAndCreatedAt(mediaResp.data ?? [])) {
    const bucket = mediaByRestaurant.get(asset.restaurant_id) ?? {};
    const values = bucket[asset.asset_type] ?? [];
    values.push(asset.file_url);
    bucket[asset.asset_type] = values;
    mediaByRestaurant.set(asset.restaurant_id, bucket);
  }

  const hoursByRestaurant = new Map<string, Record<string, { open: string; close: string; is_closed?: boolean }>>();
  for (const hour of sortByOrderAndCreatedAt(hoursResp.data ?? [])) {
    const bucket = hoursByRestaurant.get(hour.restaurant_id) ?? {};
    const normalizedHour = hour.is_closed
      ? { open: "", close: "", is_closed: true }
      : { open: hour.open_time, close: hour.close_time };
    addOpeningHourEntry(bucket, Number(hour.day_of_week), normalizedHour);
    hoursByRestaurant.set(hour.restaurant_id, bucket);
  }

  const now = new Date();
  const offersByRestaurant = new Map<string, any[]>();
  for (const offer of sortByOrderAndCreatedAt(offersResp.data ?? [])) {
    const startsAt = offer.start_at ? new Date(offer.start_at) : null;
    const endsAt = offer.end_at ? new Date(offer.end_at) : null;
    if (offer.is_active === false) continue;
    if (startsAt && startsAt > now) continue;
    if (endsAt && endsAt < now) continue;

    const bucket = offersByRestaurant.get(offer.restaurant_id) ?? [];
    bucket.push({
      id: offer.id,
      title: offer.title,
      description: offer.description,
      badge_text: offer.badge_text,
      offer_type: offer.offer_type,
      discount_value: offer.discount_value,
      minimum_bill_amount: offer.min_spend,
      start_at: offer.start_at,
      end_at: offer.end_at,
      metadata: offer.metadata ?? {},
    });
    offersByRestaurant.set(offer.restaurant_id, bucket);
  }

  const reviewStatsByRestaurant = new Map<string, any>();
  for (const review of reviewsResp.data ?? []) {
    const bucket =
      reviewStatsByRestaurant.get(review.restaurant_id) ??
      {
        count: 0,
        rating: 0,
        food_rating: { sum: 0, count: 0 },
        service_rating: { sum: 0, count: 0 },
        ambience_rating: { sum: 0, count: 0 },
        drinks_rating: { sum: 0, count: 0 },
        crowd_rating: { sum: 0, count: 0 },
      };

    bucket.count += 1;
    bucket.rating += Number(review.rating ?? 0);

    for (const field of ["food_rating", "service_rating", "ambience_rating", "drinks_rating", "crowd_rating"] as const) {
      const value = review[field];
      if (value !== null && value !== undefined) {
        bucket[field].sum += Number(value);
        bucket[field].count += 1;
      }
    }

    reviewStatsByRestaurant.set(review.restaurant_id, bucket);
  }

  const activeSubscriptionsByRestaurant = new Map<string, any>();
  for (const subscription of sortByOrderAndCreatedAt(subscriptionsResp.data ?? [])) {
    const startsAt = subscription.starts_at ? new Date(subscription.starts_at) : null;
    const expiresAt = subscription.expires_at ? new Date(subscription.expires_at) : null;
    if (subscription.status !== "active") continue;
    if (startsAt && startsAt > now) continue;
    if (expiresAt && expiresAt < now) continue;
    if (!activeSubscriptionsByRestaurant.has(subscription.restaurant_id)) {
      activeSubscriptionsByRestaurant.set(subscription.restaurant_id, subscription);
    }
  }

  return baseRestaurants.map((restaurant) => {
    const tags = tagsByRestaurant.get(restaurant.id) ?? {};
    const media = mediaByRestaurant.get(restaurant.id) ?? {};
    const reviewStats = reviewStatsByRestaurant.get(restaurant.id);
    const activeSubscription = activeSubscriptionsByRestaurant.get(restaurant.id) ?? null;
    const activeOffers = offersByRestaurant.get(restaurant.id) ?? [];

    const aggregate = reviewStats
      ? {
          rating: Number((reviewStats.rating / reviewStats.count).toFixed(1)),
          total_ratings: reviewStats.count,
          food_rating:
            reviewStats.food_rating.count > 0
              ? Number((reviewStats.food_rating.sum / reviewStats.food_rating.count).toFixed(1))
              : null,
          service_rating:
            reviewStats.service_rating.count > 0
              ? Number((reviewStats.service_rating.sum / reviewStats.service_rating.count).toFixed(1))
              : null,
          ambience_rating:
            reviewStats.ambience_rating.count > 0
              ? Number((reviewStats.ambience_rating.sum / reviewStats.ambience_rating.count).toFixed(1))
              : null,
          drinks_rating:
            reviewStats.drinks_rating.count > 0
              ? Number((reviewStats.drinks_rating.sum / reviewStats.drinks_rating.count).toFixed(1))
              : null,
          crowd_rating:
            reviewStats.crowd_rating.count > 0
              ? Number((reviewStats.crowd_rating.sum / reviewStats.crowd_rating.count).toFixed(1))
              : null,
        }
      : {
          rating: 0,
          total_ratings: 0,
          food_rating: null,
          service_rating: null,
          ambience_rating: null,
          drinks_rating: null,
          crowd_rating: null,
        };

    return {
      ...restaurant,
      cuisines: tags.cuisine ?? [],
      facilities: tags.facility ?? [],
      highlights: tags.highlight ?? [],
      worth_visit: tags.worth_visit ?? [],
      mood_tags: tags.mood ?? [],
      distance: null,
      offer: activeOffers,
      offers: activeOffers,
      food_images: media.food ?? [],
      ambience_images: media.ambience ?? [],
      menu_images: media.menu ?? [],
      opening_hours: hoursByRestaurant.get(restaurant.id) ?? {},
      subscribed: Boolean(activeSubscription),
      subscribed_plan: activeSubscription?.plan_code ?? null,
      premium_unlock_all: activeSubscription?.unlock_all ?? false,
      premium_time_slot_enabled: activeSubscription?.time_slot_enabled ?? false,
      premium_repeat_rewards_enabled: activeSubscription?.repeat_rewards_enabled ?? false,
      premium_dish_discounts_enabled: activeSubscription?.dish_discounts_enabled ?? false,
      premium_expires_at: activeSubscription?.expires_at ?? null,
      ...aggregate,
    };
  });
}

async function replaceRestaurantTags(
  sb: any,
  restaurantId: string,
  updates: Partial<Record<"cuisines" | "facilities" | "highlights" | "worth_visit" | "mood_tags", string[]>>,
) {
  const mappings = [
    { bodyKey: "cuisines" as const, tagType: "cuisine" },
    { bodyKey: "facilities" as const, tagType: "facility" },
    { bodyKey: "highlights" as const, tagType: "highlight" },
    { bodyKey: "worth_visit" as const, tagType: "worth_visit" },
    { bodyKey: "mood_tags" as const, tagType: "mood" },
  ];

  for (const { bodyKey, tagType } of mappings) {
    const values = updates[bodyKey];
    if (values === undefined) continue;

    const { error: deleteError } = await sb
      .from("restaurant_tags")
      .delete()
      .eq("restaurant_id", restaurantId)
      .eq("tag_type", tagType);
    if (deleteError) throw deleteError;

    if (!values.length) continue;

    const rows = values.map((tagValue, index) => ({
      restaurant_id: restaurantId,
      tag_type: tagType,
      tag_value: tagValue,
      sort_order: index,
    }));

    const { error: insertError } = await sb.from("restaurant_tags").insert(rows);
    if (insertError) throw insertError;
  }
}

async function replaceRestaurantMedia(
  sb: any,
  restaurantId: string,
  updates: Partial<Record<"food_images" | "ambience_images", string[]>>,
) {
  const mappings = [
    { bodyKey: "food_images" as const, assetType: "food" },
    { bodyKey: "ambience_images" as const, assetType: "ambience" },
  ];

  for (const { bodyKey, assetType } of mappings) {
    const values = updates[bodyKey];
    if (values === undefined) continue;

    const { error: deleteError } = await sb
      .from("restaurant_media_assets")
      .delete()
      .eq("restaurant_id", restaurantId)
      .eq("asset_type", assetType);
    if (deleteError) throw deleteError;

    if (!values.length) continue;

    const rows = values.map((fileUrl, index) => ({
      restaurant_id: restaurantId,
      asset_type: assetType,
      file_url: fileUrl,
      sort_order: index,
      is_active: true,
    }));

    const { error: insertError } = await sb.from("restaurant_media_assets").insert(rows);
    if (insertError) throw insertError;
  }
}

async function replaceRestaurantOpeningHours(
  sb: any,
  restaurantId: string,
  openingHours: Record<string, { open: string; close: string }> | null | undefined
) {
  if (openingHours === undefined) return;

  const { error: deleteError } = await sb
    .from("restaurant_opening_hours")
    .delete()
    .eq("restaurant_id", restaurantId);
  if (deleteError) throw deleteError;

  const rows = normalizeOpeningHoursForStorage(openingHours);
  if (!rows || !rows.length) return;

  const { error: insertError } = await sb.from("restaurant_opening_hours").insert(
    rows.map((row) => ({ restaurant_id: restaurantId, ...row }))
  );
  if (insertError) throw insertError;
}

async function replaceRestaurantOffers(sb: any, restaurantId: string, offerInput: any[] | null | undefined) {
  if (offerInput === undefined) return;

  const { error: deleteError } = await sb
    .from("restaurant_offers")
    .delete()
    .eq("restaurant_id", restaurantId);
  if (deleteError) throw deleteError;

  if (!offerInput || !offerInput.length) return;

  const rows = offerInput
    .map((item) => normalizeLegacyOfferForStorage(item))
    .filter(Boolean)
    .map((offer) => ({
      restaurant_id: restaurantId,
      ...offer,
    }));

  if (!rows.length) return;

  const { error: insertError } = await sb.from("restaurant_offers").insert(rows);
  if (insertError) throw insertError;
}

// ✅ FIX: z.record(keySchema, valueSchema)
const OpeningHoursSchema = z.record(
  z.string(),
  z.object({
    open: z.string(),
    close: z.string(),
  })
);

function normalizeBookingTerms(value: unknown, preserveUndefined = false) {
  if (value === undefined) return preserveUndefined ? undefined : [];
  if (value === null) return null;

  const terms = Array.isArray(value) ? value : [value];
  return terms
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

const CreateBookingTermsSchema = z.preprocess(
  (value) => normalizeBookingTerms(value, false),
  z.array(z.string()).nullable()
);

const UpdateBookingTermsSchema = z.preprocess(
  (value) => normalizeBookingTerms(value, true),
  z.union([z.array(z.string()), z.null(), z.undefined()])
);

const OfferObjectSchema = z
  .object({
    text: z.string().trim().optional(),
    minimum_bill_amount: z.preprocess(
      (value) => {
        if (value === "" || value === undefined) return undefined;
        if (value === null) return null;
        if (typeof value === "number") return value;
        if (typeof value === "string") return Number(value);
        return value;
      },
      z.number().min(0).nullable().optional()
    ),
  })
  .passthrough();

const OfferInputSchema = z.union([z.string(), OfferObjectSchema, z.null()]);

function normalizeOfferMinimumBillAmount(value: any) {
  if (value === "" || value === undefined || value === null) return null;
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) return null;
  return amount;
}

function normalizeRestaurantOfferForWrite(offer: any) {
  if (offer === undefined) return undefined;
  if (offer === null) return null;

  if (Array.isArray(offer)) {
    return offer;
  }

  if (typeof offer === "string") {
    const text = offer.trim();
    return text ? text : null;
  }

  if (typeof offer === "object") {
    return offer;
  }

  return null;
}

function normalizeRestaurantOfferForResponse(offer: any) {
  if (offer === null || offer === undefined) return null;

  if (Array.isArray(offer)) {
    return offer;
  }

  if (typeof offer === "string") {
    const text = offer.trim();
    return text || null;
  }

  if (typeof offer === "object") {
    return offer;
  }

  return null;
}

function getOfferRowsFromBody(body: { offer?: any[] | null; offers?: any[] | null }) {
  if (Array.isArray(body.offers)) return body.offers;
  if (Array.isArray(body.offer)) return body.offer;
  if (body.offers === null) return null;
  if (body.offer === null) return null;
  return undefined;
}


function mapRestaurantForResponse(restaurant: any) {
  if (!restaurant || typeof restaurant !== "object") return restaurant;
  return {
    ...restaurant,
    offer: normalizeRestaurantOfferForResponse(restaurant.offer),
  };
}

function mapRestaurantsForResponse(restaurants: any[]) {
  return (restaurants ?? []).map((restaurant) => mapRestaurantForResponse(restaurant));
}

router.get("/picker", async (req, res) => {
  const parsed = PickerQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res
      .status(400)
      .json({ error: "Invalid query", details: parsed.error.flatten() });
  }

  const { search, city, area, status, owner_user_id, limit } = parsed.data;

  const caller = await getCallerInfoOptional(req);
  const isAdmin = isAdminRole(caller?.role);
  const isPartner = isPartnerRole(caller?.role);

  let query = supabase
    .from("restaurants")
    .select("id,name,city,area,cover_image,is_active,owner_user_id,created_at")
    .order("name", { ascending: true })
    .limit(limit);

  if (isPartner) {
    query = query.eq("owner_user_id", caller!.user.id);
  } else if (isAdmin && owner_user_id) {
    query = query.eq("owner_user_id", owner_user_id);
  }

  if (status === "active") query = query.eq("is_active", true);
  if (status === "inactive") query = query.eq("is_active", false);
  if (city) query = query.ilike("city", `%${city}%`);
  if (area) query = query.ilike("area", `%${area}%`);

  if (search) {
    const s = search.replace(/"/g, '\\"');
    query = query.or(
      [
        `name.ilike.%${s}%`,
        `city.ilike.%${s}%`,
        `area.ilike.%${s}%`,
        `slug.ilike.%${s}%`,
        `full_address.ilike.%${s}%`,
      ].join(",")
    );
  }

  const { data, error } = await withTimeout(
    query,
    LIST_QUERY_TIMEOUT_MS,
    "GET /api/restaurants/picker query"
  ) as any;

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  return res.json({
    items: (data ?? []).map((restaurant: any) => ({
      id: restaurant.id,
      name: restaurant.name,
      city: restaurant.city,
      area: restaurant.area,
      cover_image: restaurant.cover_image,
      is_active: restaurant.is_active,
      owner_user_id: restaurant.owner_user_id,
      created_at: restaurant.created_at,
    })),
  });
});
  
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
  offer: z.array(z.any()).optional().nullable(),
  offers: z.array(z.any()).optional().nullable(),

  facilities: z.array(z.string()).optional().default([]),
  highlights: z.array(z.string()).optional().default([]),
  worth_visit: z.array(z.string()).optional().default([]),
  mood_tags: z.array(z.string()).optional().default([]),
  is_pure_veg: z.boolean().optional().default(false),

  opening_hours: OpeningHoursSchema.optional().default({}),

  food_images: z.array(z.string()).optional().default([]),
  ambience_images: z.array(z.string()).optional().default([]),
  cover_image: z.string().optional().nullable(),

  is_active: z.boolean().optional().default(true),

  slug: z.string().trim().min(1),
  latitude: z.coerce.number().optional().nullable(),
  longitude: z.coerce.number().optional().nullable(),

  booking_enabled: z.boolean().optional().default(true),
  booking_terms: CreateBookingTermsSchema,
  avg_duration_minutes: z.coerce.number().int().optional().default(90),
  max_bookings_per_slot: z.coerce.number().int().optional().nullable(),
  advance_booking_days: z.coerce.number().int().optional().default(30),

  modification_available: z.boolean().optional().default(false),
  modification_cutoff_minutes: z.coerce.number().int().optional().nullable(),
  cancellation_available: z.boolean().optional().default(false),
  cancellation_cutoff_minutes: z.coerce.number().int().optional().nullable(),
  cover_charge_enabled: z.boolean().optional().default(false),
  cover_charge_amount: z.coerce.number().optional().nullable(),

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
  offer: z.array(z.any()).optional().nullable(),
  offers: z.array(z.any()).optional().nullable(),

  facilities: z.array(z.string()).optional(),
  highlights: z.array(z.string()).optional(),
  worth_visit: z.array(z.string()).optional(),
  mood_tags: z.array(z.string()).optional(),
  is_pure_veg: z.boolean().optional(),

  opening_hours: OpeningHoursSchema.nullable().optional(),

  food_images: z.array(z.string()).optional(),
  ambience_images: z.array(z.string()).optional(),
  cover_image: z.string().nullable().optional(),

  is_active: z.boolean().optional(),

  slug: z.string().trim().min(1).optional(),
  latitude: z.coerce.number().nullable().optional(),
  longitude: z.coerce.number().nullable().optional(),

  booking_enabled: z.boolean().optional(),
  booking_terms: UpdateBookingTermsSchema,
  avg_duration_minutes: z.coerce.number().int().optional(),
  max_bookings_per_slot: z.coerce.number().int().nullable().optional(),
  advance_booking_days: z.coerce.number().int().optional(),

  modification_available: z.boolean().optional(),
  modification_cutoff_minutes: z.coerce.number().int().nullable().optional(),
  cancellation_available: z.boolean().optional(),
  cancellation_cutoff_minutes: z.coerce.number().int().nullable().optional(),
  cover_charge_enabled: z.boolean().optional(),
  cover_charge_amount: z.coerce.number().nullable().optional(),

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

  let allowedRestaurantIds: string[] | null = null;
  if (mood_tag) {
    const { data: moodRows, error: moodError } = await supabase
      .from("restaurant_tags")
      .select("restaurant_id")
      .eq("tag_type", "mood")
      .eq("tag_value", mood_tag);
    if (moodError) return res.status(500).json({ error: moodError.message });
    allowedRestaurantIds = [...new Set((moodRows ?? []).map((row: any) => row.restaurant_id))];
    if (!allowedRestaurantIds.length) {
      return res.json({ items: [], page: { limit, offset, total: 0 } });
    }
  }

  let query = supabase.from("restaurants").select(RESTAURANT_BASE_SELECT);

  if (isPartner) {
    query = query.eq("owner_user_id", caller!.user.id);
  } else if (isAdmin && owner_user_id) {
    query = query.eq("owner_user_id", owner_user_id);
  }

  if (!includeInactive && !status) query = query.eq("is_active", true);
  if (status) query = query.eq("is_active", status === "active");
  if (city) query = query.ilike("city", `%${city}%`);
  if (area) query = query.ilike("area", `%${area}%`);
  if (typeof is_pure_veg === "boolean") query = query.eq("is_pure_veg", is_pure_veg);
  if (allowedRestaurantIds) query = query.in("id", allowedRestaurantIds);

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

  let baseRows: any[] = [];
  try {
    const { data: rows, error } = await withTimeout(
      query,
      LIST_QUERY_TIMEOUT_MS,
      "GET /api/restaurants query"
    ) as any;
    if (error) return res.status(500).json({ error: error.message });
    baseRows = rows ?? [];
  } catch (error: any) {
    const isTimeout = String(error?.message ?? "").includes("timed out");
    if (isTimeout) {
      console.error("[GET /api/restaurants] Timed out", {
        timeout_ms: LIST_QUERY_TIMEOUT_MS,
        offset, limit, sort, order,
      });
      return res.status(503).json({ error: "Request timed out. Please retry." });
    }
    return res.status(500).json({ error: error?.message ?? "Unexpected error" });
  }

  const hydratedRows = await hydrateRestaurants(baseRows);
  const sortedRows = [...hydratedRows].sort((a, b) => {
    const direction = order === "asc" ? 1 : -1;
    if (sort === "name") return direction * String(a.name ?? "").localeCompare(String(b.name ?? ""));
    if (sort === "rating") return direction * (Number(a.rating ?? 0) - Number(b.rating ?? 0));
    if (sort === "distance") return direction * (Number(a.distance ?? Number.MAX_SAFE_INTEGER) - Number(b.distance ?? Number.MAX_SAFE_INTEGER));
    const aCreatedAt = a.created_at ? new Date(a.created_at).getTime() : 0;
    const bCreatedAt = b.created_at ? new Date(b.created_at).getTime() : 0;
    return direction * (aCreatedAt - bCreatedAt);
  });

  const paginatedRows = sortedRows.slice(offset, offset + limit);

  return res.json({
    items: mapRestaurantsForResponse(paginatedRows),
    page: { limit, offset, total: sortedRows.length },
  });
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
    .select(RESTAURANT_BASE_SELECT)
    .eq("is_active", true)
    .eq("booking_enabled", true)
    .not("cover_image", "is", null)
    .order("created_at", { ascending: false });

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });

  const hydratedRows = await hydrateRestaurants(data ?? []);
  const items = hydratedRows.filter(
    (restaurant: any) =>
      normalizeCanonicalCity(restaurant.city) === normalizedCity &&
      typeof restaurant.cover_image === "string" &&
      restaurant.cover_image.trim() !== "" &&
      Number(restaurant.rating ?? 0) >= 4.2 &&
      Number(restaurant.total_ratings ?? 0) >= 50 &&
      restaurant.subscribed === true &&
      hasUsableOffer(restaurant.offer)
  )
  .sort(compareGrabYourDealRestaurants);

  return res.json({
    items: mapRestaurantsForResponse(items),
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
      .select(RESTAURANT_BASE_SELECT)
      .eq("is_active", true);

    const { data: allCandidateRows, error } = await baseQuery;
    if (error) {
      return res.status(500).json({ error: error.message });
    }

    const hydratedRows = await hydrateRestaurants(allCandidateRows ?? []);
    const allCandidates = hydratedRows.filter((restaurant: any) =>
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

    return res.json({ items: mapRestaurantsForResponse(items) });
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
      .select(RESTAURANT_BASE_SELECT)
      .eq("is_active", true);

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    const hydratedRows = await hydrateRestaurants(data ?? []);
    const allActiveRestaurants = dedupeRestaurantsById(hydratedRows ?? []);

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

    return res.json({ items: mapRestaurantsForResponse(items) });
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
      .select(RESTAURANT_BASE_SELECT)
      .eq("is_active", true);

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    const hydratedRows = await hydrateRestaurants(data ?? []);
    const eligibleRestaurants = dedupeRestaurantsById(
      (hydratedRows ?? []).filter((restaurant: any) => hasUsableVisualMedia(restaurant))
    );

    const normalizedArea = area?.trim().toLowerCase();
    const normalizedCity = normalizeCanonicalCity(city);

    const items = eligibleRestaurants
      .sort((a: any, b: any) =>
        compareFoodieFrontrowRestaurants(a, b, normalizedArea, normalizedCity)
      )
      .slice(0, limit);

    return res.json({ items: mapRestaurantsForResponse(items) });
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
    .select(RESTAURANT_BASE_SELECT)
    .eq("id", idParsed.data)
    .maybeSingle();

  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: "Restaurant not found" });

  const [hydrated] = await hydrateRestaurants([data]);
  return res.json({ item: mapRestaurantForResponse(hydrated) });
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
      cost_for_two: body.cost_for_two ?? null,
      is_pure_veg: body.is_pure_veg ?? false,
      cover_image: body.cover_image ?? null,

      is_active: body.is_active ?? true,

      slug: body.slug,
      latitude: body.latitude ?? null,
      longitude: body.longitude ?? null,

      booking_enabled: body.booking_enabled ?? true,
      booking_terms: body.booking_terms ?? null,
      avg_duration_minutes: body.avg_duration_minutes ?? 90,
      max_bookings_per_slot: body.max_bookings_per_slot ?? null,
      advance_booking_days: body.advance_booking_days ?? 30,

      modification_available: body.modification_available ?? false,
      modification_cutoff_minutes: body.modification_cutoff_minutes ?? null,
      cancellation_available: body.cancellation_available ?? false,
      cancellation_cutoff_minutes: body.cancellation_cutoff_minutes ?? null,
      cover_charge_enabled: body.cover_charge_enabled ?? false,
      cover_charge_amount: body.cover_charge_amount ?? null,

      owner_user_id: body.owner_user_id ?? null,
    })
    .select()
    .single();

  if (error) {
    if ((error as any)?.code === "23505") return res.status(400).json({ error: "Slug already exists" });
    return res.status(500).json({ error: error.message });
  }

  try {
    await replaceRestaurantTags(sb, data.id, {
      cuisines: body.cuisines ?? [],
      facilities: body.facilities ?? [],
      highlights: body.highlights ?? [],
      worth_visit: body.worth_visit ?? [],
      mood_tags: body.mood_tags ?? [],
    });
    await replaceRestaurantMedia(sb, data.id, {
      food_images: body.food_images ?? [],
      ambience_images: body.ambience_images ?? [],
    });
    await replaceRestaurantOpeningHours(sb, data.id, body.opening_hours ?? {});
    await replaceRestaurantOffers(sb, data.id, getOfferRowsFromBody(body) ?? []);
  } catch (relationError: any) {
    return res.status(500).json({ error: relationError.message });
  }

  const [hydrated] = await hydrateRestaurants([data]);
  return res.status(201).json({ restaurant: mapRestaurantForResponse(hydrated) });
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
  delete payload.cuisines;
  delete payload.facilities;
  delete payload.highlights;
  delete payload.worth_visit;
  delete payload.mood_tags;
  delete payload.food_images;
  delete payload.ambience_images;
  delete payload.opening_hours;
  delete payload.offer;
  delete payload.offers;
  delete payload.distance;

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

  try {
    await replaceRestaurantTags(access.sb, id, {
      cuisines: bodyParsed.data.cuisines,
      facilities: bodyParsed.data.facilities,
      highlights: bodyParsed.data.highlights,
      worth_visit: bodyParsed.data.worth_visit,
      mood_tags: bodyParsed.data.mood_tags,
    });
    await replaceRestaurantMedia(access.sb, id, {
      food_images: bodyParsed.data.food_images,
      ambience_images: bodyParsed.data.ambience_images,
    });
    await replaceRestaurantOpeningHours(access.sb, id, bodyParsed.data.opening_hours);
    await replaceRestaurantOffers(access.sb, id, getOfferRowsFromBody(bodyParsed.data));
  } catch (relationError: any) {
    return res.status(500).json({ error: relationError.message });
  }

  console.log("[PUT /restaurants/:id] Update successful:", { id });
  const [hydrated] = await hydrateRestaurants([data]);
  return res.json({ item: mapRestaurantForResponse(hydrated) });
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
    .select("id,is_active,cover_image")
    .eq("id", id)
    .maybeSingle();

  if (exists.error) return res.status(500).json({ error: exists.error.message });
  if (!exists.data) return res.status(404).json({ error: "Restaurant not found" });

  if (hard) {
    console.log("[DELETE /restaurants/:id] hard delete start", {
      restaurantId: id,
      callerId: access.callerId,
      callerRole: access.role,
    });

    const relationTables = [
      "restaurant_reviews",
      "restaurant_subscriptions",
      "restaurant_offers",
      "restaurant_opening_hours",
      "restaurant_media_assets",
      "restaurant_tags",
    ] as const;

    const relationCounts = await Promise.all(
      relationTables.map(async (table) => {
        const { count, error } = await supabase
          .from(table)
          .select("*", { count: "exact", head: true })
          .eq("restaurant_id", id);

        if (error) {
          throw new Error(`count ${table}: ${error.message}`);
        }

        return { table, count: count ?? 0 };
      })
    ).catch((error: any) => {
      console.error("[DELETE /restaurants/:id] relation count failed", {
        restaurantId: id,
        error: error?.message ?? String(error),
      });
      return null;
    });

    if (!relationCounts) {
      return res.status(500).json({ error: "Failed to inspect dependent restaurant data" });
    }

    const { data: storageRows, error: storageRowsError } = await supabase
      .from("restaurant_media_assets")
      .select("file_path,file_url")
      .eq("restaurant_id", id);

    if (storageRowsError) {
      console.error("[DELETE /restaurants/:id] media lookup failed", {
        restaurantId: id,
        error: storageRowsError.message,
      });
      return res.status(500).json({ error: `Failed to inspect restaurant media: ${storageRowsError.message}` });
    }

    const storagePaths = new Set<string>();
    for (const row of storageRows ?? []) {
      const fromPath = extractRestaurantStoragePath((row as any).file_path);
      const fromUrl = extractRestaurantStoragePath((row as any).file_url);
      if (fromPath) storagePaths.add(fromPath);
      if (fromUrl) storagePaths.add(fromUrl);
    }

    const coverPath = extractRestaurantStoragePath(exists.data.cover_image);
    if (coverPath) storagePaths.add(coverPath);

    console.log("[DELETE /restaurants/:id] related rows found", {
      restaurantId: id,
      relationCounts,
      storagePathCount: storagePaths.size,
    });

    if (storagePaths.size > 0) {
      const { error: storageDeleteError } = await supabase.storage
        .from("restaurant")
        .remove([...storagePaths]);

      if (storageDeleteError) {
        console.error("[DELETE /restaurants/:id] storage delete failed", {
          restaurantId: id,
          bucket: "restaurant",
          paths: [...storagePaths],
          error: storageDeleteError.message,
        });
        return res.status(500).json({
          error: `Failed to delete restaurant files from storage: ${storageDeleteError.message}`,
          failed_table: "storage.objects",
        });
      }

      console.log("[DELETE /restaurants/:id] storage delete succeeded", {
        restaurantId: id,
        bucket: "restaurant",
        deletedPaths: [...storagePaths],
      });
    }

    for (const table of relationTables) {
      const { error: relationDeleteError } = await supabase
        .from(table)
        .delete()
        .eq("restaurant_id", id);

      if (relationDeleteError) {
        console.error("[DELETE /restaurants/:id] relation delete failed", {
          restaurantId: id,
          failedTable: table,
          error: relationDeleteError.message,
        });
        return res.status(500).json({
          error: `Failed to delete ${table}: ${relationDeleteError.message}`,
          failed_table: table,
        });
      }

      console.log("[DELETE /restaurants/:id] relation delete succeeded", {
        restaurantId: id,
        table,
      });
    }

    const { error: restaurantDeleteError } = await supabase
      .from("restaurants")
      .delete()
      .eq("id", id);

    if (restaurantDeleteError) {
      console.error("[DELETE /restaurants/:id] restaurants delete failed", {
        restaurantId: id,
        failedTable: "restaurants",
        error: restaurantDeleteError.message,
      });
      return res.status(500).json({
        error: `Failed to delete restaurants row: ${restaurantDeleteError.message}`,
        failed_table: "restaurants",
      });
    }

    console.log("[DELETE /restaurants/:id] hard delete succeeded", {
      restaurantId: id,
      deleteOrder: ["storage.objects", ...relationTables, "restaurants"],
    });

    return res.json({
      ok: true,
      deleted: "hard",
      id,
      delete_order: ["storage.objects", ...relationTables, "restaurants"],
    });
  }

  const { error } = await access.sb
    .from("restaurants")
    .update({ is_active: false })
    .eq("id", id);

  if (error) return res.status(500).json({ error: error.message });

  return res.json({ ok: true, deleted: "soft", id });
});

export default router;
