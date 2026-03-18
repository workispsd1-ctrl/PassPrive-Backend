import { Router } from "express";
import { createClient } from "@supabase/supabase-js";

const router = Router();

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY!;

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

/**
 * Robust helper to get authenticated user info & role from Public Users Table.
 */
async function getCallerInfo(req: any) {
  try {
    const sb = supabaseAuthed(req);
    if (!sb) return null;

    // Verify token with Auth service
    const { data: { user }, error: authError } = await sb.auth.getUser();
    if (authError || !user) {
      console.error("[getCallerInfo] Auth Verification Failed:", authError?.message);
      return null;
    }

    // Fetch user role from Public Profile table
    const { data: profile, error: dbError } = await sb
      .from("users")
      .select("id, role")
      .eq("id", user.id)
      .maybeSingle();

    if (dbError) {
      console.error("[getCallerInfo] DB Role Fetch Failed:", dbError.message);
    }

    let role = profile?.role?.toLowerCase() || "";

    // Fallback: Check Auth Metadata if role not found in DB
    if (!role && user.user_metadata?.role) {
      role = String(user.user_metadata.role).toLowerCase();
    }

    return { 
      id: user.id, 
      role,
      sb
    };
  } catch (err: any) {
    console.error("[getCallerInfo] Unexpected Error:", err.message);
    return null;
  }
}

// Helper for Auth check (Legacy support, only for routes that only admins should access)
async function isAdmin(req: any) {
  const caller = await getCallerInfo(req);
  return caller?.role === "admin" || caller?.role === "superadmin";
}

/* ---------------------------------------------
   UPDATE USER (PUT /api/auth/users/:userId)
--------------------------------------------- */
router.put("/users/:userId", async (req, res) => {
  const caller = await getCallerInfo(req);
  if (!caller) return res.status(401).json({ error: "Unauthorized" });

  const { userId: targetId } = req.params;
  const { full_name, phone, role: newRole } = req.body;

  const isSuperAdmin = caller.role === "superadmin";
  const isAdminComp = caller.role === "admin";
  const isSelf = caller.id === targetId;

  // Authorization: Admins can update others, anyone can update self (profile settings)
  if (!isSuperAdmin && !isAdminComp && !isSelf) {
    return res.status(403).json({ error: "Access denied. Insufficient permissions." });
  }

  // 1. Prepare Public Profile Update
  const updateData: any = { 
    full_name, 
    phone, 
    updated_at: new Date().toISOString() 
  };

  // Only Admin/SuperAdmin can change roles
  if ((isSuperAdmin || isAdminComp) && newRole) {
    updateData.role = newRole;
  }

  const { error: profileError } = await caller.sb
    .from("users")
    .update(updateData)
    .eq("id", targetId);

  if (profileError) return res.status(500).json({ error: profileError.message });

  // 2. Update Auth Metadata (Syncs public profile with Auth data)
  const authUpdate: any = { 
    user_metadata: { full_name } 
  };
  if (updateData.role) authUpdate.user_metadata.role = updateData.role;
  if (phone) authUpdate.phone = phone;

  const { error: authError } = await supabaseService.auth.admin.updateUserById(targetId, authUpdate);
  if (authError) {
    console.warn("[UpdateUser] Auth metadata sync failed:", authError.message);
    // Not returning error here as primary DB update succeeded
  }

  return res.status(200).json({ success: true, message: "User updated successfully" });
});

/* ---------------------------------------------
   DELETE USER (DELETE /api/auth/users/:userId)
--------------------------------------------- */
router.delete("/users/:userId", async (req, res) => {
  const caller = await getCallerInfo(req);
  if (!caller) return res.status(401).json({ error: "Unauthorized" });

  const { userId: targetId } = req.params;
  const isSuperAdmin = caller.role === "superadmin";
  const isAdminComp = caller.role === "admin";
  const isSelfDelete = caller.id === targetId;

  let canDelete = isSuperAdmin || isSelfDelete;

  // Rule: Admin can only delete specific partner roles
  if (!canDelete && isAdminComp) {
    const { data: targetProfile, error: fetchErr } = await caller.sb
      .from("users")
      .select("role")
      .eq("id", targetId)
      .maybeSingle();
      
    if (fetchErr) return res.status(500).json({ error: "Failed to verify target role" });

    const targetRole = targetProfile?.role?.toLowerCase() || "";
    const PARTNER_ROLES = [
      "restaurantpartner", "restaurant partner", 
      "storepartner", "store partner", 
      "corporate", "corporatepartner", "corporate partner"
    ];

    if (PARTNER_ROLES.includes(targetRole)) {
      canDelete = true;
    }
  }

  if (!canDelete) {
    return res.status(403).json({ error: "Access denied. You do not have permission to delete this user." });
  }

  try {
    // 1. Delete from Auth (Triggers cascading delete if configured in DB)
    const { error: authDeleteError } = await supabaseService.auth.admin.deleteUser(targetId);
    if (authDeleteError) {
      console.error("[DeleteUser] Auth deletion failed:", authDeleteError.message);
      return res.status(500).json({ error: authDeleteError.message });
    }

    // 2. Explicitly Delete from Public Users Table (Backup for non-cascading DBs)
    await caller.sb.from("users").delete().eq("id", targetId);

    return res.status(200).json({ success: true, message: "User deleted successfully" });
  } catch (err: any) {
    console.error("[DeleteUser] Server error:", err.message);
    return res.status(500).json({ error: err.message || "Internal server error" });
  }
});

export default router;
