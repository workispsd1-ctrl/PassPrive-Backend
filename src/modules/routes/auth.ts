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

function isBulk(body: any): body is BulkBody {
  return body && Array.isArray(body.users);
}

async function createOneUser(input: CreateUserBody) {
  const { email, password, full_name, phone, role } = input;

  if (!email || !password || !role) {
    return { ok: false, error: "Email, password and role are required" };
  }

  // Use auth.admin.createUser to bypass email confirmation and signup restrictions.
  // This REQUIRES a valid SUPABASE_SERVICE_KEY.
  const { data: adminData, error: adminError } = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { role, full_name: full_name || null, phone: phone || null },
  });

  if (adminError) return { ok: false, error: adminError.message };

  const userId = adminData.user?.id;
  if (!userId) return { ok: false, error: "User not returned from admin.createUser" };

  const { data: user, error: insertError } = await supabase
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
    if (isBulk(req.body)) {
      const users = req.body.users || [];
      if (!users.length) return res.status(400).json({ error: "users[] is required" });

      if (users.length > 200) {
        return res.status(400).json({ error: "Too many users in one request (max 200)" });
      }

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

    const result = await createOneUser(req.body as CreateUserBody);
    if (!result.ok) return res.status(400).json(result);

    return res.status(201).json({ user: result.user });
  } catch (err: any) {
    console.error(err);
    return res.status(500).json({ error: err?.message || "Server error" });
  }
});

export default router;
