import { Request, Response } from "express";
import supabase from "../../database/supabase";
import jwt from "jsonwebtoken";

export const authHandler = async (req: Request, res: Response) => {
  const { supabase_user } = req.body;

  if (!supabase_user)
    return res.status(400).json({
      success: false,
      message: "Supabase user is required.",
    });

  const { id, email } = supabase_user;

  try {
    const { data: user, error } = await supabase
      .from("users")
      .select("*")
      .eq("id", id)
      .maybeSingle();

    if (error) {
      console.log(error);
      return res.status(500).json({ success: false, message: "DB error" });
    }

    // 2. REGISTER (if user not found)
    if (!user) {
      const { data: newUser, error: insertError } = await supabase
        .from("users")
        .insert({
          id,
          email,
          role: "user",
          created_at: new Date().toISOString(),
          last_login: new Date().toISOString(),
          last_opened: new Date().toISOString(),
        })
        .select()
        .single();

      if (insertError) {
        console.log(insertError);
        return res.status(500).json({ success: false, message: "Registration failed" });
      }

      const token = jwt.sign(
        { id, email, role: newUser.role },
        process.env.JWT_SECRET!,
        { expiresIn: "7d" }
      );

      return res.json({
        success: true,
        mode: "registered",
        token,
        user: newUser,
      });
    }

    // 3. LOGIN (user exists)
    await supabase
      .from("users")
      .update({
        last_login: new Date().toISOString(),
        last_opened: new Date().toISOString(),
      })
      .eq("id", id);

    const token = jwt.sign(
      { id, email, role: user.role },
      process.env.JWT_SECRET!,
      { expiresIn: "7d" }
    );

    return res.json({
      success: true,
      mode: "logged_in",
      token,
      user,
    });
  } catch (err) {
    console.log(err);
    return res.status(500).json({ success: false, message: "Unexpected server error" });
  }
};
