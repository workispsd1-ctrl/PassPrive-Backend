import supabase from "../../database/supabase";

const STORE_STORAGE_BUCKET = "store";
const STORE_TAG_SELECT = "store_id,tag_type,tag_value,sort_order,created_at";
const STORE_SOCIAL_LINK_SELECT = "store_id,platform,url,sort_order,created_at";
const STORE_OPENING_HOURS_SELECT = "store_id,day_of_week,open_time,close_time,is_closed,sort_order,created_at";
const STORE_MEDIA_SELECT =
  "store_id,asset_type,file_url,file_path,sort_order,created_at,is_active";
const STORE_OFFER_SELECT =
  "id,store_id,title,description,badge_text,offer_type,discount_value,min_spend,start_at,end_at,is_active,metadata,sort_order,created_at";
const STORE_SUBSCRIPTION_SELECT =
  "id,store_id,plan_code,status,pickup_premium_enabled,starts_at,expires_at,metadata,created_at,updated_at";

export const STORE_BASE_SELECT = [
  "id",
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
  "created_at",
  "updated_at",
].join(",");

export const STORE_PREVIEW_SELECT = [
  "id",
  "name",
  "slug",
  "description",
  "category",
  "subcategory",
  "location_name",
  "address_line1",
  "city",
  "lat",
  "lng",
  "logo_url",
  "cover_image",
  "is_featured",
  "is_active",
  "sort_order",
  "is_advertised",
  "ad_priority",
  "ad_starts_at",
  "ad_ends_at",
  "ad_badge_text",
  "created_at",
].join(",");

function sortByOrderAndCreatedAt<T extends { sort_order?: number | null; created_at?: string | null }>(
  rows: T[]
) {
  return rows.slice().sort((a, b) => {
    const aSort = Number.isFinite(Number(a?.sort_order)) ? Number(a?.sort_order) : 100;
    const bSort = Number.isFinite(Number(b?.sort_order)) ? Number(b?.sort_order) : 100;
    if (aSort !== bSort) return aSort - bSort;

    const aCreatedAt = a?.created_at ? new Date(a.created_at).getTime() : 0;
    const bCreatedAt = b?.created_at ? new Date(b.created_at).getTime() : 0;
    return aCreatedAt - bCreatedAt;
  });
}

function toMapByStoreId<T extends { store_id?: string | null }>(rows: T[]) {
  const map = new Map<string, T[]>();
  for (const row of rows || []) {
    if (!row?.store_id) continue;
    const bucket = map.get(row.store_id) ?? [];
    bucket.push(row);
    map.set(row.store_id, bucket);
  }
  return map;
}

function buildSocialLinksObject(rows: any[]) {
  const entries = sortByOrderAndCreatedAt(rows)
    .filter((row) => String(row?.platform || "").trim() && String(row?.url || "").trim())
    .map((row) => [String(row.platform).trim(), String(row.url).trim()]);

  return Object.fromEntries(entries);
}

function getDayKey(dayOfWeek: number) {
  return String(dayOfWeek);
}

function normalizeStoreStoragePath(value: unknown) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;

  if (!/^https?:\/\//i.test(raw)) {
    const normalized = raw.replace(/^\/+/, "");
    const marker = `${STORE_STORAGE_BUCKET}/`;
    const markerIndex = normalized.indexOf(marker);
    return markerIndex >= 0 ? normalized.slice(markerIndex + marker.length) : normalized;
  }

  const objectPublicMatch = raw.match(new RegExp(`/object/public/${STORE_STORAGE_BUCKET}/(.+)$`, "i"));
  if (objectPublicMatch?.[1]) return objectPublicMatch[1];

  const fallbackMatch = raw.match(new RegExp(`/${STORE_STORAGE_BUCKET}/(.+)$`, "i"));
  return fallbackMatch?.[1] ?? null;
}

function toStorePublicUrl(pathOrUrl: unknown) {
  const raw = String(pathOrUrl ?? "").trim();
  if (!raw) return null;
  if (/^https?:\/\//i.test(raw)) return raw;

  const storagePath = normalizeStoreStoragePath(raw);
  if (!storagePath) return raw;

  const { data } = supabase.storage.from(STORE_STORAGE_BUCKET).getPublicUrl(storagePath);
  return data?.publicUrl ?? raw;
}

function buildOpeningHoursPayload(rows: any[]) {
  return sortByOrderAndCreatedAt(rows).map((row) => ({
    day_of_week: row.day_of_week,
    open_time: row.open_time,
    close_time: row.close_time,
    is_closed: row.is_closed,
  }));
}

function buildOpeningHoursObject(rows: any[]) {
  return sortByOrderAndCreatedAt(rows).reduce(
    (acc, row) => {
      acc[getDayKey(Number(row.day_of_week))] = row?.is_closed
        ? { open: "", close: "", is_closed: true }
        : {
            open: row?.open_time ?? "",
            close: row?.close_time ?? "",
            is_closed: false,
          };
      return acc;
    },
    {} as Record<string, { open: string; close: string; is_closed: boolean }>
  );
}

function buildOfferPayload(rows: any[]) {
  return sortByOrderAndCreatedAt(rows)
    .filter((row) => row?.is_active !== false)
    .map((row) => ({
      id: row.id,
      title: row.title,
      description: row.description,
      badge_text: row.badge_text,
      offer_type: row.offer_type,
      discount_value: row.discount_value,
      min_spend: row.min_spend,
      start_at: row.start_at,
      end_at: row.end_at,
      is_active: row.is_active,
      metadata: row.metadata ?? {},
    }));
}

function buildReviewAggregate(reviewRows: any[]) {
  const approved = (reviewRows || []).filter((row) => row?.is_approved !== false);
  const average = (field: string) => {
    const values = approved
      .map((row) => row?.[field])
      .filter((value) => value !== null && value !== undefined)
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value));

    if (!values.length) return null;
    return Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 10) / 10;
  };

  return {
    rating: average("rating") ?? 0,
    food_rating: average("food_rating"),
    service_rating: average("service_rating"),
    ambience_rating: average("ambience_rating"),
    drinks_rating: average("drinks_rating"),
    crowd_rating: average("crowd_rating"),
    total_ratings: approved.length,
  };
}

function getActiveSubscription(rows: any[]) {
  const now = Date.now();
  const active = (rows || [])
    .filter((row) => String(row?.status || "").toLowerCase() === "active")
    .filter((row) => {
      const startsAt = row?.starts_at ? new Date(row.starts_at).getTime() : null;
      const expiresAt = row?.expires_at ? new Date(row.expires_at).getTime() : null;
      if (startsAt && startsAt > now) return false;
      if (expiresAt && expiresAt < now) return false;
      return true;
    })
    .sort((a, b) => {
      const aCreatedAt = a?.created_at ? new Date(a.created_at).getTime() : 0;
      const bCreatedAt = b?.created_at ? new Date(b.created_at).getTime() : 0;
      return bCreatedAt - aCreatedAt;
    });

  return active[0] ?? null;
}

function getPreferredSubscription(rows: any[]) {
  const active = getActiveSubscription(rows);
  if (active) return active;

  return (rows || [])
    .slice()
    .sort((a, b) => {
      const aCreatedAt = a?.created_at ? new Date(a.created_at).getTime() : 0;
      const bCreatedAt = b?.created_at ? new Date(b.created_at).getTime() : 0;
      return bCreatedAt - aCreatedAt;
    })[0] ?? null;
}

function normalizeSubscription(row: any) {
  if (!row) return null;

  return {
    id: row.id ?? null,
    plan_code: row.plan_code ?? null,
    status: row.status ?? null,
    pickup_premium_enabled: row.pickup_premium_enabled ?? false,
    starts_at: row.starts_at ?? null,
    expires_at: row.expires_at ?? null,
    created_at: row.created_at ?? null,
    updated_at: row.updated_at ?? null,
    metadata: row.metadata ?? {},
  };
}

export async function hydrateStoreRows(baseStores: any[]) {
  const stores = Array.isArray(baseStores) ? baseStores : [];
  const storeIds = Array.from(new Set(stores.map((store) => store?.id).filter(Boolean)));
  if (!storeIds.length) return stores;

  const [
    tagsResult,
    socialLinksResult,
    openingHoursResult,
    mediaResult,
    offersResult,
    subscriptionsResult,
    reviewsResult,
  ] = await Promise.all([
    supabase.from("store_tags").select(STORE_TAG_SELECT).in("store_id", storeIds),
    supabase.from("store_social_links").select(STORE_SOCIAL_LINK_SELECT).in("store_id", storeIds),
    supabase.from("store_opening_hours").select(STORE_OPENING_HOURS_SELECT).in("store_id", storeIds),
    supabase.from("store_media_assets").select(STORE_MEDIA_SELECT).in("store_id", storeIds),
    supabase.from("store_offers").select(STORE_OFFER_SELECT).in("store_id", storeIds),
    supabase.from("store_subscriptions").select(STORE_SUBSCRIPTION_SELECT).in("store_id", storeIds),
    supabase
      .from("store_reviews")
      .select("store_id, rating, food_rating, service_rating, ambience_rating, drinks_rating, crowd_rating, is_approved")
      .in("store_id", storeIds),
  ]);

  const results = [
    tagsResult,
    socialLinksResult,
    openingHoursResult,
    mediaResult,
    offersResult,
    subscriptionsResult,
    reviewsResult,
  ];

  for (const result of results) {
    if (result.error) throw result.error;
  }

  const tagsByStoreId = toMapByStoreId(tagsResult.data ?? []);
  const socialLinksByStoreId = toMapByStoreId(socialLinksResult.data ?? []);
  const openingHoursByStoreId = toMapByStoreId(openingHoursResult.data ?? []);
  const mediaByStoreId = toMapByStoreId(mediaResult.data ?? []);
  const offersByStoreId = toMapByStoreId(offersResult.data ?? []);
  const subscriptionsByStoreId = toMapByStoreId(subscriptionsResult.data ?? []);
  const reviewsByStoreId = toMapByStoreId(reviewsResult.data ?? []);

  return stores.map((store) => {
    const tagRows = sortByOrderAndCreatedAt(tagsByStoreId.get(store.id) ?? []);
    const mediaRows = sortByOrderAndCreatedAt(mediaByStoreId.get(store.id) ?? []).filter(
      (row) => row?.is_active !== false
    );
    const offerRows = offersByStoreId.get(store.id) ?? [];
    const subscription = getPreferredSubscription(subscriptionsByStoreId.get(store.id) ?? []);
    const ratingSummary = buildReviewAggregate(reviewsByStoreId.get(store.id) ?? []);

    const tags = tagRows.filter((row) => row.tag_type === "tag").map((row) => row.tag_value);
    const facilities = tagRows.filter((row) => row.tag_type === "facility").map((row) => row.tag_value);
    const highlights = tagRows.filter((row) => row.tag_type === "highlight").map((row) => row.tag_value);
    const worthVisit = tagRows.filter((row) => row.tag_type === "worth_visit").map((row) => row.tag_value);
    const moodTags = tagRows.filter((row) => row.tag_type === "mood").map((row) => row.tag_value);
    const socialLinks = buildSocialLinksObject(socialLinksByStoreId.get(store.id) ?? []);

    const galleryUrls = mediaRows
      .filter((row) => row.asset_type === "gallery")
      .map((row) => toStorePublicUrl(row.file_url ?? row.file_path))
      .filter(Boolean);
    const foodImages = mediaRows
      .filter((row) => row.asset_type === "food")
      .map((row) => toStorePublicUrl(row.file_url ?? row.file_path))
      .filter(Boolean);
    const ambienceImages = mediaRows
      .filter((row) => row.asset_type === "ambience")
      .map((row) => toStorePublicUrl(row.file_url ?? row.file_path))
      .filter(Boolean);
    const menuAssets = mediaRows
      .filter((row) => row.asset_type === "menu")
      .map((row) => ({
        url: toStorePublicUrl(row.file_url ?? row.file_path),
        path: row.file_path,
        sort_order: row.sort_order,
      }))
      .filter((row) => row.url);

    const logoAsset = mediaRows.find((row) => row.asset_type === "logo");
    const coverImageAsset = mediaRows.find((row) => row.asset_type === "cover_image");
    const coverVideoAsset = mediaRows.find((row) => row.asset_type === "cover_video");
    const logoUrl = toStorePublicUrl(store.logo_url) ?? toStorePublicUrl(logoAsset?.file_url ?? logoAsset?.file_path);
    const coverImageUrl =
      toStorePublicUrl(store.cover_image) ??
      toStorePublicUrl(coverImageAsset?.file_url ?? coverImageAsset?.file_path);
    const coverVideoUrl = toStorePublicUrl(coverVideoAsset?.file_url ?? coverVideoAsset?.file_path);

    const offers = buildOfferPayload(offerRows);

    return {
      ...store,
      tags,
      facilities,
      highlights,
      worth_visit: worthVisit,
      mood_tags: moodTags,
      social_links: socialLinks,
      hours: buildOpeningHoursPayload(openingHoursByStoreId.get(store.id) ?? []),
      opening_hours: buildOpeningHoursObject(openingHoursByStoreId.get(store.id) ?? []),
      gallery_urls: galleryUrls,
      food_images: foodImages,
      ambience_images: ambienceImages,
      menu: menuAssets,
      offers,
      offer: offers[0] ?? null,
      subscription: normalizeSubscription(subscription),
      logo_url: logoUrl,
      cover_image: coverImageUrl,
      cover_image_url: coverImageUrl,
      cover_media_type: coverVideoUrl ? "video" : coverImageUrl ? "image" : null,
      cover_media_url: coverVideoUrl ?? coverImageUrl ?? null,
      cover_video_url: coverVideoUrl,
      instagram: socialLinks.instagram ?? null,
      facebook: socialLinks.facebook ?? null,
      tiktok: socialLinks.tiktok ?? null,
      maps: socialLinks.maps ?? socialLinks.google_maps ?? null,
      pickup_premium_enabled: subscription?.pickup_premium_enabled ?? false,
      pickup_premium_plan: subscription?.plan_code ?? null,
      pickup_premium_started_at: subscription?.starts_at ?? null,
      pickup_premium_expires_at: subscription?.expires_at ?? null,
      metadata: {
        ...(store.metadata ?? {}),
        rating: ratingSummary.rating,
        total_ratings: ratingSummary.total_ratings,
      },
      ...ratingSummary,
    };
  });
}

export async function hydrateStoreRow(baseStore: any) {
  const rows = await hydrateStoreRows(baseStore ? [baseStore] : []);
  return rows[0] ?? null;
}

export async function hydrateStorePreviewRows(baseStores: any[]) {
  const stores = Array.isArray(baseStores) ? baseStores : [];
  const storeIds = Array.from(new Set(stores.map((store) => store?.id).filter(Boolean)));
  if (!storeIds.length) return stores;

  const [tagsResult, mediaResult, offersResult, subscriptionsResult, reviewsResult] =
    await Promise.all([
      supabase
        .from("store_tags")
        .select(STORE_TAG_SELECT)
        .in("store_id", storeIds)
        .in("tag_type", ["tag", "facility", "highlight", "worth_visit", "mood"]),
      supabase
        .from("store_media_assets")
        .select(STORE_MEDIA_SELECT)
        .in("store_id", storeIds)
        .eq("is_active", true)
        .in("asset_type", ["logo", "cover_image", "cover_video", "gallery"]),
      supabase
        .from("store_offers")
        .select(STORE_OFFER_SELECT)
        .in("store_id", storeIds),
      supabase
        .from("store_subscriptions")
        .select(STORE_SUBSCRIPTION_SELECT)
        .in("store_id", storeIds),
      supabase
        .from("store_reviews")
        .select("store_id,rating,food_rating,service_rating,ambience_rating,drinks_rating,crowd_rating,is_approved")
        .in("store_id", storeIds)
        .eq("is_approved", true),
    ]);

  for (const result of [tagsResult, mediaResult, offersResult, subscriptionsResult, reviewsResult]) {
    if (result.error) throw result.error;
  }

  const tagsByStoreId = toMapByStoreId(tagsResult.data ?? []);
  const mediaByStoreId = toMapByStoreId(mediaResult.data ?? []);
  const offersByStoreId = toMapByStoreId(offersResult.data ?? []);
  const subscriptionsByStoreId = toMapByStoreId(subscriptionsResult.data ?? []);
  const reviewsByStoreId = toMapByStoreId(reviewsResult.data ?? []);

  return stores.map((store) => {
    const tagRows = sortByOrderAndCreatedAt(tagsByStoreId.get(store.id) ?? []);
    const mediaRows = sortByOrderAndCreatedAt(mediaByStoreId.get(store.id) ?? []).filter(
      (row) => row?.is_active !== false
    );
    const subscription = getPreferredSubscription(subscriptionsByStoreId.get(store.id) ?? []);
    const ratingSummary = buildReviewAggregate(reviewsByStoreId.get(store.id) ?? []);
    const offers = buildOfferPayload(offersByStoreId.get(store.id) ?? []);

    const tags = tagRows.filter((row) => row.tag_type === "tag").map((row) => row.tag_value);
    const coverImageAsset = mediaRows.find((row) => row.asset_type === "cover_image");
    const coverVideoAsset = mediaRows.find((row) => row.asset_type === "cover_video");
    const logoAsset = mediaRows.find((row) => row.asset_type === "logo");
    const socialLinks = {};
    const coverImageUrl =
      toStorePublicUrl(store.cover_image) ??
      toStorePublicUrl(coverImageAsset?.file_url ?? coverImageAsset?.file_path);
    const coverVideoUrl = toStorePublicUrl(coverVideoAsset?.file_url ?? coverVideoAsset?.file_path);
    const logoUrl = toStorePublicUrl(store.logo_url) ?? toStorePublicUrl(logoAsset?.file_url ?? logoAsset?.file_path);

    return {
      ...store,
      tags,
      social_links: socialLinks,
      subscription: normalizeSubscription(subscription),
      cover_image_url: coverImageUrl,
      cover_media_url: coverVideoUrl ?? coverImageUrl ?? null,
      cover_media_type: coverVideoUrl ? "video" : coverImageUrl ? "image" : null,
      logo_url: logoUrl,
      offers,
      offer: offers[0] ?? null,
      instagram: null,
      facebook: null,
      tiktok: null,
      maps: null,
      pickup_premium_enabled: subscription?.pickup_premium_enabled ?? false,
      pickup_premium_plan: subscription?.plan_code ?? null,
      pickup_premium_started_at: subscription?.starts_at ?? null,
      pickup_premium_expires_at: subscription?.expires_at ?? null,
      metadata: {
        ...(store.metadata ?? {}),
        rating: ratingSummary.rating,
        total_ratings: ratingSummary.total_ratings,
      },
      ...ratingSummary,
    };
  });
}
