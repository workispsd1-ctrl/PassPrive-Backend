import { randomUUID } from "crypto";
import { Router } from "express";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import supabase from "../../database/supabase";

const router = Router();

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY!;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in env");
}

const StoreIdSchema = z.string().uuid();

const SlotsQuerySchema = z.object({
  store_id: z.string().uuid(),
  item_id: z.string().uuid(),
  date: z.string().trim().min(1),
});

const CreateCategorySchema = z.object({
  store_id: z.string().uuid(),
  title: z.string().trim().min(1),
  starting_from: z.coerce.number().nullable().optional(),
  enabled: z.boolean().optional(),
  sort_order: z.coerce.number().int().optional(),
});

const UpdateCategorySchema = CreateCategorySchema.omit({ store_id: true }).partial();

const CreateItemSchema = z.object({
  store_id: z.string().uuid(),
  category_id: z.string().uuid(),
  title: z.string().trim().min(1),
  price: z.coerce.number().nullable().optional(),
  sku: z.string().trim().nullable().optional(),
  description: z.string().trim().nullable().optional(),
  is_available: z.boolean().optional(),
  image_url: z.string().trim().nullable().optional(),
  sort_order: z.coerce.number().int().optional(),
  track_inventory: z.boolean().optional(),
  stock_qty: z.coerce.number().int().nullable().optional(),
  low_stock_threshold: z.coerce.number().int().optional(),
  stock_status: z.enum(["in_stock", "low_stock", "out_of_stock"]).nullable().optional(),
  allow_backorder: z.boolean().optional(),
  sold_count: z.coerce.number().int().optional(),
  reserved_count: z.coerce.number().int().optional(),
  is_image_catalogue: z.boolean().optional(),
  item_type: z.string().trim().nullable().optional(),
  is_billable: z.boolean().optional(),
  duration_minutes: z.coerce.number().int().nullable().optional(),
  supports_slot_booking: z.boolean().optional(),
});

const UpdateItemSchema = CreateItemSchema.partial().omit({ store_id: true });

const CreateBookingDraftSchema = z.object({
  store_id: z.string().uuid(),
  item_id: z.string().uuid(),
  slot_start: z.string().datetime(),
  slot_end: z.string().datetime(),
  user_id: z.string().uuid().optional().nullable(),
});

const CreateBillSessionSchema = z.object({
  store_id: z.string().uuid(),
  item_id: z.string().uuid(),
  quantity: z.coerce.number().int().positive().optional(),
});

function getBearerToken(req: any) {
  const header = req.headers.authorization || "";
  const [type, token] = header.split(" ");
  if (type !== "Bearer" || !token) return null;
  return token;
}

function supabaseAuthed(req: any) {
  const token = getBearerToken(req);
  if (!token) return null;

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

  const { data: userData, error: userErr } = await sb.auth.getUser();
  if (userErr || !userData?.user) {
    res.status(401).json({ error: "Invalid session" });
    return null;
  }

  const { data: roleRow, error: roleErr } = await sb
    .from("users")
    .select("role")
    .eq("id", userData.user.id)
    .maybeSingle();

  const role = roleRow?.role?.toLowerCase();
  if (roleErr || !role || !["admin", "superadmin"].includes(role)) {
    res.status(403).json({ error: "Access denied" });
    return null;
  }

  return { sb, callerId: userData.user.id };
}

function buildNullAwarePayload(payload: Record<string, any>) {
  return Object.fromEntries(
    Object.entries(payload)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [key, value ?? null])
  );
}

function normalizeStoreType(store: any) {
  return String(store?.store_type ?? "PRODUCT").trim().toUpperCase();
}

function normalizeItemType(item: any, storeType: string) {
  return String(item?.item_type ?? storeType).trim().toUpperCase();
}

function normalizeDateString(value: string) {
  const trimmed = value.trim();
  const directDateMatch = trimmed.match(/^(\d{4}-\d{2}-\d{2})/);
  if (directDateMatch) return directDateMatch[1];

  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) return null;

  const year = parsed.getFullYear();
  const month = String(parsed.getMonth() + 1).padStart(2, "0");
  const day = String(parsed.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function normalizeTimeString(value: string) {
  const trimmed = value.trim();
  const directMatch = trimmed.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (!directMatch) return null;

  const hours = Number(directMatch[1]);
  const minutes = Number(directMatch[2]);
  const seconds = Number(directMatch[3] ?? 0);

  if (
    !Number.isInteger(hours) ||
    !Number.isInteger(minutes) ||
    !Number.isInteger(seconds) ||
    hours < 0 ||
    hours > 23 ||
    minutes < 0 ||
    minutes > 59 ||
    seconds < 0 ||
    seconds > 59
  ) {
    return null;
  }

  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(
    seconds
  ).padStart(2, "0")}`;
}

function timeToMinutes(value: string) {
  const normalized = normalizeTimeString(value);
  if (!normalized) return null;

  const [hours, minutes] = normalized.split(":").map(Number);
  return hours * 60 + minutes;
}

function isWithinOpeningWindow(timeMinutes: number, openMinutes: number, closeMinutes: number) {
  if (closeMinutes > openMinutes) {
    return timeMinutes >= openMinutes && timeMinutes <= closeMinutes;
  }

  return timeMinutes >= openMinutes || timeMinutes <= closeMinutes;
}

function getOpeningWindowsForDate(hours: any, date: Date) {
  if (!Array.isArray(hours)) return [];

  const weekday = date.getDay();

  return hours
    .filter((entry) => {
      if (!entry || typeof entry !== "object") return false;

      const values = [
        entry.day,
        entry.day_index,
        entry.weekday,
        entry.dayOfWeek,
      ].filter((value) => value !== undefined && value !== null);

      return values.some((value) => Number(value) === weekday);
    })
    .map((entry) => ({
      open: typeof entry.open === "string" ? entry.open : null,
      close: typeof entry.close === "string" ? entry.close : null,
    }))
    .filter((entry) => entry.open && entry.close);
}

async function getStoreById(storeId: string) {
  const { data, error } = await supabase
    .from("stores")
    .select("*")
    .eq("id", storeId)
    .maybeSingle();

  if (error) throw error;
  return data;
}

async function getStoreCategoriesWithItems(storeId: string) {
  const [{ data: categories, error: categoriesError }, { data: items, error: itemsError }] =
    await Promise.all([
      supabase
        .from("store_catalogue_categories")
        .select("*")
        .eq("store_id", storeId)
        .eq("enabled", true)
        .order("sort_order", { ascending: true })
        .order("created_at", { ascending: true }),
      supabase
        .from("store_catalogue_items")
        .select("*")
        .eq("store_id", storeId)
        .order("sort_order", { ascending: true })
        .order("created_at", { ascending: true }),
    ]);

  if (categoriesError) throw categoriesError;
  if (itemsError) throw itemsError;

  const itemsByCategoryId = new Map<string, any[]>();

  for (const item of items ?? []) {
    const grouped = itemsByCategoryId.get(item.category_id) ?? [];
    grouped.push(item);
    itemsByCategoryId.set(item.category_id, grouped);
  }

  return (categories ?? []).map((category) => ({
    ...category,
    items: itemsByCategoryId.get(category.id) ?? [],
  }));
}

export async function getProductCataloguePayload(storeId: string) {
  const store = await getStoreById(storeId);
  if (!store) return null;

  const storeType = normalizeStoreType(store);
  const categories = await getStoreCategoriesWithItems(storeId);

  return {
    store_id: store.id,
    store_type: storeType,
    categories: categories.map((category) => ({
      id: category.id,
      title: category.title,
      starting_from: category.starting_from,
      sort_order: category.sort_order,
      items: (category.items ?? [])
        .filter((item: any) => {
          const itemType = normalizeItemType(item, storeType);
          if (itemType === "SERVICE") return false;
          return item.is_image_catalogue === true || typeof item.image_url === "string";
        })
        .map((item: any) => ({
          id: item.id,
          title: item.title,
          description: item.description,
          price: item.price,
          image_url: item.image_url,
          is_available: item.is_available,
          sku: item.sku,
          sort_order: item.sort_order,
        })),
    })),
  };
}

export async function getServiceCataloguePayload(storeId: string) {
  const store = await getStoreById(storeId);
  if (!store) return null;

  const storeType = normalizeStoreType(store);
  const categories = await getStoreCategoriesWithItems(storeId);

  return {
    store_id: store.id,
    store_type: storeType,
    categories: categories.map((category) => ({
      id: category.id,
      title: category.title,
      starting_from: category.starting_from,
      sort_order: category.sort_order,
      items: (category.items ?? [])
        .filter((item: any) => normalizeItemType(item, storeType) === "SERVICE")
        .map((item: any) => ({
          id: item.id,
          title: item.title,
          description: item.description,
          price: item.price,
          image_url: item.image_url,
          duration_minutes: item.duration_minutes,
          supports_slot_booking: item.supports_slot_booking,
          is_billable: item.is_billable,
          is_available: item.is_available,
          sort_order: item.sort_order,
        })),
    })),
  };
}

export function buildStoreSlotConfig(store: any) {
  return {
    supports_time_slots: store?.supports_time_slots === true,
    slot_duration_minutes: store?.slot_duration_minutes ?? 30,
    slot_buffer_minutes: store?.slot_buffer_minutes ?? 0,
    slot_advance_days: store?.slot_advance_days ?? 30,
    slot_max_per_window: store?.slot_max_per_window ?? null,
  };
}

export async function buildServiceSlots(params: { storeId: string; itemId: string; date: string }) {
  const store = await getStoreById(params.storeId);
  if (!store) {
    return { status: 404 as const, body: { error: "Store not found" } };
  }

  const storeType = normalizeStoreType(store);
  if (storeType !== "SERVICE") {
    return { status: 400 as const, body: { error: "Slots are only available for service stores" } };
  }

  const { data: item, error: itemError } = await supabase
    .from("store_catalogue_items")
    .select("*")
    .eq("id", params.itemId)
    .eq("store_id", params.storeId)
    .maybeSingle();

  if (itemError) throw itemError;
  if (!item) {
    return { status: 404 as const, body: { error: "Item not found" } };
  }
  if (item.is_available !== true) {
    return { status: 400 as const, body: { error: "Item is not available" } };
  }
  if (item.supports_slot_booking !== true) {
    return { status: 400 as const, body: { error: "Item does not support slot booking" } };
  }
  if (store.supports_time_slots !== true) {
    return { status: 400 as const, body: { error: "Store does not support slot booking" } };
  }

  const bookingDate = normalizeDateString(params.date);
  if (!bookingDate) {
    return { status: 400 as const, body: { error: "Invalid date" } };
  }

  const bookingDateValue = new Date(`${bookingDate}T00:00:00`);
  const now = new Date();
  const latestDate = new Date();
  latestDate.setHours(23, 59, 59, 999);
  latestDate.setDate(latestDate.getDate() + Number(store.slot_advance_days ?? 30));

  if (bookingDateValue > latestDate) {
    return { status: 400 as const, body: { error: "Selected date exceeds advance booking window" } };
  }

  const openingWindows = getOpeningWindowsForDate(store.hours, bookingDateValue);
  if (openingWindows.length === 0) {
    return { status: 200 as const, body: { slots: [], slot_config: buildStoreSlotConfig(store) } };
  }

  const itemDuration = Number(item.duration_minutes ?? store.slot_duration_minutes ?? 30);
  const slotStep = Number(store.slot_duration_minutes ?? 30);
  const slotBuffer = Number(store.slot_buffer_minutes ?? 0);
  const slots: any[] = [];

  for (const window of openingWindows) {
    const openMinutes = timeToMinutes(window.open!);
    const closeMinutes = timeToMinutes(window.close!);
    if (openMinutes === null || closeMinutes === null) continue;

    const windowEnd = closeMinutes > openMinutes ? closeMinutes : closeMinutes + 24 * 60;

    for (let cursor = openMinutes; cursor + itemDuration <= windowEnd; cursor += slotStep + slotBuffer) {
      const normalizedCursor = cursor >= 24 * 60 ? cursor - 24 * 60 : cursor;
      const startHours = Math.floor(normalizedCursor / 60);
      const startMinutes = normalizedCursor % 60;
      const slotStart = `${bookingDate}T${String(startHours).padStart(2, "0")}:${String(startMinutes).padStart(
        2,
        "0"
      )}:00`;
      const slotEndDate = new Date(new Date(slotStart).getTime() + itemDuration * 60 * 1000);

      const isFuture = slotEndDate > now;
      if (!isFuture) continue;

      slots.push({
        slot_start: slotStart,
        slot_end: slotEndDate.toISOString(),
        duration_minutes: itemDuration,
        available_capacity: store.slot_max_per_window ?? null,
      });
    }
  }

  return {
    status: 200 as const,
    body: {
      slots,
      slot_config: buildStoreSlotConfig(store),
      item: {
        id: item.id,
        title: item.title,
        duration_minutes: item.duration_minutes,
        supports_slot_booking: item.supports_slot_booking,
      },
    },
  };
}

router.get("/stores/:storeId/catalogue", async (req, res) => {
  const parsed = StoreIdSchema.safeParse(req.params.storeId);
  if (!parsed.success) return res.status(400).json({ error: "Invalid store id" });

  try {
    const payload = await getProductCataloguePayload(parsed.data);
    if (!payload) return res.status(404).json({ error: "Store not found" });
    return res.json(payload);
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

router.get("/stores/:storeId/services", async (req, res) => {
  const parsed = StoreIdSchema.safeParse(req.params.storeId);
  if (!parsed.success) return res.status(400).json({ error: "Invalid store id" });

  try {
    const payload = await getServiceCataloguePayload(parsed.data);
    if (!payload) return res.status(404).json({ error: "Store not found" });
    return res.json(payload);
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

router.get("/slots", async (req, res) => {
  const parsed = SlotsQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid query", details: parsed.error.flatten() });
  }

  try {
    const result = await buildServiceSlots({
      storeId: parsed.data.store_id,
      itemId: parsed.data.item_id,
      date: parsed.data.date,
    });
    return res.status(result.status).json(result.body);
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

router.post("/booking-drafts", async (req, res) => {
  const parsed = CreateBookingDraftSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid body", details: parsed.error.flatten() });
  }

  try {
    const store = await getStoreById(parsed.data.store_id);
    if (!store) return res.status(404).json({ error: "Store not found" });
    if (normalizeStoreType(store) !== "SERVICE") {
      return res.status(400).json({ error: "Only service stores support booking drafts" });
    }
    if (store.supports_time_slots !== true) {
      return res.status(400).json({ error: "Store does not support time slots" });
    }

    const { data: item, error: itemError } = await supabase
      .from("store_catalogue_items")
      .select("*")
      .eq("id", parsed.data.item_id)
      .eq("store_id", parsed.data.store_id)
      .maybeSingle();

    if (itemError) return res.status(500).json({ error: itemError.message });
    if (!item) return res.status(404).json({ error: "Item not found" });
    if (item.is_available !== true) {
      return res.status(400).json({ error: "Item is not available" });
    }
    if (item.supports_slot_booking !== true) {
      return res.status(400).json({ error: "Item does not support slot booking" });
    }

    const slotStart = new Date(parsed.data.slot_start);
    const slotEnd = new Date(parsed.data.slot_end);
    if (Number.isNaN(slotStart.getTime()) || Number.isNaN(slotEnd.getTime()) || slotEnd <= slotStart) {
      return res.status(400).json({ error: "Invalid slot range" });
    }

    const expectedDuration = Number(item.duration_minutes ?? store.slot_duration_minutes ?? 30);
    const actualDuration = Math.round((slotEnd.getTime() - slotStart.getTime()) / 60000);
    if (actualDuration !== expectedDuration) {
      return res.status(400).json({ error: "Slot duration does not match item duration" });
    }

    return res.status(201).json({
      draft: {
        id: randomUUID(),
        persisted: false,
        store_id: store.id,
        item_id: item.id,
        slot_start: slotStart.toISOString(),
        slot_end: slotEnd.toISOString(),
        item_snapshot: {
          id: item.id,
          title: item.title,
          price: item.price,
          duration_minutes: item.duration_minutes,
          supports_slot_booking: item.supports_slot_booking,
        },
      },
      note: "No booking draft table exists yet; this draft is validated but not persisted.",
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

router.post("/bill-sessions", async (req, res) => {
  const parsed = CreateBillSessionSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid body", details: parsed.error.flatten() });
  }

  try {
    const store = await getStoreById(parsed.data.store_id);
    if (!store) return res.status(404).json({ error: "Store not found" });

    const premiumEnabled =
      store.pickup_premium_enabled === true || String(store.pickup_mode ?? "").toUpperCase() === "PREMIUM";

    if (!premiumEnabled) {
      return res.status(400).json({ error: "Bill sessions require premium-enabled stores" });
    }

    const { data: item, error: itemError } = await supabase
      .from("store_catalogue_items")
      .select("*")
      .eq("id", parsed.data.item_id)
      .eq("store_id", parsed.data.store_id)
      .maybeSingle();

    if (itemError) return res.status(500).json({ error: itemError.message });
    if (!item) return res.status(404).json({ error: "Item not found" });
    if (item.is_billable !== true) {
      return res.status(400).json({ error: "Selected item is not billable" });
    }

    const quantity = parsed.data.quantity ?? 1;
    const unitPrice = Number(item.price ?? 0);
    const subtotal = unitPrice * quantity;

    return res.status(201).json({
      session: {
        id: randomUUID(),
        persisted: false,
        store_id: store.id,
        item_id: item.id,
        quantity,
        currency: "MUR",
        subtotal,
        total: subtotal,
        item_snapshot: {
          id: item.id,
          title: item.title,
          description: item.description,
          price: item.price,
          is_billable: item.is_billable,
          image_url: item.image_url,
        },
      },
      note: "No bill session table exists yet; this session is validated but not persisted.",
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

router.get("/stores/:storeId/categories", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  const parsed = StoreIdSchema.safeParse(req.params.storeId);
  if (!parsed.success) return res.status(400).json({ error: "Invalid store id" });

  const { data, error } = await supabase
    .from("store_catalogue_categories")
    .select("*")
    .eq("store_id", parsed.data)
    .order("sort_order", { ascending: true })
    .order("created_at", { ascending: true });

  if (error) return res.status(500).json({ error: error.message });
  return res.json({ items: data ?? [] });
});

router.post("/categories", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  const parsed = CreateCategorySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid body", details: parsed.error.flatten() });
  }

  const payload = buildNullAwarePayload({
    ...parsed.data,
    enabled: parsed.data.enabled ?? true,
    sort_order: parsed.data.sort_order ?? 0,
  });

  const { data, error } = await supabase
    .from("store_catalogue_categories")
    .insert(payload)
    .select("*")
    .single();

  if (error) return res.status(500).json({ error: error.message });
  return res.status(201).json({ item: data });
});

router.put("/categories/:id", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  const idParsed = StoreIdSchema.safeParse(req.params.id);
  if (!idParsed.success) return res.status(400).json({ error: "Invalid category id" });

  const parsed = UpdateCategorySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid body", details: parsed.error.flatten() });
  }

  const payload = buildNullAwarePayload(parsed.data);
  if (Object.keys(payload).length === 0) {
    return res.status(400).json({ error: "No fields to update" });
  }

  const { data, error } = await supabase
    .from("store_catalogue_categories")
    .update(payload)
    .eq("id", idParsed.data)
    .select("*")
    .single();

  if (error) return res.status(500).json({ error: error.message });
  return res.json({ item: data });
});

router.delete("/categories/:id", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  const idParsed = StoreIdSchema.safeParse(req.params.id);
  if (!idParsed.success) return res.status(400).json({ error: "Invalid category id" });

  const { error } = await supabase
    .from("store_catalogue_categories")
    .delete()
    .eq("id", idParsed.data);

  if (error) return res.status(500).json({ error: error.message });
  return res.json({ ok: true, id: idParsed.data });
});

router.get("/stores/:storeId/items", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  const parsed = StoreIdSchema.safeParse(req.params.storeId);
  if (!parsed.success) return res.status(400).json({ error: "Invalid store id" });

  const { data, error } = await supabase
    .from("store_catalogue_items")
    .select("*")
    .eq("store_id", parsed.data)
    .order("sort_order", { ascending: true })
    .order("created_at", { ascending: true });

  if (error) return res.status(500).json({ error: error.message });
  return res.json({ items: data ?? [] });
});

router.post("/items", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  const parsed = CreateItemSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid body", details: parsed.error.flatten() });
  }

  const payload = buildNullAwarePayload({
    ...parsed.data,
    is_available: parsed.data.is_available ?? true,
    sort_order: parsed.data.sort_order ?? 0,
    track_inventory: parsed.data.track_inventory ?? false,
    low_stock_threshold: parsed.data.low_stock_threshold ?? 5,
    allow_backorder: parsed.data.allow_backorder ?? false,
    sold_count: parsed.data.sold_count ?? 0,
    reserved_count: parsed.data.reserved_count ?? 0,
    is_image_catalogue: parsed.data.is_image_catalogue ?? false,
    is_billable: parsed.data.is_billable ?? false,
    supports_slot_booking: parsed.data.supports_slot_booking ?? false,
  });

  const { data, error } = await supabase
    .from("store_catalogue_items")
    .insert(payload)
    .select("*")
    .single();

  if (error) return res.status(500).json({ error: error.message });
  return res.status(201).json({ item: data });
});

router.put("/items/:id", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  const idParsed = StoreIdSchema.safeParse(req.params.id);
  if (!idParsed.success) return res.status(400).json({ error: "Invalid item id" });

  const parsed = UpdateItemSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid body", details: parsed.error.flatten() });
  }

  const payload = buildNullAwarePayload(parsed.data);
  if (Object.keys(payload).length === 0) {
    return res.status(400).json({ error: "No fields to update" });
  }

  const { data, error } = await supabase
    .from("store_catalogue_items")
    .update(payload)
    .eq("id", idParsed.data)
    .select("*")
    .single();

  if (error) return res.status(500).json({ error: error.message });
  return res.json({ item: data });
});

router.delete("/items/:id", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  const idParsed = StoreIdSchema.safeParse(req.params.id);
  if (!idParsed.success) return res.status(400).json({ error: "Invalid item id" });

  const { error } = await supabase
    .from("store_catalogue_items")
    .delete()
    .eq("id", idParsed.data);

  if (error) return res.status(500).json({ error: error.message });
  return res.json({ ok: true, id: idParsed.data });
});

export default router;
