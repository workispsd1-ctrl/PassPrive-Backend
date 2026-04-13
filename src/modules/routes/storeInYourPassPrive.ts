import { Router, Request, Response } from "express";
import { z } from "zod";
import supabase from "../../database/supabase";
import { hydrateStorePreviewRows, STORE_PREVIEW_SELECT } from "../services/storeShape";

const router = Router();

const CARDS_TABLE = "store_in_your_passprive_cards";
const ITEMS_TABLE = "store_in_your_passprive_card_items";

const UuidSchema = z.string().uuid();

const CardBodySchema = z.object({
  title: z.string().trim().min(1),
  subtitle: z.string().trim().nullable().optional(),
  city: z.string().trim().nullable().optional(),
  is_active: z.boolean().optional(),
  sort_order: z.number().int().optional(),
});

const UpdateCardBodySchema = z.object({
  title: z.string().trim().min(1).optional(),
  subtitle: z.string().trim().nullable().optional(),
  city: z.string().trim().nullable().optional(),
  is_active: z.boolean().optional(),
  sort_order: z.number().int().optional(),
});

const ItemBodySchema = z.object({
  store_id: z.string().uuid(),
  custom_title: z.string().trim().nullable().optional(),
  custom_venue: z.string().trim().nullable().optional(),
  custom_offer: z.string().trim().nullable().optional(),
  custom_image_url: z.string().trim().nullable().optional(),
  sort_order: z.number().int().optional(),
  is_active: z.boolean().optional(),
});

const UpdateItemBodySchema = z.object({
  store_id: z.string().uuid().optional(),
  custom_title: z.string().trim().nullable().optional(),
  custom_venue: z.string().trim().nullable().optional(),
  custom_offer: z.string().trim().nullable().optional(),
  custom_image_url: z.string().trim().nullable().optional(),
  sort_order: z.number().int().optional(),
  is_active: z.boolean().optional(),
});

const ReorderBodySchema = z.object({
  item_ids: z.array(z.string().uuid()).min(1),
});

async function ensureStoreExists(storeId: string) {
  const { data, error } = await supabase
    .from("stores")
    .select("id")
    .eq("id", storeId)
    .maybeSingle();

  if (error) throw error;
  return !!data;
}

async function getNestedCards(options?: {
  cardId?: string;
  onlyActive?: boolean;
}) {
  const onlyActive = options?.onlyActive ?? true;

  let cardsQuery = supabase
    .from(CARDS_TABLE)
    .select("*")
    .order("sort_order", { ascending: true })
    .order("created_at", { ascending: true });

  if (options?.cardId) {
    cardsQuery = cardsQuery.eq("id", options.cardId);
  }

  if (onlyActive) {
    cardsQuery = cardsQuery.eq("is_active", true);
  }

  const { data: cards, error: cardsError } = await cardsQuery;
  if (cardsError) throw cardsError;

  if (!cards || cards.length === 0) {
    return options?.cardId ? null : [];
  }

  const cardIds = cards.map((card) => card.id);

  let itemsQuery = supabase
    .from(ITEMS_TABLE)
    .select("*")
    .in("card_id", cardIds)
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

  let storesById = new Map<string, any>();

  if (storeIds.length > 0) {
    let storesQuery = supabase
      .from("stores")
      .select(STORE_PREVIEW_SELECT)
      .in("id", storeIds);

    if (onlyActive) {
      storesQuery = storesQuery.eq("is_active", true);
    }

    const { data: stores, error: storesError } = await storesQuery;
    if (storesError) throw storesError;

    const hydratedStores = await hydrateStorePreviewRows(stores ?? []);
    storesById = new Map((hydratedStores ?? []).map((store) => [store.id, store]));
  }

  const itemsByCardId = new Map<string, any[]>();

  for (const item of items ?? []) {
    const store = storesById.get(item.store_id);
    if (!store) continue;

    const groupedItems = itemsByCardId.get(item.card_id) ?? [];
    groupedItems.push({
      ...item,
      store,
    });
    itemsByCardId.set(item.card_id, groupedItems);
  }

  const result = cards.map((card) => ({
    ...card,
    items: itemsByCardId.get(card.id) ?? [],
  }));

  return options?.cardId ? result[0] ?? null : result;
}

router.get("/", async (req: Request, res: Response) => {
  try {
    const cards = await getNestedCards({ onlyActive: true });
    return res.json({ cards });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

router.get("/:id", async (req: Request, res: Response) => {
  const idParsed = UuidSchema.safeParse(req.params.id);
  if (!idParsed.success) {
    return res.status(400).json({ error: "Invalid card id" });
  }

  try {
    const card = await getNestedCards({
      cardId: idParsed.data,
      onlyActive: true,
    });

    if (!card) {
      return res.status(404).json({ error: "Card not found" });
    }

    return res.json({ card });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

router.post("/", async (req: Request, res: Response) => {
  const parsed = CardBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res
      .status(400)
      .json({ error: "Invalid body", details: parsed.error.flatten() });
  }

  try {
    const body = parsed.data;

    const { data, error } = await supabase
      .from(CARDS_TABLE)
      .insert({
        title: body.title,
        subtitle: body.subtitle ?? null,
        city: body.city ?? null,
        is_active: body.is_active ?? true,
        sort_order: body.sort_order ?? 0,
      })
      .select()
      .single();

    if (error) throw error;

    return res.status(201).json({
      message: "Card created successfully",
      card: data,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

router.put("/:id", async (req: Request, res: Response) => {
  const idParsed = UuidSchema.safeParse(req.params.id);
  if (!idParsed.success) {
    return res.status(400).json({ error: "Invalid card id" });
  }

  const parsed = UpdateCardBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res
      .status(400)
      .json({ error: "Invalid body", details: parsed.error.flatten() });
  }

  const payload = Object.fromEntries(
    Object.entries(parsed.data).map(([key, value]) => [key, value ?? null])
  );

  if (Object.keys(payload).length === 0) {
    return res.status(400).json({ error: "No fields to update" });
  }

  try {
    const { data, error } = await supabase
      .from(CARDS_TABLE)
      .update(payload)
      .eq("id", idParsed.data)
      .select()
      .single();

    if (error) {
      return res.status(404).json({ error: "Card not found" });
    }

    return res.json({
      message: "Card updated successfully",
      card: data,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

router.delete("/:id", async (req: Request, res: Response) => {
  const idParsed = UuidSchema.safeParse(req.params.id);
  if (!idParsed.success) {
    return res.status(400).json({ error: "Invalid card id" });
  }

  try {
    const { error } = await supabase
      .from(CARDS_TABLE)
      .delete()
      .eq("id", idParsed.data);

    if (error) throw error;

    return res.json({ message: "Card deleted successfully" });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

router.post("/:cardId/items", async (req: Request, res: Response) => {
  const cardIdParsed = UuidSchema.safeParse(req.params.cardId);
  if (!cardIdParsed.success) {
    return res.status(400).json({ error: "Invalid card id" });
  }

  const parsed = ItemBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res
      .status(400)
      .json({ error: "Invalid body", details: parsed.error.flatten() });
  }

  try {
    const storeExists = await ensureStoreExists(parsed.data.store_id);
    if (!storeExists) {
      return res.status(400).json({ error: "store_id does not exist" });
    }

    const { data, error } = await supabase
      .from(ITEMS_TABLE)
      .insert({
        card_id: cardIdParsed.data,
        store_id: parsed.data.store_id,
        custom_title: parsed.data.custom_title ?? null,
        custom_venue: parsed.data.custom_venue ?? null,
        custom_offer: parsed.data.custom_offer ?? null,
        custom_image_url: parsed.data.custom_image_url ?? null,
        sort_order: parsed.data.sort_order ?? 0,
        is_active: parsed.data.is_active ?? true,
      })
      .select()
      .single();

    if (error) throw error;

    return res.status(201).json({
      message: "Card item created successfully",
      item: data,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

router.put("/:cardId/items/reorder", async (req: Request, res: Response) => {
  const cardIdParsed = UuidSchema.safeParse(req.params.cardId);
  if (!cardIdParsed.success) {
    return res.status(400).json({ error: "Invalid card id" });
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
      .eq("card_id", cardIdParsed.data)
      .in("id", parsed.data.item_ids);

    if (existingItemsError) throw existingItemsError;

    if ((existingItems ?? []).length !== parsed.data.item_ids.length) {
      return res
        .status(400)
        .json({ error: "One or more item ids do not belong to this card" });
    }

    for (const [index, itemId] of parsed.data.item_ids.entries()) {
      const { error } = await supabase
        .from(ITEMS_TABLE)
        .update({ sort_order: index })
        .eq("card_id", cardIdParsed.data)
        .eq("id", itemId);

      if (error) throw error;
    }

    const card = await getNestedCards({
      cardId: cardIdParsed.data,
      onlyActive: false,
    });

    return res.json({
      message: "Items reordered successfully",
      card,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

router.put("/:cardId/items/:itemId", async (req: Request, res: Response) => {
  const cardIdParsed = UuidSchema.safeParse(req.params.cardId);
  const itemIdParsed = UuidSchema.safeParse(req.params.itemId);

  if (!cardIdParsed.success) {
    return res.status(400).json({ error: "Invalid card id" });
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

  if (parsed.data.store_id) {
    try {
      const storeExists = await ensureStoreExists(parsed.data.store_id);
      if (!storeExists) {
        return res.status(400).json({ error: "store_id does not exist" });
      }
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  }

  const payload = Object.fromEntries(
    Object.entries(parsed.data).map(([key, value]) => [key, value ?? null])
  );

  if (Object.keys(payload).length === 0) {
    return res.status(400).json({ error: "No fields to update" });
  }

  try {
    const { data, error } = await supabase
      .from(ITEMS_TABLE)
      .update(payload)
      .eq("card_id", cardIdParsed.data)
      .eq("id", itemIdParsed.data)
      .select()
      .single();

    if (error) {
      return res.status(404).json({ error: "Item not found" });
    }

    return res.json({
      message: "Card item updated successfully",
      item: data,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

router.delete("/:cardId/items/:itemId", async (req: Request, res: Response) => {
  const cardIdParsed = UuidSchema.safeParse(req.params.cardId);
  const itemIdParsed = UuidSchema.safeParse(req.params.itemId);

  if (!cardIdParsed.success) {
    return res.status(400).json({ error: "Invalid card id" });
  }
  if (!itemIdParsed.success) {
    return res.status(400).json({ error: "Invalid item id" });
  }

  try {
    const { error } = await supabase
      .from(ITEMS_TABLE)
      .delete()
      .eq("card_id", cardIdParsed.data)
      .eq("id", itemIdParsed.data);

    if (error) throw error;

    return res.json({ message: "Card item deleted successfully" });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

export default router;
