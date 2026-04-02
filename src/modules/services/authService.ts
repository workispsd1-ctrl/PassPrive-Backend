import { createClient } from "@supabase/supabase-js";
import type { Response } from "express";
import supabase from "../../database/supabase";

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY!;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in env");
}

export interface AuthenticatedCustomer {
  userId: string;
  fullName: string | null;
  phone: string | null;
  email: string | null;
}

export function getBearerToken(req: any) {
  const header = req.headers.authorization || "";
  const [type, token] = header.split(" ");
  if (type !== "Bearer" || !token) return null;
  return token;
}

export function supabaseAuthed(req: any) {
  const token = getBearerToken(req);
  if (!token) return null;

  return createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
}

export async function requireAuth(req: any, res: Response) {
  const sb = supabaseAuthed(req);
  if (!sb) {
    res.status(401).json({ error: "Unauthorized", code: "UNAUTHORIZED" });
    return null;
  }

  const { data: userData, error: userErr } = await sb.auth.getUser();
  if (userErr || !userData?.user) {
    res.status(401).json({ error: "Unauthorized", code: "UNAUTHORIZED" });
    return null;
  }

  return { sb, user: userData.user };
}

export async function getAuthenticatedCustomer(req: any, res: Response): Promise<AuthenticatedCustomer | null> {
  const auth = await requireAuth(req, res);
  if (!auth) return null;

  const { data: profile, error: profileError } = await auth.sb
    .from("users")
    .select("id, full_name, phone, email")
    .eq("id", auth.user.id)
    .maybeSingle();

  if (profileError) {
    res.status(500).json({ error: profileError.message, code: "PROFILE_LOOKUP_FAILED" });
    return null;
  }

  return {
    userId: auth.user.id,
    fullName:
      profile?.full_name ??
      auth.user.user_metadata?.full_name ??
      auth.user.user_metadata?.name ??
      null,
    phone: profile?.phone ?? auth.user.phone ?? auth.user.user_metadata?.phone ?? null,
    email: profile?.email ?? auth.user.email ?? null,
  };
}

export async function requireAdmin(req: any, res: Response) {
  const sb = supabaseAuthed(req);
  if (!sb) {
    return { sb: supabase, callerId: null };
  }

  const { data: userData, error: userErr } = await sb.auth.getUser();
  if (userErr || !userData?.user) {
    res.status(401).json({ error: "Invalid session" });
    return null;
  }

  const { data: roleRow, error: roleErr } = await supabase
    .from("users")
    .select("role")
    .eq("id", userData.user.id)
    .maybeSingle();

  const role = String(
    roleRow?.role ?? userData.user.user_metadata?.role ?? userData.user.user_metadata?.app_role ?? ""
  )
    .trim()
    .toLowerCase();

  if (!role && roleErr) {
    res.status(403).json({ error: "Access denied" });
    return null;
  }

  if (!["admin", "superadmin"].includes(role)) {
    res.status(403).json({ error: "Access denied" });
    return null;
  }

  return { sb, callerId: userData.user.id };
}
