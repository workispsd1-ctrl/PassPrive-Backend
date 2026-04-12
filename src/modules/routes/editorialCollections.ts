import { Router, Request, Response } from "express";
import { z } from "zod";
import supabase from "../../database/supabase";
import { hydrateStoreRows, STORE_BASE_SELECT } from "../services/storeShape";

const router = Router();

const COLLECTIONS_TABLE = "editorial_collections";
const ITEMS_TABLE = "editorial_collection_items";

const UuidSchema = z.string().uuid();

const NullableTrimmedString = z.string().trim().nullable();
const IsoDateTimeString = z.string().datetime({ offset: true });

const CollectionBodySchema = z.object({
  slug: z.string().trim().min(1),
  title: z.string().trim().min(1),
  subtitle: NullableTrimmedString.optional(),
  description: NullableTrimmedString.optional(),
  cover_image_url: NullableTrimmedString.optional(),
  badge_text: NullableTrimmedString.optional(),
  source_name: NullableTrimmedString.optional(),
  source_url: NullableTrimmedString.optional(),
  content_type: z.enum(["LIST", "GUIDE", "HOTLIST", "ARTICLE"]).optional(),
  entity_type: z.enum(["STORE", "RESTAURANT", "BOTH"]).optional(),
  city: NullableTrimmedString.optional(),
  area: NullableTrimmedString.optional(),
  sort_order: z.number().int().optional(),
  is_featured: z.boolean().optional(),
  is_active: z.boolean().optional(),
  starts_at: IsoDateTimeString.optional(),
  ends_at: IsoDateTimeString.nullable().optional(),
});

const UpdateCollectionBodySchema = CollectionBodySchema.partial();

const ItemBodySchema = z
  .object({
    store_id: z.string().uuid().optional(),
    restaurant_id: z.string().uuid().optional(),
    sort_order: z.number().int().optional(),
    note: NullableTrimmedString.optional(),
    is_active: z.boolean().optional(),
  })
  .superRefine((value, ctx) => {
    const hasStore = !!value.store_id;
    const hasRestaurant = !!value.restaurant_id;

    if (hasStore === hasRestaurant) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["store_id"],
        message: "Exactly one of store_id or restaurant_id is required",
      });
    }
  });

const UpdateItemBodySchema = z
  .object({
    store_id: z.string().uuid().optional(),
    restaurant_id: z.string().uuid().optional(),
    sort_order: z.number().int().optional(),
    note: NullableTrimmedString.optional(),
    is_active: z.boolean().optional(),
  })
  .superRefine((value, ctx) => {
    const hasStore = value.store_id !== undefined;
    const hasRestaurant = value.restaurant_id !== undefined;

    if (hasStore && hasRestaurant) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["store_id"],
        message: "Provide only one of store_id or restaurant_id",
      });
    }
  });

const ReorderBodySchema = z.object({
  item_ids: z.array(z.string().uuid()).min(1),
});

function buildNullAwarePayload(payload: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(payload)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [key, value ?? null])
  );
}

async function ensureCollectionExists(collectionId: string) {
  const { data, error } = await supabase
    .from(COLLECTIONS_TABLE)
    .select("id, entity_type")
    .eq("id", collectionId)
    .maybeSingle();

  if (error) throw error;
  return data;
}

async function ensureStoreExists(storeId: string) {
  const { data, error } = await supabase
    .from("stores")
    .select("id")
    .eq("id", storeId)
    .maybeSingle();

  if (error) throw error;
  return !!data;
}

async function ensureRestaurantExists(restaurantId: string) {
  const { data, error } = await supabase
    .from("restaurants")
    .select("id")
    .eq("id", restaurantId)
    .maybeSingle();

  if (error) throw error;
  return !!data;
}

async function getItemsByCollectionId(collectionId: string, onlyActive = false) {
  let itemsQuery = supabase
    .from(ITEMS_TABLE)
    .select("*")
    .eq("collection_id", collectionId)
    .order("sort_order", { ascending: true })
    .order("created_at", { ascending: true });

  if (onlyActive) {
    itemsQuery = itemsQuery.eq("is_active", true);
  }

  const { data: items, error: itemsError } = await itemsQuery;
  if (itemsError) throw itemsError;

  const storeIds = Array.from(
    new Set((items ?? []).map((item) => item.store_id).filter(Boolean))
  );
  const restaurantIds = Array.from(
    new Set((items ?? []).map((item) => item.restaurant_id).filter(Boolean))
  );

  let storesById = new Map<string, unknown>();
  let restaurantsById = new Map<string, unknown>();

  if (storeIds.length > 0) {
    let storeQuery = supabase.from("stores").select(STORE_BASE_SELECT).in("id", storeIds);
    if (onlyActive) {
      storeQuery = storeQuery.eq("is_active", true);
    }

    const { data: stores, error: storesError } = await storeQuery;
    if (storesError) throw storesError;

    const hydratedStores = await hydrateStoreRows(stores ?? []);
    storesById = new Map((hydratedStores ?? []).map((store) => [store.id, store]));
  }

  if (restaurantIds.length > 0) {
    let restaurantsQuery = supabase
      .from("restaurants")
      .select("*")
      .in("id", restaurantIds);
    if (onlyActive) {
      restaurantsQuery = restaurantsQuery.eq("is_active", true);
    }

    const { data: restaurants, error: restaurantsError } = await restaurantsQuery;
    if (restaurantsError) throw restaurantsError;

    restaurantsById = new Map(
      (restaurants ?? []).map((restaurant) => [restaurant.id, restaurant])
    );
  }

  return (items ?? []).map((item) => ({
    ...item,
    store: item.store_id ? storesById.get(item.store_id) ?? null : null,
    restaurant: item.restaurant_id
      ? restaurantsById.get(item.restaurant_id) ?? null
      : null,
  }));
}

async function getCollectionWithItems(collectionId: string, onlyActive = false) {
  let collectionQuery = supabase
    .from(COLLECTIONS_TABLE)
    .select("*")
    .eq("id", collectionId);

  if (onlyActive) {
    collectionQuery = collectionQuery.eq("is_active", true);
  }

  const collectionResult = collectionQuery.maybeSingle();

  const { data: collection, error: collectionError } = await collectionResult;
  if (collectionError) throw collectionError;

  if (!collection) return null;

  const items = await getItemsByCollectionId(collection.id, onlyActive);

  return {
    ...collection,
    items,
  };
}

router.get("/", async (_req: Request, res: Response) => {
  try {
    const { data: collections, error } = await supabase
      .from(COLLECTIONS_TABLE)
      .select("*")
      .order("sort_order", { ascending: true })
      .order("created_at", { ascending: true });

    if (error) throw error;

    return res.json({ collections: collections ?? [] });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

router.get("/:id", async (req: Request, res: Response) => {
  const idParsed = UuidSchema.safeParse(req.params.id);
  if (!idParsed.success) {
    return res.status(400).json({ error: "Invalid collection id" });
  }

  try {
    const collection = await getCollectionWithItems(idParsed.data, false);
    if (!collection) {
      return res.status(404).json({ error: "Collection not found" });
    }

    return res.json({ collection });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

router.post("/", async (req: Request, res: Response) => {
  const parsed = CollectionBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res
      .status(400)
      .json({ error: "Invalid body", details: parsed.error.flatten() });
  }

  try {
    const body = parsed.data;

    if (body.starts_at && body.ends_at) {
      const startsAt = new Date(body.starts_at).getTime();
      const endsAt = new Date(body.ends_at).getTime();
      if (endsAt <= startsAt) {
        return res
          .status(400)
          .json({ error: "ends_at must be greater than starts_at" });
      }
    }

    const insertPayload = {
      slug: body.slug,
      title: body.title,
      subtitle: body.subtitle ?? null,
      description: body.description ?? null,
      cover_image_url: body.cover_image_url ?? null,
      badge_text: body.badge_text ?? null,
      source_name: body.source_name ?? "PassPrive",
      source_url: body.source_url ?? null,
      content_type: body.content_type ?? "LIST",
      entity_type: body.entity_type ?? "BOTH",
      city: body.city ?? null,
      area: body.area ?? null,
      sort_order: body.sort_order ?? 100,
      is_featured: body.is_featured ?? false,
      is_active: body.is_active ?? true,
      starts_at: body.starts_at ?? new Date().toISOString(),
      ends_at: body.ends_at ?? null,
    };

    const { data, error } = await supabase
      .from(COLLECTIONS_TABLE)
      .insert(insertPayload)
      .select("*")
      .single();

    if (error) throw error;

    return res.status(201).json({
      message: "Collection created successfully",
      collection: data,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

router.put("/:id", async (req: Request, res: Response) => {
  const idParsed = UuidSchema.safeParse(req.params.id);
  if (!idParsed.success) {
    return res.status(400).json({ error: "Invalid collection id" });
  }

  const parsed = UpdateCollectionBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res
      .status(400)
      .json({ error: "Invalid body", details: parsed.error.flatten() });
  }

  const payload = buildNullAwarePayload(parsed.data);
  if (Object.keys(payload).length === 0) {
    return res.status(400).json({ error: "No fields to update" });
  }

  if (payload.starts_at && payload.ends_at) {
    const startsAt = new Date(String(payload.starts_at)).getTime();
    const endsAt = new Date(String(payload.ends_at)).getTime();
    if (endsAt <= startsAt) {
      return res
        .status(400)
        .json({ error: "ends_at must be greater than starts_at" });
    }
  }

  try {
    const { data, error } = await supabase
      .from(COLLECTIONS_TABLE)
      .update(payload)
      .eq("id", idParsed.data)
      .select("*")
      .maybeSingle();

    if (error) throw error;
    if (!data) {
      return res.status(404).json({ error: "Collection not found" });
    }

    return res.json({
      message: "Collection updated successfully",
      collection: data,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

router.delete("/:id", async (req: Request, res: Response) => {
  const idParsed = UuidSchema.safeParse(req.params.id);
  if (!idParsed.success) {
    return res.status(400).json({ error: "Invalid collection id" });
  }

  try {
    const { data, error } = await supabase
      .from(COLLECTIONS_TABLE)
      .delete()
      .eq("id", idParsed.data)
      .select("id")
      .maybeSingle();

    if (error) throw error;
    if (!data) {
      return res.status(404).json({ error: "Collection not found" });
    }

    return res.json({ message: "Collection deleted successfully" });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

router.get("/:id/items", async (req: Request, res: Response) => {
  const idParsed = UuidSchema.safeParse(req.params.id);
  if (!idParsed.success) {
    return res.status(400).json({ error: "Invalid collection id" });
  }

  try {
    const collection = await ensureCollectionExists(idParsed.data);
    if (!collection) {
      return res.status(404).json({ error: "Collection not found" });
    }

    const items = await getItemsByCollectionId(idParsed.data, false);
    return res.json({ items });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

router.post("/:id/items", async (req: Request, res: Response) => {
  const idParsed = UuidSchema.safeParse(req.params.id);
  if (!idParsed.success) {
    return res.status(400).json({ error: "Invalid collection id" });
  }

  const parsed = ItemBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res
      .status(400)
      .json({ error: "Invalid body", details: parsed.error.flatten() });
  }

  try {
    const collection = await ensureCollectionExists(idParsed.data);
    if (!collection) {
      return res.status(404).json({ error: "Collection not found" });
    }

    const body = parsed.data;

    if (collection.entity_type === "STORE" && body.restaurant_id) {
      return res
        .status(400)
        .json({ error: "This collection allows only store items" });
    }

    if (collection.entity_type === "RESTAURANT" && body.store_id) {
      return res
        .status(400)
        .json({ error: "This collection allows only restaurant items" });
    }

    if (body.store_id) {
      const storeExists = await ensureStoreExists(body.store_id);
      if (!storeExists) {
        return res.status(400).json({ error: "store_id does not exist" });
      }
    }

    if (body.restaurant_id) {
      const restaurantExists = await ensureRestaurantExists(body.restaurant_id);
      if (!restaurantExists) {
        return res.status(400).json({ error: "restaurant_id does not exist" });
      }
    }

    const { data, error } = await supabase
      .from(ITEMS_TABLE)
      .insert({
        collection_id: idParsed.data,
        store_id: body.store_id ?? null,
        restaurant_id: body.restaurant_id ?? null,
        sort_order: body.sort_order ?? 100,
        note: body.note ?? null,
        is_active: body.is_active ?? true,
      })
      .select("*")
      .single();

    if (error) throw error;

    return res.status(201).json({
      message: "Collection item created successfully",
      item: data,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

router.put("/:id/items/:itemId", async (req: Request, res: Response) => {
  const idParsed = UuidSchema.safeParse(req.params.id);
  const itemIdParsed = UuidSchema.safeParse(req.params.itemId);
  if (!idParsed.success) {
    return res.status(400).json({ error: "Invalid collection id" });
  }
  if (!itemIdParsed.success) {
    return res.status(400).json({ error: "Invalid item id" });
  }

  const parsed = UpdateItemBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res
      .status(400)
      .json({ error: "Invalid body", details: parsed.error.flatten() });
  }

  const payload = buildNullAwarePayload(parsed.data);
  if (Object.keys(payload).length === 0) {
    return res.status(400).json({ error: "No fields to update" });
  }

  try {
    const collection = await ensureCollectionExists(idParsed.data);
    if (!collection) {
      return res.status(404).json({ error: "Collection not found" });
    }

    const { data: existingItem, error: existingItemError } = await supabase
      .from(ITEMS_TABLE)
      .select("id, store_id, restaurant_id")
      .eq("id", itemIdParsed.data)
      .eq("collection_id", idParsed.data)
      .maybeSingle();

    if (existingItemError) throw existingItemError;
    if (!existingItem) {
      return res.status(404).json({ error: "Item not found" });
    }

    const nextStoreId =
      parsed.data.store_id !== undefined ? parsed.data.store_id : existingItem.store_id;
    const nextRestaurantId =
      parsed.data.restaurant_id !== undefined
        ? parsed.data.restaurant_id
        : existingItem.restaurant_id;

    const hasStore = !!nextStoreId;
    const hasRestaurant = !!nextRestaurantId;
    if (hasStore === hasRestaurant) {
      return res
        .status(400)
        .json({ error: "Exactly one of store_id or restaurant_id is required" });
    }

    if (collection.entity_type === "STORE" && hasRestaurant) {
      return res
        .status(400)
        .json({ error: "This collection allows only store items" });
    }

    if (collection.entity_type === "RESTAURANT" && hasStore) {
      return res
        .status(400)
        .json({ error: "This collection allows only restaurant items" });
    }

    if (parsed.data.store_id) {
      const storeExists = await ensureStoreExists(parsed.data.store_id);
      if (!storeExists) {
        return res.status(400).json({ error: "store_id does not exist" });
      }
    }

    if (parsed.data.restaurant_id) {
      const restaurantExists = await ensureRestaurantExists(parsed.data.restaurant_id);
      if (!restaurantExists) {
        return res.status(400).json({ error: "restaurant_id does not exist" });
      }
    }

    const { data, error } = await supabase
      .from(ITEMS_TABLE)
      .update(payload)
      .eq("id", itemIdParsed.data)
      .eq("collection_id", idParsed.data)
      .select("*")
      .maybeSingle();

    if (error) throw error;
    if (!data) {
      return res.status(404).json({ error: "Item not found" });
    }

    return res.json({
      message: "Collection item updated successfully",
      item: data,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

router.delete("/:id/items/:itemId", async (req: Request, res: Response) => {
  const idParsed = UuidSchema.safeParse(req.params.id);
  const itemIdParsed = UuidSchema.safeParse(req.params.itemId);
  if (!idParsed.success) {
    return res.status(400).json({ error: "Invalid collection id" });
  }
  if (!itemIdParsed.success) {
    return res.status(400).json({ error: "Invalid item id" });
  }

  try {
    const { data, error } = await supabase
      .from(ITEMS_TABLE)
      .delete()
      .eq("collection_id", idParsed.data)
      .eq("id", itemIdParsed.data)
      .select("id")
      .maybeSingle();

    if (error) throw error;
    if (!data) {
      return res.status(404).json({ error: "Item not found" });
    }

    return res.json({ message: "Collection item deleted successfully" });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

router.put("/:id/items/reorder", async (req: Request, res: Response) => {
  const idParsed = UuidSchema.safeParse(req.params.id);
  if (!idParsed.success) {
    return res.status(400).json({ error: "Invalid collection id" });
  }

  const parsed = ReorderBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res
      .status(400)
      .json({ error: "Invalid body", details: parsed.error.flatten() });
  }

  try {
    const { data: existingItems, error: existingItemsError } = await supabase
      .from(ITEMS_TABLE)
      .select("id")
      .eq("collection_id", idParsed.data)
      .in("id", parsed.data.item_ids);

    if (existingItemsError) throw existingItemsError;

    if ((existingItems ?? []).length !== parsed.data.item_ids.length) {
      return res
        .status(400)
        .json({ error: "One or more item ids do not belong to this collection" });
    }

    for (const [index, itemId] of parsed.data.item_ids.entries()) {
      const { error } = await supabase
        .from(ITEMS_TABLE)
        .update({ sort_order: index })
        .eq("collection_id", idParsed.data)
        .eq("id", itemId);

      if (error) throw error;
    }

    const items = await getItemsByCollectionId(idParsed.data, false);

    return res.json({
      message: "Items reordered successfully",
      items,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

export default router;
