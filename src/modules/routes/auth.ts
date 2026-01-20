import express, { Request, Response } from "express";
import { createClient } from "@supabase/supabase-js";
import supabase from "../../database/supabase"; // anon client

const router = express.Router();

type CreateUserBody = {
  email: string;
  password: string;
  full_name?: string;
  phone?: string;
  role: string;
};

type BulkBody = {
  users: CreateUserBody[];
};

function isBulk(body: any): body is BulkBody {
  return body && Array.isArray(body.users);
}

async function createOneUser(input: CreateUserBody) {
  const { email, password, full_name, phone, role } = input;

  if (!email || !password || !role) {
    return { ok: false, error: "Email, password and role are required" };
  }

  // 1) Create auth user via signUp (anon)
  const { data: signUpData, error: signUpError } = await supabase.auth.signUp({
    email,
    password,
    options: {
      data: { role, full_name: full_name || null, phone: phone || null },
    },
  });

  if (signUpError) {
    return { ok: false, error: signUpError.message };
  }

  const userId = signUpData.user?.id;
  if (!userId) {
    return { ok: false, error: "User not returned from signUp" };
  }

  // Email confirmation OFF -> session should exist, but still guard
  const accessToken = signUpData.session?.access_token;
  if (!accessToken) {
    return {
      ok: false,
      error:
        "No session returned from signUp. If email confirmation is OFF, this is unexpected.",
    };
  }

  // 2) Insert into public.users as that newly-created user (RLS-safe)
  const supabaseAuthed = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_KEY!, // ⚠️ should be ANON KEY (rename env later)
    {
      global: { headers: { Authorization: `Bearer ${accessToken}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    }
  );

  const { data: user, error: insertError } = await supabaseAuthed
    .from("users")
    .insert({
      id: userId,
      email,
      full_name: full_name || null,
      phone: phone || null,
      role,
      profile_image: null,
      gender: null,
      dob: null,
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

/**
 * POST /api/auth/create-user
 * - Supports single {email,password,role,...}
 * - Supports bulk { users: [...] }
 */
router.post("/create-user", async (req: Request, res: Response) => {
  try {
    // ✅ BULK MODE
    if (isBulk(req.body)) {
      const users = req.body.users || [];
      if (!users.length) {
        return res.status(400).json({ error: "users[] is required" });
      }

      // Optional safety limit
      if (users.length > 200) {
        return res.status(400).json({ error: "Too many users in one request (max 200)" });
      }

      // RunC: do sequential to avoid rate limits (safe + predictable)
      const created: any[] = [];
      const failed: any[] = [];

      for (const u of users) {
        const result = await createOneUser(u);
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

    // ✅ SINGLE MODE
    const result = await createOneUser(req.body as CreateUserBody);
    if (!result.ok) {
      return res.status(400).json(result);
    }
    return res.status(201).json({ user: result.user });
  } catch (err: any) {
    console.error(err);
    return res.status(500).json({ error: err?.message || "Server error" });
  }
});

export default router;
