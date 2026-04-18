import { Router } from "express";
import { z } from "zod";
import supabase from "../../database/supabase";
import {
  hydrateRestaurantPreviewRows,
  RESTAURANT_PREVIEW_SELECT,
} from "../services/restaurantShape";
import { hydrateStoreRows, STORE_BASE_SELECT } from "../services/storeShape";

const router = Router();

const COLLECTIONS_TABLE = "editorial_collections";
const ITEMS_TABLE = "editorial_collection_items";

const ListQuerySchema = z.object({
  city: z.string().trim().min(1).optional(),
  area: z.string().trim().min(1).optional(),
  limit: z
    .string()
    .optional()
    .transform((value) => (value ? Number(value) : 20))
    .refine((value) => Number.isFinite(value) && value > 0 && value <= 100, "limit 1-100"),
  includeItems: z
    .string()
    .optional()
    .transform((value) => value !== "false"),
});

function lower(value?: string | null) {
  return String(value || "").trim().toLowerCase();
}

function matchesLocation(collection: any, city?: string, area?: string) {
  if (!city && !area) return true;

  const collectionCity = lower(collection?.city);
  const collectionArea = lower(collection?.area);
  const cityNeedle = lower(city);
  const areaNeedle = lower(area);

  if (cityNeedle && collectionCity && collectionCity !== cityNeedle) return false;
  if (areaNeedle && collectionArea && collectionArea !== areaNeedle) return false;
  return true;
}

async function getActiveCollections() {
  const nowIso = new Date().toISOString();
  const { data, error } = await supabase
    .from(COLLECTIONS_TABLE)
    .select("*")
    .eq("is_active", true)
    .lte("starts_at", nowIso)
    .or(`ends_at.is.null,ends_at.gt.${nowIso}`)
    .order("is_featured", { ascending: false })
    .order("sort_order", { ascending: true })
    .order("created_at", { ascending: true });

  if (error) throw error;
  return data ?? [];
}

async function getActiveItemsByCollectionIds(collectionIds: string[]) {
  if (!collectionIds.length) return [];

  const { data, error } = await supabase
    .from(ITEMS_TABLE)
    .select("*")
    .in("collection_id", collectionIds)
    .eq("is_active", true)
    .order("sort_order", { ascending: true })
    .order("created_at", { ascending: true });

  if (error) throw error;
  return data ?? [];
}

async function hydrateEditorialEntities(items: any[]) {
  const storeIds = Array.from(new Set(items.map((item) => item?.store_id).filter(Boolean)));
  const restaurantIds = Array.from(
    new Set(items.map((item) => item?.restaurant_id).filter(Boolean))
  );

  let storesById = new Map<string, any>();
  let restaurantsById = new Map<string, any>();

  if (storeIds.length) {
    const { data: stores, error } = await supabase
      .from("stores")
      .select(STORE_BASE_SELECT)
      .in("id", storeIds)
      .eq("is_active", true);
    if (error) throw error;

    const hydratedStores = await hydrateStoreRows(stores ?? []);
    storesById = new Map(hydratedStores.map((store) => [store.id, store]));
  }

  if (restaurantIds.length) {
    const { data: restaurants, error } = await supabase
      .from("restaurants")
      .select(RESTAURANT_PREVIEW_SELECT)
      .in("id", restaurantIds)
      .eq("is_active", true);
    if (error) throw error;

    const hydratedRestaurants = await hydrateRestaurantPreviewRows(restaurants ?? []);
    restaurantsById = new Map(hydratedRestaurants.map((restaurant) => [restaurant.id, restaurant]));
  }

  return items
    .map((item) => {
      const store = item?.store_id ? storesById.get(item.store_id) ?? null : null;
      const restaurant = item?.restaurant_id
        ? restaurantsById.get(item.restaurant_id) ?? null
        : null;

      return {
        ...item,
        entity_type: store ? "STORE" : "RESTAURANT",
        entity: store ?? restaurant,
        store,
        restaurant,
      };
    })
    .filter((item) => Boolean(item.entity));
}

router.get("/", async (req, res) => {
  const parsed = ListQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid query", details: parsed.error.flatten() });
  }

  const { city, area, limit, includeItems } = parsed.data;

  try {
    const collections = (await getActiveCollections())
      .filter((collection) => matchesLocation(collection, city, area))
      .slice(0, limit);

    if (!includeItems || !collections.length) {
      return res.json({
        collections: collections.map((collection) => ({ ...collection, items: [] })),
      });
    }

    const collectionIds = collections.map((collection) => collection.id);
    const activeItems = await getActiveItemsByCollectionIds(collectionIds);
    const hydratedItems = await hydrateEditorialEntities(activeItems);

    const itemsByCollectionId = new Map<string, any[]>();
    for (const item of hydratedItems) {
      const bucket = itemsByCollectionId.get(item.collection_id) ?? [];
      bucket.push(item);
      itemsByCollectionId.set(item.collection_id, bucket);
    }

    return res.json({
      collections: collections.map((collection) => ({
        ...collection,
        items: itemsByCollectionId.get(collection.id) ?? [],
      })),
    });
  } catch (error: any) {
    return res.status(500).json({ error: error?.message ?? "Failed to load editorials" });
  }
});

router.get("/:slug", async (req, res) => {
  const slug = String(req.params.slug || "").trim();
  if (!slug) return res.status(400).json({ error: "Invalid slug" });

  try {
    const nowIso = new Date().toISOString();
    const { data: collection, error: collectionError } = await supabase
      .from(COLLECTIONS_TABLE)
      .select("*")
      .eq("slug", slug)
      .eq("is_active", true)
      .lte("starts_at", nowIso)
      .or(`ends_at.is.null,ends_at.gt.${nowIso}`)
      .maybeSingle();

    if (collectionError) return res.status(500).json({ error: collectionError.message });
    if (!collection) return res.status(404).json({ error: "Editorial not found" });

    const items = await getActiveItemsByCollectionIds([collection.id]);
    const hydratedItems = await hydrateEditorialEntities(items);

    return res.json({
      editorial: {
        ...collection,
        items: hydratedItems.filter((item) => item.collection_id === collection.id),
      },
    });
  } catch (error: any) {
    return res.status(500).json({ error: error?.message ?? "Failed to load editorial" });
  }
});

export default router;
