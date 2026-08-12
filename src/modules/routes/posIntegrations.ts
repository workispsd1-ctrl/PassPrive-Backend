import { Router } from "express";
import supabase from "../../database/supabase";
import { FulleService } from "../services/fulleService";

const router = Router();

/**
 * Helper to fetch Fulle POS integration settings for a restaurant
 */
async function getFulleCredentials(restaurantId: string) {
  const { data, error } = await supabase
    .from("restaurant_till_providers")
    .select("*")
    .eq("restaurant_id", restaurantId)
    .eq("provider_name", "fulle")
    .eq("is_enabled", true)
    .maybeSingle();

  if (error) {
    throw new Error(`Database error fetching POS credentials: ${error.message}`);
  }

  if (!data) {
    throw new Error(`No active Fulle integration found for restaurant ${restaurantId}`);
  }

  const mutualKey = data.config?.mutualKey ?? data.config?.mutual_key;
  if (!mutualKey) {
    throw new Error(`Mutual Key configuration is missing for restaurant ${restaurantId}`);
  }

  return {
    mutualKey,
    externalRestaurantId: Number(data.external_restaurant_id),
  };
}

/**
 * GET /api/pos/points-of-sale
 * Fetches points of sale (takes restaurant_id OR mutual_key for onboarding)
 */
router.get("/points-of-sale", async (req, res) => {
  try {
    const { restaurant_id, mutual_key, base64 } = req.query;
    let mutualKey = mutual_key as string;

    if (restaurant_id) {
      const creds = await getFulleCredentials(restaurant_id as string);
      mutualKey = creds.mutualKey;
    }

    if (!mutualKey) {
      return res.status(400).json({
        error: "Missing restaurant_id or mutual_key parameter",
        code: "INVALID_PARAMS"
      });
    }

    const data = await FulleService.getPointsOfSale(mutualKey, base64 as string);
    return res.json(data);
  } catch (err: any) {
    return res.status(500).json({
      error: err.message || "Failed to fetch points of sale",
      code: "POS_FETCH_FAILED"
    });
  }
});

/**
 * GET /api/pos/booking-settings/services
 * Fetches booking services for a restaurant
 */
router.get("/booking-settings/services", async (req, res) => {
  try {
    const { restaurant_id, day } = req.query;
    if (!restaurant_id) {
      return res.status(400).json({
        error: "Missing restaurant_id parameter",
        code: "INVALID_PARAMS"
      });
    }

    const creds = await getFulleCredentials(restaurant_id as string);
    const dayNum = day !== undefined ? Number(day) : undefined;

    const data = await FulleService.getBookingServices(
      creds.mutualKey,
      creds.externalRestaurantId,
      dayNum
    );
    return res.json(data);
  } catch (err: any) {
    return res.status(500).json({
      error: err.message || "Failed to fetch booking services",
      code: "SERVICES_FETCH_FAILED"
    });
  }
});

/**
 * GET /api/pos/products
 * Fetches products for a restaurant
 */
router.get("/products", async (req, res) => {
  try {
    const { restaurant_id, ...otherParams } = req.query;
    if (!restaurant_id) {
      return res.status(400).json({
        error: "Missing restaurant_id parameter",
        code: "INVALID_PARAMS"
      });
    }

    const creds = await getFulleCredentials(restaurant_id as string);
    const queryParams: Record<string, any> = {
      id_point_of_sale: creds.externalRestaurantId,
      ...otherParams
    };

    const data = await FulleService.getProducts(creds.mutualKey, queryParams);
    return res.json(data);
  } catch (err: any) {
    return res.status(500).json({
      error: err.message || "Failed to fetch products",
      code: "PRODUCTS_FETCH_FAILED"
    });
  }
});

/**
 * GET /api/pos/products-gallery/:id
 * Fetches product pictures gallery for a product ID
 */
router.get("/products-gallery/:id", async (req, res) => {
  try {
    const productId = Number(req.params.id);
    const { restaurant_id } = req.query;
    if (Number.isNaN(productId)) {
      return res.status(400).json({
        error: "Invalid or missing product ID in path",
        code: "INVALID_PARAMS"
      });
    }
    if (!restaurant_id) {
      return res.status(400).json({
        error: "Missing restaurant_id parameter",
        code: "INVALID_PARAMS"
      });
    }

    const creds = await getFulleCredentials(restaurant_id as string);
    const data = await FulleService.getProductGallery(creds.mutualKey, productId);
    return res.json(data);
  } catch (err: any) {
    return res.status(500).json({
      error: err.message || "Failed to fetch product gallery",
      code: "GALLERY_FETCH_FAILED"
    });
  }
});

/**
 * POST /api/pos/bookings
 * Manually create a booking on Fulle
 */
router.post("/bookings", async (req, res) => {
  try {
    const { restaurant_id, booking_payload } = req.body;
    if (!restaurant_id || !booking_payload) {
      return res.status(400).json({
        error: "Missing restaurant_id or booking_payload",
        code: "INVALID_PARAMS"
      });
    }

    const creds = await getFulleCredentials(restaurant_id);
    const finalPayload = {
      ...booking_payload,
      point_of_sale: { id: creds.externalRestaurantId }
    };

    const data = await FulleService.createBooking(creds.mutualKey, finalPayload);
    return res.json(data);
  } catch (err: any) {
    return res.status(500).json({
      error: err.message || "Failed to create Fulle booking",
      code: "BOOKING_CREATE_FAILED"
    });
  }
});

/**
 * POST /api/pos/bookings/:id
 * Manually update a booking on Fulle
 */
router.post("/bookings/:id", async (req, res) => {
  try {
    const externalBookingId = Number(req.params.id);
    const { restaurant_id, booking_payload } = req.body;

    if (Number.isNaN(externalBookingId)) {
      return res.status(400).json({
        error: "Invalid booking ID in path",
        code: "INVALID_PARAMS"
      });
    }
    if (!restaurant_id || !booking_payload) {
      return res.status(400).json({
        error: "Missing restaurant_id or booking_payload",
        code: "INVALID_PARAMS"
      });
    }

    const creds = await getFulleCredentials(restaurant_id);
    const data = await FulleService.updateBooking(creds.mutualKey, externalBookingId, booking_payload);
    return res.json(data);
  } catch (err: any) {
    return res.status(500).json({
      error: err.message || "Failed to update Fulle booking",
      code: "BOOKING_UPDATE_FAILED"
    });
  }
});

/**
 * POST /api/pos/bookings/:id/cancel
 * Manually cancel a booking on Fulle
 */
router.post("/bookings/:id/cancel", async (req, res) => {
  try {
    const externalBookingId = Number(req.params.id);
    const { restaurant_id, comment } = req.body;

    if (Number.isNaN(externalBookingId)) {
      return res.status(400).json({
        error: "Invalid booking ID in path",
        code: "INVALID_PARAMS"
      });
    }
    if (!restaurant_id) {
      return res.status(400).json({
        error: "Missing restaurant_id parameter",
        code: "INVALID_PARAMS"
      });
    }

    const creds = await getFulleCredentials(restaurant_id);
    const data = await FulleService.updateBookingLevel(
      creds.mutualKey,
      externalBookingId,
      -1,
      comment
    );
    return res.json(data);
  } catch (err: any) {
    return res.status(500).json({
      error: err.message || "Failed to cancel Fulle booking",
      code: "BOOKING_CANCEL_FAILED"
    });
  }
});

export default router;
