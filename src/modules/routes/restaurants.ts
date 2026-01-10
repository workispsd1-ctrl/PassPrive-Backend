// src/modules/routes/restaurants.ts
import { Router } from "express";
import { z } from "zod";
import { createClient } from "@supabase/supabase-js";
import supabase from "../../database/supabase";

const router = Router();

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_ANON_KEY = process.env.SUPABASE_SERVICE_KEY!;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  throw new Error("Missing SUPABASE_URL or SUPABASE_ANON_KEY in env");
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

// ✅ FIX: z.record(keySchema, valueSchema)
const OpeningHoursSchema = z.record(
  z.string(),
  z.object({
    open: z.string(),
    close: z.string(),
  })
);

/**
 * ✅ POST create restaurant ONLY (NO partner creation here)
 * owner_user_id can be passed from frontend after /api/auth/create-user returns id
 */
const CreateRestaurantSchema = z.object({
  name: z.string().trim().min(1),
  phone: z.string().trim().optional().nullable(),
  city: z.string().trim().optional().nullable(),
  area: z.string().trim().optional().nullable(),
  full_address: z.string().trim().optional().nullable(),

  cuisines: z.array(z.string()).optional().default([]),
  cost_for_two: z.number().int().optional().nullable(),
  distance: z.number().optional().nullable(),
  offer: z.string().trim().optional().nullable(),

  facilities: z.array(z.string()).optional().default([]),
  highlights: z.array(z.string()).optional().default([]),
  worth_visit: z.array(z.string()).optional().default([]),

  opening_hours: OpeningHoursSchema.optional().default({}),

  reviews: z.any().optional().default([]),
  menu: z.any().optional().default([]),

  food_images: z.array(z.string()).optional().default([]),
  ambience_images: z.array(z.string()).optional().default([]),
  cover_image: z.string().optional().nullable(),

  is_active: z.boolean().optional().default(true),

  slug: z.string().trim().min(1),
  latitude: z.number().optional().nullable(),
  longitude: z.number().optional().nullable(),

  booking_enabled: z.boolean().optional().default(true),
  avg_duration_minutes: z.number().int().optional().default(90),
  max_bookings_per_slot: z.number().int().optional().nullable(),
  advance_booking_days: z.number().int().optional().default(30),

  // ✅ optional: allow admin to set owner_user_id at creation time
  owner_user_id: z.string().uuid().optional().nullable(),
});

const UpdateRestaurantSchema = z.object({
  name: z.string().trim().min(1).optional(),
  phone: z.string().trim().nullable().optional(),
  city: z.string().trim().nullable().optional(),
  area: z.string().trim().nullable().optional(),
  full_address: z.string().trim().nullable().optional(),

  cuisines: z.array(z.string()).optional(),
  cost_for_two: z.number().int().nullable().optional(),
  distance: z.number().nullable().optional(),
  offer: z.string().trim().nullable().optional(),

  facilities: z.array(z.string()).optional(),
  highlights: z.array(z.string()).optional(),
  worth_visit: z.array(z.string()).optional(),

  opening_hours: OpeningHoursSchema.nullable().optional(),

  reviews: z.any().optional(),
  menu: z.any().optional(),

  food_images: z.array(z.string()).optional(),
  ambience_images: z.array(z.string()).optional(),
  cover_image: z.string().nullable().optional(),

  is_active: z.boolean().optional(),

  slug: z.string().trim().min(1).optional(),
  latitude: z.number().nullable().optional(),
  longitude: z.number().nullable().optional(),

  booking_enabled: z.boolean().optional(),
  avg_duration_minutes: z.number().int().optional(),
  max_bookings_per_slot: z.number().int().nullable().optional(),
  advance_booking_days: z.number().int().optional(),

  // ✅ allow admin to relink owner if needed
  owner_user_id: z.string().uuid().nullable().optional(),
});

/* ---------------------------------------------
   ROUTES
--------------------------------------------- */

// ✅ Public: GET /api/restaurants
router.get("/", async (req, res) => {
  const parsed = ListQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res
      .status(400)
      .json({ error: "Invalid query", details: parsed.error.flatten() });
  }

  const { search, city, area, status, includeInactive, limit, offset, sort, order } =
    parsed.data;

  let query = supabase.from("restaurants").select("*", { count: "exact" });

  if (!includeInactive && !status) query = query.eq("is_active", true);
  if (status) query = query.eq("is_active", status === "active");
  if (city) query = query.ilike("city", `%${city}%`);
  if (area) query = query.ilike("area", `%${area}%`);

  if (search) {
    const s = search.replace(/"/g, '\\"');
    query = query.or(
      `name.ilike.%${s}%,phone.ilike.%${s}%,area.ilike.%${s}%,city.ilike.%${s}%`
    );
  }

  query = query.order(sort, { ascending: order === "asc" });

  const from = offset;
  const to = offset + limit - 1;

  const { data, error, count } = await query.range(from, to);
  if (error) return res.status(500).json({ error: error.message });

  return res.json({ items: data ?? [], page: { limit, offset, total: count ?? 0 } });
});

// ✅ Public: GET /api/restaurants/:id
router.get("/:id", async (req, res) => {
  const idParsed = IdSchema.safeParse(req.params.id);
  if (!idParsed.success) return res.status(400).json({ error: "Invalid restaurant id" });

  const { data, error } = await supabase
    .from("restaurants")
    .select("*")
    .eq("id", idParsed.data)
    .maybeSingle();

  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: "Restaurant not found" });

  return res.json({ item: data });
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

      cuisines: body.cuisines ?? [],
      cost_for_two: body.cost_for_two ?? null,
      distance: body.distance ?? null,
      offer: body.offer ?? null,

      facilities: body.facilities ?? [],
      highlights: body.highlights ?? [],
      worth_visit: body.worth_visit ?? [],

      opening_hours: body.opening_hours ?? {},
      reviews: body.reviews ?? [],
      menu: body.menu ?? [],

      food_images: body.food_images ?? [],
      ambience_images: body.ambience_images ?? [],
      cover_image: body.cover_image ?? null,

      is_active: body.is_active ?? true,

      slug: body.slug,
      latitude: body.latitude ?? null,
      longitude: body.longitude ?? null,

      booking_enabled: body.booking_enabled ?? true,
      avg_duration_minutes: body.avg_duration_minutes ?? 90,
      max_bookings_per_slot: body.max_bookings_per_slot ?? null,
      advance_booking_days: body.advance_booking_days ?? 30,

      owner_user_id: body.owner_user_id ?? null,
    })
    .select()
    .single();

  if (error) {
    if ((error as any)?.code === "23505") return res.status(400).json({ error: "Slug already exists" });
    return res.status(500).json({ error: error.message });
  }

  return res.status(201).json({ restaurant: data });
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
    return res
      .status(400)
      .json({ error: "Invalid body", details: bodyParsed.error.flatten() });
  }

  const id = idParsed.data;

  const access = await requireRestaurantWriteAccess(req, res, id);
  if (!access) return;

  const { data, error } = await access.sb
    .from("restaurants")
    .update(bodyParsed.data)
    .eq("id", id)
    .select()
    .single();

  if (error) {
    if ((error as any)?.code === "23505") return res.status(400).json({ error: "Slug already exists" });
    return res.status(500).json({ error: error.message });
  }

  return res.json({ item: data });
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
    .select("id,is_active")
    .eq("id", id)
    .maybeSingle();

  if (exists.error) return res.status(500).json({ error: exists.error.message });
  if (!exists.data) return res.status(404).json({ error: "Restaurant not found" });

  if (hard) {
    const { error } = await access.sb.from("restaurants").delete().eq("id", id);
    if (error) return res.status(500).json({ error: error.message });
    return res.json({ ok: true, deleted: "hard", id });
  }

  const { error } = await access.sb
    .from("restaurants")
    .update({ is_active: false })
    .eq("id", id);

  if (error) return res.status(500).json({ error: error.message });

  return res.json({ ok: true, deleted: "soft", id });
});

export default router;
