import express, { Request, Response } from "express";
import crypto from "crypto";
import supabase, { supabaseServiceRole as supabaseService, supabaseAuthed } from "../../database/supabase";
import { EmtelProvider } from "../services/smsService";
import { OtpService } from "../services/otpService";

function getProjectRef(url: string | undefined) {
  const match = String(url ?? "").match(/^https:\/\/([^.]+)\.supabase\.co$/i);
  return match?.[1] ?? "unknown";
}

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
    backendSupabaseUrl: process.env.SUPABASE_URL,
    backendSupabaseProjectRef: getProjectRef(process.env.SUPABASE_URL),
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

const SIGNUP_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const SIGNUP_SECRET =
  process.env.OTP_SIGNUP_SECRET?.trim() ||
  process.env.SUPABASE_SERVICE_KEY?.trim() ||
  process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ||
  "";

function signSignupToken(phone: string): string | null {
  if (!SIGNUP_SECRET) return null;
  const body = Buffer.from(JSON.stringify({ phone, exp: Date.now() + SIGNUP_TOKEN_TTL_MS })).toString("base64url");
  const sig = crypto.createHmac("sha256", SIGNUP_SECRET).update(body).digest("base64url");
  return `${body}.${sig}`;
}

function readSignupToken(token: unknown): string | null {
  if (!SIGNUP_SECRET || typeof token !== "string") return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expected = crypto.createHmac("sha256", SIGNUP_SECRET).update(body).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const { phone, exp } = JSON.parse(Buffer.from(body, "base64url").toString());
    if (typeof phone !== "string" || typeof exp !== "number" || exp < Date.now()) return null;
    return phone;
  } catch {
    return null;
  }
}

async function findUsersByPhone(phone: string) {
  const localPart = String(phone).replace(/\D/g, "").slice(-8);
  return supabase.from("users").select("id,email,phone").ilike("phone", `%${localPart}`).limit(5);
}

async function mintSession(email: string) {
  const { data: link, error: linkError } = await supabase.auth.admin.generateLink({
    type: "magiclink",
    email,
  });
  if (linkError) return { error: linkError, session: null, sessionToken: null };

  let sessionToken: string | null = link?.properties?.hashed_token ?? null;
  let session: { access_token: string; refresh_token: string } | null = null;
  if (sessionToken) {
    const { data: verified, error: exchangeError } = await supabase.auth.verifyOtp({
      token_hash: sessionToken,
      type: "magiclink",
    });
    if (!exchangeError && verified?.session) {
      session = {
        access_token: verified.session.access_token,
        refresh_token: verified.session.refresh_token,
      };
      sessionToken = null;
    }
  }
  return { error: null, session, sessionToken };
}

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

    const { data: matches, error: userError } = await findUsersByPhone(phone);

    if (userError) {
      console.error(`[OTP] Error checking user registration:`, userError);
      return res.status(500).json({
        success: false,
        error: "Something went wrong. Please try again.",
      });
    }

    const user = (matches ?? []).find(m => m?.email) ?? (matches ?? [])[0] ?? null;
    const registered = !!user;

    let sessionToken: string | null = null;
    let session: { access_token: string; refresh_token: string } | null = null;
    if (registered && user?.email) {
      const minted = await mintSession(user.email);
      if (minted.error) {
        console.error(`[OTP] Could not mint a session for ${phone}:`, minted.error);
        return res.status(500).json({
          success: false,
          error: "Verified, but could not sign you in. Please try again.",
        });
      }
      session = minted.session;
      sessionToken = minted.sessionToken;
    }

    return res.status(200).json({
      success: true,
      message: "OTP verified successfully.",
      registered,
      // Preferred: ready-to-use tokens, applied locally with setSession().
      session,
      // Fallback for clients that still redeem the hash themselves.
      session_token: sessionToken,
      signup_token: registered ? null : signSignupToken(phone),
    });
  } catch (err: any) {
    console.error(`[OTP] Error in /verify-otp for ${phone}:`, err);
    return res.status(500).json({ success: false, error: err.message || "Failed to verify OTP." });
  }
});

router.post("/register-phone", async (req: Request, res: Response) => {
  const phone = readSignupToken(req.body?.signup_token);
  if (!phone) {
    return res.status(401).json({ success: false, error: "Your verification has expired. Please verify your number again." });
  }

  const fullName = String(req.body?.full_name ?? "").trim();
  const email = String(req.body?.email ?? "").trim().toLowerCase();
  if (fullName.length < 2) {
    return res.status(400).json({ success: false, error: "Please enter your full name." });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ success: false, error: "Please enter a valid email address." });
  }

  try {
    const { data: existing, error: lookupError } = await findUsersByPhone(phone);
    if (lookupError) throw lookupError;
    if ((existing ?? []).length) {
      return res.status(409).json({ success: false, error: "This number already has an account. Please log in again." });
    }

    const { data: emailTaken } = await supabaseService.from("users").select("id").ilike("email", email.replace(/[%_\\]/g, "\\$&")).limit(1);
    if ((emailTaken ?? []).length) {
      return res.status(409).json({ success: false, error: "This email is already in use. Try another email or continue with Google." });
    }

    const { data: created, error: createError } = await supabaseService.auth.admin.createUser({
      email,
      email_confirm: true,
      user_metadata: { role: "user", full_name: fullName, phone },
    });
    if (createError || !created?.user?.id) {
      if (/already/i.test(createError?.message ?? "")) {
        return res.status(409).json({ success: false, error: "This email is already in use. Try another email or continue with Google." });
      }
      throw createError ?? new Error("User not returned from admin.createUser");
    }

    const { error: insertError } = await supabaseService.from("users").insert({
      id: created.user.id,
      email,
      full_name: fullName,
      phone,
      role: "user",
    });
    if (insertError) {
      await supabaseService.auth.admin.deleteUser(created.user.id).catch(() => {});
      throw insertError;
    }

    const minted = await mintSession(email);
    if (minted.error) throw minted.error;

    return res.status(201).json({
      success: true,
      user_id: created.user.id,
      session: minted.session,
      session_token: minted.sessionToken,
    });
  } catch (err: any) {
    console.error(`[OTP] Error in /register-phone for ${phone}:`, err);
    return res.status(500).json({ success: false, error: "Could not create your account. Please try again." });
  }
});

export default router;
