// src/routes/stores.ts
import { Router } from "express";
import { z } from "zod";
import supabase from "../../database/supabase";

const router = Router();

const IdSchema = z.string().uuid();

const ListQuerySchema = z.object({
  // search across name/slug/category/subcategory/city/region/tags
  search: z.string().trim().min(1).optional(),

  // filters
  city: z.string().trim().min(1).optional(),
  region: z.string().trim().min(1).optional(),
  country: z.string().trim().min(1).optional(),
  category: z.string().trim().min(1).optional(),
  subcategory: z.string().trim().min(1).optional(),
  tag: z.string().trim().min(1).optional(), // single tag filter
  is_featured: z
    .string()
    .optional()
    .transform((v) => (v === undefined ? undefined : v === "true")),

  // status maps to is_active
  status: z.enum(["active", "inactive"]).optional(),
  includeInactive: z
    .string()
    .optional()
    .transform((v) => v === "true"),

  // pagination
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

  // sorting (safe allowlist)
  sort: z
    .enum(["created_at", "updated_at", "name", "sort_order"])
    .optional()
    .default("created_at"),
  order: z.enum(["asc", "desc"]).optional().default("desc"),
});

const DeleteQuerySchema = z.object({
  hard: z
    .string()
    .optional()
    .transform((v) => v === "true"),
});

// GET /api/stores
// /api/stores?search=&city=&category=&tag=&status=&includeInactive=&limit=&offset=&sort=&order=&is_featured=
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
    region,
    country,
    category,
    subcategory,
    tag,
    is_featured,
    status,
    includeInactive,
    limit,
    offset,
    sort,
    order,
  } = parsed.data;

  let query = supabase.from("stores").select("*", { count: "exact" });

  // default: only active stores
  if (!includeInactive && !status) {
    query = query.eq("is_active", true);
  }
  if (status) {
    query = query.eq("is_active", status === "active");
  }

  // filters
  if (city) query = query.ilike("city", `%${city}%`);
  if (region) query = query.ilike("region", `%${region}%`);
  if (country) query = query.ilike("country", `%${country}%`);

  if (category) query = query.eq("category", category);
  if (subcategory) query = query.eq("subcategory", subcategory);

  if (typeof is_featured === "boolean") {
    query = query.eq("is_featured", is_featured);
  }

  // tag filter (array contains)
  if (tag) {
    // tags is text[]
    query = query.contains("tags", [tag]);
  }

  // search (OR)
  if (search) {
    const s = search.replace(/"/g, '\\"');

    // NOTE: PostgREST "or" string. Also includes tags with ilike via cast might not be allowed directly.
    // We'll cover common text fields. Tags search can be done via tag=... filter above.
    query = query.or(
      [
        `name.ilike.%${s}%`,
        `slug.ilike.%${s}%`,
        `category.ilike.%${s}%`,
        `subcategory.ilike.%${s}%`,
        `city.ilike.%${s}%`,
        `region.ilike.%${s}%`,
        `location_name.ilike.%${s}%`,
      ].join(",")
    );
  }

  // ordering
  query = query.order(sort, { ascending: order === "asc" });

  // IMPORTANT: for consistent ordering when values tie
  if (sort !== "created_at") {
    query = query.order("created_at", { ascending: false });
  }

  const from = offset;
  const to = offset + limit - 1;

  const { data, error, count } = await query.range(from, to);

  if (error) return res.status(500).json({ error: error.message });

  return res.json({
    items: data ?? [],
    page: { limit, offset, total: count ?? 0 },
  });
});

// GET /api/stores/:id
// Optional: ?include=payment,catalogue to fetch related tables in one response
router.get("/:id", async (req, res) => {
  const idParsed = IdSchema.safeParse(req.params.id);
  if (!idParsed.success) return res.status(400).json({ error: "Invalid store id" });

  const include = String(req.query.include ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const includePayment = include.includes("payment");
  const includeCatalogue = include.includes("catalogue");

  // main store
  const { data: store, error } = await supabase
    .from("stores")
    .select("*")
    .eq("id", idParsed.data)
    .maybeSingle();

  if (error) return res.status(500).json({ error: error.message });
  if (!store) return res.status(404).json({ error: "Store not found" });

  // related (optional)
  let payment: any = null;
  let catalogue: any[] = [];

  if (includePayment) {
    const resp = await supabase
      .from("store_payment_details")
      .select("*")
      .eq("store_id", store.id)
      .maybeSingle();

    if (resp.error) return res.status(500).json({ error: resp.error.message });
    payment = resp.data ?? null;
  }

  if (includeCatalogue) {
    const resp = await supabase
      .from("store_catalogue_items")
      .select("*")
      .eq("store_id", store.id)
      .order("sort_order", { ascending: true })
      .order("created_at", { ascending: true });

    if (resp.error) return res.status(500).json({ error: resp.error.message });
    catalogue = resp.data ?? [];
  }

  return res.json({
    item: store,
    ...(includePayment ? { payment } : {}),
    ...(includeCatalogue ? { catalogue } : {}),
  });
});

// DELETE /api/stores/:id?hard=true
// default: soft delete => is_active = false
// hard delete will cascade-delete payment_details and catalogue_items because of FK ON DELETE CASCADE
router.delete("/:id", async (req, res) => {
  const idParsed = IdSchema.safeParse(req.params.id);
  if (!idParsed.success) return res.status(400).json({ error: "Invalid store id" });

  const qParsed = DeleteQuerySchema.safeParse(req.query);
  if (!qParsed.success) {
    return res
      .status(400)
      .json({ error: "Invalid query", details: qParsed.error.flatten() });
  }

  const id = idParsed.data;
  const { hard } = qParsed.data;

  // Confirm exists
  const exists = await supabase
    .from("stores")
    .select("id,is_active")
    .eq("id", id)
    .maybeSingle();

  if (exists.error) return res.status(500).json({ error: exists.error.message });
  if (!exists.data) return res.status(404).json({ error: "Store not found" });

  if (hard) {
    const { error } = await supabase.from("stores").delete().eq("id", id);
    if (error) return res.status(500).json({ error: error.message });
    return res.json({ ok: true, deleted: "hard", id });
  }

  // Soft delete
  const { error } = await supabase
    .from("stores")
    .update({ is_active: false })
    .eq("id", id);

  if (error) return res.status(500).json({ error: error.message });

  return res.json({ ok: true, deleted: "soft", id });
});

export default router;
