import { Router } from "express";
import { createClient } from "@supabase/supabase-js";
import {
  getStoresHomeSectionById,
  syncAllStoresHomeSections,
  syncStoresHomeSectionItems,
} from "./storesHomeSections";

const router = Router();

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY!;

function supabaseAuthed(req: any) {
  const h = req.headers.authorization || "";
  const [type, token] = h.split(" ");
  if (type !== "Bearer" || !token) return null;

  return createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
}

async function requireSuperAdmin(req: any, res: any) {
  const sb = supabaseAuthed(req);
  if (!sb) {
    res.status(401).json({ error: "Missing token" });
    return null;
  }

  const {
    data: { user },
    error: userErr,
  } = await sb.auth.getUser();

  if (userErr || !user) {
    res.status(401).json({ error: "Invalid session" });
    return null;
  }

  const { data: profile, error: profileErr } = await sb
    .from("users")
    .select("role")
    .eq("id", user.id)
    .maybeSingle();

  if (profileErr) {
    res.status(500).json({ error: profileErr.message });
    return null;
  }

  const role = String(profile?.role || "").toLowerCase();
  if (role !== "superadmin") {
    res.status(403).json({ error: "Access denied" });
    return null;
  }

  return { sb, userId: user.id };
}

router.post("/sections/:id/sync", async (req, res) => {
  const auth = await requireSuperAdmin(req, res);
  if (!auth) return;

  try {
    const section = await getStoresHomeSectionById(req.params.id);
    if (!section) {
      return res.status(404).json({ error: "Section not found" });
    }

    const result = await syncStoresHomeSectionItems(req.params.id);

    return res.json({
      ok: true,
      section: result.section,
      summary: result.summary,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

router.post("/sections/sync-all", async (req, res) => {
  const auth = await requireSuperAdmin(req, res);
  if (!auth) return;

  try {
    const results = await syncAllStoresHomeSections();

    return res.json({
      ok: true,
      sections: results,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

export default router;
