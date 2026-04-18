import { Router } from "express";
import { z } from "zod";
import { createClient } from "@supabase/supabase-js";
import supabase from "../../database/supabase";

const router = Router();

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY!;

const supabaseService = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const EventSchema = z.object({
  entity_type: z.enum(["RESTAURANT", "STORE"]),
  entity_id: z.string().uuid(),
  event_type: z.enum([
    "IMPRESSION",
    "DETAIL_VIEW",
    "CLICK",
    "SAVE",
    "UNSAVE",
    "SHARE",
    "BOOKING_STARTED",
    "BOOKING_COMPLETED",
    "ORDER_STARTED",
    "ORDER_COMPLETED",
    "OFFER_VIEW",
    "OFFER_REDEEMED",
    "SEARCH_RESULT_VIEW",
    "CALL_TAP",
    "DIRECTIONS_TAP",
  ]),
  session_id: z.string().trim().min(1).max(200).optional().nullable(),
  anonymous_id: z.string().trim().min(1).max(200).optional().nullable(),
  source: z.string().trim().min(1).max(80).optional().default("APP"),
  surface: z.string().trim().min(1).max(120).optional().nullable(),
  city: z.string().trim().min(1).max(120).optional().nullable(),
  lat: z.coerce.number().min(-90).max(90).optional().nullable(),
  lng: z.coerce.number().min(-180).max(180).optional().nullable(),
  metadata: z.record(z.string(), z.unknown()).optional().default({}),
  occurred_at: z.string().datetime().optional().nullable(),
});

const BodySchema = z.union([
  EventSchema,
  z.object({
    events: z.array(EventSchema).min(1).max(100),
  }),
]);

function getBearerToken(req: any) {
  const header = req.headers.authorization || "";
  const [type, token] = header.split(" ");
  if (type !== "Bearer" || !token) return null;
  return token;
}

async function getOptionalUserId(req: any) {
  const token = getBearerToken(req);
  if (!token) return null;

  const {
    data: { user },
  } = await supabaseService.auth.getUser(token);

  return user?.id ?? null;
}

router.post("/events", async (req, res) => {
  const parsed = BodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid analytics payload", details: parsed.error.flatten() });
  }

  const events = "events" in parsed.data ? parsed.data.events : [parsed.data];
  const userId = await getOptionalUserId(req);

  try {
    const rows = events.map((event) => ({
      entity_type: event.entity_type,
      entity_id: event.entity_id,
      event_type: event.event_type,
      user_id: userId,
      session_id: event.session_id ?? null,
      anonymous_id: event.anonymous_id ?? null,
      source: event.source ?? "APP",
      surface: event.surface ?? null,
      city: event.city ?? null,
      lat: event.lat ?? null,
      lng: event.lng ?? null,
      metadata: event.metadata ?? {},
      occurred_at: event.occurred_at ?? new Date().toISOString(),
    }));

    const { data, error } = await supabase
      .from("entity_analytics_events")
      .insert(rows)
      .select("id");

    if (error) return res.status(500).json({ error: error.message });

    return res.status(201).json({
      ok: true,
      count: data?.length ?? rows.length,
      ids: (data ?? []).map((row: any) => row.id),
    });
  } catch (error: any) {
    return res.status(500).json({ error: error?.message ?? "Failed to record analytics event" });
  }
});

export default router;
