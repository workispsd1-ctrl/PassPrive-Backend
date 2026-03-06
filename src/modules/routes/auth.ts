import express, { Request, Response } from "express";
import { createClient } from "@supabase/supabase-js";
import supabase from "../../database/supabase"; 

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


const supabaseAdmin = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!,
  {
    auth: { persistSession: false, autoRefreshToken: false },
  }
);

async function createOneUser(input: CreateUserBody) {
  const { email, password, full_name, phone, role } = input;

  if (!email || !password || !role) {
    return { ok: false, error: "Email, password and role are required" };
  }

  const { data: signUpData, error: signUpError } = await supabase.auth.signUp({
    email,
    password,
    options: {
      data: { role, full_name: full_name || null, phone: phone || null },
    },
  });

  if (signUpError) return { ok: false, error: signUpError.message };

  const userId = signUpData.user?.id;
  if (!userId) return { ok: false, error: "User not returned from signUp" };

  const accessToken = signUpData.session?.access_token;
  if (!accessToken) {
    return {
      ok: false,
      error:
        "No session returned from signUp. If email confirmation is OFF, this is unexpected.",
    };
  }

  const supabaseAuthed = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_KEY!,
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

      membership: input.membership ?? null,
      membership_tier: input.membership_tier ?? "none",
      membership_started: input.membership_started ?? null,
      membership_expiry: input.membership_expiry ?? null,

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
      if (!users.length) {
        return res.status(400).json({ error: "users[] is required" });
      }

      if (users.length > 200) {
        return res
          .status(400)
          .json({ error: "Too many users in one request (max 200)" });
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


router.get("/google-signup", async (req: Request, res: Response) => {
  try {
    const role = String(req.query.role || "customer");

    const redirectTo = `${process.env.BACKEND_URL}/auth/callback/google?role=${encodeURIComponent(
      role
    )}`;

    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo,
      },
    });

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    return res.status(200).json({
      url: data.url,
      message: "Redirect user to this URL for Google signup",
    });
  } catch (err: any) {
    console.error(err);
    return res.status(500).json({ error: err?.message || "Server error" });
  }
});


router.get("/auth/callback/google", async (req: Request, res: Response) => {
  try {
    const code = req.query.code as string | undefined;
    const role = String(req.query.role || "customer");

    if (!code) {
      return res.status(400).json({ error: "Missing OAuth code" });
    }

    const { data, error } = await supabase.auth.exchangeCodeForSession(code);

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    const authUser = data.user;
    const session = data.session;

    if (!authUser || !session?.access_token) {
      return res.status(400).json({ error: "Failed to get authenticated Google user" });
    }


    const email = authUser.email ?? null;
    const full_name =
      (authUser.user_metadata?.full_name as string | undefined) ||
      (authUser.user_metadata?.name as string | undefined) ||
      null;
    const phone = (authUser.phone as string | undefined) || null;
    const profile_image =
      (authUser.user_metadata?.avatar_url as string | undefined) || null;

    // upsert profile row
    const { data: profile, error: profileError } = await supabaseAdmin
      .from("users")
      .upsert(
        {
          id: authUser.id,
          email,
          full_name,
          phone,
          role,

          profile_image,
          gender: null,
          dob: null,

          membership: null,
          membership_tier: "none",
          membership_started: null,
          membership_expiry: null,

          corporate_code: null,
          corporate_code_status: "pending",
        },
        { onConflict: "id" }
      )
      .select("*")
      .single();

    if (profileError) {
      return res.status(400).json({
        error: profileError.message,
        hint: "Could not create/update user profile after Google signup",
      });
    }

  
    return res.status(200).json({
      message: "Google signup/login successful",
      session,
      user: profile,
    });


  } catch (err: any) {
    console.error(err);
    return res.status(500).json({ error: err?.message || "Server error" });
  }
});

export default router;