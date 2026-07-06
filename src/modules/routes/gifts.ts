import { Router } from "express";
import { getAuthenticatedCustomer, requireAdmin } from "../services/authService";
import supabase from "../../database/supabase";
import multer from "multer";

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
});

const BRAND_ASSETS_BUCKET = "brand-gifting-assets";

// 1. GET /api/gifts/summary  -> balance + transactions + brand balances in one call
//    (the mobile Gifts view reads this on focus).
router.get("/summary", async (req, res) => {
  const customer = await getAuthenticatedCustomer(req, res);
  if (!customer) return;

  try {
    const [balanceResult, txResult, brandResult] = await Promise.all([
      supabase
        .from("gift_balances")
        .select("balance, locked_balance")
        .eq("user_id", customer.userId)
        .maybeSingle(),
      supabase
        .from("gift_transactions")
        .select("*")
        .eq("user_id", customer.userId)
        .order("created_at", { ascending: false })
        .limit(100),
      supabase
        .from("brand_gift_balances")
        .select(`
          balance,
          locked_balance,
          store_id,
          restaurant_id,
          stores ( name, logo_url ),
          restaurants ( name, cover_image )
        `)
        .eq("user_id", customer.userId),
    ]);

    if (balanceResult.error) {
      console.error("Error fetching gift balance:", balanceResult.error);
      return res.status(500).json({ success: false, error: "Database error" });
    }
    if (txResult.error) {
      console.error("Error fetching gift transactions:", txResult.error);
      return res.status(500).json({ success: false, error: "Database error" });
    }
    if (brandResult.error) {
      console.error("Error fetching brand balances:", brandResult.error);
      return res.status(500).json({ success: false, error: "Database error" });
    }

    return res.json({
      success: true,
      balance: balanceResult.data?.balance ?? 0.00,
      locked_balance: balanceResult.data?.locked_balance ?? 0.00,
      transactions: txResult.data || [],
      brand_balances: brandResult.data || [],
    });
  } catch (err: any) {
    console.error("Get summary unexpected error:", err);
    return res.status(500).json({ success: false, error: "Internal server error" });
  }
});

// 2. GET /api/gifts/balance
router.get("/balance", async (req, res) => {
  const customer = await getAuthenticatedCustomer(req, res);
  if (!customer) return;

  try {
    const { data: wallet, error } = await supabase
      .from("gift_balances")
      .select("balance, locked_balance")
      .eq("user_id", customer.userId)
      .maybeSingle();

    if (error) {
      console.error("Error fetching gift balance:", error);
      return res.status(500).json({ success: false, error: "Database error" });
    }

    return res.json({
      success: true,
      balance: wallet?.balance ?? 0.00,
      locked_balance: wallet?.locked_balance ?? 0.00,
    });
  } catch (err: any) {
    console.error("Get balance unexpected error:", err);
    return res.status(500).json({ success: false, error: "Internal server error" });
  }
});

// 2. GET /api/gifts/my-codes
router.get("/my-codes", async (req, res) => {
  const customer = await getAuthenticatedCustomer(req, res);
  if (!customer) return;

  try {
    const { data: codes, error } = await supabase
      .from("gift_codes")
      .select("*")
      .eq("created_by", customer.userId)
      .order("created_at", { ascending: false });

    if (error) {
      console.error("Error fetching gift codes:", error);
      return res.status(500).json({ success: false, error: "Database error" });
    }

    return res.json({
      success: true,
      gift_codes: codes || [],
    });
  } catch (err: any) {
    console.error("Get my-codes unexpected error:", err);
    return res.status(500).json({ success: false, error: "Internal server error" });
  }
});

// 3. POST /api/gifts/redeem
router.post("/redeem", async (req, res) => {
  const { code } = req.body;

  if (!code || typeof code !== "string" || !code.trim()) {
    return res.status(400).json({ success: false, error: "Gift code is required" });
  }

  const customer = await getAuthenticatedCustomer(req, res);
  if (!customer) return;

  try {
    // Call the postgres atomic RPC function to handle the redemption
    const { data, error } = await supabase.rpc("redeem_gift_code", {
      p_code: code.trim(),
      p_user_id: customer.userId,
    });

    if (error) {
      console.error("Error calling redeem_gift_code RPC:", error);
      return res.status(500).json({ success: false, error: "Database transaction failed" });
    }

    const result = data as { success: boolean; message: string; amount?: number; new_balance?: number };

    if (!result.success) {
      return res.status(400).json({ success: false, error: result.message });
    }

    return res.json({
      success: true,
      message: result.message,
      amount: result.amount,
      new_balance: result.new_balance,
    });
  } catch (err: any) {
    console.error("Redeem code unexpected error:", err);
    return res.status(500).json({ success: false, error: "Internal server error" });
  }
});

// 4. GET /api/gifts/discounts
router.get("/discounts", async (req, res) => {
  try {
    const now = new Date().toISOString();
    const { data: discounts, error } = await supabase
      .from("running_discounts")
      .select("*")
      .eq("is_active", true);

    if (error) {
      console.error("Error fetching running discounts:", error);
      return res.status(500).json({ success: false, error: "Database error" });
    }

    // Filter discounts based on validity dates if set
    const activeDiscounts = (discounts || []).filter((discount) => {
      if (discount.start_date && new Date(discount.start_date) > new Date(now)) {
        return false;
      }
      if (discount.end_date && new Date(discount.end_date) < new Date(now)) {
        return false;
      }
      return true;
    });

    return res.json({
      success: true,
      discounts: activeDiscounts,
    });
  } catch (err: any) {
    console.error("Get discounts unexpected error:", err);
    return res.status(500).json({ success: false, error: "Internal server error" });
  }
});

// 5. GET /api/gifts/brands
router.get("/brands", async (req, res) => {
  try {
    const now = new Date().toISOString();

    // Query active stores where gifting is enabled
    const { data: stores, error: storesError } = await supabase
      .from("stores")
      .select("id, name, logo_url, description, gifting_discount_percentage, gifting_start_date, gifting_end_date, gifting_logo_url, gifting_logo_path, gifting_card_image_url, gifting_card_image_path")
      .eq("is_active", true)
      .eq("gifting_enabled", true);

    if (storesError) {
      console.error("Error fetching active stores for gifting:", storesError);
      return res.status(500).json({ success: false, error: "Database error" });
    }

    // Query active restaurants where gifting is enabled
    const { data: restaurants, error: restError } = await supabase
      .from("restaurants")
      .select("id, name, cover_image, description, gifting_discount_percentage, gifting_start_date, gifting_end_date, gifting_logo_url, gifting_logo_path, gifting_card_image_url, gifting_card_image_path")
      .eq("is_active", true)
      .eq("gifting_enabled", true);

    if (restError) {
      console.error("Error fetching active restaurants for gifting:", restError);
      return res.status(500).json({ success: false, error: "Database error" });
    }

    // Filter stores based on validity range
    const activeStores = (stores || []).filter((s) => {
      if (s.gifting_start_date && new Date(s.gifting_start_date) > new Date(now)) return false;
      if (s.gifting_end_date && new Date(s.gifting_end_date) < new Date(now)) return false;
      return true;
    });

    // Filter restaurants based on validity range
    const activeRestaurants = (restaurants || []).filter((r) => {
      if (r.gifting_start_date && new Date(r.gifting_start_date) > new Date(now)) return false;
      if (r.gifting_end_date && new Date(r.gifting_end_date) < new Date(now)) return false;
      return true;
    });

    // Map to a combined list of brands
    const brands = [
      ...activeStores.map((s) => ({
        id: s.id,
        name: s.name,
        image: s.logo_url,
        description: s.description,
        discount_percentage: Number(s.gifting_discount_percentage || 0),
        type: "store",
        gifting_logo_url: s.gifting_logo_url,
        gifting_logo_path: s.gifting_logo_path,
        gifting_card_image_url: s.gifting_card_image_url,
        gifting_card_image_path: s.gifting_card_image_path,
      })),
      ...activeRestaurants.map((r) => ({
        id: r.id,
        name: r.name,
        image: r.cover_image,
        description: r.description,
        discount_percentage: Number(r.gifting_discount_percentage || 0),
        type: "restaurant",
        gifting_logo_url: r.gifting_logo_url,
        gifting_logo_path: r.gifting_logo_path,
        gifting_card_image_url: r.gifting_card_image_url,
        gifting_card_image_path: r.gifting_card_image_path,
      })),
    ];

    return res.json({
      success: true,
      brands,
    });
  } catch (err: any) {
    console.error("Get gifting brands unexpected error:", err);
    return res.status(500).json({ success: false, error: "Internal server error" });
  }
});

// Helper to upload a brand asset file to Supabase storage
const uploadBrandGiftingAsset = async (file: Express.Multer.File, prefix: string) => {
  const fileExt = file.originalname.split(".").pop();
  const fileName = `${prefix}_${Date.now()}.${fileExt}`;

  const { error: uploadErr } = await supabase.storage
    .from(BRAND_ASSETS_BUCKET)
    .upload(fileName, file.buffer, {
      contentType: file.mimetype,
    });

  if (uploadErr) throw uploadErr;

  const { data: publicUrl } = supabase.storage
    .from(BRAND_ASSETS_BUCKET)
    .getPublicUrl(fileName);

  return {
    url: publicUrl.publicUrl,
    path: fileName,
  };
};

// 6. POST /api/gifts/brands/:brandType/:id/upload
// Admin-only endpoint to upload brand gifting logo and gifting card background image
router.post(
  "/brands/:brandType/:id/upload",
  upload.fields([
    { name: "logo", maxCount: 1 },
    { name: "card", maxCount: 1 },
  ]),
  async (req: any, res: any) => {
    try {
      const admin = await requireAdmin(req, res);
      if (!admin) return;

      const { brandType, id } = req.params;
      const files = req.files as { [fieldname: string]: Express.Multer.File[] } | undefined;

      if (!["store", "restaurant"].includes(brandType)) {
        return res.status(400).json({ error: "Invalid brandType. Must be 'store' or 'restaurant'" });
      }

      const table = brandType === "store" ? "stores" : "restaurants";
      const updates: any = {};

      if (files?.logo?.[0]) {
        const result = await uploadBrandGiftingAsset(files.logo[0], `${brandType}_logo_${id}`);
        updates.gifting_logo_url = result.url;
        updates.gifting_logo_path = result.path;
      }

      if (files?.card?.[0]) {
        const result = await uploadBrandGiftingAsset(files.card[0], `${brandType}_card_${id}`);
        updates.gifting_card_image_url = result.url;
        updates.gifting_card_image_path = result.path;
      }

      if (Object.keys(updates).length === 0) {
        return res.status(400).json({ error: "No files uploaded. Provide 'logo' or 'card' field." });
      }

      const { data, error } = await supabase
        .from(table)
        .update(updates)
        .eq("id", id)
        .select()
        .maybeSingle();

      if (error) throw error;
      if (!data) {
        return res.status(404).json({ error: `${brandType} not found` });
      }

      return res.json({
        success: true,
        message: "Brand gifting assets uploaded successfully",
        brand: data,
      });
    } catch (err: any) {
      console.error("[gifting-assets] Upload failed:", err);
      return res.status(500).json({ error: err.message || "Failed to upload brand gifting assets" });
    }
  }
);

export default router;
