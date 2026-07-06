import { createClient } from "@supabase/supabase-js";
import type { Response } from "express";
import { createRemoteJWKSet, jwtVerify } from "jose";
import supabase from "../../database/supabase";

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY!;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in env");
}

// Supabase signs access tokens with asymmetric keys (ES256) exposed via JWKS.
// createRemoteJWKSet fetches once and caches/refreshes the keys, so verifying a
// token below requires no per-request network call to Supabase Auth.
const SUPABASE_JWKS = createRemoteJWKSet(
  new URL(`${SUPABASE_URL}/auth/v1/.well-known/jwks.json`)
);

interface VerifiedToken {
  userId: string;
  email: string | null;
  phone: string | null;
  userMetadata: Record<string, any>;
}

/**
 * Verify a Supabase access token locally against the project JWKS.
 * Returns null (rather than throwing) so callers can fall back to a remote
 * getUser() check if local verification is not possible for a given token.
 */
async function verifyAccessTokenLocally(token: string): Promise<VerifiedToken | null> {
  try {
    const { payload } = await jwtVerify(token, SUPABASE_JWKS, {
      audience: "authenticated",
    });
    if (!payload.sub) return null;
    const userMetadata =
      payload.user_metadata && typeof payload.user_metadata === "object"
        ? (payload.user_metadata as Record<string, any>)
        : {};
    return {
      userId: String(payload.sub),
      email: typeof payload.email === "string" ? payload.email : null,
      phone: typeof payload.phone === "string" ? payload.phone : null,
      userMetadata,
    };
  } catch {
    return null;
  }
}

export interface AuthenticatedCustomer {
  userId: string;
  fullName: string | null;
  phone: string | null;
  email: string | null;
}

function normalizeAdminRole(value: any) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw) return "";
  if (["superadmin", "super_admin", "super admin"].includes(raw)) return "superadmin";
  if (["admin", "admin_user", "admin user"].includes(raw)) return "admin";
  return raw.replace(/[_\s]+/g, "");
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

  // Fast path: verify the Supabase access token locally against the project
  // JWKS (no network call). The token's claims give us everything callers need.
  const token = getBearerToken(req)!;
  const verified = await verifyAccessTokenLocally(token);
  if (verified) {
    const user = {
      id: verified.userId,
      email: verified.email,
      phone: verified.phone,
      user_metadata: verified.userMetadata,
    };
    return { sb, user };
  }

  // Fallback: if local verification fails for any reason, fall back to the
  // remote getUser() introspection so behaviour never regresses.
  const { data: userData, error: userErr } = await sb.auth.getUser();
  if (userErr || !userData?.user) {
    res.status(401).json({ error: "Unauthorized", code: "UNAUTHORIZED" });
    return null;
  }

  return { sb, user: userData.user };
}

export async function getAuthenticatedCustomer(req: any, res: Response): Promise<AuthenticatedCustomer | null> {
  
  // --- ADD THIS BYPASS BLOCK FOR LOAD TESTING ---
  if (req.headers["x-bypass-auth"] === "load-test-secret") {
    return {
      userId: "a6043906-66ae-44d9-bc96-9d92b844744e", // Make sure this UUID exists in your database `users` table
      fullName: "Load Test User",
      phone: "+1234567890",
      email: "loadtest@example.com"
    };
  }

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

  const role = normalizeAdminRole(
    roleRow?.role ?? userData.user.user_metadata?.role ?? userData.user.user_metadata?.app_role
  );
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
