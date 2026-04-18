import { Router } from "express";
import { z } from "zod";
import supabase from "../../database/supabase";
import {
  hydrateRestaurantPreviewRows,
  RESTAURANT_PREVIEW_SELECT,
} from "../services/restaurantShape";
import {
  hydrateStorePreviewRows,
  STORE_PREVIEW_SELECT,
} from "../services/storeShape";

const router = Router();

const QuerySchema = z.object({
  city: z.string().trim().min(1).optional(),
  lat: z
    .string()
    .optional()
    .transform((value) => (value ? Number(value) : null))
    .refine((value) => value === null || Number.isFinite(value), "lat must be numeric"),
  lng: z
    .string()
    .optional()
    .transform((value) => (value ? Number(value) : null))
    .refine((value) => value === null || Number.isFinite(value), "lng must be numeric"),
  limit: z
    .string()
    .optional()
    .transform((value) => (value ? Number(value) : 8))
    .refine((value) => Number.isFinite(value) && value > 0 && value <= 50, "limit 1-50"),
  includeInactive: z
    .string()
    .optional()
    .transform((value) => value === "true"),
});

const FALLBACK_STORE_IMAGE =
  "https://images.unsplash.com/photo-1523381210434-271e8be1f52b?auto=format&fit=crop&w=1200&q=80";
const FALLBACK_RESTAURANT_IMAGE =
  "https://images.unsplash.com/photo-1517248135467-4c7edcad34c4?auto=format&fit=crop&w=1200&q=80";

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function toNumberOrNull(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeCity(value?: string | null) {
  const normalized = String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
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

function isSameCity(left?: string | null, right?: string | null) {
  const leftCity = normalizeCity(left);
  const rightCity = normalizeCity(right);
  return Boolean(leftCity && rightCity && leftCity === rightCity);
}

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number) {
  const toRad = (degrees: number) => (degrees * Math.PI) / 180;
  const earthRadiusKm = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);
  return earthRadiusKm * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

function getDistanceKm(row: any, lat: number | null, lng: number | null) {
  if (lat === null || lng === null) return null;

  const entityLat = toNumberOrNull(row?.lat ?? row?.latitude);
  const entityLng = toNumberOrNull(row?.lng ?? row?.longitude);
  if (entityLat === null || entityLng === null) return null;

  return haversineKm(lat, lng, entityLat, entityLng);
}

function isAdvertisementActive(row: any, now = new Date()) {
  if (!row?.is_advertised) return false;

  const startsAt = row.ad_starts_at ? new Date(row.ad_starts_at) : null;
  const endsAt = row.ad_ends_at ? new Date(row.ad_ends_at) : null;

  if (startsAt && startsAt > now) return false;
  if (endsAt && endsAt < now) return false;
  return true;
}

function getStoreImage(row: any) {
  return (
    row?.cover_media_url ||
    row?.cover_image_url ||
    (Array.isArray(row?.gallery_urls) ? row.gallery_urls.find(Boolean) : null) ||
    row?.logo_url ||
    FALLBACK_STORE_IMAGE
  );
}

function getRestaurantImage(row: any) {
  const candidates = [
    row?.cover_image,
    ...(Array.isArray(row?.ambience_images) ? row.ambience_images : []),
    ...(Array.isArray(row?.food_images) ? row.food_images : []),
  ].filter(Boolean);

  return candidates[0] || FALLBACK_RESTAURANT_IMAGE;
}

function getCreatedAtBoost(row: any) {
  const createdAt = row?.created_at ? new Date(row.created_at).getTime() : 0;
  if (!createdAt) return 0;

  const ageDays = Math.max(0, (Date.now() - createdAt) / (24 * 60 * 60 * 1000));
  return clamp(30 - ageDays, 0, 30);
}

function normalizeRestaurant(row: any, lat: number | null, lng: number | null, analytics?: any) {
  const distanceKm = getDistanceKm(row, lat, lng);
  const rating = toNumberOrNull(row?.rating) ?? 0;
  const popularity = toNumberOrNull(row?.total_ratings) ?? 0;
  const distanceBoost = distanceKm !== null ? clamp(45 - distanceKm * 2.5, 0, 45) : 0;
  const hasOffer = Array.isArray(row?.offers) && row.offers.length > 0;
  const isPremium =
    row?.subscribed === true ||
    row?.premium_unlock_all === true ||
    row?.premium_time_slot_enabled === true ||
    row?.premium_repeat_rewards_enabled === true ||
    row?.premium_dish_discounts_enabled === true;
  const behavioralScore = toNumberOrNull(analytics?.trend_score);
  const fallbackScore =
    rating * 24 +
    Math.min(popularity, 2000) / 22 +
    distanceBoost +
    getCreatedAtBoost(row) +
    (hasOffer ? 12 : 0) +
    (isPremium ? 10 : 0) +
    (isAdvertisementActive(row) ? 15 : 0);

  return {
    id: `restaurant-${row.id}`,
    entityId: row.id,
    entityType: "RESTAURANT",
    name: row?.name || "Restaurant",
    subtitle:
      row?.offers?.[0]?.title ||
      row?.offers?.[0]?.badge_text ||
      row?.cuisines?.[0] ||
      row?.area ||
      "Trending dining pick",
    image: getRestaurantImage(row),
    rating,
    popularity,
    distanceKm,
    tags: Array.isArray(row?.cuisines) ? row.cuisines.filter(Boolean).slice(0, 4) : [],
    isAdvertised: isAdvertisementActive(row),
    adBadgeText: row?.ad_badge_text || "Ad",
    isPremium,
    trendScore: behavioralScore ?? 0,
    scoreSource: behavioralScore !== null ? "behavioral" : "cold_start",
    scoreComponents: analytics?.score_components ?? {},
    analytics: analytics
      ? {
          score_24h: analytics.score_24h,
          score_7d: analytics.score_7d,
          score_30d: analytics.score_30d,
          impressions_7d: analytics.impressions_7d,
          detail_views_7d: analytics.detail_views_7d,
          clicks_7d: analytics.clicks_7d,
          saves_7d: analytics.saves_7d,
          conversions_7d: analytics.conversions_7d,
          offer_redemptions_7d: analytics.offer_redemptions_7d,
        }
      : null,
    raw: row,
    score: behavioralScore !== null ? behavioralScore + fallbackScore * 0.15 : fallbackScore,
  };
}

function normalizeStore(row: any, lat: number | null, lng: number | null, analytics?: any) {
  const distanceKm = getDistanceKm(row, lat, lng);
  const rating =
    toNumberOrNull(row?.rating) ??
    toNumberOrNull(row?.metadata?.rating) ??
    toNumberOrNull(row?.metadata?.avg_rating) ??
    0;
  const popularity =
    toNumberOrNull(row?.total_ratings) ??
    toNumberOrNull(row?.metadata?.total_ratings) ??
    toNumberOrNull(row?.metadata?.rating_count) ??
    0;
  const distanceBoost = distanceKm !== null ? clamp(45 - distanceKm * 2.5, 0, 45) : 0;
  const hasOffer = Array.isArray(row?.offers) && row.offers.length > 0;
  const isPremium = row?.pickup_premium_enabled === true;
  const behavioralScore = toNumberOrNull(analytics?.trend_score);
  const fallbackScore =
    rating * 24 +
    Math.min(popularity, 2000) / 22 +
    distanceBoost +
    getCreatedAtBoost(row) +
    (hasOffer ? 12 : 0) +
    (isPremium ? 10 : 0) +
    (isAdvertisementActive(row) ? 15 : 0);

  return {
    id: `store-${row.id}`,
    entityId: row.id,
    entityType: "STORE",
    name: row?.name || "Store",
    subtitle:
      row?.description ||
      row?.subcategory ||
      row?.category ||
      row?.location_name ||
      "Trending store near you",
    image: getStoreImage(row),
    rating,
    popularity,
    distanceKm,
    tags: Array.isArray(row?.tags)
      ? row.tags.filter(Boolean).slice(0, 4)
      : [row?.subcategory, row?.category].filter(Boolean).slice(0, 4),
    isAdvertised: isAdvertisementActive(row),
    adBadgeText: row?.ad_badge_text || "Ad",
    isPremium,
    trendScore: behavioralScore ?? 0,
    scoreSource: behavioralScore !== null ? "behavioral" : "cold_start",
    scoreComponents: analytics?.score_components ?? {},
    analytics: analytics
      ? {
          score_24h: analytics.score_24h,
          score_7d: analytics.score_7d,
          score_30d: analytics.score_30d,
          impressions_7d: analytics.impressions_7d,
          detail_views_7d: analytics.detail_views_7d,
          clicks_7d: analytics.clicks_7d,
          saves_7d: analytics.saves_7d,
          conversions_7d: analytics.conversions_7d,
          offer_redemptions_7d: analytics.offer_redemptions_7d,
        }
      : null,
    raw: row,
    score: behavioralScore !== null ? behavioralScore + fallbackScore * 0.15 : fallbackScore,
  };
}

function compareTrendingItems(a: any, b: any, city?: string | null) {
  const aSameCity = isSameCity(a?.raw?.city, city) ? 1 : 0;
  const bSameCity = isSameCity(b?.raw?.city, city) ? 1 : 0;
  if (aSameCity !== bSameCity) return bSameCity - aSameCity;

  const aAd = a?.isAdvertised ? 1 : 0;
  const bAd = b?.isAdvertised ? 1 : 0;
  if (aAd !== bAd) return bAd - aAd;

  if (aAd && bAd) {
    const aPriority = toNumberOrNull(a?.raw?.ad_priority) ?? 100;
    const bPriority = toNumberOrNull(b?.raw?.ad_priority) ?? 100;
    if (aPriority !== bPriority) return aPriority - bPriority;
  }

  const aPremium = a?.isPremium ? 1 : 0;
  const bPremium = b?.isPremium ? 1 : 0;
  if (aPremium !== bPremium) return bPremium - aPremium;

  if (a.score !== b.score) return b.score - a.score;

  const aDistance = toNumberOrNull(a?.distanceKm);
  const bDistance = toNumberOrNull(b?.distanceKm);
  if (aDistance !== null && bDistance !== null && aDistance !== bDistance) return aDistance - bDistance;
  if (aDistance !== null && bDistance === null) return -1;
  if (aDistance === null && bDistance !== null) return 1;

  if (a.rating !== b.rating) return b.rating - a.rating;
  if (a.popularity !== b.popularity) return b.popularity - a.popularity;

  return String(a?.name || "").localeCompare(String(b?.name || ""));
}

router.get("/", async (req, res) => {
  const parsed = QuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid query", details: parsed.error.flatten() });
  }

  const { city, lat, lng, limit, includeInactive } = parsed.data;
  const scanLimit = Math.min(Math.max(limit * 8, 60), 200);

  try {
    const { data: refreshedScores, error: refreshError } = await supabase.rpc(
      "refresh_entity_trending_scores"
    );
    if (refreshError && String(refreshError.message || "").trim()) {
      console.warn("[GET /api/now-trending] score refresh skipped", {
        message: refreshError.message,
      });
    }

    const scoresResult = await supabase
      .from("entity_trending_scores")
      .select("*")
      .order("trend_score", { ascending: false })
      .limit(scanLimit * 2);

    if (scoresResult.error) return res.status(500).json({ error: scoresResult.error.message });

    const scoreRows = Array.isArray(scoresResult.data) ? scoresResult.data : [];
    const scoreByEntityKey = new Map(
      scoreRows.map((row: any) => [`${row.entity_type}:${row.entity_id}`, row])
    );
    const scoredStoreIds = scoreRows
      .filter((row: any) => row.entity_type === "STORE")
      .map((row: any) => row.entity_id)
      .filter(Boolean);
    const scoredRestaurantIds = scoreRows
      .filter((row: any) => row.entity_type === "RESTAURANT")
      .map((row: any) => row.entity_id)
      .filter(Boolean);

    let storeQuery = supabase.from("stores").select(STORE_PREVIEW_SELECT);
    let restaurantQuery = supabase.from("restaurants").select(RESTAURANT_PREVIEW_SELECT);

    if (!includeInactive) {
      storeQuery = storeQuery.eq("is_active", true);
      restaurantQuery = restaurantQuery.eq("is_active", true);
    }

    if (scoredStoreIds.length) {
      storeQuery = storeQuery.in("id", Array.from(new Set(scoredStoreIds)));
    } else {
      storeQuery = storeQuery
        .order("is_advertised", { ascending: false })
        .order("ad_priority", { ascending: true, nullsFirst: false })
        .order("created_at", { ascending: false })
        .limit(scanLimit);
    }

    if (scoredRestaurantIds.length) {
      restaurantQuery = restaurantQuery.in("id", Array.from(new Set(scoredRestaurantIds)));
    } else {
      restaurantQuery = restaurantQuery
        .order("is_advertised", { ascending: false })
        .order("ad_priority", { ascending: true, nullsFirst: false })
        .order("created_at", { ascending: false })
        .limit(scanLimit);
    }

    let [storeResult, restaurantResult] = await Promise.all([storeQuery, restaurantQuery]);

    if (storeResult.error) return res.status(500).json({ error: storeResult.error.message });
    if (restaurantResult.error) return res.status(500).json({ error: restaurantResult.error.message });

    if ((storeResult.data ?? []).length + (restaurantResult.data ?? []).length < limit) {
      const [fallbackStores, fallbackRestaurants] = await Promise.all([
        supabase
          .from("stores")
          .select(STORE_PREVIEW_SELECT)
          .eq("is_active", true)
          .order("is_advertised", { ascending: false })
          .order("ad_priority", { ascending: true, nullsFirst: false })
          .order("created_at", { ascending: false })
          .limit(scanLimit),
        supabase
          .from("restaurants")
          .select(RESTAURANT_PREVIEW_SELECT)
          .eq("is_active", true)
          .order("is_advertised", { ascending: false })
          .order("ad_priority", { ascending: true, nullsFirst: false })
          .order("created_at", { ascending: false })
          .limit(scanLimit),
      ]);

      if (!fallbackStores.error && fallbackStores.data) {
        const existingIds = new Set((storeResult.data ?? []).map((row: any) => row.id));
        storeResult = {
          ...storeResult,
          data: [
            ...(storeResult.data ?? []),
            ...fallbackStores.data.filter((row: any) => !existingIds.has(row.id)),
          ],
        } as any;
      }
      if (!fallbackRestaurants.error && fallbackRestaurants.data) {
        const existingIds = new Set((restaurantResult.data ?? []).map((row: any) => row.id));
        restaurantResult = {
          ...restaurantResult,
          data: [
            ...(restaurantResult.data ?? []),
            ...fallbackRestaurants.data.filter((row: any) => !existingIds.has(row.id)),
          ],
        } as any;
      }
    }

    const [stores, restaurants] = await Promise.all([
      hydrateStorePreviewRows(storeResult.data ?? []),
      hydrateRestaurantPreviewRows(restaurantResult.data ?? []),
    ]);

    const items = [
      ...stores.map((store: any) =>
        normalizeStore(store, lat, lng, scoreByEntityKey.get(`STORE:${store.id}`))
      ),
      ...restaurants.map((restaurant: any) =>
        normalizeRestaurant(restaurant, lat, lng, scoreByEntityKey.get(`RESTAURANT:${restaurant.id}`))
      ),
    ]
      .sort((a, b) => compareTrendingItems(a, b, city))
      .slice(0, limit);

    return res.json({
      items,
      page: {
        limit,
        offset: 0,
        total: items.length,
      },
      meta: {
        scoring: "behavioral_time_decay_with_cold_start_fallback",
        refreshed_scores: refreshedScores ?? null,
      },
    });
  } catch (error: any) {
    return res.status(500).json({ error: error?.message ?? "Failed to load now trending" });
  }
});

export default router;
