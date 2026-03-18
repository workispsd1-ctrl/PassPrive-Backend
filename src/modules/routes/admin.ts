import { Router } from "express";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";

const router = Router();

// Your environment variables
const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY!;

// Initialize Supabase admin client (Service Key is required for deleting/updating users)
const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// Helper for Auth check (Ensures only admins can call these)
async function isAdmin(req: any) {
  const h = req.headers.authorization || "";
  const [type, token] = h.split(" ");
  if (type !== "Bearer" || !token) return false;

  const { data: { user }, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !user) return false;

  const { data: profile } = await supabaseAdmin
    .from("users")
    .select("role")
    .eq("id", user.id)
    .single();

  const role = profile?.role?.toLowerCase();
  return role === "admin" || role === "superadmin";
}

/* ---------------------------------------------
   UPDATE USER (PUT /api/auth/users/:userId)
--------------------------------------------- */
router.put("/users/:userId", async (req, res) => {
  if (!(await isAdmin(req))) return res.status(403).json({ error: "Unauthorized" });

  const { full_name, phone, role } = req.body;
  const { userId } = req.params;

  // 1. Update Public Profile Table
  const { error: profileError } = await supabaseAdmin
    .from("users")
    .update({ 
      full_name, 
      phone, 
      role, 
      updated_at: new Date().toISOString() 
    })
    .eq("id", userId);

  if (profileError) return res.status(500).json({ error: profileError.message });

  // 2. Update Auth Metadata (Optional, keeps it in sync)
  const { error: authError } = await supabaseAdmin.auth.admin.updateUserById(userId, {
    user_metadata: { full_name, role },
    phone: phone // Note: Changing phone in Auth requires valid formatting
  });

  return res.status(200).json({ success: true, message: "User updated successfully" });
});

/* ---------------------------------------------
   DELETE USER (DELETE /api/auth/users/:userId)
--------------------------------------------- */
router.delete("/users/:userId", async (req, res) => {
  if (!(await isAdmin(req))) return res.status(403).json({ error: "Unauthorized" });

  const { userId } = req.params;

  // 1. Delete from Auth (This automatically triggers RLS or deletes associated data if CASCADE is on)
  const { error: authDeleteError } = await supabaseAdmin.auth.admin.deleteUser(userId);
  if (authDeleteError) return res.status(500).json({ error: authDeleteError.message });

  // 2. Delete from Public Users Table (if not handled by cascade)
  await supabaseAdmin.from("users").delete().eq("id", userId);

  return res.status(200).json({ success: true, message: "User deleted successfully" });
});

export default router;
