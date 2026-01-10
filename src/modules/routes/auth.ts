import express, { Request, Response } from "express";
import { createClient } from "@supabase/supabase-js";
import supabase from "../../database/supabase"; // anon client

const router = express.Router();

interface CreateUserBody {
  email: string;
  password: string;
  full_name?: string;
  phone?: string;
  role: string;
}

/**
 * POST /api/auth/create-user
 * Body: { email, password, full_name, phone, role }
 *
 * Option B: Use anon key + signUp (NO auth.admin.*)
 */
router.post(
  "/create-user",
  async (req: Request<{}, {}, CreateUserBody>, res: Response) => {
    const { email, password, full_name, phone, role } = req.body;

    if (!email || !password || !role) {
      return res
        .status(400)
        .json({ error: "Email, password and role are required" });
    }

    try {
      // 1) Create auth user via normal signUp (anon)
      const { data: signUpData, error: signUpError } = await supabase.auth.signUp(
        {
          email,
          password,
          options: {
            data: { role, full_name: full_name || null, phone: phone || null },
          },
        }
      );

      if (signUpError) {
        return res.status(400).json({ error: signUpError.message });
      }

      const userId = signUpData.user?.id;
      if (!userId) {
        return res.status(500).json({ error: "User not returned from signUp" });
      }

      // IMPORTANT: if email confirmation is ON, session may be null
      const accessToken = signUpData.session?.access_token;

      if (!accessToken) {
        // We cannot insert into public.users using anon without an authenticated session
        return res.status(202).json({
          message:
            "Auth user created but no session returned. Email confirmation is likely enabled. " +
            "After the user confirms email and logs in, create the users profile row OR use a DB trigger.",
          user: { id: userId, email },
        });
      }

      // 2) Insert into public.users as THAT newly-created user (RLS-safe)
      const supabaseAuthed = createClient(
        process.env.SUPABASE_URL!,
        process.env.SUPABASE_SERVICE_KEY!, // same anon key
        {
          global: {
            headers: { Authorization: `Bearer ${accessToken}` },
          },
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
        return res.status(400).json({
          error: insertError.message,
          hint:
            "RLS likely blocks insert. Add policy: WITH CHECK (auth.uid() = id).",
        });
      }

      return res.status(201).json({ user });
    } catch (err: any) {
      console.error(err);
      return res.status(500).json({ error: err?.message || "Server error" });
    }
  }
);

export default router;
