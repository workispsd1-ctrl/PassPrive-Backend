import supabase from "../../database/supabase";
import { FulleApiError, FulleService } from "./fulleService";

/**
 * XL-ENT (CashMag) booking sync.
 *
 * A DB trigger on restaurant_bookings enqueues a row in pos_sync_jobs whenever a
 * booking for an XL-ENT restaurant is created or a POS-relevant field changes
 * (see migration 20260930120000_xlent_pos_sync_outbox.sql). This worker claims
 * those jobs and reconciles the booking's current state with CashMag through the
 * Fulle API: create it if CashMag doesn't know it yet, otherwise update or cancel.
 */

export const XLENT_PROVIDER = "xlent";

const WORKER_INTERVAL_MS = 15_000;
const MAX_ATTEMPTS = 8;
const CLAIM_BATCH_SIZE = 10;

// CashMag booking levels: -1 = cancelled, 0 = awaiting acceptance, 1 = accepted.
const LEVEL_CANCELLED = -1;
const LEVEL_PENDING = 0;
const LEVEL_ACCEPTED = 1;
// Fulle "origin" of the booking (1 = external/online).
const BOOKING_ORIGIN_ONLINE = 1;

export type XlentCredentials = {
  mutualKey: string;
  pointOfSaleId: number;
};

type PosSyncJob = {
  id: string;
  booking_id: string;
  restaurant_id: string;
  provider_name: string;
  reason: string;
  attempts: number;
  updated_at: string;
};

export type BookingRow = {
  id: string;
  restaurant_id: string;
  customer_name: string | null;
  customer_phone: string | null;
  customer_email: string | null;
  booking_date: string;
  booking_time: string;
  duration_minutes: number | null;
  party_size: number;
  status: string | null;
  special_request: string | null;
  booking_code: string | null;
  cancel_reason: string | null;
  created_at: string;
  external_pos_id: string | null;
  external_pos_reference: string | null;
};

class NonRetryableSyncError extends Error {}

export class PosNotConfiguredError extends Error {}

/**
 * Reads the XL-ENT config for a restaurant. Returns null when the integration is
 * not enabled; throws PosNotConfiguredError when it is enabled but incomplete.
 */
export async function getXlentCredentials(restaurantId: string): Promise<XlentCredentials | null> {
  const { data, error } = await supabase
    .from("restaurant_till_providers")
    .select("external_restaurant_id, is_enabled, api_key_secret_id")
    .eq("restaurant_id", restaurantId)
    .eq("provider_name", XLENT_PROVIDER)
    .maybeSingle();

  if (error) {
    throw new Error(`Database error fetching XL-ENT config: ${error.message}`);
  }
  if (!data || !data.is_enabled) return null;

  const pointOfSaleId = Number(data.external_restaurant_id);
  if (!Number.isInteger(pointOfSaleId) || pointOfSaleId <= 0) {
    throw new PosNotConfiguredError(`XL-ENT point of sale is not selected for restaurant ${restaurantId}`);
  }

  const mutualKey = data.api_key_secret_id ? await getXlentApiKey(restaurantId) : null;
  if (!mutualKey) {
    throw new PosNotConfiguredError(`XL-ENT API key is missing for restaurant ${restaurantId}`);
  }

  return { mutualKey, pointOfSaleId };
}

/**
 * XL-ENT hands out merchant keys as "mutual<hex>", but the header scheme already
 * says "Mutual", so the prefix must not be sent twice.
 */
export function normalizeXlentApiKey(raw: string): string {
  return raw.trim().replace(/^mutual\s*/i, "").trim();
}

/** Decrypts the merchant API key from Supabase Vault (service role only). */
export async function getXlentApiKey(restaurantId: string): Promise<string | null> {
  const { data, error } = await supabase.rpc("get_till_provider_api_key", {
    p_restaurant_id: restaurantId,
    p_provider: XLENT_PROVIDER,
  });
  if (error) throw new Error(`Failed to read XL-ENT API key: ${error.message}`);
  return typeof data === "string" && data.trim() ? normalizeXlentApiKey(data) : null;
}

/** Encrypts and stores the merchant API key in Supabase Vault. The provider row must exist. */
export async function setXlentApiKey(restaurantId: string, apiKey: string): Promise<void> {
  const { error } = await supabase.rpc("set_till_provider_api_key", {
    p_restaurant_id: restaurantId,
    p_provider: XLENT_PROVIDER,
    p_api_key: normalizeXlentApiKey(apiKey),
  });
  if (error) throw new Error(`Failed to store XL-ENT API key: ${error.message}`);
}

// ---------------------------------------------------------------------------
// Payload helpers
// ---------------------------------------------------------------------------

function toHms(time: string): string {
  const [h = "0", m = "0", s = "0"] = String(time).split(":");
  return [h, m, s].map((part) => String(Number(part) || 0).padStart(2, "0")).join(":");
}

/** End time of the booking, or undefined when it would cross midnight. */
function endHms(time: string, durationMinutes: number | null): string | undefined {
  const duration = Number(durationMinutes) || 90;
  const [h, m] = toHms(time).split(":").map(Number);
  const end = h * 60 + m + duration;
  if (end >= 24 * 60) return undefined;
  return `${String(Math.floor(end / 60)).padStart(2, "0")}:${String(end % 60).padStart(2, "0")}:00`;
}

function toFulleDateTime(iso: string): string {
  const date = new Date(iso);
  const safe = Number.isNaN(date.getTime()) ? new Date() : date;
  return safe.toISOString().slice(0, 19).replace("T", " ");
}

function levelForStatus(status: string | null): number {
  if (status === "cancelled") return LEVEL_CANCELLED;
  if (status === "pending") return LEVEL_PENDING;
  return LEVEL_ACCEPTED;
}

function isUsablePhone(phone: string | null): phone is string {
  return Boolean(phone && phone.trim() && phone.trim().toUpperCase() !== "NA");
}

/** Shown on the POS so staff can identify the guest even without a CashMag client. */
function buildComment(booking: BookingRow): string {
  const header = [
    `PassPrive ${booking.booking_code ?? ""}`.trim(),
    booking.customer_name,
    isUsablePhone(booking.customer_phone) ? booking.customer_phone : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return booking.special_request ? `${header}\n${booking.special_request}` : header;
}

function extractList(response: any): any[] {
  if (Array.isArray(response)) return response;
  if (Array.isArray(response?.list)) return response.list;
  return [];
}

// ---------------------------------------------------------------------------
// CashMag operations
// ---------------------------------------------------------------------------

async function resolveServiceId(creds: XlentCredentials, booking: BookingRow): Promise<number | null> {
  try {
    const day = new Date(`${booking.booking_date}T00:00:00Z`).getUTCDay();
    const services = extractList(
      await FulleService.getBookingServices(creds.mutualKey, creds.pointOfSaleId, day)
    ).filter((service) => Number(service.archive ?? 0) === 0);
    if (services.length === 0) return null;

    const [bh, bm] = toHms(booking.booking_time).split(":").map(Number);
    const bookingMinutes = bh * 60 + bm;

    for (const service of services) {
      if (!service.start || !service.end) continue;
      const [sh, sm] = toHms(service.start).split(":").map(Number);
      const [eh, em] = toHms(service.end).split(":").map(Number);
      const start = sh * 60 + sm;
      let end = eh * 60 + em;
      if (end < start) end += 24 * 60;
      if (bookingMinutes >= start && bookingMinutes <= end) {
        return Number(service.id);
      }
    }
    return Number(services[0].id) || null;
  } catch (err) {
    console.warn("[XL-ENT] Could not resolve booking service:", err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * Find or create the CashMag client. CashMag rejects bookings without a client
 * (CODE_ERR_INSERT, err "empty"), so this must succeed for the booking to sync.
 */
async function resolveClientId(creds: XlentCredentials, booking: BookingRow): Promise<number> {
  const email = booking.customer_email?.trim() || null;
  if (email) {
    const found = extractList(await FulleService.getClientByEmail(creds.mutualKey, email));
    const match = found.find((client) => String(client.mail ?? "").toLowerCase() === email.toLowerCase());
    if (match?.id) return Number(match.id);
  }

  const [firstname, ...rest] = (booking.customer_name?.trim() || "Guest").split(/\s+/);
  const base: Record<string, unknown> = {
    category: 1,
    firstname,
    lastname: rest.join(" ") || firstname,
  };
  if (email) base.mail = email;

  // Phone is unique in CashMag; if it clashes with another client, retry without it.
  const attempts = isUsablePhone(booking.customer_phone)
    ? [{ ...base, phone: booking.customer_phone.trim() }, base]
    : [base];

  let lastError: unknown = null;
  for (const payload of attempts) {
    try {
      const created = await FulleService.createClient(creds.mutualKey, payload);
      const id = Number(created?.object?.id ?? created?.id);
      if (Number.isFinite(id) && id > 0) return id;
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(
    `Could not find or create the CashMag client: ${lastError instanceof Error ? lastError.message : "no id returned"}`
  );
}

/** Marker at the start of the booking comment; how we recognise our own bookings in CashMag. */
function commentMarker(booking: BookingRow): string | null {
  return booking.booking_code ? `PassPrive ${booking.booking_code}` : null;
}

/**
 * Finds a booking we already pushed (e.g. a previous attempt timed out after
 * CashMag created it). CashMag enforces id_extern uniqueness on insert but never
 * returns id_extern when listing, so we match on the comment marker instead.
 */
async function findExistingPosBooking(creds: XlentCredentials, booking: BookingRow) {
  const marker = commentMarker(booking);
  if (!marker) return null;

  const createdDate = booking.created_at.slice(0, 10);
  const [from, to] = [createdDate, booking.booking_date].sort();
  const list = extractList(
    await FulleService.getBookings(creds.mutualKey, {
      from_date: from,
      to_date: to,
      id_point_of_sale: creds.pointOfSaleId,
    })
  );
  const match = list.find((item) => {
    const comment = String(item.comment ?? "");
    return comment === marker || comment.startsWith(`${marker} `) || comment.startsWith(`${marker}\n`);
  });
  return match?.id ? { id: String(match.id), reference: match.reference ? String(match.reference) : null } : null;
}

function isDuplicateInsert(err: unknown): boolean {
  if (!(err instanceof FulleApiError)) return false;
  const body = err.body as { code?: number; err?: unknown } | null;
  // -1 CODE_ERR_INSERT without an "err" detail is what a duplicate id_extern returns.
  return body?.code === -1 && !body?.err;
}

export async function createPosBooking(creds: XlentCredentials, booking: BookingRow, isRetry: boolean) {
  if (isRetry) {
    const existing = await findExistingPosBooking(creds, booking).catch(() => null);
    if (existing) return existing;
  }

  const [clientId, serviceId] = await Promise.all([
    resolveClientId(creds, booking),
    resolveServiceId(creds, booking),
  ]);

  const payload: Record<string, unknown> = {
    id_extern: booking.id,
    date_creation: toFulleDateTime(booking.created_at),
    date_execution: booking.booking_date,
    hour_execution: toHms(booking.booking_time),
    n_people: booking.party_size,
    origin: BOOKING_ORIGIN_ONLINE,
    booking_level: { id: levelForStatus(booking.status) },
    client: { id: clientId },
    point_of_sale: { id: creds.pointOfSaleId },
    comment: buildComment(booking),
    notify: 1,
  };
  const hourEnd = endHms(booking.booking_time, booking.duration_minutes);
  if (hourEnd) payload.hour_end_execution = hourEnd;
  if (serviceId) payload.booking_service = { id: serviceId };

  let response: any;
  try {
    response = await FulleService.createBooking(creds.mutualKey, payload);
  } catch (err) {
    if (isDuplicateInsert(err)) {
      const existing = await findExistingPosBooking(creds, booking);
      if (existing) return existing;
    }
    throw err;
  }

  const createdId = Number(response?.object?.id ?? response?.id);
  if (Number.isFinite(createdId) && createdId > 0) {
    return {
      id: String(createdId),
      reference: (response?.object?.reference ?? response?.reference ?? null) as string | null,
    };
  }

  const existing = await findExistingPosBooking(creds, booking);
  if (existing) return existing;
  throw new Error("CashMag accepted the booking but did not return its id");
}

export async function updatePosBooking(creds: XlentCredentials, booking: BookingRow, reason: string) {
  const externalId = Number(booking.external_pos_id);
  if (!Number.isInteger(externalId)) {
    throw new NonRetryableSyncError(`Invalid external POS id "${booking.external_pos_id}"`);
  }

  if (booking.status === "cancelled") {
    await FulleService.updateBookingLevel(
      creds.mutualKey,
      externalId,
      LEVEL_CANCELLED,
      booking.cancel_reason || "Cancelled on PassPrive"
    );
    return;
  }

  const payload: Record<string, unknown> = {
    date_execution: booking.booking_date,
    hour_execution: toHms(booking.booking_time),
    n_people: booking.party_size,
    comment: buildComment(booking),
    notify: 1,
  };
  const hourEnd = endHms(booking.booking_time, booking.duration_minutes);
  if (hourEnd) payload.hour_end_execution = hourEnd;
  await FulleService.updateBooking(creds.mutualKey, externalId, payload);

  // Status changes (pending -> confirmed, or un-cancel) also move the CashMag level.
  if (reason.startsWith("status:") || reason === "manual") {
    await FulleService.updateBookingLevel(creds.mutualKey, externalId, levelForStatus(booking.status));
  }
}

// ---------------------------------------------------------------------------
// Job processing
// ---------------------------------------------------------------------------

type SyncOutcome =
  | { kind: "synced"; externalId: string | null; reference: string | null }
  | { kind: "skipped"; note: string };

async function syncBooking(job: PosSyncJob): Promise<SyncOutcome> {
  const { data: booking, error } = await supabase
    .from("restaurant_bookings")
    .select(
      "id, restaurant_id, customer_name, customer_phone, customer_email, booking_date, booking_time, duration_minutes, party_size, status, special_request, booking_code, cancel_reason, created_at, external_pos_id, external_pos_reference"
    )
    .eq("id", job.booking_id)
    .maybeSingle<BookingRow>();

  if (error) throw new Error(`Failed to load booking: ${error.message}`);
  if (!booking) return { kind: "skipped", note: "Booking no longer exists" };

  let creds: XlentCredentials | null;
  try {
    creds = await getXlentCredentials(booking.restaurant_id);
  } catch (err) {
    if (err instanceof PosNotConfiguredError) throw new NonRetryableSyncError(err.message);
    throw err;
  }
  if (!creds) return { kind: "skipped", note: "XL-ENT is disabled for this restaurant" };

  if (!booking.external_pos_id) {
    if (booking.status === "cancelled") {
      return { kind: "skipped", note: "Cancelled before it reached the POS" };
    }
    const created = await createPosBooking(creds, booking, job.attempts > 1);
    return { kind: "synced", externalId: created.id, reference: created.reference };
  }

  await updatePosBooking(creds, booking, job.reason);
  return { kind: "synced", externalId: booking.external_pos_id, reference: booking.external_pos_reference };
}

function isRetryable(err: unknown): boolean {
  if (err instanceof NonRetryableSyncError) return false;
  if (err instanceof FulleApiError) {
    return err.status === 408 || err.status === 429 || err.status >= 500;
  }
  return true; // network errors, timeouts, DB hiccups
}

function backoffMs(attempts: number): number {
  return Math.min(60 * 60 * 1000, 30_000 * 2 ** Math.max(0, attempts - 1));
}

/**
 * Closes the job unless the booking changed while we were syncing (the enqueue
 * trigger bumps updated_at); in that case the job goes back to pending.
 */
async function finishJob(job: PosSyncJob, patch: Record<string, unknown>) {
  const now = new Date().toISOString();
  const { data } = await supabase
    .from("pos_sync_jobs")
    .update({ ...patch, locked_at: null, updated_at: now })
    .eq("id", job.id)
    .eq("updated_at", job.updated_at)
    .select("id");

  if (!data || data.length === 0) {
    await supabase
      .from("pos_sync_jobs")
      .update({ status: "pending", locked_at: null, next_attempt_at: now, updated_at: now })
      .eq("id", job.id);
  }
}

async function processJob(job: PosSyncJob) {
  const now = new Date().toISOString();
  try {
    const outcome = await syncBooking(job);

    if (outcome.kind === "synced") {
      await supabase
        .from("restaurant_bookings")
        .update({
          external_pos_id: outcome.externalId,
          external_pos_reference: outcome.reference,
          pos_provider: job.provider_name,
          pos_sync_status: "synced",
          pos_sync_error: null,
          pos_synced_at: now,
        })
        .eq("id", job.booking_id);
    } else {
      await supabase
        .from("restaurant_bookings")
        .update({ pos_sync_status: "skipped", pos_sync_error: outcome.note })
        .eq("id", job.booking_id);
    }

    await finishJob(job, {
      status: "done",
      last_error: outcome.kind === "skipped" ? outcome.note : null,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const giveUp = !isRetryable(err) || job.attempts >= MAX_ATTEMPTS;
    console.error(
      `[XL-ENT] Sync failed for booking ${job.booking_id} (attempt ${job.attempts}${giveUp ? ", giving up" : ""}):`,
      message
    );

    await supabase
      .from("restaurant_bookings")
      .update({ pos_sync_status: giveUp ? "failed" : "pending", pos_sync_error: message.slice(0, 1000) })
      .eq("id", job.booking_id);

    await finishJob(job, {
      status: giveUp ? "failed" : "pending",
      last_error: message.slice(0, 2000),
      next_attempt_at: new Date(Date.now() + backoffMs(job.attempts)).toISOString(),
    });
  }
}

/** Claims and processes due jobs. Returns how many were processed. */
export async function runPosSyncJobs(options: { bookingId?: string; limit?: number } = {}): Promise<number> {
  const { data, error } = await supabase.rpc("claim_pos_sync_jobs", {
    p_limit: options.limit ?? CLAIM_BATCH_SIZE,
    p_booking_id: options.bookingId ?? null,
  });
  if (error) {
    console.error("[XL-ENT] Failed to claim POS sync jobs:", error.message);
    return 0;
  }

  const jobs = (data ?? []) as PosSyncJob[];
  // Sequential on purpose: FulleService rate-limits per merchant key anyway.
  for (const job of jobs) {
    await processJob(job);
  }
  return jobs.length;
}

/**
 * Syncs one booking right away (used after a booking is confirmed so the app
 * response already carries the POS reference). Never throws; gives up waiting
 * after timeoutMs and leaves the rest to the background worker.
 */
export async function syncBookingNow(bookingId: string, timeoutMs = 8000): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });
  try {
    await Promise.race([
      runPosSyncJobs({ bookingId, limit: 1 }).catch((err) => {
        console.error("[XL-ENT] Inline sync failed:", err);
      }),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Puts a booking back in the queue (admin "resync") and processes it now. */
export async function resyncBooking(bookingId: string): Promise<void> {
  const { error } = await supabase.rpc("requeue_pos_sync_job", {
    p_booking_id: bookingId,
    p_reason: "manual",
  });
  if (error) throw new Error(`Failed to queue resync: ${error.message}`);
  await syncBookingNow(bookingId, 20000);
}

let workerTimer: NodeJS.Timeout | null = null;
let workerRunning = false;

export function startPosSyncWorker() {
  if (workerTimer || process.env.POS_SYNC_WORKER_DISABLED === "true") return;

  const tick = async () => {
    if (workerRunning) return;
    workerRunning = true;
    try {
      // Drain in batches so a backlog doesn't wait a full interval per batch.
      while ((await runPosSyncJobs()) === CLAIM_BATCH_SIZE) {
        // keep going
      }
    } catch (err) {
      console.error("[XL-ENT] POS sync worker tick failed:", err);
    } finally {
      workerRunning = false;
    }
  };

  workerTimer = setInterval(tick, WORKER_INTERVAL_MS);
  workerTimer.unref?.();
  void tick();
  console.log("[XL-ENT] POS sync worker started");
}
