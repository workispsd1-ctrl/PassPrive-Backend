import { Router } from "express";
import { z } from "zod";
import { createClient } from "@supabase/supabase-js";
import supabase from "../../database/supabase";
import {
  buildStoreSlotConfig,
  getProductCataloguePayload,
  getServiceCataloguePayload,
} from "./storeCatalogue";
import { fetchHydratedStoreRowById, hydrateStoreRow, hydrateStoreRows, STORE_BASE_SELECT } from "../services/storeShape";

const router = Router();

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY!;
const LIST_QUERY_TIMEOUT_MS = Number(process.env.LIST_QUERY_TIMEOUT_MS ?? 5000);
const STORE_ROUTE_DEBUG = String(process.env.STORE_ROUTE_DEBUG ?? "false").trim().toLowerCase() === "true";
const STORE_STORAGE_BUCKET = "stores";

const supabaseService = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

function supabaseAuthed(req: any) {
  const h = req.headers.authorization || "";
  const [type, token] = h.split(" ");
  if (type !== "Bearer" || !token) return null;

  return createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
}

async function requireAdmin(req: any, res: any) {
  const sb = supabaseAuthed(req);
  if (!sb) {
    res.status(401).json({ error: "Missing token" });
    return null;
  }

  const { data: { user }, error: userErr } = await sb.auth.getUser();
  if (userErr || !user) {
    res.status(401).json({ error: "Invalid session" });
    return null;
  }

  // Check the 'users' table for the role using the authed client
  const { data: row, error: roleErr } = await sb
    .from("users")
    .select("role")
    .eq("id", user.id)
    .maybeSingle();

  const role = row?.role?.toLowerCase();
  
  if (roleErr || !role || !["admin", "superadmin"].includes(role)) {
    res.status(403).json({ error: "Access denied" });
    return null;
  }

  return { sb, callerId: user.id };
}

const IdSchema = z.string().uuid();

const ListQuerySchema = z.object({
  // search across name/slug/category/subcategory/city/region/tags
  search: z.string().trim().min(1).optional(),

  // filters
  city: z.string().trim().min(1).optional(),
  region: z.string().trim().min(1).optional(),
  country: z.string().trim().min(1).optional(),
  category: z.string().trim().min(1).optional(),
  subcategory: z.string().trim().min(1).optional(),
  tag: z.string().trim().min(1).optional(), // single tag filter
  is_featured: z
    .string()
    .optional()
    .transform((v) => (v === undefined ? undefined : v === "true")),

  // status maps to is_active
  status: z.enum(["active", "inactive"]).optional(),
  includeInactive: z
    .string()
    .optional()
    .transform((v) => v === "true"),

  // pagination
  limit: z
    .string()
    .optional()
    .transform((v) => (v ? Number(v) : 20))
    .refine((n) => Number.isFinite(n) && n > 0 && n <= 100, "limit 1-100"),
  offset: z
    .string()
    .optional()
    .transform((v) => (v ? Number(v) : 0))
    .refine((n) => Number.isFinite(n) && n >= 0, "offset must be >= 0"),

  // sorting (safe allowlist)
  sort: z
    .enum(["created_at", "updated_at", "name", "sort_order"])
    .optional()
    .default("created_at"),
  order: z.enum(["asc", "desc"]).optional().default("desc"),
});

const DeleteQuerySchema = z.object({
  hard: z
    .string()
    .optional()
    .transform((v) => v === undefined ? true : v !== "false"),
});

const FeedQuerySchema = z.object({
  search: z.string().trim().min(1).optional(),
  city: z.string().trim().min(1).optional(),
  region: z.string().trim().min(1).optional(),
  country: z.string().trim().min(1).optional(),
  category: z.string().trim().min(1).optional(),
  subcategory: z.string().trim().min(1).optional(),
  tag: z.string().trim().min(1).optional(),
  includeInactive: z
    .string()
    .optional()
    .transform((v) => v === "true"),
  lat: z
    .string()
    .optional()
    .transform((v) => (v ? Number(v) : null))
    .refine((n) => n === null || Number.isFinite(n), "lat must be numeric"),
  lng: z
    .string()
    .optional()
    .transform((v) => (v ? Number(v) : null))
    .refine((n) => n === null || Number.isFinite(n), "lng must be numeric"),
  limit: z
    .string()
    .optional()
    .transform((v) => (v ? Number(v) : 24))
    .refine((n) => Number.isFinite(n) && n > 0 && n <= 100, "limit 1-100"),
  offset: z
    .string()
    .optional()
    .transform((v) => (v ? Number(v) : 0))
    .refine((n) => Number.isFinite(n) && n >= 0, "offset must be >= 0"),
});

const NewKickInQuerySchema = z.object({
  search: z.string().trim().min(1).optional(),
  city: z.string().trim().min(1).optional(),
  region: z.string().trim().min(1).optional(),
  country: z.string().trim().min(1).optional(),
  category: z.string().trim().min(1).optional(),
  subcategory: z.string().trim().min(1).optional(),
  tag: z.string().trim().min(1).optional(),
  includeInactive: z
    .string()
    .optional()
    .transform((v) => v === "true"),
  lat: z
    .string()
    .optional()
    .transform((v) => (v ? Number(v) : null))
    .refine((n) => n === null || Number.isFinite(n), "lat must be numeric"),
  lng: z
    .string()
    .optional()
    .transform((v) => (v ? Number(v) : null))
    .refine((n) => n === null || Number.isFinite(n), "lng must be numeric"),
  limit: z
    .string()
    .optional()
    .transform((v) => (v ? Number(v) : 24))
    .refine((n) => Number.isFinite(n) && n > 0 && n <= 100, "limit 1-100"),
  offset: z
    .string()
    .optional()
    .transform((v) => (v ? Number(v) : 0))
    .refine((n) => Number.isFinite(n) && n >= 0, "offset must be >= 0"),
  freshnessDays: z
    .string()
    .optional()
    .transform((v) => (v ? Number(v) : 30))
    .refine((n) => Number.isFinite(n) && n > 0 && n <= 90, "freshnessDays 1-90"),
  excludeStoreIds: z.string().optional(),
});

const NullableTrimmedString = z.string().trim().nullable().optional();
const NullableNumber = z.coerce.number().nullable().optional();
const NullableInteger = z.coerce.number().int().nullable().optional();

const OpeningHoursValueSchema = z.object({
  open: z.string().optional().default(""),
  close: z.string().optional().default(""),
  is_closed: z.boolean().optional(),
});

const OpeningHoursSchema = z.record(z.string(), OpeningHoursValueSchema);

const LegacyHoursRowSchema = z.object({
  day_of_week: z.coerce.number().int().min(0).max(6),
  open_time: z.string().nullable().optional(),
  close_time: z.string().nullable().optional(),
  is_closed: z.boolean().optional(),
});

function normalizeBookingTerms(value: unknown, preserveUndefined = false) {
  if (value === undefined) return preserveUndefined ? undefined : [];
  if (value === null) return null;

  const terms = Array.isArray(value) ? value : [value];
  return terms
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

const CreateBookingTermsSchema = z.preprocess(
  (value) => normalizeBookingTerms(value, false),
  z.array(z.string()).nullable()
);

const UpdateBookingTermsSchema = z.preprocess(
  (value) => normalizeBookingTerms(value, true),
  z.union([z.array(z.string()), z.null(), z.undefined()])
);

const StoreSubscriptionSchema = z
  .object({
    id: z.string().uuid().optional(),
    plan_code: NullableTrimmedString,
    status: NullableTrimmedString,
    pickup_premium_enabled: z.boolean().optional(),
    starts_at: z.string().datetime().nullable().optional(),
    expires_at: z.string().datetime().nullable().optional(),
    metadata: z.record(z.string(), z.any()).optional(),
  })
  .passthrough();

const UpdateStoreSchema = z
  .object({
    name: z.string().trim().min(1).optional(),
    slug: z.string().trim().min(1).optional(),
    description: NullableTrimmedString,
    category: NullableTrimmedString,
    subcategory: NullableTrimmedString,
    phone: NullableTrimmedString,
    whatsapp: NullableTrimmedString,
    email: NullableTrimmedString,
    website: NullableTrimmedString,
    location_name: NullableTrimmedString,
    address_line1: NullableTrimmedString,
    address_line2: NullableTrimmedString,
    city: NullableTrimmedString,
    region: NullableTrimmedString,
    country: NullableTrimmedString,
    postal_code: NullableTrimmedString,
    full_address: NullableTrimmedString,
    lat: NullableNumber,
    lng: NullableNumber,
    google_place_id: NullableTrimmedString,
    logo_url: NullableTrimmedString,
    cover_image: NullableTrimmedString,
    owner_user_id: z.string().uuid().nullable().optional(),
    created_by: z.string().uuid().nullable().optional(),
    is_featured: z.boolean().optional(),
    is_active: z.boolean().optional(),
    is_top_brand: z.boolean().optional(),
    sort_order: NullableInteger,
    store_type: NullableTrimmedString,
    booking_enabled: z.boolean().optional(),
    avg_duration_minutes: NullableInteger,
    max_bookings_per_slot: NullableInteger,
    advance_booking_days: NullableInteger,
    modification_available: z.boolean().optional(),
    modification_cutoff_minutes: NullableInteger,
    cancellation_available: z.boolean().optional(),
    cancellation_cutoff_minutes: NullableInteger,
    cover_charge_enabled: z.boolean().optional(),
    cover_charge_amount: NullableNumber,
    booking_terms: UpdateBookingTermsSchema,
    pickup_basic_enabled: z.boolean().optional(),
    pickup_mode: NullableTrimmedString,
    supports_time_slots: z.boolean().optional(),
    slot_duration_minutes: NullableInteger,
    slot_buffer_minutes: NullableInteger,
    slot_advance_days: NullableInteger,
    slot_max_per_window: NullableInteger,
    is_advertised: z.boolean().optional(),
    ad_priority: NullableInteger,
    ad_starts_at: z.string().datetime().nullable().optional(),
    ad_ends_at: z.string().datetime().nullable().optional(),
    ad_badge_text: NullableTrimmedString,
    tags: z.array(z.string()).optional(),
    facilities: z.array(z.string()).optional(),
    highlights: z.array(z.string()).optional(),
    worth_visit: z.array(z.string()).optional(),
    mood_tags: z.array(z.string()).optional(),
    social_links: z.record(z.string(), z.string()).optional(),
    instagram: NullableTrimmedString,
    facebook: NullableTrimmedString,
    tiktok: NullableTrimmedString,
    maps: NullableTrimmedString,
    opening_hours: OpeningHoursSchema.nullable().optional(),
    hours: z.array(LegacyHoursRowSchema).nullable().optional(),
    offers: z.array(z.any()).nullable().optional(),
    offer: z.array(z.any()).nullable().optional(),
    subscription: StoreSubscriptionSchema.nullable().optional(),
    gallery_urls: z.array(z.string()).optional(),
    cover_video_url: NullableTrimmedString,
  })
  .passthrough();

function normalizeStoreStoragePath(value: unknown) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;

  if (!/^https?:\/\//i.test(raw)) {
    const normalized = raw.replace(/^\/+/, "");
    const marker = "store/";
    const markerIndex = normalized.indexOf(marker);
    return markerIndex >= 0 ? normalized.slice(markerIndex + marker.length) : normalized;
  }

  const objectPublicMatch = raw.match(new RegExp(`/object/public/${STORE_STORAGE_BUCKET}/(.+)$`, "i"));
  if (objectPublicMatch?.[1]) return objectPublicMatch[1];

  const fallbackMatch = raw.match(new RegExp(`/${STORE_STORAGE_BUCKET}/(.+)$`, "i"));
  return fallbackMatch?.[1] ?? null;
}

function normalizeMediaReferenceForStorage(value: unknown) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;

  const filePath = normalizeStoreStoragePath(raw);
  if (/^https?:\/\//i.test(raw)) {
    return { file_url: raw, file_path: filePath };
  }

  const { data } = supabase.storage.from(STORE_STORAGE_BUCKET).getPublicUrl(filePath ?? raw);
  return {
    file_url: data?.publicUrl ?? raw,
    file_path: filePath ?? raw,
  };
}

function normalizeLegacyOfferTitle(item: any) {
  if (typeof item === "string") return item.trim();
  if (!item || typeof item !== "object") return "";
  return String(item.title ?? item.text ?? item.label ?? item.name ?? "").trim();
}

function normalizeOfferNumericValue(value: any) {
  if (value === "" || value === undefined || value === null) return null;
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) return null;
  return amount;
}

function normalizeStoreOfferForStorage(item: any) {
  if (item === null || item === undefined) return null;

  if (typeof item === "string") {
    const title = item.trim();
    if (!title) return null;

    return {
      title,
      description: null,
      badge_text: null,
      offer_type: "custom",
      discount_value: null,
      min_spend: null,
      start_at: null,
      end_at: null,
      is_active: true,
      metadata: {},
    };
  }

  if (typeof item === "object" && !Array.isArray(item)) {
    const title = normalizeLegacyOfferTitle(item);
    if (!title) return null;

    const normalizedType = String(item.offer_type ?? item.type ?? "custom").trim().toLowerCase();
    const offerType = ["flat", "percentage", "bogo", "free_item", "cover_discount", "custom"].includes(
      normalizedType
    )
      ? normalizedType
      : "custom";

    const {
      id: _id,
      title: _title,
      text: _text,
      label: _label,
      name: _name,
      offer_type: _offerType,
      type: _type,
      ...rest
    } = item;

    return {
      title,
      description: typeof item.description === "string" ? item.description : null,
      badge_text: typeof item.badge_text === "string" ? item.badge_text : null,
      offer_type: offerType,
      discount_value: normalizeOfferNumericValue(item.discount_value),
      min_spend: normalizeOfferNumericValue(item.minimum_bill_amount ?? item.min_spend),
      start_at: item.start_at ?? null,
      end_at: item.end_at ?? null,
      is_active: item.is_active !== false,
      metadata: rest,
    };
  }

  return null;
}

function getStoreOfferRowsFromBody(body: { offer?: any[] | null; offers?: any[] | null }) {
  if (Array.isArray(body.offers)) return body.offers;
  if (Array.isArray(body.offer)) return body.offer;
  if (body.offers === null) return null;
  if (body.offer === null) return null;
  return undefined;
}

function normalizeOpeningHoursForStorage(
  openingHours: Record<string, { open?: string; close?: string; is_closed?: boolean }> | null | undefined,
  legacyHours: Array<{ day_of_week: number; open_time?: string | null; close_time?: string | null; is_closed?: boolean }> | null | undefined
) {
  if (openingHours === undefined && legacyHours === undefined) return undefined;
  if (openingHours === null || legacyHours === null) return [];

  if (openingHours) {
    return Object.entries(openingHours)
      .map(([day, value]) => {
        const dayOfWeek = Number(day);
        if (!Number.isInteger(dayOfWeek) || dayOfWeek < 0 || dayOfWeek > 6) return null;
        const open = typeof value?.open === "string" ? value.open : "";
        const close = typeof value?.close === "string" ? value.close : "";
        const isClosed = value?.is_closed === true || !open || !close;
        return {
          day_of_week: dayOfWeek,
          open_time: isClosed ? null : open,
          close_time: isClosed ? null : close,
          is_closed: isClosed,
        };
      })
      .filter(Boolean) as Array<{
      day_of_week: number;
      open_time: string | null;
      close_time: string | null;
      is_closed: boolean;
    }>;
  }

  return (legacyHours ?? []).map((row) => {
    const isClosed = row.is_closed === true || !row.open_time || !row.close_time;
    return {
      day_of_week: row.day_of_week,
      open_time: isClosed ? null : row.open_time ?? null,
      close_time: isClosed ? null : row.close_time ?? null,
      is_closed: isClosed,
    };
  });
}

function mergeSocialLinks(body: z.infer<typeof UpdateStoreSchema>) {
  const socialLinks: Record<string, string> = {};

  for (const [key, value] of Object.entries(body.social_links ?? {})) {
    if (!String(key).trim() || !String(value ?? "").trim()) continue;
    socialLinks[String(key).trim()] = String(value).trim();
  }

  const aliases = {
    instagram: body.instagram,
    facebook: body.facebook,
    tiktok: body.tiktok,
    maps: body.maps,
  };

  for (const [platform, value] of Object.entries(aliases)) {
    if (value === undefined) continue;
    if (value === null || value.trim() === "") {
      delete socialLinks[platform];
      continue;
    }
    socialLinks[platform] = value.trim();
  }

  return socialLinks;
}

async function replaceStoreTags(
  sb: any,
  storeId: string,
  updates: Partial<Record<"tags" | "facilities" | "highlights" | "worth_visit" | "mood_tags", string[]>>
) {
  const mappings = [
    { bodyKey: "tags" as const, tagType: "tag" },
    { bodyKey: "facilities" as const, tagType: "facility" },
    { bodyKey: "highlights" as const, tagType: "highlight" },
    { bodyKey: "worth_visit" as const, tagType: "worth_visit" },
    { bodyKey: "mood_tags" as const, tagType: "mood" },
  ];

  const providedMappings = mappings.filter(({ bodyKey }) => updates[bodyKey] !== undefined);
  if (!providedMappings.length) return;

  const { error: deleteError } = await sb
    .from("store_tags")
    .delete()
    .eq("store_id", storeId)
    .in("tag_type", providedMappings.map(({ tagType }) => tagType));
  if (deleteError) throw deleteError;

  const rows = providedMappings.flatMap(({ bodyKey, tagType }) =>
    (updates[bodyKey] ?? [])
      .map((value, index) => ({
        store_id: storeId,
        tag_type: tagType,
        tag_value: String(value).trim(),
        sort_order: index,
      }))
      .filter((row) => row.tag_value.length > 0)
  );

  if (!rows.length) return;

  const { error: insertError } = await sb.from("store_tags").insert(rows);
  if (insertError) throw insertError;
}

async function replaceStoreSocialLinks(sb: any, storeId: string, socialLinks: Record<string, string> | undefined) {
  if (socialLinks === undefined) return;

  const { error: deleteError } = await sb
    .from("store_social_links")
    .delete()
    .eq("store_id", storeId);
  if (deleteError) throw deleteError;

  const rows = Object.entries(socialLinks)
    .map(([platform, url], index) => ({
      store_id: storeId,
      platform,
      url,
      sort_order: index,
    }))
    .filter((row) => row.platform.trim() && row.url.trim());

  if (!rows.length) return;

  const { error: insertError } = await sb.from("store_social_links").insert(rows);
  if (insertError) throw insertError;
}

async function replaceStoreOpeningHours(
  sb: any,
  storeId: string,
  openingHours: Record<string, { open?: string; close?: string; is_closed?: boolean }> | null | undefined,
  legacyHours: Array<{ day_of_week: number; open_time?: string | null; close_time?: string | null; is_closed?: boolean }> | null | undefined
) {
  const rows = normalizeOpeningHoursForStorage(openingHours, legacyHours);
  if (rows === undefined) return;

  const { error: deleteError } = await sb
    .from("store_opening_hours")
    .delete()
    .eq("store_id", storeId);
  if (deleteError) throw deleteError;

  if (!rows.length) return;

  const { error: insertError } = await sb
    .from("store_opening_hours")
    .insert(rows.map((row) => ({ store_id: storeId, ...row })));
  if (insertError) throw insertError;
}

async function replaceStoreOffers(sb: any, storeId: string, offerInput: any[] | null | undefined) {
  if (offerInput === undefined) return;

  const { error: deleteError } = await sb
    .from("store_offers")
    .delete()
    .eq("store_id", storeId);
  if (deleteError) throw deleteError;

  if (!offerInput || !offerInput.length) return;

  const rows = offerInput
    .map((item) => normalizeStoreOfferForStorage(item))
    .filter(Boolean)
    .map((offer) => ({
      store_id: storeId,
      ...offer,
    }));

  if (!rows.length) return;

  const { error: insertError } = await sb.from("store_offers").insert(rows);
  if (insertError) throw insertError;
}

async function replaceStoreSubscription(
  sb: any,
  storeId: string,
  subscription: z.infer<typeof StoreSubscriptionSchema> | null | undefined
) {
  if (subscription === undefined) return;

  const { error: deleteError } = await sb
    .from("store_subscriptions")
    .delete()
    .eq("store_id", storeId);
  if (deleteError) throw deleteError;

  if (!subscription) return;

  const row = {
    ...(subscription.id ? { id: subscription.id } : {}),
    store_id: storeId,
    plan_code: subscription.plan_code ?? null,
    status: subscription.status ?? (subscription.pickup_premium_enabled ? "active" : "inactive"),
    pickup_premium_enabled: subscription.pickup_premium_enabled ?? false,
    starts_at: subscription.starts_at ?? null,
    expires_at: subscription.expires_at ?? null,
    metadata: subscription.metadata ?? {},
  };

  const { error: insertError } = await sb.from("store_subscriptions").insert(row);
  if (insertError) throw insertError;
}

async function replaceStoreMedia(
  sb: any,
  storeId: string,
  media: {
    logo_url?: string | null;
    cover_image?: string | null;
    cover_video_url?: string | null;
    gallery_urls?: string[];
  }
) {
  const assetMappings = [
    { assetType: "logo", values: media.logo_url === undefined ? undefined : media.logo_url ? [media.logo_url] : [] },
    {
      assetType: "cover_image",
      values: media.cover_image === undefined ? undefined : media.cover_image ? [media.cover_image] : [],
    },
    {
      assetType: "cover_video",
      values: media.cover_video_url === undefined ? undefined : media.cover_video_url ? [media.cover_video_url] : [],
    },
    { assetType: "gallery", values: media.gallery_urls },
  ];

  const providedMappings = assetMappings.filter(({ values }) => values !== undefined);
  if (!providedMappings.length) return;

  const { error: deleteError } = await sb
    .from("store_media_assets")
    .delete()
    .eq("store_id", storeId)
    .in("asset_type", providedMappings.map(({ assetType }) => assetType));
  if (deleteError) throw deleteError;

  const rows = providedMappings.flatMap(({ assetType, values }) =>
    (values ?? [])
      .map((value, index) => {
        const mediaRef = normalizeMediaReferenceForStorage(value);
        if (!mediaRef) return null;
        return {
          store_id: storeId,
          asset_type: assetType,
          file_url: mediaRef.file_url,
          file_path: mediaRef.file_path,
          sort_order: index,
          is_active: true,
        };
      })
      .filter(Boolean)
  );

  if (!rows.length) return;

  const { error: insertError } = await sb.from("store_media_assets").insert(rows);
  if (insertError) throw insertError;
}

function buildStoreBaseUpdatePayload(body: z.infer<typeof UpdateStoreSchema>) {
  const payload: Record<string, any> = {};
  const allowedKeys = [
    "name",
    "slug",
    "description",
    "category",
    "subcategory",
    "phone",
    "whatsapp",
    "email",
    "website",
    "location_name",
    "address_line1",
    "address_line2",
    "city",
    "region",
    "country",
    "postal_code",
    "full_address",
    "lat",
    "lng",
    "google_place_id",
    "logo_url",
    "cover_image",
    "owner_user_id",
    "created_by",
    "is_featured",
    "is_active",
    "is_top_brand",
    "sort_order",
    "store_type",
    "booking_enabled",
    "avg_duration_minutes",
    "max_bookings_per_slot",
    "advance_booking_days",
    "modification_available",
    "modification_cutoff_minutes",
    "cancellation_available",
    "cancellation_cutoff_minutes",
    "cover_charge_enabled",
    "cover_charge_amount",
    "booking_terms",
    "pickup_basic_enabled",
    "pickup_mode",
    "supports_time_slots",
    "slot_duration_minutes",
    "slot_buffer_minutes",
    "slot_advance_days",
    "slot_max_per_window",
    "is_advertised",
    "ad_priority",
    "ad_starts_at",
    "ad_ends_at",
    "ad_badge_text",
  ] as const;

  for (const key of allowedKeys) {
    if (body[key] !== undefined) {
      payload[key] = body[key];
    }
  }

  return payload;
}

async function hardDeleteStore(sb: any, storeId: string, canonicalMedia: { logo_url?: string | null; cover_image?: string | null }) {
  const { data: mediaRows, error: mediaLookupError } = await sb
    .from("store_media_assets")
    .select("file_path,file_url")
    .eq("store_id", storeId);

  if (mediaLookupError) {
    throw new Error(`Failed to inspect store media: ${mediaLookupError.message}`);
  }

  const storagePaths = new Set<string>();
  for (const row of mediaRows ?? []) {
    const fromPath = normalizeStoreStoragePath((row as any).file_path);
    const fromUrl = normalizeStoreStoragePath((row as any).file_url);
    if (fromPath) storagePaths.add(fromPath);
    if (fromUrl) storagePaths.add(fromUrl);
  }

  const logoPath = normalizeStoreStoragePath(canonicalMedia.logo_url);
  const coverImagePath = normalizeStoreStoragePath(canonicalMedia.cover_image);
  if (logoPath) storagePaths.add(logoPath);
  if (coverImagePath) storagePaths.add(coverImagePath);

  if (storagePaths.size > 0) {
    const { error: storageDeleteError } = await supabaseService.storage.from(STORE_STORAGE_BUCKET).remove([...storagePaths]);
    if (storageDeleteError) {
      throw new Error(`Failed to delete store files from storage: ${storageDeleteError.message}`);
    }
  }

  const independentRelationTables = [
    "store_members",
    "store_payment_details",
    "store_tags",
    "store_social_links",
    "store_opening_hours",
    "store_media_assets",
    "store_offers",
    "store_subscriptions",
    "store_reviews",
  ] as const;

  await Promise.all(
    independentRelationTables.map(async (table) => {
      const { error } = await sb.from(table).delete().eq("store_id", storeId);
      if (error) {
        throw new Error(`Failed to delete ${table}: ${error.message}`);
      }
    })
  );

  const { error: deleteItemsError } = await sb
    .from("store_catalogue_items")
    .delete()
    .eq("store_id", storeId);
  if (deleteItemsError) {
    throw new Error(`Failed to delete store_catalogue_items: ${deleteItemsError.message}`);
  }

  const { error: deleteCategoriesError } = await sb
    .from("store_catalogue_categories")
    .delete()
    .eq("store_id", storeId);
  if (deleteCategoriesError) {
    throw new Error(`Failed to delete store_catalogue_categories: ${deleteCategoriesError.message}`);
  }

  const { error: deleteStoreError } = await sb.from("stores").delete().eq("id", storeId);
  if (deleteStoreError) {
    throw new Error(`Failed to delete store: ${deleteStoreError.message}`);
  }
}

async function deleteLinkedStoreOwnerUser(ownerUserId: string | null | undefined, deletedStoreId: string) {
  const normalizedOwnerId = String(ownerUserId ?? "").trim();
  if (!normalizedOwnerId) return;

  const { data: ownerRow, error: ownerLookupError } = await supabaseService
    .from("users")
    .select("id,role")
    .eq("id", normalizedOwnerId)
    .maybeSingle();

  if (ownerLookupError) {
    throw new Error(`Failed to inspect owner user: ${ownerLookupError.message}`);
  }

  const ownerRole = String(ownerRow?.role ?? "").trim().toLowerCase();
  if (ownerRole !== "storepartner") return;

  const [
    otherStoresResult,
    restaurantResult,
    corporateResult,
  ] = await Promise.all([
    supabaseService
      .from("stores")
      .select("id", { count: "exact", head: true })
      .eq("owner_user_id", normalizedOwnerId)
      .neq("id", deletedStoreId),
    supabaseService
      .from("restaurants")
      .select("id", { count: "exact", head: true })
      .eq("owner_user_id", normalizedOwnerId),
    supabaseService
      .from("corporate")
      .select("id", { count: "exact", head: true })
      .eq("owner_user_id", normalizedOwnerId),
  ]);

  for (const result of [otherStoresResult, restaurantResult, corporateResult]) {
    if (result.error) {
      throw new Error(result.error.message);
    }
  }

  const stillReferenced =
    (otherStoresResult.count ?? 0) > 0 ||
    (restaurantResult.count ?? 0) > 0 ||
    (corporateResult.count ?? 0) > 0;

  if (stillReferenced) return;

  const { error: deleteUserRowError } = await supabaseService
    .from("users")
    .delete()
    .eq("id", normalizedOwnerId);

  if (deleteUserRowError) {
    throw new Error(`Failed to delete users row: ${deleteUserRowError.message}`);
  }

  const { error: deleteAuthUserError } = await supabaseService.auth.admin.deleteUser(normalizedOwnerId);
  if (deleteAuthUserError) {
    const message = String(deleteAuthUserError.message ?? "");
    if (!message.toLowerCase().includes("not found")) {
      throw new Error(`Failed to delete auth user: ${deleteAuthUserError.message}`);
    }
  }
}

function summarizeStoreFeedRows(rows: any[]) {
  const summary = {
    total: Array.isArray(rows) ? rows.length : 0,
    advertised: 0,
    premium: 0,
    sameCity: 0,
    hasDistance: 0,
  };

  for (const row of rows || []) {
    if (isStoreAdvertisementActive(row)) summary.advertised += 1;
    if (isStorePremiumActive(row)) summary.premium += 1;
    if (String(row?.city || "").trim()) summary.sameCity += 1;
    if (row?.lat != null && row?.lng != null) summary.hasDistance += 1;
  }

  return summary;
}

function normalizeCanonicalCity(value?: string | null) {
  const normalized = String(value || "").trim().toLowerCase();

  const aliases: Record<string, string> = {
    hyderabad: "hyderabad",
    secunderabad: "hyderabad",
    "secunderabad, hyderabad": "hyderabad",
    "hyderabad, secunderabad": "hyderabad",
    mumbai: "mumbai",
    bombay: "mumbai",
    bengaluru: "bengaluru",
    bangalore: "bengaluru",
  };

  return aliases[normalized] || normalized;
}

function normalizeLocationValue(value?: string | null) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function resolveStoreCity(store: any) {
  const directCity = normalizeCanonicalCity(store?.city);
  if (directCity) return directCity;

  const candidateFields = [
    store?.location_name,
    store?.address_line1,
    store?.address_line2,
    store?.full_address,
    store?.region,
  ];

  for (const field of candidateFields) {
    const normalized = normalizeLocationValue(field);
    if (!normalized) continue;

    if (normalized.includes("hyderabad") || normalized.includes("secunderabad")) {
      return "hyderabad";
    }
    if (normalized.includes("mumbai") || normalized.includes("bombay")) {
      return "mumbai";
    }
    if (normalized.includes("bengaluru") || normalized.includes("bangalore")) {
      return "bengaluru";
    }
  }

  return directCity || "";
}

function getStoreResolvedCity(store: any) {
  return resolveStoreCity(store) || null;
}

function parseStoreIdList(value: string | undefined) {
  if (!value) return new Set<string>();

  return new Set(
    value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
  );
}

async function getStoreIdsByTag(tag: string) {
  const normalizedTag = String(tag || "").trim();
  if (!normalizedTag) return [];

  const { data, error } = await supabase
    .from("store_tags")
    .select("store_id")
    .eq("tag_value", normalizedTag);

  if (error) throw error;
  return Array.from(new Set((data ?? []).map((row: any) => row.store_id).filter(Boolean)));
}

function logStoreFeedRows(label: string, rows: any[]) {
  if (!STORE_ROUTE_DEBUG) return;
  console.info(label, (rows || []).map((row: any) => ({
    id: row?.id || row?.store_id || null,
    name: row?.name || row?.store_name || null,
    city: row?.city || null,
    region: row?.region || null,
    country: row?.country || null,
    location_name: row?.location_name || null,
    address_line1: row?.address_line1 || null,
    lat: row?.lat ?? null,
    lng: row?.lng ?? null,
    created_at: row?.created_at || null,
    is_advertised: !!row?.is_advertised,
    pickup_premium_enabled: !!row?.pickup_premium_enabled,
    resolved_city: row?.resolved_city || null,
    distance_km: row?.distance_km ?? null,
  })));
}

function isStoreAdvertisementActive(store: any, now = new Date()) {
  if (!store?.is_advertised) return false;

  const startsAt = store.ad_starts_at ? new Date(store.ad_starts_at) : null;
  const endsAt = store.ad_ends_at ? new Date(store.ad_ends_at) : null;

  if (startsAt && startsAt > now) return false;
  if (endsAt && endsAt < now) return false;

  return true;
}

function isStorePremiumActive(store: any, now = new Date()) {
  if (!store?.pickup_premium_enabled) return false;

  const startedAt = store.pickup_premium_started_at
    ? new Date(store.pickup_premium_started_at)
    : null;
  const expiresAt = store.pickup_premium_expires_at
    ? new Date(store.pickup_premium_expires_at)
    : null;

  if (startedAt && startedAt > now) return false;
  if (expiresAt && expiresAt < now) return false;

  return true;
}

function comparePrimitiveValues(aValue: any, bValue: any, ascending: boolean) {
  if (aValue === bValue) return 0;

  if (aValue === null || aValue === undefined) return 1;
  if (bValue === null || bValue === undefined) return -1;

  if (typeof aValue === "number" && typeof bValue === "number") {
    return ascending ? aValue - bValue : bValue - aValue;
  }

  const aText = String(aValue).toLowerCase();
  const bText = String(bValue).toLowerCase();

  if (aText < bText) return ascending ? -1 : 1;
  if (aText > bText) return ascending ? 1 : -1;
  return 0;
}

function isStoreLocationMatch(store: any, feedLocation: any) {
  if (!feedLocation) return 0;

  const storeCity = String(store?.city || "").trim().toLowerCase();
  const storeRegion = String(store?.region || "").trim().toLowerCase();
  const storeCountry = String(store?.country || "").trim().toLowerCase();

  const feedCity = String(feedLocation?.city || "").trim().toLowerCase();
  const feedRegion = String(feedLocation?.region || "").trim().toLowerCase();
  const feedCountry = String(feedLocation?.country || "").trim().toLowerCase();

  if (feedCity && storeCity && storeCity === feedCity) return 3;
  if (feedRegion && storeRegion && storeRegion === feedRegion) return 2;
  if (feedCountry && storeCountry && storeCountry === feedCountry) return 1;
  return 0;
}

function getStoreDistanceKm(store: any, userLat: number | null, userLng: number | null) {
  if (userLat == null || userLng == null) return null;
  if (store?.lat == null || store?.lng == null) return null;

  const lat = Number(store.lat);
  const lng = Number(store.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  const toRad = (value: number) => (value * Math.PI) / 180;
  const earthRadiusKm = 6371;
  const dLat = toRad(lat - userLat);
  const dLng = toRad(lng - userLng);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(userLat)) * Math.cos(toRad(lat)) *
    Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return earthRadiusKm * c;
}

function compareStoresForSmartFeed(a: any, b: any, feedLocation: any, userLat: number | null, userLng: number | null) {
  const aLocation = isStoreLocationMatch(a, feedLocation);
  const bLocation = isStoreLocationMatch(b, feedLocation);
  if (aLocation !== bLocation) {
    return bLocation - aLocation;
  }

  const aAd = isStoreAdvertisementActive(a);
  const bAd = isStoreAdvertisementActive(b);
  if (aAd !== bAd) {
    return aAd ? -1 : 1;
  }

  if (aAd && bAd) {
    const aPriority = typeof a.ad_priority === "number" ? a.ad_priority : 100;
    const bPriority = typeof b.ad_priority === "number" ? b.ad_priority : 100;
    if (aPriority !== bPriority) {
      return aPriority - bPriority;
    }
  }

  const aFeatured = !!a?.is_featured;
  const bFeatured = !!b?.is_featured;
  if (aFeatured !== bFeatured) {
    return aFeatured ? -1 : 1;
  }

  const aPremium = isStorePremiumActive(a);
  const bPremium = isStorePremiumActive(b);
  if (aPremium !== bPremium) {
    return aPremium ? -1 : 1;
  }

  const aDistance = getStoreDistanceKm(a, userLat, userLng);
  const bDistance = getStoreDistanceKm(b, userLat, userLng);
  if (aDistance != null && bDistance != null && aDistance !== bDistance) {
    return aDistance - bDistance;
  }
  if (aDistance != null && bDistance == null) return -1;
  if (aDistance == null && bDistance != null) return 1;

  const aRating = Number(a?.rating ?? 0);
  const bRating = Number(b?.rating ?? 0);
  if (aRating !== bRating) {
    return bRating - aRating;
  }

  const aRatings = Number(a?.total_ratings ?? 0);
  const bRatings = Number(b?.total_ratings ?? 0);
  if (aRatings !== bRatings) {
    return bRatings - aRatings;
  }

  const aSortOrder = Number.isFinite(Number(a?.sort_order)) ? Number(a.sort_order) : 9999;
  const bSortOrder = Number.isFinite(Number(b?.sort_order)) ? Number(b.sort_order) : 9999;
  if (aSortOrder !== bSortOrder) {
    return aSortOrder - bSortOrder;
  }

  const aCreatedAt = a?.created_at ? new Date(a.created_at).getTime() : 0;
  const bCreatedAt = b?.created_at ? new Date(b.created_at).getTime() : 0;
  if (aCreatedAt !== bCreatedAt) {
    return bCreatedAt - aCreatedAt;
  }

  return String(a?.name || "").localeCompare(String(b?.name || ""));
}

function compareStoresForNewKickInPrimary(
  a: any,
  b: any,
  userLat: number | null,
  userLng: number | null
) {
  const aAd = isStoreAdvertisementActive(a);
  const bAd = isStoreAdvertisementActive(b);
  if (aAd !== bAd) {
    return aAd ? -1 : 1;
  }

  const aCreatedAt = a?.created_at ? new Date(a.created_at).getTime() : 0;
  const bCreatedAt = b?.created_at ? new Date(b.created_at).getTime() : 0;
  if (aCreatedAt !== bCreatedAt) {
    return bCreatedAt - aCreatedAt;
  }

  const aPremium = isStorePremiumActive(a);
  const bPremium = isStorePremiumActive(b);
  if (aPremium !== bPremium) {
    return aPremium ? -1 : 1;
  }

  const aDistance = getStoreDistanceKm(a, userLat, userLng);
  const bDistance = getStoreDistanceKm(b, userLat, userLng);
  if (aDistance != null && bDistance != null && aDistance !== bDistance) {
    return aDistance - bDistance;
  }
  if (aDistance != null && bDistance == null) return -1;
  if (aDistance == null && bDistance != null) return 1;

  const aRating = Number(a?.rating ?? 0);
  const bRating = Number(b?.rating ?? 0);
  if (aRating !== bRating) {
    return bRating - aRating;
  }

  const aRatings = Number(a?.total_ratings ?? 0);
  const bRatings = Number(b?.total_ratings ?? 0);
  if (aRatings !== bRatings) {
    return bRatings - aRatings;
  }

  const aSortOrder = Number.isFinite(Number(a?.sort_order)) ? Number(a.sort_order) : 9999;
  const bSortOrder = Number.isFinite(Number(b?.sort_order)) ? Number(b.sort_order) : 9999;
  if (aSortOrder !== bSortOrder) {
    return aSortOrder - bSortOrder;
  }

  return String(a?.name || "").localeCompare(String(b?.name || ""));
}

function compareStoresForNewKickInFallback(
  a: any,
  b: any,
  userLat: number | null,
  userLng: number | null
) {
  const aDistance = getStoreDistanceKm(a, userLat, userLng);
  const bDistance = getStoreDistanceKm(b, userLat, userLng);
  if (aDistance != null && bDistance != null && aDistance !== bDistance) {
    return aDistance - bDistance;
  }
  if (aDistance != null && bDistance == null) return -1;
  if (aDistance == null && bDistance != null) return 1;

  return compareStoresForNewKickInPrimary(a, b, userLat, userLng);
}

function inferFeedCity(rows: any[], userLat: number | null, userLng: number | null, requestedCity?: string | null) {
  const normalizedRequestedCity = normalizeCanonicalCity(requestedCity);
  if (normalizedRequestedCity) return normalizedRequestedCity;

  const scored = new Map<string, number>();
  const candidates = (rows || [])
    .map((row) => ({
      row,
      city: resolveStoreCity(row),
      distanceKm: getStoreDistanceKm(row, userLat, userLng),
    }))
    .filter((item) => Boolean(item.city));

  if (!candidates.length) return "";

  const ordered = candidates
    .slice()
    .sort((a, b) => {
      const aDistance = a.distanceKm ?? Number.POSITIVE_INFINITY;
      const bDistance = b.distanceKm ?? Number.POSITIVE_INFINITY;
      if (aDistance !== bDistance) return aDistance - bDistance;

      const aCreatedAt = a.row?.created_at ? new Date(a.row.created_at).getTime() : 0;
      const bCreatedAt = b.row?.created_at ? new Date(b.row.created_at).getTime() : 0;
      return bCreatedAt - aCreatedAt;
    })
    .slice(0, Math.min(Math.max(rows.length, 1), 40));

  for (const item of ordered) {
    const distanceKm = item.distanceKm;
    const createdAt = item.row?.created_at ? new Date(item.row.created_at).getTime() : 0;
    const ageDays = createdAt > 0 ? Math.max(0, (Date.now() - createdAt) / (24 * 60 * 60 * 1000)) : 30;

    let score = 1;
    if (Number.isFinite(distanceKm)) {
      const safeDistanceKm = Number(distanceKm);
      score += Math.max(0, 20 - Math.min(safeDistanceKm, 20)) / 20;
    }
    score += Math.max(0, 30 - Math.min(ageDays, 30)) / 60;
    if (isStoreAdvertisementActive(item.row)) score += 0.2;
    if (isStorePremiumActive(item.row)) score += 0.1;

    scored.set(item.city, (scored.get(item.city) ?? 0) + score);
  }

  let bestCity = "";
  let bestScore = 0;
  for (const [cityKey, cityScore] of scored.entries()) {
    if (cityScore > bestScore) {
      bestCity = cityKey;
      bestScore = cityScore;
    }
  }

  return bestCity;
}

function isSameCityStore(store: any, feedCity: string) {
  const normalizedFeedCity = normalizeCanonicalCity(feedCity);
  if (!normalizedFeedCity) return false;
  return resolveStoreCity(store) === normalizedFeedCity;
}

function compareStoresForFeed(a: any, b: any, sort: string, order: "asc" | "desc") {
  const aAdvertised = isStoreAdvertisementActive(a);
  const bAdvertised = isStoreAdvertisementActive(b);

  if (aAdvertised !== bAdvertised) {
    return aAdvertised ? -1 : 1;
  }

  if (aAdvertised && bAdvertised) {
    const aPriority = typeof a.ad_priority === "number" ? a.ad_priority : 100;
    const bPriority = typeof b.ad_priority === "number" ? b.ad_priority : 100;

    if (aPriority !== bPriority) {
      return aPriority - bPriority;
    }
  }

  const aPremium = isStorePremiumActive(a);
  const bPremium = isStorePremiumActive(b);

  if (aPremium !== bPremium) {
    return aPremium ? -1 : 1;
  }

  const primarySort = comparePrimitiveValues(a?.[sort], b?.[sort], order === "asc");
  if (primarySort !== 0) return primarySort;

  return comparePrimitiveValues(a?.created_at, b?.created_at, false);
}

async function withTimeout<T>(promise: PromiseLike<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    Promise.resolve(promise)
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

// GET /api/stores
// /api/stores?search=&city=&category=&tag=&status=&includeInactive=&limit=&offset=&sort=&order=&is_featured=
router.get("/", async (req, res) => {
  const parsed = ListQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res
      .status(400)
      .json({ error: "Invalid query", details: parsed.error.flatten() });
  }

  const {
    search,
    city,
    region,
    country,
    category,
    subcategory,
    tag,
    is_featured,
    status,
    includeInactive,
    limit,
    offset,
    sort,
    order,
  } = parsed.data;

  let query = supabase.from("stores").select(STORE_BASE_SELECT, { count: "exact" });

  // default: only active stores
  if (!includeInactive && !status) {
    query = query.eq("is_active", true);
  }
  if (status) {
    query = query.eq("is_active", status === "active");
  }

  // filters
  if (category) query = query.eq("category", category);
  if (subcategory) query = query.eq("subcategory", subcategory);

  if (typeof is_featured === "boolean") {
    query = query.eq("is_featured", is_featured);
  }

  let tagStoreIds: string[] | null = null;
  if (tag) {
    tagStoreIds = await getStoreIdsByTag(tag);
    if (!tagStoreIds.length) {
      return res.json({
        items: [],
        page: { limit, offset, total: 0 },
      });
    }
    query = query.in("id", tagStoreIds);
  }

  // search (OR)
  if (search) {
    const s = search.replace(/"/g, '\\"');

    // NOTE: PostgREST "or" string. Also includes tags with ilike via cast might not be allowed directly.
    // We'll cover common text fields. Tags search can be done via tag=... filter above.
    query = query.or(
      [
        `name.ilike.%${s}%`,
        `slug.ilike.%${s}%`,
        `category.ilike.%${s}%`,
        `subcategory.ilike.%${s}%`,
        `city.ilike.%${s}%`,
        `region.ilike.%${s}%`,
        `location_name.ilike.%${s}%`,
      ].join(",")
    );
  }

  // DB-side ordering + pagination for better tail latency under load.
  query = query
    .order("is_advertised", { ascending: false })
    .order("ad_priority", { ascending: true, nullsFirst: false })
    .order("pickup_premium_enabled", { ascending: false })
    .order(sort, { ascending: order === "asc" });

  if (sort !== "created_at") {
    query = query.order("created_at", { ascending: false });
  }

  const from = offset;
  const to = offset + limit - 1;

  let data: any[] | null = null;
  let count: number | null = null;
  try {
    const result = await withTimeout(
      query.range(from, to),
      LIST_QUERY_TIMEOUT_MS,
      "GET /api/stores query"
    );

    const { data: rows, error, count: total } = result as any;
    if (error) return res.status(500).json({ error: error.message });
    data = await hydrateStoreRows(rows ?? []);
    count = total ?? 0;
  } catch (error: any) {
    const isTimeout = String(error?.message ?? "").includes("timed out");
    if (isTimeout) {
      console.error("[GET /api/stores] Timed out", {
        timeout_ms: LIST_QUERY_TIMEOUT_MS,
        offset,
        limit,
        sort,
        order,
      });
      return res.status(503).json({ error: "Request timed out. Please retry." });
    }
    return res.status(500).json({ error: error?.message ?? "Unexpected error" });
  }

  return res.json({
    items: data ?? [],
    page: { limit, offset, total: count ?? 0 },
  });
});

// GET /api/stores/feed
// Smart store feed sorted by location, ad, recency and rating.
router.get("/feed", async (req, res) => {
  const parsed = FeedQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res
      .status(400)
      .json({ error: "Invalid query", details: parsed.error.flatten() });
  }

  const {
    search,
    city,
    region,
    country,
    category,
    subcategory,
    tag,
    includeInactive,
    lat,
    lng,
    limit,
    offset,
  } = parsed.data;

  if (STORE_ROUTE_DEBUG) {
    console.info("[GET /api/stores/feed] query", {
      search: search || null,
      city: city || null,
      region: region || null,
      country: country || null,
      category: category || null,
      subcategory: subcategory || null,
      tag: tag || null,
      includeInactive,
      lat,
      lng,
      limit,
      offset,
    });
  }

  let query = supabase.from("stores").select(STORE_BASE_SELECT, { count: "exact" });

  if (!includeInactive) {
    query = query.eq("is_active", true);
  }
  if (category) query = query.eq("category", category);
  if (subcategory) query = query.eq("subcategory", subcategory);
  if (tag) {
    const tagStoreIds = await getStoreIdsByTag(tag);
    if (!tagStoreIds.length) {
      return res.json({
        items: [],
        page: { limit, offset, total: 0 },
      });
    }
    query = query.in("id", tagStoreIds);
  }

  if (search) {
    const s = search.replace(/"/g, '\\"');
    query = query.or(
      [
        `name.ilike.%${s}%`,
        `slug.ilike.%${s}%`,
        `category.ilike.%${s}%`,
        `subcategory.ilike.%${s}%`,
        `city.ilike.%${s}%`,
        `region.ilike.%${s}%`,
        `location_name.ilike.%${s}%`,
        `full_address.ilike.%${s}%`,
      ].join(",")
    );
  }

  const scanLimit = Math.min(Math.max(limit + offset + Math.max(limit, 1) * 4, 120), 500);

  try {
    const result = await withTimeout(
      query.range(0, scanLimit - 1),
      LIST_QUERY_TIMEOUT_MS,
      "GET /api/stores/feed query"
    );

    const { data: rows, error, count: total } = result as any;
    if (error) return res.status(500).json({ error: error.message });

    const rawRows = await hydrateStoreRows(rows ?? []);
    if (STORE_ROUTE_DEBUG) {
      console.info("[GET /api/stores/feed] raw result", {
        count: rawRows.length,
        total: total ?? null,
        scanLimit,
        sample: summarizeStoreFeedRows(rawRows),
      });
    }

    const ranked = rawRows
      .slice()
      .sort((a: any, b: any) => compareStoresForSmartFeed(a, b, { city, region, country }, lat, lng));
    if (STORE_ROUTE_DEBUG) {
      console.info("[GET /api/stores/feed] ranked result", {
        count: ranked.length,
        topIds: ranked.slice(0, 8).map((row: any) => row?.id || row?.store_id || null),
        topCities: ranked.slice(0, 8).map((row: any) => row?.city || null),
      });
    }

    const pageItems = ranked.slice(offset, offset + limit);

    if (STORE_ROUTE_DEBUG) {
      console.info("[GET /api/stores/feed] page result", {
        count: pageItems.length,
        limit,
        offset,
        returnedIds: pageItems.map((row: any) => row?.id || row?.store_id || null),
      });
    }

    return res.json({
      items: pageItems,
      page: { limit, offset, total: total ?? ranked.length },
    });
  } catch (error: any) {
    const isTimeout = String(error?.message ?? "").includes("timed out");
    if (isTimeout) {
      console.error("[GET /api/stores/feed] Timed out", {
        timeout_ms: LIST_QUERY_TIMEOUT_MS,
        offset,
        limit,
        city,
        region,
        country,
      });
      return res.status(503).json({ error: "Request timed out. Please retry." });
    }
    return res.status(500).json({ error: error?.message ?? "Unexpected error" });
  }
});

// GET /api/stores/new-kick-in
// New Kick In stores sorted by local same-city relevance first, then nearest fallback.
router.get("/new-kick-in", async (req, res) => {
  const parsed = NewKickInQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res
      .status(400)
      .json({ error: "Invalid query", details: parsed.error.flatten() });
  }

  const {
    search,
    city,
    region,
    country,
    category,
    subcategory,
    tag,
    includeInactive,
    lat,
    lng,
    limit,
    offset,
    freshnessDays,
    excludeStoreIds,
  } = parsed.data;

  const excludedStoreIds = parseStoreIdList(excludeStoreIds);
  const freshnessCutoff = new Date(Date.now() - freshnessDays * 24 * 60 * 60 * 1000);

  let query = supabase.from("stores").select(STORE_BASE_SELECT, { count: "exact" });

  if (!includeInactive) {
    query = query.eq("is_active", true);
  }
  if (category) query = query.eq("category", category);
  if (subcategory) query = query.eq("subcategory", subcategory);
  if (tag) {
    const tagStoreIds = await getStoreIdsByTag(tag);
    if (!tagStoreIds.length) {
      return res.json({
        items: [],
        page: { limit, offset, total: 0 },
      });
    }
    query = query.in("id", tagStoreIds);
  }

  if (search) {
    const s = search.replace(/"/g, '\\"');
    query = query.or(
      [
        `name.ilike.%${s}%`,
        `slug.ilike.%${s}%`,
        `category.ilike.%${s}%`,
        `subcategory.ilike.%${s}%`,
        `city.ilike.%${s}%`,
        `region.ilike.%${s}%`,
        `location_name.ilike.%${s}%`,
        `full_address.ilike.%${s}%`,
      ].join(",")
    );
  }

  const scanLimit = Math.min(Math.max(limit + offset + Math.max(limit, 1) * 4, 120), 500);

  try {
    const result = await withTimeout(
      query.range(0, scanLimit - 1),
      LIST_QUERY_TIMEOUT_MS,
      "GET /api/stores/new-kick-in query"
    );

    const { data: rows, error, count: total } = result as any;
    if (error) return res.status(500).json({ error: error.message });

    const hydratedRows = await hydrateStoreRows(rows ?? []);
    const rawRows = hydratedRows.map((row: any) => ({
      ...row,
      resolved_city: getStoreResolvedCity(row),
      distance_km: getStoreDistanceKm(row, lat, lng),
    }));
    if (STORE_ROUTE_DEBUG) {
      console.info("[GET /api/stores/new-kick-in] raw result", {
        count: rawRows.length,
        total: total ?? null,
        scanLimit,
        freshnessDays,
        excludedCount: excludedStoreIds.size,
        sample: summarizeStoreFeedRows(rawRows),
      });
    }
    logStoreFeedRows("[GET /api/stores/new-kick-in] raw rows", rawRows);

    const freshRows = rawRows.filter((row: any) => {
      if (!row?.created_at) return false;
      const createdAt = new Date(row.created_at);
      return Number.isFinite(createdAt.getTime()) && createdAt >= freshnessCutoff;
    });
    if (STORE_ROUTE_DEBUG) {
      console.info("[GET /api/stores/new-kick-in] freshness filter", {
        freshnessDays,
        cutoff: freshnessCutoff.toISOString(),
        count: freshRows.length,
      });
    }
    logStoreFeedRows("[GET /api/stores/new-kick-in] fresh rows", freshRows);

    const inferredCity = inferFeedCity(freshRows.length ? freshRows : rawRows, lat, lng, city);
    const requestedCity = normalizeCanonicalCity(city);
    const feedCity = requestedCity || inferredCity;

    const excludedRows = rawRows.filter((row: any) =>
      excludedStoreIds.has(String(row?.id || row?.store_id || ""))
    );
    const usableRows = rawRows.filter(
      (row: any) => !excludedStoreIds.has(String(row?.id || row?.store_id || ""))
    );

    const freshUsableRows = freshRows.filter(
      (row: any) => !excludedStoreIds.has(String(row?.id || row?.store_id || ""))
    );
    const olderUsableRows = usableRows.filter((row: any) => {
      if (!row?.created_at) return true;
      const createdAt = new Date(row.created_at);
      return !Number.isFinite(createdAt.getTime()) || createdAt < freshnessCutoff;
    });

    const sameCityRecentRows = feedCity
      ? freshUsableRows.filter((row: any) => isSameCityStore(row, feedCity))
      : [];
    const sameCityOlderRows = feedCity
      ? olderUsableRows.filter((row: any) => isSameCityStore(row, feedCity))
      : [];
    const outsideCityRows = usableRows.filter((row: any) =>
      feedCity ? !isSameCityStore(row, feedCity) : true
    );

    const sameCityRecentSorted = sameCityRecentRows
      .slice()
      .sort((a: any, b: any) => compareStoresForNewKickInPrimary(a, b, lat, lng));
    const sameCityOlderSorted = sameCityOlderRows
      .slice()
      .sort((a: any, b: any) => compareStoresForNewKickInPrimary(a, b, lat, lng));
    const outsideCitySorted = outsideCityRows
      .slice()
      .sort((a: any, b: any) => compareStoresForNewKickInFallback(a, b, lat, lng));

    const sameCityRecentCount = sameCityRecentSorted.length;
    const sameCityOlderCount = sameCityOlderSorted.length;
    const outsideCityFallbackCount = outsideCitySorted.length;

    let ranked: any[] = sameCityRecentSorted;
    if (ranked.length < limit) {
      ranked = [...ranked, ...sameCityOlderSorted];
    }
    if (ranked.length < limit) {
      ranked = [...ranked, ...outsideCitySorted];
    }

    if (STORE_ROUTE_DEBUG) {
      console.info("[GET /api/stores/new-kick-in] location resolution", {
        requestedCity: city || null,
        inferredCity: inferredCity || null,
        resolvedFeedCity: feedCity || null,
        sameCityRecentCount,
        sameCityOlderCount,
        outsideCityFallbackCount,
        excludedCount: excludedRows.length,
      });
    }

    logStoreFeedRows("[GET /api/stores/new-kick-in] same city recent rows", sameCityRecentSorted);
    logStoreFeedRows("[GET /api/stores/new-kick-in] same city older rows", sameCityOlderSorted);
    logStoreFeedRows("[GET /api/stores/new-kick-in] outside city rows", outsideCitySorted);

    if (STORE_ROUTE_DEBUG) {
      console.info("[GET /api/stores/new-kick-in] ranked result", {
        count: ranked.length,
        sameCityCount: sameCityRecentSorted.length + sameCityOlderSorted.length,
        recentCount: sameCityRecentSorted.length,
        olderCount: sameCityOlderSorted.length,
        fallbackCount: outsideCitySorted.length,
        topIds: ranked.slice(0, 8).map((row: any) => row?.id || row?.store_id || null),
        topCities: ranked.slice(0, 8).map((row: any) => row?.city || null),
      });
    }
    logStoreFeedRows("[GET /api/stores/new-kick-in] ranked rows", ranked);

    const pageItems = ranked.slice(offset, offset + limit);
    if (STORE_ROUTE_DEBUG) {
      console.info("[GET /api/stores/new-kick-in] page result", {
        count: pageItems.length,
        limit,
        offset,
        returnedIds: pageItems.map((row: any) => row?.id || row?.store_id || null),
      });
    }
    logStoreFeedRows("[GET /api/stores/new-kick-in] page rows", pageItems);

    return res.json({
      items: pageItems,
      page: { limit, offset, total: total ?? ranked.length },
    });
  } catch (error: any) {
    const isTimeout = String(error?.message ?? "").includes("timed out");
    if (isTimeout) {
      console.error("[GET /api/stores/new-kick-in] Timed out", {
        timeout_ms: LIST_QUERY_TIMEOUT_MS,
        offset,
        limit,
        city,
        region,
        country,
      });
      return res.status(503).json({ error: "Request timed out. Please retry." });
    }
    return res.status(500).json({ error: error?.message ?? "Unexpected error" });
  }
});

// GET /api/stores/:id
// Optional: ?include=payment,catalogue,services,slots to fetch related tables in one response
router.get("/:id", async (req, res) => {
  const idParsed = IdSchema.safeParse(req.params.id);
  if (!idParsed.success) return res.status(400).json({ error: "Invalid store id" });

  const include = String(req.query.include ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const includePayment = include.includes("payment");
  const includeCatalogue = include.includes("catalogue");
  const includeServices = include.includes("services");
  const includeSlots = include.includes("slots");

  let hydratedStore: any = null;
  try {
    hydratedStore = await fetchHydratedStoreRowById(idParsed.data);
  } catch (error: any) {
    return res.status(500).json({ error: error?.message ?? "Failed to load store" });
  }

  if (!hydratedStore) return res.status(404).json({ error: "Store not found" });

  // related (optional)
  let payment: any = null;
  let catalogue: any = null;
  let services: any = null;
  let slots: any = null;

  if (includePayment) {
    const resp = await supabase
      .from("store_payment_details")
      .select("*")
      .eq("store_id", hydratedStore.id)
      .maybeSingle();

    if (resp.error) return res.status(500).json({ error: resp.error.message });
    payment = resp.data ?? null;
  }

  if (includeCatalogue) {
    try {
      catalogue = await getProductCataloguePayload(hydratedStore.id);
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  }

  if (includeServices) {
    try {
      services = await getServiceCataloguePayload(hydratedStore.id);
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  }

  if (includeSlots) {
    slots = buildStoreSlotConfig(hydratedStore);
  }

  return res.json({
    item: hydratedStore,
    ...(includePayment ? { payment } : {}),
    ...(includeCatalogue ? { catalogue } : {}),
    ...(includeServices ? { services } : {}),
    ...(includeSlots ? { slots } : {}),
  });
});

// PUT /api/stores/:id
// Admin editor write path for a single normalized store payload.
router.put("/:id", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  const idParsed = IdSchema.safeParse(req.params.id);
  if (!idParsed.success) return res.status(400).json({ error: "Invalid store id" });

  const bodyParsed = UpdateStoreSchema.safeParse(req.body);
  if (!bodyParsed.success) {
    return res
      .status(400)
      .json({ error: "Invalid body", details: bodyParsed.error.flatten() });
  }

  const id = idParsed.data;
  const body = bodyParsed.data;

  const { data: existingStore, error: existingError } = await admin.sb
    .from("stores")
    .select("id")
    .eq("id", id)
    .maybeSingle();

  if (existingError) return res.status(500).json({ error: existingError.message });
  if (!existingStore) return res.status(404).json({ error: "Store not found" });

  const basePayload = buildStoreBaseUpdatePayload(body);

  let updatedStore: any = null;
  if (Object.keys(basePayload).length > 0) {
    const { data, error } = await admin.sb
      .from("stores")
      .update(basePayload)
      .eq("id", id)
      .select(STORE_BASE_SELECT)
      .single();

    if (error) {
      if ((error as any)?.code === "23505") {
        return res.status(400).json({ error: "Slug already exists" });
      }
      return res.status(500).json({ error: error.message });
    }

    updatedStore = data;
  }

  try {
    const shouldWriteSocialLinks =
      body.social_links !== undefined ||
      body.instagram !== undefined ||
      body.facebook !== undefined ||
      body.tiktok !== undefined ||
      body.maps !== undefined;
    await Promise.all([
      replaceStoreTags(admin.sb, id, {
        tags: body.tags,
        facilities: body.facilities,
        highlights: body.highlights,
        worth_visit: body.worth_visit,
        mood_tags: body.mood_tags,
      }),
      replaceStoreSocialLinks(admin.sb, id, shouldWriteSocialLinks ? mergeSocialLinks(body) : undefined),
      replaceStoreOpeningHours(admin.sb, id, body.opening_hours, body.hours),
      replaceStoreOffers(admin.sb, id, getStoreOfferRowsFromBody(body)),
      replaceStoreSubscription(admin.sb, id, body.subscription),
      replaceStoreMedia(admin.sb, id, {
        logo_url: body.logo_url,
        cover_image: body.cover_image,
        cover_video_url: body.cover_video_url,
        gallery_urls: body.gallery_urls,
      }),
    ]);
  } catch (relationError: any) {
    return res.status(500).json({ error: relationError?.message ?? "Failed to update store relations" });
  }

  const storeForHydration =
    updatedStore ??
    (
      await admin.sb
        .from("stores")
        .select(STORE_BASE_SELECT)
        .eq("id", id)
        .maybeSingle()
    ).data;

  if (!storeForHydration) {
    return res.status(404).json({ error: "Store not found after update" });
  }

  const hydratedStore = await hydrateStoreRow(storeForHydration);
  return res.json({ item: hydratedStore });
});

// DELETE /api/stores/:id?hard=true
router.delete("/:id", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  const idParsed = IdSchema.safeParse(req.params.id);
  if (!idParsed.success) return res.status(400).json({ error: "Invalid store id" });

  const qParsed = DeleteQuerySchema.safeParse(req.query);
  if (!qParsed.success) {
    return res
      .status(400)
      .json({ error: "Invalid query", details: qParsed.error.flatten() });
  }

  const id = idParsed.data;
  const { hard } = qParsed.data;

  // Confirm exists
  const exists = await admin.sb
    .from("stores")
    .select("id,is_active,logo_url,cover_image,owner_user_id")
    .eq("id", id)
    .maybeSingle();

  if (exists.error) return res.status(500).json({ error: exists.error.message });
  if (!exists.data) return res.status(404).json({ error: "Store not found" });

  if (hard) {
    try {
      await hardDeleteStore(admin.sb, id, {
        logo_url: exists.data.logo_url,
        cover_image: exists.data.cover_image,
      });
      await deleteLinkedStoreOwnerUser(exists.data.owner_user_id, id);
    } catch (error: any) {
      return res.status(500).json({ error: error?.message ?? "Failed to hard delete store" });
    }
    return res.json({ ok: true, deleted: "hard", id });
  }

  // Soft delete
  const { error } = await admin.sb
    .from("stores")
    .update({ is_active: false })
    .eq("id", id);

  if (error) return res.status(500).json({ error: error.message });

  return res.json({ ok: true, deleted: "soft", id });
});

export default router;
