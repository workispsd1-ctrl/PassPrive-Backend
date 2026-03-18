import { Router } from "express";
import { z } from "zod";
import { createClient } from "@supabase/supabase-js";
import supabaseAdmin from "../../database/supabase";

const router = Router();

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY!;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in env");
}

/* ---------------------------------------------
   HELPERS & AUTH
--------------------------------------------- */

/**
 * Builds a Supabase client that uses the user's JWT for RLS checks.
 */
function supabaseAuthed(req: any) {
  const h = req.headers.authorization || "";
  const [type, token] = h.split(" ");
  if (type !== "Bearer" || !token) return null;

  return createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
}

/**
 * Validates that the caller is an admin or superadmin.
 * Returns the authenticated user's ID on success, or null if validation fails
 * (after sending an appropriate error response).
 */
async function requireAdmin(req: any, res: any) {
  const sb = supabaseAuthed(req);
  if (!sb) {
    res.status(401).json({ error: "Missing token" });
    return null;
  }

  const { data: { user }, error: userErr } = await sb.auth.getUser();
  if (userErr || !user) {
    res.status(401).json({ error: "Invalid session" });
    return null;
  }

  const { data: row, error: roleErr } = await supabaseAdmin
    .from("users")
    .select("role")
    .eq("id", user.id)
    .maybeSingle();

  let role = row?.role?.toLowerCase() || "";

  // Fallback: Check Auth Metadata if role not found in DB
  if (!role && user.user_metadata?.role) {
    role = String(user.user_metadata.role).toLowerCase();
  }

  if (roleErr || !["admin", "superadmin"].includes(role)) {
    res.status(403).json({ error: "Access denied" });
    return null;
  }

  return { sb, callerId: user.id };
}

/* ---------------------------------------------
   SCHEMAS
--------------------------------------------- */
const CreateCorporateSchema = z.object({
  name: z.string().trim().min(1),
  phone: z.string().trim().nullable().optional(),
  email: z.string().trim().email().nullable().optional(),
  city: z.string().trim().nullable().optional(),
  area: z.string().trim().nullable().optional(),
  full_address: z.string().trim().nullable().optional(),
  plan: z.string().trim().nullable().optional(),
  subscription_id: z.string().uuid().nullable().optional(),
  subscription_start: z.string().nullable().optional(),
  subscription_expiry: z.string().nullable().optional(),
  seats: z.number().int().min(0).optional(),
  owner_user_id: z.string().uuid(),
  owner_email: z.string().trim().email(),
});

const UpdateCorporateSchema = z.object({
  name: z.string().trim().optional(), // Removed min(1) to allow empty string if frontend sends it
  phone: z.string().trim().nullable().optional(),
  email: z.string().trim().email().nullable().optional(),
  city: z.string().trim().nullable().optional(),
  area: z.string().trim().nullable().optional(),
  full_address: z.string().trim().nullable().optional(),
  is_active: z.boolean().optional(),
  plan: z.string().trim().nullable().optional(),
  seats: z.number().int().min(0).optional(),
  subscription_start: z.string().nullable().optional(),
  subscription_expiry: z.string().nullable().optional(),
  subscription_status: z.enum(['active', 'inactive', 'expired']).optional(),
});

const AddEmployeesSchema = z.object({
  employees: z.array(z.object({
    user_id: z.string().uuid(),
    name: z.string().trim().min(1),
    email: z.string().trim().email(),
    phone: z.string().trim().min(1),
    department: z.string().trim().nullable().optional(),
    designation: z.string().trim().nullable().optional(),
    created_at: z.string().nullable().optional(),
  })).min(1),
});

/* ---------------------------------------------
   ROUTES
--------------------------------------------- */

// ✅ GET ALL Corporates
router.get("/", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  const { data, error } = await supabaseAdmin
    .from("corporate")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json({ corporates: data });
});

// ✅ GET Single Corporate
router.get("/:id", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  const { data, error } = await supabaseAdmin
    .from("corporate")
    .select("*")
    .eq("id", req.params.id)
    .maybeSingle();

  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: "Corporate not found" });

  return res.status(200).json({ corporate: data });
});

// ✅ CREATE Corporate
router.post("/", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  const parsed = CreateCorporateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid body", details: parsed.error.flatten() });

  const body = parsed.data;

  try {
    let planText = body.plan || null;
    if (!planText && body.subscription_id) {
      const { data: planRow } = await supabaseAdmin
        .from("subscription")
        .select("plan_name")
        .eq("id", body.subscription_id)
        .maybeSingle();
      if (planRow) planText = planRow.plan_name;
    }

    const { data: corporate, error: corpErr } = await supabaseAdmin
      .from("corporate")
      .insert({
        name: body.name,
        phone: body.phone ?? null,
        email: body.email ?? body.owner_email,
        city: body.city ?? null,
        area: body.area ?? null,
        full_address: body.full_address ?? null,
        owner_user_id: body.owner_user_id,
        owner_email: body.owner_email,
        plan: planText,
        seats: body.seats ?? 0,
        subscription_start: body.subscription_start || null,
        subscription_expiry: body.subscription_expiry || null,
        subscription_status: "active",
        is_active: true,
        employees: [],
      })
      .select("*")
      .single();

    if (corpErr) return res.status(500).json({ error: corpErr.message });
    return res.status(201).json({ corporate });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// ✅ UPDATE Corporate
router.put("/", async (req, res) => res.status(400).json({ error: "ID is required for update" }));
router.put("/:id", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  const parsed = UpdateCorporateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid body", details: parsed.error.flatten() });

  const { data: updated, error } = await supabaseAdmin
    .from("corporate")
    .update({ ...parsed.data, updated_at: new Date().toISOString() })
    .eq("id", req.params.id)
    .select("*")
    .single();

  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json({ success: true, corporate: updated });
});

// ✅ ADD/UPDATE Employees (Append to JSONB)
router.post("/:id/employees", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  const parsed = AddEmployeesSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: "Invalid body",
      details: parsed.error.flatten()
    });
  }

  const { data: corp, error: fetchErr } = await supabaseAdmin
    .from("corporate")
    .select("employees, seats")
    .eq("id", req.params.id)
    .single();

  if (fetchErr || !corp) return res.status(404).json({ error: "Not found" });

  const existing = Array.isArray(corp.employees) ? corp.employees : [];
  const merged = [...existing];

  for (const emp of parsed.data.employees) {
    const idx = merged.findIndex(e => e.user_id === emp.user_id);
    if (idx >= 0) {
      merged[idx] = { ...merged[idx], ...emp };
    } else {
      merged.push({
        ...emp,
        created_at: emp.created_at || new Date().toISOString()
      });
    }
  }

  const { data: updated, error: updErr } = await supabaseAdmin
    .from("corporate")
    .update({ employees: merged })
    .eq("id", req.params.id)
    .select("employees")
    .single();

  if (updErr) return res.status(500).json({ error: updErr.message });
  return res.status(200).json({ ok: true, employees: updated.employees });
});

// ✅ DELETE Employee from JSONB
router.delete("/:id/employees/:userId", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  const { data: corp } = await supabaseAdmin
    .from("corporate")
    .select("employees")
    .eq("id", req.params.id)
    .single();

  if (!corp) return res.status(404).json({ error: "Corporate not found" });

  const next = (Array.isArray(corp.employees) ? corp.employees : [])
    .filter((e: any) => String(e?.user_id || "") !== req.params.userId);

  const { error: updErr } = await supabaseAdmin
    .from("corporate")
    .update({ employees: next })
    .eq("id", req.params.id);

  if (updErr) return res.status(500).json({ error: updErr.message });
  return res.status(200).json({ ok: true });
});

export default router;
