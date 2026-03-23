import { Router } from "express";
import { z } from "zod";
import supabase from "../../database/supabase";

const router = Router();

const SectionSlugSchema = z.object({
  slug: z.string().trim().min(1),
});

const SectionQuerySchema = z.object({
  limit: z
    .string()
    .optional()
    .transform((v) => (v ? Number(v) : undefined))
    .refine(
      (v) => v === undefined || (Number.isFinite(v) && v > 0 && v <= 500),
      "limit 1-500"
    ),
});

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

function extractStoreRating(store: any) {
  const metadata = store?.metadata ?? {};
  const candidates = [
    metadata?.rating,
    metadata?.avg_rating,
    metadata?.average_rating,
  ];

  for (const value of candidates) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }

  return 0;
}

function extractStoreRatingCount(store: any) {
  const metadata = store?.metadata ?? {};
  const candidates = [
    metadata?.total_ratings,
    metadata?.rating_count,
    metadata?.ratings_count,
    metadata?.review_count,
  ];

  for (const value of candidates) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }

  return 0;
}

function compareQualifiedStores(a: any, b: any) {
  const aAdvertised = isStoreAdvertisementActive(a);
  const bAdvertised = isStoreAdvertisementActive(b);

  if (aAdvertised !== bAdvertised) {
    return aAdvertised ? -1 : 1;
  }

  const aPremium = isStorePremiumActive(a);
  const bPremium = isStorePremiumActive(b);

  if (aPremium !== bPremium) {
    return aPremium ? -1 : 1;
  }

  const aRating = extractStoreRating(a);
  const bRating = extractStoreRating(b);
  if (aRating !== bRating) {
    return bRating - aRating;
  }

  const aRatingCount = extractStoreRatingCount(a);
  const bRatingCount = extractStoreRatingCount(b);
  if (aRatingCount !== bRatingCount) {
    return bRatingCount - aRatingCount;
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

export async function getStoresHomeSectionBySlug(slug: string) {
  const { data, error } = await supabase
    .from("stores_home_sections")
    .select("id, slug, title, subtitle, max_items, starts_at, ends_at, is_active")
    .eq("slug", slug)
    .eq("is_active", true)
    .maybeSingle();

  if (error) throw error;
  return data;
}

export async function syncStoresHomeSectionItems(sectionId: string) {
  const { data: section, error: sectionError } = await supabase
    .from("stores_home_sections")
    .select("id, slug")
    .eq("id", sectionId)
    .maybeSingle();

  if (sectionError) throw sectionError;
  if (!section) throw new Error("Section not found");

  const { data: existingItems, error: existingItemsError } = await supabase
    .from("stores_home_section_items")
    .select("id, section_id, store_id, source_type, sort_order, is_active")
    .eq("section_id", sectionId);

  if (existingItemsError) throw existingItemsError;

  const { data: stores, error: storesError } = await supabase
    .from("stores")
    .select(
      [
        "id",
        "is_active",
        "offers",
        "is_advertised",
        "ad_priority",
        "ad_starts_at",
        "ad_ends_at",
        "pickup_premium_enabled",
        "pickup_premium_started_at",
        "pickup_premium_expires_at",
        "city",
        "category",
        "subcategory",
        "tags",
        "sort_order",
        "metadata",
        "created_at",
      ].join(",")
    )
    .eq("is_active", true);

  if (storesError) throw storesError;

  const storeRows = (stores ?? []) as any[];

  const qualifyingStores = storeRows
    .filter((store: any) => hasUsableStoreOffers(store.offers))
    .sort(compareQualifiedStores);

  const rankedStoreIds = new Set(qualifyingStores.map((store: any) => store.id));
  const existingByStoreId = new Map<string, any>(
    (existingItems ?? []).map((item: any) => [item.store_id, item])
  );

  const inserts = [];
  const updates = [];
  const deactivations = [];

  let inserted = 0;
  let reactivated = 0;
  let deactivated = 0;
  let skipped_manual = 0;

  for (const [index, store] of qualifyingStores.entries()) {
    const existing = existingByStoreId.get(store.id);
    const nextSortOrder = index + 1;

    if (!existing) {
      inserts.push({
        section_id: sectionId,
        store_id: store.id,
        source_type: "AUTO",
        sort_order: nextSortOrder,
        is_active: true,
      });
      inserted += 1;
      continue;
    }

    if (existing.source_type === "MANUAL") {
      skipped_manual += 1;
      continue;
    }

    updates.push({
      id: existing.id,
      sort_order: nextSortOrder,
      is_active: true,
    });

    if (!existing.is_active) {
      reactivated += 1;
    }
  }

  for (const item of existingItems ?? []) {
    if (item.source_type !== "AUTO") continue;
    if (!item.is_active) continue;
    if (rankedStoreIds.has(item.store_id)) continue;

    deactivations.push(item.id);
    deactivated += 1;
  }

  if (inserts.length > 0) {
    const { error } = await supabase
      .from("stores_home_section_items")
      .insert(inserts);

    if (error) throw error;
  }

  for (const update of updates) {
    const { error } = await supabase
      .from("stores_home_section_items")
      .update({
        sort_order: update.sort_order,
        is_active: update.is_active,
      })
      .eq("id", update.id);

    if (error) throw error;
  }

  if (deactivations.length > 0) {
    const { error } = await supabase
      .from("stores_home_section_items")
      .update({ is_active: false })
      .in("id", deactivations);

    if (error) throw error;
  }

  return {
    section: {
      id: section.id,
      slug: section.slug,
    },
    summary: {
      qualifying: qualifyingStores.length,
      inserted,
      reactivated,
      deactivated,
      skipped_manual,
    },
  };
}

export async function syncStoresHomeSectionItemsBySlug(slug: string) {
  const section = await getStoresHomeSectionBySlug(slug);
  if (!section) throw new Error("Section not found");
  return syncStoresHomeSectionItems(section.id);
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
    const section = await getStoresHomeSectionBySlug(slugParsed.data.slug);
    if (!section) {
      return res.status(404).json({ error: "Section not found" });
    }

    const now = new Date();
    const startsAt = section.starts_at ? new Date(section.starts_at) : null;
    const endsAt = section.ends_at ? new Date(section.ends_at) : null;

    if ((startsAt && startsAt > now) || (endsAt && endsAt <= now)) {
      return res.status(404).json({ error: "Section not found" });
    }

    const { data: sectionItems, error: sectionItemsError } = await supabase
      .from("stores_home_section_items")
      .select("id, section_id, store_id, source_type, sort_order, is_active, created_at")
      .eq("section_id", section.id)
      .eq("is_active", true)
      .order("sort_order", { ascending: true })
      .order("created_at", { ascending: true });

    if (sectionItemsError) {
      return res.status(500).json({ error: sectionItemsError.message });
    }

    const storeIds = Array.from(
      new Set((sectionItems ?? []).map((item: any) => item.store_id))
    );

    if (storeIds.length === 0) {
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
      .in("id", storeIds)
      .eq("is_active", true);

    if (storesError) {
      return res.status(500).json({ error: storesError.message });
    }

    const storesById = new Map<string, any>(
      ((stores ?? []) as any[]).map((store: any) => [store.id, store])
    );

    const joinedItems = (sectionItems ?? [])
      .map((item: any) => {
        const store = storesById.get(item.store_id);
        if (!store) return null;

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
          source_type: item.source_type,
          sort_order: item.sort_order,
          created_at: store.created_at,
        };
      })
      .filter(Boolean) as any[];

    const finalItems =
      queryParsed.data.limit !== undefined
        ? joinedItems.slice(0, queryParsed.data.limit)
        : joinedItems;

    return res.json({
      section: {
        id: section.id,
        slug: section.slug,
        title: section.title,
        subtitle: section.subtitle,
        max_items: section.max_items,
      },
      items: finalItems,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

export default router;
