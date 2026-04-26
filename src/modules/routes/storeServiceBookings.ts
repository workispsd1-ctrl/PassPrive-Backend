import { Router } from "express";
import { getAuthenticatedCustomer } from "../services/authService";
import {
  confirmStoreServiceBooking,
  StoreServiceBookingPayloadSchema,
} from "../services/storeServiceBookingService";

const router = Router();

export const STORE_SERVICE_BOOKING_ROUTE_ALIASES = [
  "/api/store-service-booking",
  "/api/store-service-bookings",
  "/api/service-bookings",
  "/api/store-bookings",
] as const;

export function createConfirmStoreServiceBookingHandler(deps?: {
  getCustomer?: typeof getAuthenticatedCustomer;
  confirmBooking?: typeof confirmStoreServiceBooking;
}) {
  const getCustomer = deps?.getCustomer ?? getAuthenticatedCustomer;
  const confirmBooking = deps?.confirmBooking ?? confirmStoreServiceBooking;

  return async (req: any, res: any) => {
    const parsed = StoreServiceBookingPayloadSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: "Invalid booking payload",
        code: "INVALID_PAYLOAD",
        details: parsed.error.flatten(),
      });
    }

    const customer = await getCustomer(req, res);
    if (!customer) return;

    try {
      const result = await confirmBooking(parsed.data, customer);
      return res.status(result.status).json(result.body);
    } catch (err: any) {
      return res.status(500).json({
        error: err?.message || "Failed to create booking",
        code: "BOOKING_CREATE_FAILED",
      });
    }
  };
}

router.post("/confirm", createConfirmStoreServiceBookingHandler());

export default router;
