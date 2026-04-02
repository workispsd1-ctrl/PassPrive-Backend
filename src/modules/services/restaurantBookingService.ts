import { z } from "zod";
import supabase from "../../database/supabase";
import type { AuthenticatedCustomer } from "./authService";

const NON_CANCELLED_STATUSES = ["pending", "confirmed", "seated", "completed"];
const WEEKDAY_NAMES = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];

export const BookingPayloadSchema = z.object({
  restaurant: z.union([
    z.string().uuid(),
    z.object({
      id: z.string().uuid(),
    }),
  ]),
  guests: z.union([
    z.coerce.number().int().positive(),
    z.object({
      count: z.coerce.number().int().positive().optional(),
      value: z.coerce.number().int().positive().optional(),
    }),
  ]),
  selectedDate: z.string().trim().min(1),
  selectedTime: z.string().trim().min(1),
  meal: z.string().trim().nullable().optional(),
  option: z
    .object({
      type: z.string().trim().min(1),
      label: z.string().trim().nullable().optional(),
      offerId: z.string().trim().nullable().optional(),
      offer_id: z.string().trim().nullable().optional(),
      id: z.string().trim().nullable().optional(),
      title: z.string().trim().nullable().optional(),
      coverChargeRequired: z.boolean().optional(),
      coverChargeAmount: z.coerce.number().nullable().optional(),
      data: z.any().optional(),
    })
    .nullable()
    .optional(),
  notes: z.string().trim().max(1000).nullable().optional(),
  user: z.any().optional(),
  payment: z
    .object({
      amount: z.coerce.number().optional(),
      status: z.string().trim().nullable().optional(),
      method: z.string().trim().nullable().optional(),
      reference: z.string().trim().nullable().optional(),
      verified: z.boolean().optional(),
      paymentSessionId: z.string().uuid().nullable().optional(),
    })
    .nullable()
    .optional(),
});

export type BookingPayload = z.infer<typeof BookingPayloadSchema>;

export function normalizeRestaurantId(value: string | { id: string }) {
  return typeof value === "string" ? value : value.id;
}

function normalizePartySize(value: number | { count?: number; value?: number }) {
  return typeof value === "number" ? value : value.count ?? value.value ?? 0;
}

export function normalizeDateString(value: string) {
  const trimmed = value.trim();
  const directDateMatch = trimmed.match(/^(\d{4}-\d{2}-\d{2})/);
  if (directDateMatch) return directDateMatch[1];

  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) return null;

  const year = parsed.getFullYear();
  const month = String(parsed.getMonth() + 1).padStart(2, "0");
  const day = String(parsed.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function normalizeTimeString(value: string) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) return null;

  const meridiemMatch = trimmed.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)$/i);
  if (meridiemMatch) {
    let hours = Number(meridiemMatch[1]);
    const minutes = Number(meridiemMatch[2]);
    const seconds = Number(meridiemMatch[3] ?? 0);
    const meridiem = meridiemMatch[4].toUpperCase();

    if (
      !Number.isInteger(hours) || !Number.isInteger(minutes) || !Number.isInteger(seconds) ||
      hours < 1 || hours > 12 || minutes < 0 || minutes > 59 || seconds < 0 || seconds > 59
    ) return null;

    if (meridiem === "PM" && hours !== 12) hours += 12;
    if (meridiem === "AM" && hours === 12) hours = 0;

    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }

  const match24 = trimmed.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (match24) {
    const hours = Number(match24[1]);
    const minutes = Number(match24[2]);
    const seconds = Number(match24[3] ?? 0);

    if (
      !Number.isInteger(hours) || !Number.isInteger(minutes) || !Number.isInteger(seconds) ||
      hours < 0 || hours > 23 || minutes < 0 || minutes > 59 || seconds < 0 || seconds > 59
    ) return null;

    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }

  return null;
}


function timeToMinutes(value: string) {
  const normalized = normalizeTimeString(value);
  if (!normalized) return null;

  const [hours, minutes] = normalized.split(":").map(Number);
  return hours * 60 + minutes;
}

function isWithinOpeningWindow(timeMinutes: number, openMinutes: number, closeMinutes: number) {
  if (closeMinutes > openMinutes) {
    return timeMinutes >= openMinutes && timeMinutes <= closeMinutes;
  }

  return timeMinutes >= openMinutes || timeMinutes <= closeMinutes;
}

function getOpeningWindowsForDate(openingHours: any, bookingDate: Date) {
  if (!openingHours || typeof openingHours !== "object" || Array.isArray(openingHours)) {
    return [];
  }

  const weekdayName = WEEKDAY_NAMES[bookingDate.getDay()];
  const weekdayShort = weekdayName.slice(0, 3);
  const candidates = [
    openingHours[weekdayName],
    openingHours[weekdayName.toLowerCase()],
    openingHours[weekdayName.toUpperCase()],
    openingHours[weekdayShort],
    openingHours[weekdayShort.toLowerCase()],
    openingHours[weekdayShort.toUpperCase()],
    openingHours[String(bookingDate.getDay())],
  ].filter((value) => value !== undefined);

  const rawWindow = candidates[0];
  if (!rawWindow) return [];

  const normalizedWindows = Array.isArray(rawWindow) ? rawWindow : [rawWindow];

  return normalizedWindows
    .map((window) => {
      if (typeof window === "string") {
        const [open, close] = window.split(" - ").map((part) => part?.trim());
        return open && close ? { open, close } : null;
      }

      if (window && typeof window === "object" && !window.closed) {
        return {
          open: typeof window.open === "string" ? window.open : null,
          close: typeof window.close === "string" ? window.close : null,
        };
      }

      return null;
    })
    .filter((window): window is { open: string; close: string } => !!window?.open && !!window?.close);
}

function extractOfferCandidates(offerValue: any): any[] {
  if (!offerValue) return [];
  if (Array.isArray(offerValue)) return offerValue.filter(Boolean);

  if (typeof offerValue === "object") {
    if (Array.isArray(offerValue.offers)) return offerValue.offers.filter(Boolean);
    if (Array.isArray(offerValue.items)) return offerValue.items.filter(Boolean);

    return Object.values(offerValue).flatMap((value) => {
      if (Array.isArray(value)) return value.filter(Boolean);
      if (value && typeof value === "object") return [value];
      return [];
    });
  }

  return [];
}

function matchesOfferIdentifier(candidate: any, option: any) {
  const selectedIds = [
    option?.offerId,
    option?.offer_id,
    option?.id,
    option?.data?.offerId,
    option?.data?.offer_id,
    option?.data?.id,
  ]
    .filter((value) => typeof value === "string" && value.trim().length > 0)
    .map((value) => String(value).trim());

  const candidateIds = [
    candidate?.id,
    candidate?.offerId,
    candidate?.offer_id,
    candidate?.code,
  ]
    .filter((value) => typeof value === "string" && value.trim().length > 0)
    .map((value) => String(value).trim());

  if (selectedIds.length > 0 && candidateIds.length > 0) {
    return candidateIds.some((candidateId) => selectedIds.includes(candidateId));
  }

  const selectedTitle = String(
    option?.title ?? option?.label ?? option?.data?.title ?? option?.data?.label ?? ""
  )
    .trim()
    .toLowerCase();

  const candidateTitle = String(
    candidate?.title ?? candidate?.label ?? candidate?.name ?? candidate?.offer_title ?? ""
  )
    .trim()
    .toLowerCase();

  return selectedTitle.length > 0 && candidateTitle.length > 0 && selectedTitle === candidateTitle;
}

function isOfferDateActive(candidate: any, bookingDate: string) {
  const startValue =
    candidate?.start_at ??
    candidate?.starts_at ??
    candidate?.start_date ??
    candidate?.startDate ??   
    candidate?.valid_from ??
    null;
  const endValue =
    candidate?.end_at ??
    candidate?.ends_at ??
    candidate?.end_date ??
    candidate?.endDate ??     
    candidate?.valid_until ??
    null;

  if (startValue) {
    const normalizedStart = normalizeDateString(String(startValue));
    if (normalizedStart && bookingDate < normalizedStart) return false;
  }

  if (endValue) {
    const normalizedEnd = normalizeDateString(String(endValue));
    if (normalizedEnd && bookingDate > normalizedEnd) return false;
  }

  return true;
}

function isOfferWeekdayActive(candidate: any, bookingDate: Date) {
  const rawWeekdays =
    candidate?.weekdays ??
    candidate?.days ??
    candidate?.valid_days ??
    candidate?.applicable_days ??
    null;

  if (!rawWeekdays) return true;

  const weekdayName = WEEKDAY_NAMES[bookingDate.getDay()];
  const weekdayShort = weekdayName.slice(0, 3);

  const normalizedWeekdays = (Array.isArray(rawWeekdays) ? rawWeekdays : [rawWeekdays])
    .map((value) => String(value).trim().toLowerCase())
    .filter(Boolean);

  if (normalizedWeekdays.length === 0) return true;

  return normalizedWeekdays.includes(weekdayName) || normalizedWeekdays.includes(weekdayShort);
}

function isOfferTimeActive(candidate: any, bookingTime: string) {
  const timeMinutes = timeToMinutes(bookingTime);
  if (timeMinutes === null) return false;

  const startValue =
    candidate?.start_time ??
    candidate?.from_time ??
    candidate?.time_start ??
    candidate?.window_start ??
    candidate?.slotStart ??  
    null;
  const endValue =
    candidate?.end_time ??
    candidate?.to_time ??
    candidate?.time_end ??
    candidate?.window_end ??
     candidate?.slotEnd ??  
    null;

  if (!startValue || !endValue) return true;

  const startMinutes = timeToMinutes(String(startValue));
  const endMinutes = timeToMinutes(String(endValue));

  if (startMinutes === null || endMinutes === null) return true;

  return isWithinOpeningWindow(timeMinutes, startMinutes, endMinutes);
}

function isOfferActive(candidate: any, bookingDate: string, bookingDateValue: Date, bookingTime: string) {
  const explicitActive = candidate?.is_active;
  if (explicitActive === false) return false;

  return (
    isOfferDateActive(candidate, bookingDate) &&
    isOfferWeekdayActive(candidate, bookingDateValue) &&
    isOfferTimeActive(candidate, bookingTime)
  );
}

function findVerifiedOffer(restaurantOffer: any, option: any, bookingDate: string, bookingDateValue: Date, bookingTime: string) {
  const embeddedOffer =
    option?.offer ?? option?.data?.offer ?? option?.billPaymentOffer ?? option?.data?.billPaymentOffer ?? null;

  if (embeddedOffer && isOfferActive(embeddedOffer, bookingDate, bookingDateValue, bookingTime)) {
    return embeddedOffer;
  }

  const candidates = extractOfferCandidates(restaurantOffer);
  return candidates.find(
    (candidate) =>
      matchesOfferIdentifier(candidate, option) &&
      isOfferActive(candidate, bookingDate, bookingDateValue, bookingTime)
  );
}


function buildSelectedOfferSummary(offer: any) {
  if (!offer) return null;

  return {
    id: offer.id ?? offer.offerId ?? offer.offer_id ?? null,
    title: offer.title ?? offer.label ?? offer.name ?? null,
    description: offer.description ?? null,
    start_time: offer.start_time ?? offer.from_time ?? null,
    end_time: offer.end_time ?? offer.to_time ?? null,
  };
}

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

async function getRestaurantSlotBookingCount(restaurantId: string, bookingDate: string, bookingTime: string) {
  const { count, error } = await supabase
    .from("restaurant_bookings")
    .select("id", { count: "exact", head: true })
    .eq("restaurant_id", restaurantId)
    .eq("booking_date", bookingDate)
    .eq("booking_time", bookingTime)
    .is("cancelled_at", null)
    .in("status", NON_CANCELLED_STATUSES);

  if (error) throw error;
  return count ?? 0;
}

async function findRecentDuplicateBooking(params: {
  restaurantId: string;
  customerUserId: string;
  bookingDate: string;
  bookingTime: string;
  partySize: number;
}) {
  const { data, error } = await supabase
    .from("restaurant_bookings")
    .select("*")
    .eq("restaurant_id", params.restaurantId)
    .eq("customer_user_id", params.customerUserId)
    .eq("booking_date", params.bookingDate)
    .eq("booking_time", params.bookingTime)
    .eq("party_size", params.partySize)
    .in("status", NON_CANCELLED_STATUSES)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return data;
}

export async function evaluateBookingPaymentRequirement(body: BookingPayload, customer: AuthenticatedCustomer) {
  const restaurantId = normalizeRestaurantId(body.restaurant);
  const partySize = normalizePartySize(body.guests);
  const bookingDate = normalizeDateString(body.selectedDate);
  const bookingTime = normalizeTimeString(body.selectedTime);

  if (!bookingDate || !bookingTime) {
    return { ok: false as const, status: 400, body: { error: "Invalid booking date or time", code: "INVALID_SLOT" } };
  }

  const bookingDateValue = new Date(`${bookingDate}T00:00:00`);
  if (Number.isNaN(bookingDateValue.getTime())) {
    return { ok: false as const, status: 400, body: { error: "Invalid booking date", code: "INVALID_SLOT" } };
  }

  const { data: restaurant, error: restaurantError } = await supabase
    .from("restaurants")
    .select("*")
    .eq("id", restaurantId)
    .maybeSingle();

  if (restaurantError) {
    return { ok: false as const, status: 500, body: { error: restaurantError.message } };
  }
  if (!restaurant || restaurant.is_active !== true) {
    return { ok: false as const, status: 404, body: { error: "Restaurant not found", code: "RESTAURANT_NOT_FOUND" } };
  }
  if (restaurant.booking_enabled !== true) {
    return { ok: false as const, status: 400, body: { error: "Bookings are disabled", code: "BOOKING_DISABLED" } };
  }
  if (!Number.isInteger(partySize) || partySize <= 0) {
    return { ok: false as const, status: 400, body: { error: "Invalid guest count", code: "INVALID_PARTY_SIZE" } };
  }

  const now = new Date();
  const bookingDateTime = new Date(`${bookingDate}T${bookingTime}`);
  if (Number.isNaN(bookingDateTime.getTime())) {
    return { ok: false as const, status: 400, body: { error: "Invalid slot", code: "INVALID_SLOT" } };
  }

  const advanceBookingDays = Number(restaurant.advance_booking_days ?? 30);
  const latestBookingDate = new Date();
  latestBookingDate.setHours(23, 59, 59, 999);
  latestBookingDate.setDate(latestBookingDate.getDate() + advanceBookingDays);

  if (bookingDateTime > latestBookingDate) {
    return {
      ok: false as const,
      status: 400,
      body: { error: "Selected date exceeds advance booking window", code: "ADVANCE_WINDOW_EXCEEDED" },
    };
  }

  const minBookingTime = new Date(now.getTime() + 30 * 60 * 1000);
  if (bookingDateTime < minBookingTime) {
    return { ok: false as const, status: 400, body: { error: "Selected slot is no longer available", code: "INVALID_SLOT" } };
  }

  const openingWindows = getOpeningWindowsForDate(restaurant.opening_hours, bookingDateValue);
  if (openingWindows.length > 0) {
    const bookingTimeMinutes = timeToMinutes(bookingTime);
    const isOpenForSlot =
      bookingTimeMinutes !== null &&
      openingWindows.some((window) => {
        const openMinutes = timeToMinutes(window.open!);
        const closeMinutes = timeToMinutes(window.close!);
        if (openMinutes === null || closeMinutes === null) return false;
        return isWithinOpeningWindow(bookingTimeMinutes, openMinutes, closeMinutes);
      });

    if (!isOpenForSlot) {
      return {
        ok: false as const,
        status: 400,
        body: { error: "Selected time is outside restaurant opening hours", code: "INVALID_SLOT" },
      };
    }
  }

  const existingBooking = await findRecentDuplicateBooking({
    restaurantId,
    customerUserId: customer.userId,
    bookingDate,
    bookingTime,
    partySize,
  });

  const activeBookingCount = await getRestaurantSlotBookingCount(restaurantId, bookingDate, bookingTime);
  const maxBookingsPerSlot = parseNumericSignal(restaurant.max_bookings_per_slot);

  if (maxBookingsPerSlot > 0 && activeBookingCount >= maxBookingsPerSlot) {
    return { ok: false as const, status: 409, body: { error: "Selected slot is full", code: "SLOT_FULL" } };
  }

  const selectedOption = body.option ?? null;
  const isRegularBooking =
    !selectedOption ||
    String(selectedOption.type).trim().toLowerCase() === "regular table reservation";

  let verifiedOffer: any = null;
  if (!isRegularBooking) {
    verifiedOffer = findVerifiedOffer(
      restaurant.offer,
      selectedOption,
      bookingDate,
      bookingDateValue,
      bookingTime
    );

    if (!verifiedOffer) {
      return {
        ok: false as const,
        status: 400,
        body: { error: "Selected offer is invalid or inactive", code: "INVALID_OFFER" },
      };
    }
  }

  const requestedCoverChargeRequired =
    selectedOption?.coverChargeRequired === true ||
    parseNumericSignal(selectedOption?.coverChargeAmount) > 0;

  const verifiedCoverChargeAmount = requestedCoverChargeRequired
    ? parseNumericSignal(
        selectedOption?.coverChargeAmount ??
          verifiedOffer?.cover_charge_amount ??
          restaurant.cover_charge_amount
      )
    : 0;

  return {
    ok: true as const,
    bookingDate,
    bookingTime,
    partySize,
    restaurantId,
    restaurant,
    selectedOption,
    verifiedOffer,
    verifiedCoverChargeAmount,
    paymentRequired: verifiedCoverChargeAmount > 0,
    duplicateBooking: existingBooking ?? null,
  };
}

export async function confirmRestaurantBooking(body: BookingPayload, customer: AuthenticatedCustomer) {
  const evaluation = await evaluateBookingPaymentRequirement(body, customer);
  if (!evaluation.ok) return evaluation;

  const paymentRequired = evaluation.paymentRequired;
  const payment = body.payment ?? null;
  const paymentVerified = !paymentRequired || isPaymentVerified(payment);

  if (paymentRequired && !paymentVerified) {
    return {
      ok: false as const,
      status: 402,
      body: { error: "Payment verification is required before confirming this booking", code: "PAYMENT_REQUIRED" },
    };
  }

  if (evaluation.duplicateBooking) {
    let existingBooking = evaluation.duplicateBooking;

    if (paymentRequired && paymentVerified) {
      const currentPaymentStatus = String(existingBooking.payment_status ?? "").trim().toLowerCase();
      const nextPaymentReference = payment?.reference ?? existingBooking.payment_reference ?? null;
      const nextPaymentMethod = payment?.method ?? existingBooking.payment_method ?? null;
      const shouldSyncPaidState =
        currentPaymentStatus !== "paid" ||
        existingBooking.payment_reference !== nextPaymentReference ||
        existingBooking.payment_method !== nextPaymentMethod;

      if (shouldSyncPaidState) {
        const { data: updatedBooking, error: updateError } = await supabase
          .from("restaurant_bookings")
          .update({
            payment_status: "paid",
            payment_method: nextPaymentMethod,
            payment_reference: nextPaymentReference,
            payment_amount: evaluation.verifiedCoverChargeAmount,
            payment_required: true,
            cover_charge_required: true,
            cover_charge_amount: evaluation.verifiedCoverChargeAmount,
            status: existingBooking.status === "pending" ? "confirmed" : existingBooking.status,
            updated_at: new Date().toISOString(),
          })
          .eq("id", existingBooking.id)
          .select("*")
          .single();

        if (updateError) {
          return {
            ok: false as const,
            status: 500,
            body: { error: updateError.message, code: "BOOKING_PAYMENT_SYNC_FAILED" },
          };
        }

        if (updatedBooking) {
          existingBooking = updatedBooking;
        }
      }
    }

    return {
      ok: true as const,
      status: 200,
      body: {
        booking: {
          id: existingBooking.id,
          booking_code: existingBooking.booking_code,
          restaurant_id: existingBooking.restaurant_id,
          booking_date: existingBooking.booking_date,
          booking_time: existingBooking.booking_time,
          party_size: existingBooking.party_size,
          status: deriveClientStatus(existingBooking),
          booking_status: existingBooking.status,
          selected_offer: existingBooking.selected_offer ?? null,
          cover_charge_amount: existingBooking.cover_charge_amount ?? null,
          payment_status: existingBooking.payment_status ?? null,
          payment_method: existingBooking.payment_method ?? null,
          payment_reference: existingBooking.payment_reference ?? null,
        },
        duplicate: true,
      },
    };
  }

  const customerBookingNumberResp = await supabase
    .from("restaurant_bookings")
    .select("id", { count: "exact", head: true })
    .eq("customer_user_id", customer.userId);

  if (customerBookingNumberResp.error) {
    return {
      ok: false as const,
      status: 500,
      body: { error: customerBookingNumberResp.error.message },
    };
  }

  const normalizedPaymentStatus = paymentRequired ? (paymentVerified ? "paid" : "pending") : "paid";
  const bookingCode = generateBookingCode();
  const insertPayload = {
    restaurant_id: evaluation.restaurantId,
    customer_user_id: customer.userId,
    customer_name: customer.fullName || "Guest",
    customer_phone: customer.phone || "NA",
    customer_email: customer.email,
    booking_date: evaluation.bookingDate,
    booking_time: evaluation.bookingTime,
    duration_minutes: parseNumericSignal(evaluation.restaurant.avg_duration_minutes) || 90,
    party_size: evaluation.partySize,
    status: "confirmed",
    source: "app",
    special_request: body.notes ?? null,
    booking_code: bookingCode,
    read: false,
    customer_booking_number: (customerBookingNumberResp.count ?? 0) + 1,
    selected_offer: buildSelectedOfferSummary(evaluation.verifiedOffer),
    payment_required: paymentRequired,
    cover_charge_required: paymentRequired,
    cover_charge_amount: paymentRequired ? evaluation.verifiedCoverChargeAmount : 0,
    payment_amount: paymentRequired ? evaluation.verifiedCoverChargeAmount : 0,
    payment_status: normalizedPaymentStatus,
    payment_method: payment?.method ?? null,
    payment_reference: payment?.reference ?? null,
    booked_slot_label: body.selectedTime ?? null,
  };

  const { data: booking, error: insertError } = await supabase
    .from("restaurant_bookings")
    .insert(insertPayload as any)
    .select("*")
    .single();

  if (insertError) {
    return {
      ok: false as const,
      status: 500,
      body: { error: insertError.message, code: "BOOKING_INSERT_FAILED" },
    };
  }

  return {
    ok: true as const,
    status: 201,
    body: {
      booking: {
        id: booking.id,
        booking_code: booking.booking_code,
        restaurant_id: booking.restaurant_id,
        booking_date: booking.booking_date,
        booking_time: booking.booking_time,
        party_size: booking.party_size,
        status: deriveClientStatus(booking),
        booking_status: booking.status,
        selected_offer: booking.selected_offer ?? null,
        cover_charge_amount: booking.cover_charge_amount ?? null,
        payment_status: booking.payment_status ?? null,
      },
    },
  };
}
