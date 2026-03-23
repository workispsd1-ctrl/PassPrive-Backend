import { Router } from "express";
import { z } from "zod";
import { createClient } from "@supabase/supabase-js";
import supabase from "../../database/supabase";

const router = Router();
const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY!;

const SectionSlugSchema = z.object({
  slug: z.string().trim().min(1),
});

const SectionIdSchema = z.object({
  id: z.string().uuid(),
});

const SectionQuerySchema = z.object({
  city: z.string().trim().min(1).optional(),
  user_lat: z
    .string()
    .optional()
    .transform((v) => (v ? Number(v) : undefined))
    .refine((v) => v === undefined || Number.isFinite(v), "user_lat must be a number"),
  user_lng: z
    .string()
    .optional()
    .transform((v) => (v ? Number(v) : undefined))
    .refine((v) => v === undefined || Number.isFinite(v), "user_lng must be a number"),
  limit: z
    .string()
    .optional()
    .transform((v) => (v ? Number(v) : undefined))
    .refine((v) => v === undefined || (Number.isFinite(v) && v > 0 && v <= 100), "limit 1-100"),
});

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

function hasUsableStoreOffers(offers: any) {
  if (offers === null || offers === undefined) return false;
  if (typeof offers === "string") return offers.trim().length > 0;
  if (Array.isArray(offers)) return offers.length > 0;
  if (typeof offers === "object") return Object.keys(offers).length > 0;
  return true;
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

function toRadians(value: number) {
  return (value * Math.PI) / 180;
}

function calculateDistanceKm(
  userLat?: number,
  userLng?: number,
  storeLat?: number | null,
  storeLng?: number | null
) {
  if (
    userLat === undefined ||
    userLng === undefined ||
    storeLat === null ||
    storeLat === undefined ||
    storeLng === null ||
    storeLng === undefined
  ) {
    return null;
  }

  const earthRadiusKm = 6371;
  const dLat = toRadians(storeLat - userLat);
  const dLng = toRadians(storeLng - userLng);

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRadians(userLat)) *
      Math.cos(toRadians(storeLat)) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Number((earthRadiusKm * c).toFixed(2));
}

function compareSectionStores(a: any, b: any, normalizedCity?: string) {
  const aSameCity =
    normalizedCity &&
    normalizeCanonicalCity(a.city) === normalizedCity;
  const bSameCity =
    normalizedCity &&
    normalizeCanonicalCity(b.city) === normalizedCity;

  if (aSameCity !== bSameCity) {
    return aSameCity ? -1 : 1;
  }

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

  const aDistance = typeof a.distance_km === "number" ? a.distance_km : Number.POSITIVE_INFINITY;
  const bDistance = typeof b.distance_km === "number" ? b.distance_km : Number.POSITIVE_INFINITY;
  if (aDistance !== bDistance) {
    return aDistance - bDistance;
  }

  const aSortOrder = typeof a.sort_order === "number" ? a.sort_order : 0;
  const bSortOrder = typeof b.sort_order === "number" ? b.sort_order : 0;
  if (aSortOrder !== bSortOrder) {
    return aSortOrder - bSortOrder;
  }

  const aCreatedAt = a.created_at ? new Date(a.created_at).getTime() : 0;
  const bCreatedAt = b.created_at ? new Date(b.created_at).getTime() : 0;
  return bCreatedAt - aCreatedAt;
}

function compareSectionInventoryRows(a: any, b: any) {
  const aManual = a.source_type === "MANUAL";
  const bManual = b.source_type === "MANUAL";

  if (aManual !== bManual) {
    return aManual ? -1 : 1;
  }

  const aSortOrder = typeof a.sort_order === "number" ? a.sort_order : 0;
  const bSortOrder = typeof b.sort_order === "number" ? b.sort_order : 0;
  if (aSortOrder !== bSortOrder) {
    return aSortOrder - bSortOrder;
  }

  const aCreatedAt = a.created_at ? new Date(a.created_at).getTime() : 0;
  const bCreatedAt = b.created_at ? new Date(b.created_at).getTime() : 0;
  return bCreatedAt - aCreatedAt;
}

export type StoresHomeSyncSummary = {
  qualifying: number;
  inserted: number;
  reactivated: number;
  deactivated: number;
  skipped_manual: number;
};

export async function getStoresHomeSectionById(sectionId: string) {
  const { data, error } = await supabase
    .from("stores_home_sections")
    .select("id, slug, title, subtitle, max_items, starts_at, ends_at, is_active")
    .eq("id", sectionId)
    .maybeSingle();

  if (error) throw error;
  return data;
}

export async function getStoresHomeSectionBySlug(slug: string) {
  const { data, error } = await supabase
    .from("stores_home_sections")
    .select("id, slug, title, subtitle, max_items, starts_at, ends_at, is_active")
    .eq("slug", slug)
    .maybeSingle();

  if (error) throw error;
  return data;
}

export async function syncStoresHomeSectionItems(sectionId: string) {
  const section = await getStoresHomeSectionById(sectionId);
  if (!section) {
    throw new Error("Section not found");
  }

  const { data: existingItems, error: existingItemsError } = await supabase
    .from("stores_home_section_items")
    .select("id, section_id, store_id, source_type, sort_order, is_active, created_at")
    .eq("section_id", sectionId);

  if (existingItemsError) throw existingItemsError;

  const { data: qualifyingStores, error: qualifyingStoresError } = await supabase
    .from("stores")
    .select("id, sort_order, offers, is_active")
    .eq("is_active", true);

  if (qualifyingStoresError) throw qualifyingStoresError;

  const qualifyingStoreRows = (qualifyingStores ?? []).filter((store: any) =>
    hasUsableStoreOffers(store.offers)
  );

  const qualifyingStoreIds = new Set(
    qualifyingStoreRows.map((store: any) => store.id)
  );

  const existingByStoreId = new Map<string, any>(
    (existingItems ?? []).map((item: any) => [item.store_id, item])
  );

  const summary: StoresHomeSyncSummary = {
    qualifying: qualifyingStoreRows.length,
    inserted: 0,
    reactivated: 0,
    deactivated: 0,
    skipped_manual: 0,
  };

  const inserts = [];
  const autoReactivations = [];
  const autoSortUpdates = [];
  const autoDeactivations = [];

  for (const store of qualifyingStoreRows) {
    const existing = existingByStoreId.get(store.id);
    const nextSortOrder =
      typeof store.sort_order === "number" ? store.sort_order : 100;

    if (!existing) {
      inserts.push({
        section_id: sectionId,
        store_id: store.id,
        source_type: "AUTO",
        is_active: true,
        sort_order: nextSortOrder,
      });
      summary.inserted += 1;
      continue;
    }

    if (existing.source_type === "MANUAL") {
      summary.skipped_manual += 1;
      continue;
    }

    if (!existing.is_active) {
      autoReactivations.push({
        id: existing.id,
        sort_order: nextSortOrder,
      });
      summary.reactivated += 1;
      continue;
    }

    if (existing.sort_order !== nextSortOrder) {
      autoSortUpdates.push({
        id: existing.id,
        sort_order: nextSortOrder,
      });
    }
  }

  for (const item of existingItems ?? []) {
    if (item.source_type !== "AUTO") continue;
    if (!item.is_active) continue;
    if (qualifyingStoreIds.has(item.store_id)) continue;

    autoDeactivations.push(item.id);
    summary.deactivated += 1;
  }

  if (inserts.length > 0) {
    const { error } = await supabase
      .from("stores_home_section_items")
      .insert(inserts);

    if (error) throw error;
  }

  for (const item of autoReactivations) {
    const { error } = await supabase
      .from("stores_home_section_items")
      .update({
        is_active: true,
        sort_order: item.sort_order,
      })
      .eq("id", item.id);

    if (error) throw error;
  }

  for (const item of autoSortUpdates) {
    const { error } = await supabase
      .from("stores_home_section_items")
      .update({
        sort_order: item.sort_order,
      })
      .eq("id", item.id);

    if (error) throw error;
  }

  if (autoDeactivations.length > 0) {
    const { error } = await supabase
      .from("stores_home_section_items")
      .update({ is_active: false })
      .in("id", autoDeactivations);

    if (error) throw error;
  }

  return {
    section: {
      id: section.id,
      slug: section.slug,
    },
    summary,
  };
}

export async function syncAllStoresHomeSections() {
  const { data: sections, error } = await supabase
    .from("stores_home_sections")
    .select("id, slug")
    .eq("is_active", true);

  if (error) throw error;

  const results = [];

  for (const section of sections ?? []) {
    results.push(await syncStoresHomeSectionItems(section.id));
  }

  return results;
}

router.get("/sections/:slug", async (req, res) => {
  const slugParsed = SectionSlugSchema.safeParse(req.params);
  if (!slugParsed.success) {
    return res
      .status(400)
      .json({ error: "Invalid slug", details: slugParsed.error.flatten() });
  }

  const queryParsed = SectionQuerySchema.safeParse(req.query);
  if (!queryParsed.success) {
    return res
      .status(400)
      .json({ error: "Invalid query", details: queryParsed.error.flatten() });
  }

  try {
    const { slug } = slugParsed.data;
    const { city, user_lat, user_lng, limit } = queryParsed.data;
    const now = new Date();
    const normalizedCity = normalizeCanonicalCity(city);

    const { data: section, error: sectionError } = await supabase
      .from("stores_home_sections")
      .select("id, slug, title, subtitle, max_items, starts_at, ends_at, is_active")
      .eq("slug", slug)
      .eq("is_active", true)
      .maybeSingle();

    if (sectionError) {
      return res.status(500).json({ error: sectionError.message });
    }

    if (!section) {
      return res.status(404).json({ error: "Section not found" });
    }

    const startsAt = section.starts_at ? new Date(section.starts_at) : null;
    const endsAt = section.ends_at ? new Date(section.ends_at) : null;

    if ((startsAt && startsAt > now) || (endsAt && endsAt <= now)) {
      return res.status(404).json({ error: "Section not found" });
    }

    const { data: sectionItems, error: itemsError } = await supabase
      .from("stores_home_section_items")
      .select("id, section_id, store_id, source_type, sort_order, is_active, created_at")
      .eq("section_id", section.id)
      .eq("is_active", true);

    if (itemsError) {
      return res.status(500).json({ error: itemsError.message });
    }

    if (!sectionItems || sectionItems.length === 0) {
      return res.json({
        section: {
          id: section.id,
          slug: section.slug,
          title: section.title,
          subtitle: section.subtitle,
          max_items: section.max_items,
        },
        items: [],
      });
    }

    const preferredSectionItems = Array.from(
      new Map(
        [...sectionItems]
          .sort(compareSectionInventoryRows)
          .map((item) => [item.store_id, item])
      ).values()
    );

    const uniqueStoreIds = Array.from(new Set(preferredSectionItems.map((item) => item.store_id)));

    const { data: stores, error: storesError } = await supabase
      .from("stores")
      .select(
        [
          "id",
          "name",
          "description",
          "city",
          "location_name",
          "address_line1",
          "category",
          "subcategory",
          "tags",
          "cover_image_url",
          "cover_media_url",
          "logo_url",
          "offers",
          "is_featured",
          "is_active",
          "pickup_premium_enabled",
          "pickup_premium_started_at",
          "pickup_premium_expires_at",
          "is_advertised",
          "ad_badge_text",
          "ad_priority",
          "ad_starts_at",
          "ad_ends_at",
          "lat",
          "lng",
          "sort_order",
          "created_at",
        ].join(",")
      )
      .in("id", uniqueStoreIds)
      .eq("is_active", true);

    if (storesError) {
      return res.status(500).json({ error: storesError.message });
    }

    const storeRows = (stores ?? []) as any[];
    const storesById = new Map<string, any>(
      storeRows.map((store: any) => [store.id, store])
    );

    const rankedItems = preferredSectionItems
      .map((item) => {
        const store = storesById.get(item.store_id);
        if (!store) return null;
        if (!hasUsableStoreOffers(store.offers)) return null;

        return {
          id: store.id,
          name: store.name,
          description: store.description,
          city: store.city,
          location_name: store.location_name,
          address_line1: store.address_line1,
          category: store.category,
          subcategory: store.subcategory,
          tags: store.tags,
          cover_image_url: store.cover_image_url,
          cover_media_url: store.cover_media_url,
          logo_url: store.logo_url,
          offers: store.offers,
          is_featured: store.is_featured,
          pickup_premium_enabled: store.pickup_premium_enabled,
          pickup_premium_started_at: store.pickup_premium_started_at,
          pickup_premium_expires_at: store.pickup_premium_expires_at,
          is_advertised: store.is_advertised,
          ad_badge_text: store.ad_badge_text,
          ad_priority: store.ad_priority,
          ad_starts_at: store.ad_starts_at,
          ad_ends_at: store.ad_ends_at,
          lat: store.lat,
          lng: store.lng,
          distance_km: calculateDistanceKm(user_lat, user_lng, store.lat, store.lng),
          source_type: item.source_type,
          sort_order: item.sort_order,
          created_at: store.created_at,
        };
      })
      .filter(Boolean) as any[];

    const dedupedRankedItems = rankedItems.sort((a, b) =>
      compareSectionStores(a, b, normalizedCity)
    );

    const finalLimit = limit ?? section.max_items ?? 12;

    return res.json({
      section: {
        id: section.id,
        slug: section.slug,
        title: section.title,
        subtitle: section.subtitle,
        max_items: section.max_items,
      },
      items: dedupedRankedItems.slice(0, finalLimit),
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

export default router;
