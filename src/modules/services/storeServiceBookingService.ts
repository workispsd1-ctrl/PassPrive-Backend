import { z } from "zod";
import supabase from "../../database/supabase";
import type { AuthenticatedCustomer } from "./authService";
import { normalizeDateString, normalizeTimeString } from "./restaurantBookingService";

const NON_CANCELLED_STATUSES = ["pending", "confirmed", "seated", "completed"];

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

function deriveClientStatus(booking: any) {
  return booking?.status;
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

function mapBookingForClient(booking: any) {
  return {
    id: booking.id,
    booking_code: booking.booking_code ?? null,
    store_id: booking.store_id,
    booking_date: booking.booking_date,
    booking_time: booking.booking_time,
    status: deriveClientStatus(booking),
    booking_status: booking.status,
    notes: booking.special_request ?? null,
    services: booking.services ?? booking.service_details ?? [],
    selected_offer: booking.selected_offer ?? null,
    cover_charge_amount: booking.cover_charge_amount ?? null,
    payment_status: booking.payment_status ?? null,
    payment_method: booking.payment_method ?? null,
    payment_reference: booking.payment_reference ?? null,
    payment_amount: booking.payment_amount ?? null,
    metadata: booking.metadata ?? null,
  };
}

async function findRecentDuplicateBooking(params: {
  db: any;
  storeId: string;
  customerUserId: string;
  bookingDate: string;
  bookingTime: string;
}) {
  const { data, error } = await params.db
    .from("store_bookings")
    .select("*")
    .eq("store_id", params.storeId)
    .eq("customer_user_id", params.customerUserId)
    .eq("booking_date", params.bookingDate)
    .eq("booking_time", params.bookingTime)
    .in("status", NON_CANCELLED_STATUSES)
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
  const normalizedPaymentStatus = paymentRequired ? (paymentVerified ? "paid" : "pending") : "paid";
  const normalizedBookingStatus = paymentVerified ? "confirmed" : "pending";

  const existingBooking = await findRecentDuplicateBooking({
    db,
    storeId,
    customerUserId: customer.userId,
    bookingDate,
    bookingTime,
  });

  if (existingBooking) {
    let updatedBooking = existingBooking;

    const shouldConfirmPending = existingBooking.status === "pending" && paymentVerified;
    const shouldSyncPayment =
      paymentRequired &&
      (String(existingBooking.payment_status ?? "").trim().toLowerCase() !== normalizedPaymentStatus ||
        existingBooking.payment_reference !== (payment?.reference ?? null) ||
        existingBooking.payment_method !== (payment?.method ?? null));

    if (shouldConfirmPending || shouldSyncPayment) {
      const { data: syncedBooking, error: syncError } = await db
        .from("store_bookings")
        .update({
          status: shouldConfirmPending ? "confirmed" : existingBooking.status,
          payment_required: paymentRequired,
          cover_charge_required: paymentRequired,
          cover_charge_amount: paymentAmount,
          payment_amount: paymentAmount,
          payment_status: normalizedPaymentStatus,
          payment_method: payment?.method ?? existingBooking.payment_method ?? null,
          payment_reference: payment?.reference ?? existingBooking.payment_reference ?? null,
          updated_at: new Date().toISOString(),
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

  const customerBookingNumberResp = await db
    .from("store_bookings")
    .select("id", { count: "exact", head: true })
    .eq("customer_user_id", customer.userId);

  if (customerBookingNumberResp?.error) {
    return {
      ok: false as const,
      status: 500,
      body: {
        error: customerBookingNumberResp.error.message,
        code: "BOOKING_COUNT_FAILED",
      },
    };
  }

  const totalDuration = normalizedServices.reduce((total, line) => total + line.duration_minutes * line.quantity, 0);
  const bookingCode = generateBookingCode();

  const insertPayload = {
    store_id: storeId,
    customer_user_id: customer.userId,
    customer_name: customer.fullName || "Guest",
    customer_phone: customer.phone || "NA",
    customer_email: customer.email,
    booking_date: bookingDate,
    booking_time: bookingTime,
    duration_minutes: totalDuration || 30,
    status: normalizedBookingStatus,
    source: String(body.metadata?.source ?? "app"),
    special_request: body.notes ?? null,
    booking_code: bookingCode,
    read: false,
    customer_booking_number: (customerBookingNumberResp?.count ?? 0) + 1,
    selected_offer: body.option ?? null,
    payment_required: paymentRequired,
    cover_charge_required: paymentRequired,
    cover_charge_amount: paymentAmount,
    payment_amount: paymentAmount,
    payment_status: normalizedPaymentStatus,
    payment_method: payment?.method ?? null,
    payment_reference: payment?.reference ?? null,
    booked_slot_label: selectedTime,
    services: normalizedServices,
    service_details: normalizedServices,
    metadata: {
      ...(body.metadata ?? {}),
      stylist: body.metadata?.stylist ?? null,
      source: body.metadata?.source ?? "app",
      serviceBooking: body.serviceBooking !== false,
    },
  };

  const { data: booking, error: insertError } = await db
    .from("store_bookings")
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
