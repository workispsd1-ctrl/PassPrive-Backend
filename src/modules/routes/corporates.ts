// src/modules/routes/corporates.ts
import { Router } from "express";
import { z } from "zod";
import { createClient } from "@supabase/supabase-js";

const router = Router();

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY!;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in env");
}

function getBearerToken(req: any) {
  const h = req.headers.authorization || "";
  const [type, token] = h.split(" ");
  if (type !== "Bearer" || !token) return null;
  return token;
}

function supabaseAuthed(req: any) {
  const token = getBearerToken(req);
  if (!token) return null;

  // Using service key + caller's Bearer token to evaluate RLS/Policies for reads/writes
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
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

/* ---------------------------------------------
   CREATE Corporate (same as you had)
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

function toDateOrNull(s?: string | null) {
  if (!s) return null;
  return s; // "YYYY-MM-DD"
}

router.post("/", async (req, res) => {
  const parsed = CreateCorporateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: "Invalid body",
      details: parsed.error.flatten(),
    });
  }

  const admin = await requireAdmin(req, res);
  if (!admin) return;

  const { sb } = admin;
  const body = parsed.data;

  try {
    // Resolve plan text
    let planText: string | null = body.plan ?? null;

    if (!planText && body.subscription_id) {
      const { data: planRow, error: planErr } = await sb
        .from("subscription")
        .select("id,plan_name")
        .eq("id", body.subscription_id)
        .maybeSingle();

      if (planErr) return res.status(500).json({ error: planErr.message });
      if (!planRow) return res.status(400).json({ error: "Invalid subscription_id" });

      planText = planRow.plan_name;
    }

    // Validate owner exists in public.users
    const { data: ownerRow, error: ownerErr } = await sb
      .from("users")
      .select("id,email,role")
      .eq("id", body.owner_user_id)
      .maybeSingle();

    if (ownerErr) return res.status(500).json({ error: ownerErr.message });
    if (!ownerRow) return res.status(400).json({ error: "Owner user not found in users table" });

    if (String(ownerRow.email || "").toLowerCase() !== body.owner_email.toLowerCase()) {
      return res.status(400).json({ error: "owner_email does not match users.email" });
    }

    const { data: corporate, error: corpErr } = await sb
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

        subscription_start: toDateOrNull(body.subscription_start),
        subscription_expiry: toDateOrNull(body.subscription_expiry),

        subscription_status: "active",
        is_active: true,

        // ✅ IMPORTANT: employees jsonb array
        employees: [],
      })
      .select("*")
      .single();

    if (corpErr) return res.status(500).json({ error: corpErr.message });

    return res.status(201).json({ corporate });
  } catch (err: any) {
    console.error(err);
    return res.status(500).json({ error: err?.message || "Server error" });
  }
});

/* ---------------------------------------------
   EMPLOYEES JSONB: APPEND + REMOVE
--------------------------------------------- */

const EmployeeJsonSchema = z.object({
  user_id: z.string().uuid(),
  name: z.string().trim().min(1),
  email: z.string().trim().email(),
  phone: z.string().trim().min(1),
  department: z.string().trim().optional().nullable(),
  designation: z.string().trim().optional().nullable(),
  created_at: z.string().optional().nullable(), // ISO allowed
});

const AddEmployeesSchema = z.object({
  employees: z.array(EmployeeJsonSchema).min(1),
});

const CorporateIdParamSchema = z.object({
  id: z.string().uuid(),
});

const RemoveEmployeeParamSchema = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
});

// ✅ POST /api/corporates/:id/employees  -> append into corporate.employees
router.post("/:id/employees", async (req, res) => {
  const p = CorporateIdParamSchema.safeParse(req.params);
  if (!p.success) return res.status(400).json({ error: "Invalid corporate id" });

  const parsed = AddEmployeesSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid body", details: parsed.error.flatten() });
  }

  const admin = await requireAdmin(req, res);
  if (!admin) return;

  const { sb } = admin;
  const corporateId = p.data.id;
  const incoming = parsed.data.employees;

  try {
    // Load corporate row (employees + seats)
    const { data: corp, error: corpErr } = await sb
      .from("corporate")
      .select("id,seats,employees")
      .eq("id", corporateId)
      .single();

    if (corpErr) return res.status(500).json({ error: corpErr.message });
    if (!corp) return res.status(404).json({ error: "Corporate not found" });

    const existing: any[] = Array.isArray(corp.employees) ? corp.employees : [];
    const seats = Number(corp.seats || 0);

    // Optional: validate users exist
    const ids = incoming.map((e) => e.user_id);
    const { data: usersRows, error: usersErr } = await sb
      .from("users")
      .select("id,email")
      .in("id", ids);

    if (usersErr) return res.status(500).json({ error: usersErr.message });

    const usersMap = new Map((usersRows || []).map((u: any) => [u.id, u.email]));

    for (const emp of incoming) {
      if (!usersMap.has(emp.user_id)) {
        return res.status(400).json({ error: `User not found in users table: ${emp.user_id}` });
      }
      const email = String(usersMap.get(emp.user_id) || "").toLowerCase();
      if (email !== emp.email.toLowerCase()) {
        return res.status(400).json({
          error: `Email mismatch for user_id ${emp.user_id}: users.email != provided email`,
        });
      }
    }

    // ✅ merge + dedupe by user_id (and also by email fallback)
    const byUserId = new Map<string, any>();
    for (const e of existing) {
      const uid = String(e?.user_id || "");
      if (uid) byUserId.set(uid, e);
    }

    for (const emp of incoming) {
      const nowIso = new Date().toISOString();
      byUserId.set(emp.user_id, {
        user_id: emp.user_id,
        name: emp.name,
        email: emp.email,
        phone: emp.phone,
        department: emp.department ?? null,
        designation: emp.designation ?? null,
        created_at: emp.created_at ?? nowIso,
      });
    }

    const merged = Array.from(byUserId.values());

    // Optional seats enforcement (if seats > 0)
    if (seats > 0 && merged.length > seats) {
      return res.status(400).json({
        error: `Seats exceeded. Seats=${seats}, requested employees=${merged.length}`,
      });
    }

    const { data: updated, error: updErr } = await sb
      .from("corporate")
      .update({ employees: merged })
      .eq("id", corporateId)
      .select("id,employees,seats")
      .single();

    if (updErr) return res.status(500).json({ error: updErr.message });

    return res.status(200).json({
      ok: true,
      corporate_id: updated.id,
      employees: updated.employees,
      seats: updated.seats,
    });
  } catch (err: any) {
    console.error(err);
    return res.status(500).json({ error: err?.message || "Server error" });
  }
});

// ✅ DELETE /api/corporates/:id/employees/:userId  -> remove from corporate.employees
router.delete("/:id/employees/:userId", async (req, res) => {
  const p = RemoveEmployeeParamSchema.safeParse(req.params);
  if (!p.success) return res.status(400).json({ error: "Invalid params" });

  const admin = await requireAdmin(req, res);
  if (!admin) return;

  const { sb } = admin;
  const { id: corporateId, userId } = p.data;

  try {
    const { data: corp, error: corpErr } = await sb
      .from("corporate")
      .select("id,employees")
      .eq("id", corporateId)
      .single();

    if (corpErr) return res.status(500).json({ error: corpErr.message });
    if (!corp) return res.status(404).json({ error: "Corporate not found" });

    const existing: any[] = Array.isArray(corp.employees) ? corp.employees : [];
    const next = existing.filter((e) => String(e?.user_id || "") !== userId);

    const { data: updated, error: updErr } = await sb
      .from("corporate")
      .update({ employees: next })
      .eq("id", corporateId)
      .select("id,employees")
      .single();

    if (updErr) return res.status(500).json({ error: updErr.message });

    return res.status(200).json({
      ok: true,
      corporate_id: updated.id,
      employees: updated.employees,
    });
  } catch (err: any) {
    console.error(err);
    return res.status(500).json({ error: err?.message || "Server error" });
  }
});

export default router;
