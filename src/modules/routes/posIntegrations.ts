import { Router, type Request, type Response } from "express";
import supabase from "../../database/supabase";
import { getBearerToken, requireAdmin } from "../services/authService";
import { FulleService } from "../services/fulleService";
import {
  PosNotConfiguredError,
  XLENT_PROVIDER,
  getXlentApiKey,
  getXlentCredentials,
  normalizeXlentApiKey,
  resyncBooking,
  setXlentApiKey,
} from "../services/posSyncService";

const router = Router();

/**
 * Every POS route acts on a merchant's till with their API key, so all of them
 * are admin-only. (requireAdmin lets token-less requests through, hence the
 * explicit bearer check.)
 */
router.use(async (req, res, next) => {
  if (!getBearerToken(req)) {
    return res.status(401).json({ error: "Unauthorized", code: "UNAUTHORIZED" });
  }
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  next();
});

async function requireCredentials(restaurantId: string, res: Response) {
  try {
    const creds = await getXlentCredentials(restaurantId);
    if (!creds) {
      res.status(404).json({
        error: `XL-ENT is not enabled for restaurant ${restaurantId}`,
        code: "POS_NOT_ENABLED",
      });
      return null;
    }
    return creds;
  } catch (err) {
    const notConfigured = err instanceof PosNotConfiguredError;
    res.status(notConfigured ? 409 : 500).json({
      error: err instanceof Error ? err.message : "Failed to read XL-ENT config",
      code: notConfigured ? "POS_NOT_CONFIGURED" : "POS_CONFIG_READ_FAILED",
    });
    return null;
  }
}

function fail(res: Response, err: unknown, fallback: string, code: string) {
  return res.status(502).json({
    error: err instanceof Error ? err.message : fallback,
    code,
  });
}

function maskKey(key: string) {
  return key.length <= 4 ? "••••" : `••••${key.slice(-4)}`;
}

// ---------------------------------------------------------------------------
// XL-ENT configuration (used by the admin restaurant pages)
// ---------------------------------------------------------------------------

/**
 * GET /api/pos/xlent/restaurants/:restaurantId/config
 * The API key is never returned, only whether one is stored.
 */
router.get("/xlent/restaurants/:restaurantId/config", async (req, res) => {
  const { data, error } = await supabase
    .from("restaurant_till_providers")
    .select("is_enabled, external_restaurant_id, api_key_secret_id, config, updated_at")
    .eq("restaurant_id", req.params.restaurantId)
    .eq("provider_name", XLENT_PROVIDER)
    .maybeSingle();

  if (error) return res.status(500).json({ error: error.message, code: "POS_CONFIG_READ_FAILED" });

  const hasKey = Boolean(data?.api_key_secret_id);
  const pointOfSaleId = Number(data?.external_restaurant_id);
  return res.json({
    enabled: Boolean(data?.is_enabled),
    has_api_key: hasKey,
    api_key_hint: hasKey ? data?.config?.apiKeyHint ?? "••••" : null,
    point_of_sale_id: Number.isInteger(pointOfSaleId) && pointOfSaleId > 0 ? pointOfSaleId : null,
    point_of_sale_name: data?.config?.pointOfSaleName ?? null,
    updated_at: data?.updated_at ?? null,
  });
});

/**
 * PUT /api/pos/xlent/restaurants/:restaurantId/config
 * Body: { enabled, api_key?, point_of_sale_id?, point_of_sale_name? }
 * api_key is optional on update: omitted/blank keeps the stored key.
 * Enabling requires a working key and a point of sale that key can see.
 */
router.put("/xlent/restaurants/:restaurantId/config", async (req: Request, res: Response) => {
  const restaurantId = req.params.restaurantId;
  const enabled = req.body?.enabled === true;
  const newKey = typeof req.body?.api_key === "string" ? normalizeXlentApiKey(req.body.api_key) : "";
  const requestedPos = req.body?.point_of_sale_id;
  const pointOfSaleName =
    typeof req.body?.point_of_sale_name === "string" ? req.body.point_of_sale_name.trim() : null;

  const { data: existing, error: readError } = await supabase
    .from("restaurant_till_providers")
    .select("id, config, external_restaurant_id, api_key_secret_id")
    .eq("restaurant_id", restaurantId)
    .eq("provider_name", XLENT_PROVIDER)
    .maybeSingle();
  if (readError) return res.status(500).json({ error: readError.message, code: "POS_CONFIG_READ_FAILED" });

  if (!enabled) {
    if (existing) {
      const { error } = await supabase
        .from("restaurant_till_providers")
        .update({ is_enabled: false, updated_at: new Date().toISOString() })
        .eq("id", existing.id);
      if (error) return res.status(500).json({ error: error.message, code: "POS_CONFIG_SAVE_FAILED" });
    }
    return res.json({ ok: true, enabled: false });
  }

  let mutualKey = newKey;
  if (!mutualKey && existing?.api_key_secret_id) {
    try {
      mutualKey = (await getXlentApiKey(restaurantId)) ?? "";
    } catch (err) {
      return res.status(500).json({ error: err instanceof Error ? err.message : String(err), code: "POS_CONFIG_READ_FAILED" });
    }
  }
  const pointOfSaleId = Number(requestedPos ?? existing?.external_restaurant_id);
  if (!mutualKey) {
    return res.status(400).json({ error: "XL-ENT API key is required", code: "POS_KEY_REQUIRED" });
  }
  if (!Number.isInteger(pointOfSaleId) || pointOfSaleId <= 0) {
    return res.status(400).json({ error: "Select the XL-ENT point of sale", code: "POS_POINT_OF_SALE_REQUIRED" });
  }

  // Validate against CashMag before saving so a typo can't silently break bookings.
  try {
    const points = await FulleService.getPointsOfSale(mutualKey);
    const list = Array.isArray(points?.list) ? points.list : [];
    if (!list.some((pos: any) => Number(pos.id) === pointOfSaleId)) {
      return res.status(400).json({
        error: `Point of sale ${pointOfSaleId} is not available for this API key`,
        code: "POS_POINT_OF_SALE_INVALID",
      });
    }
  } catch (err) {
    return res.status(400).json({
      error: `XL-ENT rejected the API key: ${err instanceof Error ? err.message : String(err)}`,
      code: "POS_KEY_INVALID",
    });
  }

  // The key itself goes to Vault; config only keeps non-secret display metadata.
  // A new key is stored before enabling, so a failed key write never leaves an
  // enabled provider without a key.
  const row = {
    restaurant_id: restaurantId,
    provider_name: XLENT_PROVIDER,
    external_restaurant_id: String(pointOfSaleId),
    is_enabled: newKey ? false : true,
    config: {
      pointOfSaleName: pointOfSaleName ?? existing?.config?.pointOfSaleName ?? null,
      apiKeyHint: newKey ? maskKey(newKey) : existing?.config?.apiKeyHint ?? null,
    },
    updated_at: new Date().toISOString(),
  };

  const { error } = await supabase
    .from("restaurant_till_providers")
    .upsert(row, { onConflict: "restaurant_id,provider_name" });
  if (error) return res.status(500).json({ error: error.message, code: "POS_CONFIG_SAVE_FAILED" });

  if (newKey) {
    try {
      await setXlentApiKey(restaurantId, newKey);
    } catch (err) {
      return res.status(500).json({ error: err instanceof Error ? err.message : String(err), code: "POS_KEY_SAVE_FAILED" });
    }
    const { error: enableError } = await supabase
      .from("restaurant_till_providers")
      .update({ is_enabled: true, updated_at: new Date().toISOString() })
      .eq("restaurant_id", restaurantId)
      .eq("provider_name", XLENT_PROVIDER);
    if (enableError) return res.status(500).json({ error: enableError.message, code: "POS_CONFIG_SAVE_FAILED" });
  }

  return res.json({ ok: true, enabled: true, point_of_sale_id: pointOfSaleId });
});

/**
 * POST /api/pos/xlent/points-of-sale
 * Body: { api_key } or { restaurant_id } (uses the stored key).
 * Lets the admin pick the merchant's point of sale after pasting the key.
 */
router.post("/xlent/points-of-sale", async (req, res) => {
  let mutualKey = typeof req.body?.api_key === "string" ? normalizeXlentApiKey(req.body.api_key) : "";

  if (!mutualKey && typeof req.body?.restaurant_id === "string") {
    try {
      mutualKey = (await getXlentApiKey(req.body.restaurant_id)) ?? "";
    } catch (err) {
      return res.status(500).json({ error: err instanceof Error ? err.message : String(err), code: "POS_CONFIG_READ_FAILED" });
    }
  }
  if (!mutualKey) {
    return res.status(400).json({ error: "Missing api_key", code: "INVALID_PARAMS" });
  }

  try {
    const points = await FulleService.getPointsOfSale(mutualKey);
    const list = Array.isArray(points?.list) ? points.list : [];
    return res.json({
      points_of_sale: list.map((pos: any) => ({
        id: Number(pos.id),
        name: pos.name ?? pos.name_webshop ?? `Point of sale ${pos.id}`,
        address: [pos.address, pos.postal, pos.city].filter(Boolean).join(", "),
      })),
    });
  } catch (err) {
    return fail(res, err, "Failed to fetch points of sale", "POS_FETCH_FAILED");
  }
});

/**
 * GET /api/pos/xlent/restaurants/:restaurantId/bookings
 * Recent bookings with their POS sync state, for the admin status panel.
 */
router.get("/xlent/restaurants/:restaurantId/bookings", async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 20, 100);
  const { data, error } = await supabase
    .from("restaurant_bookings")
    .select(
      "id, booking_code, customer_name, booking_date, booking_time, party_size, status, external_pos_id, external_pos_reference, pos_sync_status, pos_sync_error, pos_synced_at, created_at"
    )
    .eq("restaurant_id", req.params.restaurantId)
    .not("pos_sync_status", "is", null)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) return res.status(500).json({ error: error.message, code: "POS_STATUS_READ_FAILED" });
  return res.json({ bookings: data ?? [] });
});

/**
 * POST /api/pos/xlent/bookings/:bookingId/resync
 * Re-queues a booking and syncs it immediately.
 */
router.post("/xlent/bookings/:bookingId/resync", async (req, res) => {
  try {
    await resyncBooking(req.params.bookingId);
    const { data } = await supabase
      .from("restaurant_bookings")
      .select("id, external_pos_id, external_pos_reference, pos_sync_status, pos_sync_error, pos_synced_at")
      .eq("id", req.params.bookingId)
      .maybeSingle();
    return res.json({ booking: data });
  } catch (err) {
    return res.status(500).json({
      error: err instanceof Error ? err.message : "Resync failed",
      code: "POS_RESYNC_FAILED",
    });
  }
});

// ---------------------------------------------------------------------------
// Raw Fulle passthroughs (debugging / manual operations)
// ---------------------------------------------------------------------------

/**
 * GET /api/pos/booking-settings/services?restaurant_id=&day=
 */
router.get("/booking-settings/services", async (req, res) => {
  const { restaurant_id, day } = req.query;
  if (!restaurant_id) {
    return res.status(400).json({ error: "Missing restaurant_id parameter", code: "INVALID_PARAMS" });
  }
  const creds = await requireCredentials(String(restaurant_id), res);
  if (!creds) return;

  try {
    const data = await FulleService.getBookingServices(
      creds.mutualKey,
      creds.pointOfSaleId,
      day !== undefined ? Number(day) : undefined
    );
    return res.json(data);
  } catch (err) {
    return fail(res, err, "Failed to fetch booking services", "SERVICES_FETCH_FAILED");
  }
});

/**
 * GET /api/pos/products?restaurant_id=&...
 */
router.get("/products", async (req, res) => {
  const { restaurant_id, ...otherParams } = req.query;
  if (!restaurant_id) {
    return res.status(400).json({ error: "Missing restaurant_id parameter", code: "INVALID_PARAMS" });
  }
  const creds = await requireCredentials(String(restaurant_id), res);
  if (!creds) return;

  try {
    const data = await FulleService.getProducts(creds.mutualKey, {
      id_point_of_sale: creds.pointOfSaleId,
      ...otherParams,
    });
    return res.json(data);
  } catch (err) {
    return fail(res, err, "Failed to fetch products", "PRODUCTS_FETCH_FAILED");
  }
});

/**
 * GET /api/pos/products-gallery/:id?restaurant_id=
 */
router.get("/products-gallery/:id", async (req, res) => {
  const productId = Number(req.params.id);
  const { restaurant_id } = req.query;
  if (Number.isNaN(productId) || !restaurant_id) {
    return res.status(400).json({ error: "Invalid product id or missing restaurant_id", code: "INVALID_PARAMS" });
  }
  const creds = await requireCredentials(String(restaurant_id), res);
  if (!creds) return;

  try {
    const data = await FulleService.getProductGallery(creds.mutualKey, productId);
    return res.json(data);
  } catch (err) {
    return fail(res, err, "Failed to fetch product gallery", "GALLERY_FETCH_FAILED");
  }
});

export default router;
