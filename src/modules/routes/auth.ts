import express, { Request, Response } from "express";
import { createClient } from "@supabase/supabase-js";
import supabase from "../../database/supabase";
import { EmtelProvider } from "../services/smsService";
import { OtpService } from "../services/otpService";

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_KEY =
  process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY!;

function getProjectRef(url: string | undefined) {
  const match = String(url ?? "").match(/^https:\/\/([^.]+)\.supabase\.co$/i);
  return match?.[1] ?? "unknown";
}

function supabaseAuthed(req: any) {
  const h = req.headers.authorization || "";
  const [type, token] = h.split(" ");
  if (type !== "Bearer" || !token) return null;

  return createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
}

// Dedicated service account client for auth.admin operations
const supabaseService = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

function normalizeAdminRole(value: any) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw) return "";
  if (["superadmin", "super_admin", "super admin"].includes(raw)) return "superadmin";
  if (["admin", "admin_user", "admin user"].includes(raw)) return "admin";
  return raw.replace(/[_\s]+/g, "");
}

async function requireAdmin(req: any, res: any) {
  const authHeader = req.headers.authorization || "";
  const [authType, authToken] = authHeader.split(" ");
  console.log("[auth/create-user] auth check start", {
    path: req.originalUrl,
    method: req.method,
    hasAuthorizationHeader: Boolean(authHeader),
    authorizationType: authType || null,
    bearerTokenExtracted: Boolean(authType === "Bearer" && authToken),
    backendSupabaseUrl: SUPABASE_URL,
    backendSupabaseProjectRef: getProjectRef(SUPABASE_URL),
  });

  const sb = supabaseAuthed(req);
  if (!sb) {
    console.warn("[auth/create-user] missing or malformed authorization header", {
      hasAuthorizationHeader: Boolean(authHeader),
      authorizationPreview: authHeader ? `${String(authHeader).slice(0, 24)}...` : null,
    });
    res.status(401).json({ error: "Missing token" });
    return null;
  }

  const { data: { user }, error: userErr } = await sb.auth.getUser();
  console.log("[auth/create-user] auth.getUser result", {
    hasUser: Boolean(user),
    userId: user?.id ?? null,
    authErrorMessage: userErr?.message ?? null,
    authErrorStatus: (userErr as any)?.status ?? null,
    authErrorCode: (userErr as any)?.code ?? null,
  });
  if (userErr || !user) {
    res.status(401).json({ error: "Invalid session" });
    return null;
  }

  const { data: row, error: roleErr } = await supabaseService
    .from("users")
    .select("role")
    .eq("id", user.id)
    .maybeSingle();

  const role = normalizeAdminRole(row?.role ?? user.user_metadata?.role ?? user.user_metadata?.app_role);
  if (!role && roleErr) {
    res.status(403).json({ error: "Access denied" });
    return null;
  }
  if (!["admin", "superadmin"].includes(role)) {
    res.status(403).json({ error: "Access denied" });
    return null;
  }

  return { sb, callerId: user.id };
}

const router = express.Router();

type CreateUserBody = {
  email: string;
  password: string;
  full_name?: string;
  phone?: string;
  role: string;

  membership?: string | null;
  membership_tier?: string | null;
  membership_started?: string | null;
  membership_expiry?: string | null;

  corporate_code?: string | null;
  corporate_code_status?: string | null;
};

type BulkBody = {
  users: CreateUserBody[];
};

//Hello pushing the code

function isBulk(body: any): body is BulkBody {
  return body && Array.isArray(body.users);
}

async function createOneUser(input: CreateUserBody, sb: any) {
  const { email, password, full_name, phone, role } = input;

  if (!email || !password || !role) {
    return { ok: false, error: "Email, password and role are required" };
  }

  // Prefer admin API when available.
  const { data: adminData, error: adminError } = await supabaseService.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { role, full_name: full_name || null, phone: phone || null },
  });

  let userId = adminData.user?.id;

  // Fallback for projects configured with anon-style key on backend.
  if (adminError && String(adminError.message || "").toLowerCase() === "user not allowed") {
    const { data: signUpData, error: signUpErr } = await supabaseService.auth.signUp({
      email,
      password,
      options: {
        data: {
          role,
          full_name: full_name || null,
          phone: phone || null,
        },
      },
    });

    if (signUpErr) {
      return {
        ok: false,
        error: signUpErr.message,
        hint: "Supabase admin key is not privileged. Use service_role key in SUPABASE_SERVICE_KEY for admin create-user behavior.",
      };
    }

    userId = signUpData.user?.id;
  } else if (adminError) {
    return { ok: false, error: adminError.message };
  }

  if (!userId) return { ok: false, error: "User not returned from admin.createUser" };

  const { data: user, error: insertError } = await supabaseService
    .from("users")
    .insert({
      id: userId,
      email,
      full_name: full_name || null,
      phone: phone || null,
      role,

      // ✅ merchants (restaurant/store partners) are cashback-whitelisted on onboarding
      cashback_enabled: ["restaurantpartner", "storepartner"].includes(role),

      profile_image: null,
      gender: null,
      dob: null,

      // ✅ membership details
      membership: input.membership ?? null,
      membership_tier: input.membership_tier ?? "none",
      membership_started: input.membership_started ?? null,
      membership_expiry: input.membership_expiry ?? null,

      // ✅ corporate details
      corporate_code: input.corporate_code ?? null,
      corporate_code_status: input.corporate_code_status ?? "pending",
    })
    .select("*")
    .single();

  if (insertError) {
    return {
      ok: false,
      error: insertError.message,
      hint: "RLS might block insert. Add policy: WITH CHECK (auth.uid() = id).",
    };
  }

  return { ok: true, user };
}

router.post("/create-user", async (req: Request, res: Response) => {
  try {
    const admin = await requireAdmin(req, res);
    if (!admin) return;

    if (isBulk(req.body)) {
      const users = req.body.users || [];
      if (!users.length) return res.status(400).json({ error: "users[] is required" });

      if (users.length > 200) {
        return res.status(400).json({ error: "Too many users in one request (max 200)" });
      }

      const created: any[] = [];
      const failed: any[] = [];

      for (const u of users) {
        const result = await createOneUser(u, admin.sb);
        if (result.ok) created.push(result.user);
        else failed.push({ email: u.email, error: result.error, hint: (result as any).hint });
      }

      return res.status(200).json({
        created_count: created.length,
        failed_count: failed.length,
        created,
        failed,
      });
    }

    const result = await createOneUser(req.body as CreateUserBody, admin.sb);
    if (!result.ok) return res.status(400).json(result);

    return res.status(201).json({ user: result.user });
  } catch (err: any) {
    console.error(err);
    return res.status(500).json({ error: err?.message || "Server error" });
  }
});

router.post("/send-otp", async (req: Request, res: Response) => {
  const { phone } = req.body;
  if (!phone) {
    return res.status(400).json({ success: false, error: "Phone number is required." });
  }

  try {
    const otp = await OtpService.generateAndSaveOtp(phone);

    const message = `Your PassPrive verification code is ${otp}.\n\nThis code is valid for 5 minutes.\n\nDo not share this code with anyone.`;
    const smsProvider = new EmtelProvider();
    const smsResult = await smsProvider.send(phone, message);

    if (smsResult.success) {
      console.log(`[OTP] SMS sent successfully to ${phone}. Provider response: ${smsResult.message}`);
      return res.status(200).json({ success: true, message: "OTP sent successfully." });
    } else {
      console.error(`[OTP] SMS delivery failed for ${phone}. Provider status: ${smsResult.statusCode}. Response: ${smsResult.message}`);
      return res.status(502).json({
        success: false,
        error: "Failed to deliver OTP via SMS provider.",
        details: smsResult.message,
      });
    }
  } catch (err: any) {
    console.error(`[OTP] Error in /send-otp for ${phone}:`, err);
    return res.status(400).json({ success: false, error: err.message || "Failed to send OTP." });
  }
});

router.post("/verify-otp", async (req: Request, res: Response) => {
  const { phone, code } = req.body;
  if (!phone || !code) {
    return res.status(400).json({ success: false, error: "Phone number and OTP code are required." });
  }

  try {
    const verification = await OtpService.verifyOtp(phone, code);
    if (!verification.success) {
      return res.status(400).json({ success: false, error: verification.message });
    }

    // Match on the significant digits, not the exact string. 28 stored numbers
    // have no country code while the app always sends one, so equality reported
    // existing users as brand new. Nine numbers are duplicated, which made
    // .maybeSingle() fail and surfaced a raw database error on the OTP screen.
    const digits = String(phone).replace(/\D/g, "");
    const localPart = digits.slice(-8);

    const { data: matches, error: userError } = await supabase
      .from("users")
      .select("id,email,phone")
      .ilike("phone", `%${localPart}`)
      .limit(5);

    if (userError) {
      console.error(`[OTP] Error checking user registration:`, userError);
      return res.status(500).json({
        success: false,
        error: "Something went wrong. Please try again.",
      });
    }

    // Prefer a row with an email — that is what the session is minted from.
    const user = (matches ?? []).find(m => m?.email) ?? (matches ?? [])[0] ?? null;
    const registered = !!user;

    // Verifying the OTP is what proves ownership of the phone, but on its own it
    // leaves the caller unauthenticated: every RLS policy and every
    // supabase.auth.getUser() in the app keys off a real session. Mint one here
    // so "OTP verified" and "signed in" are the same event.
    let sessionToken: string | null = null;
    let session: { access_token: string; refresh_token: string } | null = null;
    if (registered && user?.email) {
      const { data: link, error: linkError } = await supabase.auth.admin.generateLink({
        type: "magiclink",
        email: user.email,
      });

      if (linkError) {
        console.error(`[OTP] Could not mint a session for ${phone}:`, linkError);
        return res.status(500).json({
          success: false,
          error: "Verified, but could not sign you in. Please try again.",
        });
      }

      sessionToken = link?.properties?.hashed_token ?? null;

      // Redeem the hash here rather than making the phone do it. That turns two
      // sequential round-trips from the device into one, and the server->Supabase
      // hop is far cheaper than mobile->Supabase. A throwaway client keeps the
      // resulting session off the shared admin singleton.
      if (sessionToken) {
        const exchangeClient = createClient(
          process.env.SUPABASE_URL!,
          process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY!,
          { auth: { persistSession: false, autoRefreshToken: false } },
        );

        const { data: verified, error: exchangeError } = await exchangeClient.auth.verifyOtp({
          token_hash: sessionToken,
          type: "magiclink",
        });

        if (!exchangeError && verified?.session) {
          session = {
            access_token: verified.session.access_token,
            refresh_token: verified.session.refresh_token,
          };
          sessionToken = null; // spent — don't hand a dead hash to the client
        }
      }
    }

    return res.status(200).json({
      success: true,
      message: "OTP verified successfully.",
      registered,
      // Preferred: ready-to-use tokens, applied locally with setSession().
      session,
      // Fallback for clients that still redeem the hash themselves.
      session_token: sessionToken,
    });
  } catch (err: any) {
    console.error(`[OTP] Error in /verify-otp for ${phone}:`, err);
    return res.status(500).json({ success: false, error: err.message || "Failed to verify OTP." });
  }
});

export default router;
