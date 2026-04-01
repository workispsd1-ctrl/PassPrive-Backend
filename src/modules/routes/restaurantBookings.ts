import { Router } from "express";
import {
  getAuthenticatedCustomer,
} from "../services/authService";
import {
  BookingPayloadSchema,
  confirmRestaurantBooking,
} from "../services/restaurantBookingService";

const router = Router();

router.post("/confirm", async (req, res) => {
  const parsed = BookingPayloadSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: "Invalid booking payload",
      code: "INVALID_PAYLOAD",
      details: parsed.error.flatten(),
    });
  }

  const customer = await getAuthenticatedCustomer(req, res);
  if (!customer) return;

  try {
    const result = await confirmRestaurantBooking(parsed.data, customer);
    return res.status(result.status).json(result.body);
  } catch (err: any) {
    return res.status(500).json({
      error: err?.message || "Failed to create booking",
      code: "BOOKING_CREATE_FAILED",
    });
  }
});

export default router;
