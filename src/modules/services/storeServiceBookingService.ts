import { z } from "zod";
import supabase from "../../database/supabase";
import type { AuthenticatedCustomer } from "./authService";
import { normalizeDateString, normalizeTimeString } from "./restaurantBookingService";

const NON_CANCELLED_ORDER_STATUSES = ["NEW", "PLACED", "ACCEPTED", "PREPARING", "READY", "OUT_FOR_DELIVERY"];

const StoreRefSchema = z.union([
  z.string().uuid(),
  z.object({
    id: z.string().uuid(),
  }),
]);

const ServiceLineSchema = z
  .object({
    id: z.string().uuid().nullable().optional(),
    title: z.string().trim().min(1),
    quantity: z.coerce.number().int().positive().default(1),
    price: z.coerce.number().nonnegative().default(0),
    duration_minutes: z.coerce.number().int().nonnegative().default(0),
  })
  .passthrough();

export const StoreServiceBookingPayloadSchema = z
  .object({
    store: StoreRefSchema.optional().nullable(),
    restaurant: StoreRefSchema.optional().nullable(),
    serviceBooking: z.boolean().optional(),
    selectedDate: z.string().trim().optional(),
    selectedTime: z.string().trim().optional(),
    notes: z.string().trim().max(1000).nullable().optional(),
    services: z.array(ServiceLineSchema).optional(),
    selectedServices: z.array(ServiceLineSchema).optional(),
    option: z.any().optional(),
    payment: z
      .object({
        amount: z.coerce.number().nonnegative().optional(),
        status: z.string().trim().nullable().optional(),
        method: z.string().trim().nullable().optional(),
        reference: z.string().trim().nullable().optional(),
        verified: z.boolean().optional(),
      })
      .nullable()
      .optional(),
    metadata: z.record(z.string(), z.any()).optional(),
  })
  .passthrough();

export type StoreServiceBookingPayload = z.infer<typeof StoreServiceBookingPayloadSchema>;

function parseNumericSignal(value: any) {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
}

function isPaymentVerified(payment: any) {
  const status = String(payment?.status ?? "").trim().toLowerCase();
  return payment?.verified === true || ["paid", "verified", "captured", "succeeded", "success"].includes(status);
}

function generateBookingCode() {
  const now = new Date();
  const dateSegment = `${String(now.getFullYear()).slice(-2)}${String(now.getMonth() + 1).padStart(2, "0")}${String(
    now.getDate()
  ).padStart(2, "0")}`;
  const randomSegment = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `PP-${dateSegment}-${randomSegment}`;
}

function deriveClientStatus(order: any) {
  const status = String(order?.status ?? "").trim().toUpperCase();
  if (["NEW"].includes(status)) return "pending";
  if (["PLACED", "ACCEPTED", "PREPARING", "READY", "OUT_FOR_DELIVERY", "DELIVERED"].includes(status)) {
    return "confirmed";
  }
  if (["REJECTED", "CANCELLED"].includes(status)) return "cancelled";
  return "pending";
}

function normalizeStoreId(value: string | { id: string } | null | undefined) {
  if (!value) return null;
  return typeof value === "string" ? value : value.id;
}

function normalizeServiceLines(body: StoreServiceBookingPayload) {
  const source = Array.isArray(body.services) && body.services.length > 0 ? body.services : body.selectedServices;
  const lines = Array.isArray(source) ? source : [];

  return lines.map((line) => {
    const quantity = Number.isFinite(Number(line.quantity)) ? Number(line.quantity) : 1;
    const price = Number.isFinite(Number(line.price)) ? Number(line.price) : 0;
    const durationMinutes = Number.isFinite(Number(line.duration_minutes)) ? Number(line.duration_minutes) : 0;

    return {
      id: line.id ?? null,
      title: String(line.title ?? "").trim(),
      quantity: quantity > 0 ? quantity : 1,
      price: price >= 0 ? price : 0,
      duration_minutes: durationMinutes >= 0 ? durationMinutes : 0,
    };
  });
}

function buildUtcSlotIso(bookingDate: string, bookingTime: string) {
  const [year, month, day] = bookingDate.split("-").map(Number);
  const [hour, minute, second] = bookingTime.split(":").map(Number);
  if (
    !Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day) ||
    !Number.isInteger(hour) || !Number.isInteger(minute) || !Number.isInteger(second)
  ) {
    return null;
  }
  return new Date(Date.UTC(year, month - 1, day, hour, minute, second)).toISOString();
}

function parseSlotToDateAndTime(slot: any, fallbackDate?: any, fallbackTime?: any) {
  const slotString = String(slot ?? "").trim();
  if (slotString) {
    const parsed = new Date(slotString);
    if (!Number.isNaN(parsed.getTime())) {
      const year = parsed.getUTCFullYear();
      const month = String(parsed.getUTCMonth() + 1).padStart(2, "0");
      const day = String(parsed.getUTCDate()).padStart(2, "0");
      const hours = String(parsed.getUTCHours()).padStart(2, "0");
      const minutes = String(parsed.getUTCMinutes()).padStart(2, "0");
      const seconds = String(parsed.getUTCSeconds()).padStart(2, "0");
      return {
        date: `${year}-${month}-${day}`,
        time: `${hours}:${minutes}:${seconds}`,
      };
    }
  }

  return {
    date: normalizeDateString(String(fallbackDate ?? "")) ?? null,
    time: normalizeTimeString(String(fallbackTime ?? "")) ?? null,
  };
}

function mapBookingForClient(order: any) {
  const slot = parseSlotToDateAndTime(order.slot_start_at, order.metadata?.booking_date, order.metadata?.booking_time);

  return {
    id: order.id,
    booking_code: order.order_no ?? null,
    store_id: order.store_id,
    booking_date: slot.date,
    booking_time: slot.time,
    status: deriveClientStatus(order),
    booking_status: order.status,
    notes: order.notes ?? null,
    services: order.items ?? [],
    selected_offer: order.metadata?.selected_offer ?? null,
    cover_charge_amount: order.metadata?.cover_charge_amount ?? null,
    payment_status: order.payment_status ? String(order.payment_status).toLowerCase() : null,
    payment_method: order.payment_method ?? null,
    payment_reference: order.metadata?.payment?.reference ?? null,
    payment_amount: order.total_amount ?? null,
    metadata: order.metadata ?? null,
  };
}

async function findRecentDuplicateBooking(params: {
  db: any;
  storeId: string;
  customerUserId: string;
  slotStartAt: string;
}) {
  const { data, error } = await params.db
    .from("store_orders")
    .select("*")
    .eq("store_id", params.storeId)
    .eq("customer_user_id", params.customerUserId)
    .eq("slot_start_at", params.slotStartAt)
    .in("status", NON_CANCELLED_ORDER_STATUSES)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return data;
}

export async function confirmStoreServiceBooking(
  body: StoreServiceBookingPayload,
  customer: AuthenticatedCustomer,
  db: any = supabase
) {
  const storeId = normalizeStoreId(body.store) ?? normalizeStoreId(body.restaurant);
  if (!storeId) {
    return {
      ok: false as const,
      status: 400,
      body: {
        error: "store.id or restaurant.id is required",
        code: "STORE_ID_REQUIRED",
      },
    };
  }

  const selectedDate = String(body.selectedDate ?? "").trim();
  const selectedTime = String(body.selectedTime ?? "").trim();

  if (!selectedDate || !selectedTime) {
    return {
      ok: false as const,
      status: 400,
      body: {
        error: "selectedDate and selectedTime are required",
        code: "SLOT_REQUIRED",
      },
    };
  }

  const bookingDate = normalizeDateString(selectedDate);
  const bookingTime = normalizeTimeString(selectedTime);

  if (!bookingDate || !bookingTime) {
    return {
      ok: false as const,
      status: 400,
      body: {
        error: "Invalid booking date or time",
        code: "INVALID_SLOT",
      },
    };
  }

  const normalizedServices = normalizeServiceLines(body).filter((line) => line.title.length > 0);
  if (normalizedServices.length === 0) {
    return {
      ok: false as const,
      status: 400,
      body: {
        error: "At least one service is required",
        code: "SERVICES_REQUIRED",
      },
    };
  }

  const { data: store, error: storeError } = await db
    .from("stores")
    .select("id, is_active")
    .eq("id", storeId)
    .maybeSingle();

  if (storeError) {
    return {
      ok: false as const,
      status: 500,
      body: {
        error: storeError.message,
        code: "STORE_LOOKUP_FAILED",
      },
    };
  }

  if (!store) {
    return {
      ok: false as const,
      status: 404,
      body: {
        error: "Store not found",
        code: "STORE_NOT_FOUND",
      },
    };
  }

  if (store.is_active !== true) {
    return {
      ok: false as const,
      status: 400,
      body: {
        error: "Store is inactive",
        code: "STORE_INACTIVE",
      },
    };
  }

  const payment = body.payment ?? null;
  const paymentAmount = parseNumericSignal(payment?.amount);
  const paymentRequired = paymentAmount > 0;
  const paymentVerified = !paymentRequired || isPaymentVerified(payment);
  const normalizedPaymentStatus = paymentRequired ? (paymentVerified ? "PAID" : "PENDING") : "PAID";
  const normalizedOrderStatus = paymentVerified ? "PLACED" : "NEW";

  const totalDuration = normalizedServices.reduce((total, line) => total + line.duration_minutes * line.quantity, 0);
  const slotStartAt = buildUtcSlotIso(bookingDate, bookingTime);
  if (!slotStartAt) {
    return {
      ok: false as const,
      status: 400,
      body: {
        error: "Invalid booking date or time",
        code: "INVALID_SLOT",
      },
    };
  }

  const slotEndAt = new Date(new Date(slotStartAt).getTime() + (totalDuration || 30) * 60 * 1000).toISOString();

  const existingBooking = await findRecentDuplicateBooking({
    db,
    storeId,
    customerUserId: customer.userId,
    slotStartAt,
  });

  if (existingBooking) {
    let updatedBooking = existingBooking;

    const shouldConfirmPending = existingBooking.status === "NEW" && paymentVerified;
    const shouldSyncPayment =
      paymentRequired &&
      (String(existingBooking.payment_status ?? "").trim().toUpperCase() !== normalizedPaymentStatus ||
        String(existingBooking.payment_method ?? "") !== String(payment?.method ?? existingBooking.payment_method ?? "") ||
        String(existingBooking.total_amount ?? "") !== String(paymentAmount));

    if (shouldConfirmPending || shouldSyncPayment) {
      const { data: syncedBooking, error: syncError } = await db
        .from("store_orders")
        .update({
          status: shouldConfirmPending ? "PLACED" : existingBooking.status,
          payment_status: normalizedPaymentStatus,
          payment_method: payment?.method ?? existingBooking.payment_method ?? null,
          total_amount: paymentAmount > 0 ? paymentAmount : existingBooking.total_amount,
          updated_at: new Date().toISOString(),
          metadata: {
            ...(existingBooking.metadata ?? {}),
            payment: {
              ...(existingBooking.metadata?.payment ?? {}),
              ...(payment ?? {}),
              amount: paymentAmount,
            },
          },
        })
        .eq("id", existingBooking.id)
        .select("*")
        .single();

      if (syncError) {
        return {
          ok: false as const,
          status: 500,
          body: {
            error: syncError.message,
            code: "BOOKING_PAYMENT_SYNC_FAILED",
          },
        };
      }

      if (syncedBooking) {
        updatedBooking = syncedBooking;
      }
    }

    return {
      ok: true as const,
      status: 200,
      body: {
        success: true,
        booking: mapBookingForClient(updatedBooking),
        duplicate: true,
      },
    };
  }

  const bookingCode = generateBookingCode();
  const subtotal = Number(
    normalizedServices.reduce((total, line) => total + parseNumericSignal(line.price) * parseNumericSignal(line.quantity), 0)
  );
  const totalAmount = paymentAmount > 0 ? paymentAmount : subtotal;

  const insertPayload = {
    order_no: bookingCode,
    store_id: storeId,
    customer_user_id: customer.userId,
    customer_name: customer.fullName || "Guest",
    customer_phone: customer.phone || "NA",
    customer_email: customer.email,
    notes: body.notes ?? null,
    items: normalizedServices,
    subtotal,
    total_amount: totalAmount,
    payment_method: payment?.method ?? "COD",
    payment_status: normalizedPaymentStatus,
    status: normalizedOrderStatus,
    order_flow: "BASIC",
    service_type: "APPOINTMENT",
    selected_item_in_store: true,
    scheduled_for: slotStartAt,
    slot_start_at: slotStartAt,
    slot_end_at: slotEndAt,
    metadata: {
      ...(body.metadata ?? {}),
      stylist: body.metadata?.stylist ?? null,
      source: body.metadata?.source ?? "app",
      serviceBooking: body.serviceBooking !== false,
      selected_offer: body.option ?? null,
      cover_charge_amount: paymentAmount,
      booking_date: bookingDate,
      booking_time: bookingTime,
      payment: {
        ...(payment ?? {}),
        amount: paymentAmount,
      },
    },
  };

  const { data: booking, error: insertError } = await db
    .from("store_orders")
    .insert(insertPayload as any)
    .select("*")
    .single();

  if (insertError) {
    return {
      ok: false as const,
      status: 500,
      body: {
        error: insertError.message,
        code: "BOOKING_INSERT_FAILED",
      },
    };
  }

  return {
    ok: true as const,
    status: 201,
    body: {
      success: true,
      booking: mapBookingForClient(booking),
    },
  };
}
