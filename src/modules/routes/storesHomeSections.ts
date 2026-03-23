import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import supabase from "../../database/supabase";

const router = Router();
const upload = multer({ storage: multer.memoryStorage() });

function parseMetadataInput(value: any) {
  if (value === undefined) return undefined;
  if (typeof value === "object" && value !== null) return value;
  if (typeof value === "string" && value.trim() !== "") {
    try {
      return JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  return {};
}

function parseBooleanInput(value: any) {
  if (value === undefined) return undefined;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }
  return value;
}

const CreateSectionSchema = z.object({
  slug: z.string().trim().min(1),
  title: z.string().trim().min(1),
  subtitle: z.string().trim().nullable().optional(),
  is_active: z.preprocess(parseBooleanInput, z.boolean().optional()),
  starts_at: z.string().datetime().optional(),
  ends_at: z.string().datetime().nullable().optional(),
  max_items: z.coerce.number().int().positive().optional(),
  metadata: z.preprocess(parseMetadataInput, z.record(z.string(), z.any()).optional()),
  sync_items: z.preprocess(parseBooleanInput, z.boolean().optional()),
  thumbnail_url: z.string().trim().nullable().optional(),
});

const UpdateSectionSchema = z.object({
  slug: z.string().trim().min(1).optional(),
  title: z.string().trim().min(1).optional(),
  subtitle: z.string().trim().nullable().optional(),
  is_active: z.preprocess(parseBooleanInput, z.boolean().optional()),
  starts_at: z.string().datetime().optional(),
  ends_at: z.string().datetime().nullable().optional(),
  max_items: z.coerce.number().int().positive().optional(),
  metadata: z.preprocess(parseMetadataInput, z.record(z.string(), z.any()).optional()),
  sync_items: z.preprocess(parseBooleanInput, z.boolean().optional()),
  thumbnail_url: z.string().trim().nullable().optional(),
});

const SectionSlugSchema = z.object({
  slug: z.string().trim().min(1),
});

const SectionIdSchema = z.object({
  id: z.string().uuid(),
});

const SectionItemIdSchema = z.object({
  id: z.string().uuid(),
  itemId: z.string().uuid(),
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

const AddManualItemSchema = z.object({
  store_id: z.string().uuid(),
  sort_order: z.number().int().optional(),
  is_active: z.boolean().optional(),
});

const UpdateSectionItemSchema = z.object({
  store_id: z.string().uuid().optional(),
  sort_order: z.number().int().optional(),
  is_active: z.boolean().optional(),
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

async function uploadCampaignThumbnail(file: Express.Multer.File) {
  const fileExt = file.originalname.split(".").pop();
  const fileName = `campaign_${Date.now()}.${fileExt}`;

  const { error: uploadError } = await supabase.storage
    .from("store-campaign")
    .upload(fileName, file.buffer, {
      contentType: file.mimetype,
    });

  if (uploadError) throw uploadError;

  const publicUrl = supabase.storage
    .from("store-campaign")
    .getPublicUrl(fileName).data.publicUrl;

  return {
    thumbnail_url: publicUrl,
    thumbnail_path: fileName,
  };
}

export async function getStoresHomeSectionBySlug(slug: string) {
  const { data, error } = await supabase
    .from("stores_home_sections")
    .select("id, slug, title, subtitle, max_items, starts_at, ends_at, is_active, thumbnail_url")
    .eq("slug", slug)
    .eq("is_active", true)
    .maybeSingle();

  if (error) throw error;
  return data;
}

export async function getStoresHomeSectionById(id: string) {
  const { data, error } = await supabase
    .from("stores_home_sections")
    .select("id, slug, title, subtitle, max_items, starts_at, ends_at, is_active, metadata, thumbnail_url")
    .eq("id", id)
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

  let inserted = 0;
  let reactivated = 0;
  let deactivated = 0;
  let skipped_manual = 0;

  const inserts = [];
  const updates = [];
  const deactivateIds = [];

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

    deactivateIds.push(item.id);
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

  if (deactivateIds.length > 0) {
    const { error } = await supabase
      .from("stores_home_section_items")
      .update({ is_active: false })
      .in("id", deactivateIds);

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

router.post("/sections", upload.single("thumbnail"), async (req, res) => {
  const parsed = CreateSectionSchema.safeParse(req.body);
  if (!parsed.success) {
    return res
      .status(400)
      .json({ error: "Invalid body", details: parsed.error.flatten() });
  }

  try {
    const body = parsed.data;
    let metadata = body.metadata ?? {};
    let thumbnailUrl = body.thumbnail_url ?? null;

    if (req.file) {
      const uploadedThumbnail = await uploadCampaignThumbnail(req.file);
      thumbnailUrl = uploadedThumbnail.thumbnail_url;
      metadata = {
        ...metadata,
        thumbnail_path: uploadedThumbnail.thumbnail_path,
      };
    }

    const { data, error } = await supabase
      .from("stores_home_sections")
      .insert({
        slug: body.slug,
        title: body.title,
        subtitle: body.subtitle ?? null,
        is_active: body.is_active ?? true,
        starts_at: body.starts_at ?? new Date().toISOString(),
        ends_at: body.ends_at ?? null,
        max_items: body.max_items ?? 12,
        metadata,
        thumbnail_url: thumbnailUrl,
      })
      .select()
      .single();

    if (error) {
      if ((error as any)?.code === "23505") {
        return res.status(400).json({ error: "Slug already exists" });
      }
      throw error;
    }

    const syncResult =
      body.sync_items === false ? null : await syncStoresHomeSectionItems(data.id);

    return res.status(201).json({
      message: "Stores home section created successfully",
      section: data,
      ...(syncResult ? { sync_summary: syncResult.summary } : {}),
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

router.get("/sections", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("stores_home_sections")
      .select("*")
      .order("created_at", { ascending: false });

    if (error) throw error;

    return res.json({ sections: data ?? [] });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

router.put("/sections/:id", upload.single("thumbnail"), async (req, res) => {
  const paramsParsed = SectionIdSchema.safeParse(req.params);
  if (!paramsParsed.success) {
    return res
      .status(400)
      .json({ error: "Invalid section id", details: paramsParsed.error.flatten() });
  }

  const bodyParsed = UpdateSectionSchema.safeParse(req.body);
  if (!bodyParsed.success) {
    return res
      .status(400)
      .json({ error: "Invalid body", details: bodyParsed.error.flatten() });
  }

  const { sync_items, ...body } = bodyParsed.data;

  if (Object.keys(bodyParsed.data).length === 0) {
    return res.status(400).json({ error: "No fields to update" });
  }

  try {
    let updatePayload: any = { ...body };

    if (body.metadata !== undefined) {
      updatePayload.metadata = body.metadata;
    }

    if (req.file) {
      const currentSection = await getStoresHomeSectionById(paramsParsed.data.id);
      const existingMetadata = currentSection?.metadata ?? {};
      const uploadedThumbnail = await uploadCampaignThumbnail(req.file);

      updatePayload.thumbnail_url = uploadedThumbnail.thumbnail_url;
      updatePayload.metadata = {
        ...existingMetadata,
        ...(updatePayload.metadata ?? {}),
        thumbnail_path: uploadedThumbnail.thumbnail_path,
      };
    }

    const { data, error } = await supabase
      .from("stores_home_sections")
      .update(updatePayload)
      .eq("id", paramsParsed.data.id)
      .select()
      .single();

    if (error) {
      if ((error as any)?.code === "23505") {
        return res.status(400).json({ error: "Slug already exists" });
      }
      throw error;
    }

    const syncResult = sync_items ? await syncStoresHomeSectionItems(data.id) : null;

    return res.json({
      message: "Stores home section updated successfully",
      section: data,
      ...(syncResult ? { sync_summary: syncResult.summary } : {}),
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

router.get("/sections/:id/items", async (req, res) => {
  const paramsParsed = SectionIdSchema.safeParse(req.params);
  if (!paramsParsed.success) {
    return res
      .status(400)
      .json({ error: "Invalid section id", details: paramsParsed.error.flatten() });
  }

  try {
    const section = await getStoresHomeSectionById(paramsParsed.data.id);
    if (!section) {
      return res.status(404).json({ error: "Section not found" });
    }

    const { data, error } = await supabase
      .from("stores_home_section_items")
      .select("*")
      .eq("section_id", paramsParsed.data.id)
      .order("sort_order", { ascending: true })
      .order("created_at", { ascending: true });

    if (error) throw error;

    const storeIds = Array.from(
      new Set((data ?? []).map((item: any) => item.store_id))
    );

    let storesById = new Map<string, any>();

    if (storeIds.length > 0) {
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
        .in("id", storeIds);

      if (storesError) throw storesError;

      storesById = new Map<string, any>(
        ((stores ?? []) as any[]).map((store: any) => [store.id, store])
      );
    }

    const items = (data ?? []).map((item: any) => ({
      ...item,
      store: storesById.get(item.store_id) ?? null,
    }));

    return res.json({
      section: {
        id: section.id,
        slug: section.slug,
        title: section.title,
        subtitle: section.subtitle,
        max_items: section.max_items,
        thumbnail_url: section.thumbnail_url,
      },
      items,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

router.post("/sections/:id/items", async (req, res) => {
  const paramsParsed = SectionIdSchema.safeParse(req.params);
  if (!paramsParsed.success) {
    return res
      .status(400)
      .json({ error: "Invalid section id", details: paramsParsed.error.flatten() });
  }

  const bodyParsed = AddManualItemSchema.safeParse(req.body);
  if (!bodyParsed.success) {
    return res
      .status(400)
      .json({ error: "Invalid body", details: bodyParsed.error.flatten() });
  }

  try {
    const section = await getStoresHomeSectionById(paramsParsed.data.id);
    if (!section) {
      return res.status(404).json({ error: "Section not found" });
    }

    const { data: store, error: storeError } = await supabase
      .from("stores")
      .select("id")
      .eq("id", bodyParsed.data.store_id)
      .maybeSingle();

    if (storeError) throw storeError;
    if (!store) {
      return res.status(404).json({ error: "Store not found" });
    }

    const { data, error } = await supabase
      .from("stores_home_section_items")
      .upsert({
        section_id: paramsParsed.data.id,
        store_id: bodyParsed.data.store_id,
        source_type: "MANUAL",
        sort_order: bodyParsed.data.sort_order ?? 100,
        is_active: bodyParsed.data.is_active ?? true,
      }, { onConflict: "section_id,store_id" })
      .select()
      .single();

    if (error) throw error;

    return res.status(201).json({
      message: "Manual store added to section successfully",
      item: data,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

router.put("/sections/:id/items/:itemId", async (req, res) => {
  const paramsParsed = SectionItemIdSchema.safeParse(req.params);
  if (!paramsParsed.success) {
    return res
      .status(400)
      .json({ error: "Invalid params", details: paramsParsed.error.flatten() });
  }

  const bodyParsed = UpdateSectionItemSchema.safeParse(req.body);
  if (!bodyParsed.success) {
    return res
      .status(400)
      .json({ error: "Invalid body", details: bodyParsed.error.flatten() });
  }

  if (Object.keys(bodyParsed.data).length === 0) {
    return res.status(400).json({ error: "No fields to update" });
  }

  try {
    if (bodyParsed.data.store_id) {
      const { data: store, error: storeError } = await supabase
        .from("stores")
        .select("id")
        .eq("id", bodyParsed.data.store_id)
        .maybeSingle();

      if (storeError) throw storeError;
      if (!store) {
        return res.status(404).json({ error: "Store not found" });
      }
    }

    const { data, error } = await supabase
      .from("stores_home_section_items")
      .update(bodyParsed.data)
      .eq("section_id", paramsParsed.data.id)
      .eq("id", paramsParsed.data.itemId)
      .select()
      .single();

    if (error) throw error;

    return res.json({
      message: "Section item updated successfully",
      item: data,
    });
  } catch (err: any) {
    if ((err as any)?.code === "23505") {
      return res.status(400).json({ error: "This store already exists in the section" });
    }
    return res.status(500).json({ error: err.message });
  }
});

router.delete("/sections/:id/items/:itemId", async (req, res) => {
  const paramsParsed = SectionItemIdSchema.safeParse(req.params);
  if (!paramsParsed.success) {
    return res
      .status(400)
      .json({ error: "Invalid params", details: paramsParsed.error.flatten() });
  }

  try {
    const { error } = await supabase
      .from("stores_home_section_items")
      .update({ is_active: false })
      .eq("section_id", paramsParsed.data.id)
      .eq("id", paramsParsed.data.itemId);

    if (error) throw error;

    return res.json({ message: "Section item removed successfully" });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

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
          thumbnail_url: section.thumbnail_url,
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

    const finalLimit = queryParsed.data.limit ?? section.max_items ?? 12;
    const finalItems = joinedItems.slice(0, finalLimit);

    return res.json({
      section: {
        id: section.id,
        slug: section.slug,
        title: section.title,
        subtitle: section.subtitle,
        max_items: section.max_items,
        thumbnail_url: section.thumbnail_url,
      },
      items: finalItems,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

export default router;
