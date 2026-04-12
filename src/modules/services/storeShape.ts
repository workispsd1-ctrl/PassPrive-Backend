import supabase from "../../database/supabase";

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

function buildOpeningHoursPayload(rows: any[]) {
  return sortByOrderAndCreatedAt(rows).map((row) => ({
    day_of_week: row.day_of_week,
    open_time: row.open_time,
    close_time: row.close_time,
    is_closed: row.is_closed,
  }));
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
    supabase.from("store_tags").select("*").in("store_id", storeIds),
    supabase.from("store_social_links").select("*").in("store_id", storeIds),
    supabase.from("store_opening_hours").select("*").in("store_id", storeIds),
    supabase.from("store_media_assets").select("*").in("store_id", storeIds),
    supabase.from("store_offers").select("*").in("store_id", storeIds),
    supabase.from("store_subscriptions").select("*").in("store_id", storeIds),
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
    const subscription = getActiveSubscription(subscriptionsByStoreId.get(store.id) ?? []);
    const ratingSummary = buildReviewAggregate(reviewsByStoreId.get(store.id) ?? []);

    const tags = tagRows.filter((row) => row.tag_type === "tag").map((row) => row.tag_value);
    const facilities = tagRows.filter((row) => row.tag_type === "facility").map((row) => row.tag_value);
    const highlights = tagRows.filter((row) => row.tag_type === "highlight").map((row) => row.tag_value);
    const worthVisit = tagRows.filter((row) => row.tag_type === "worth_visit").map((row) => row.tag_value);
    const moodTags = tagRows.filter((row) => row.tag_type === "mood").map((row) => row.tag_value);

    const galleryUrls = mediaRows
      .filter((row) => row.asset_type === "gallery")
      .map((row) => row.file_url);
    const foodImages = mediaRows
      .filter((row) => row.asset_type === "food")
      .map((row) => row.file_url);
    const ambienceImages = mediaRows
      .filter((row) => row.asset_type === "ambience")
      .map((row) => row.file_url);
    const menuAssets = mediaRows
      .filter((row) => row.asset_type === "menu")
      .map((row) => ({
        url: row.file_url,
        path: row.file_path,
        sort_order: row.sort_order,
      }));

    const logoAsset = mediaRows.find((row) => row.asset_type === "logo");
    const coverImageAsset = mediaRows.find((row) => row.asset_type === "cover_image");
    const coverVideoAsset = mediaRows.find((row) => row.asset_type === "cover_video");

    const offers = buildOfferPayload(offerRows);

    return {
      ...store,
      tags,
      facilities,
      highlights,
      worth_visit: worthVisit,
      mood_tags: moodTags,
      social_links: buildSocialLinksObject(socialLinksByStoreId.get(store.id) ?? []),
      hours: buildOpeningHoursPayload(openingHoursByStoreId.get(store.id) ?? []),
      gallery_urls: galleryUrls,
      food_images: foodImages,
      ambience_images: ambienceImages,
      menu: menuAssets,
      offers,
      offer: offers[0] ?? null,
      logo_url: store.logo_url ?? logoAsset?.file_url ?? null,
      cover_image: store.cover_image ?? coverImageAsset?.file_url ?? null,
      cover_image_url: store.cover_image ?? coverImageAsset?.file_url ?? null,
      cover_media_type: coverVideoAsset ? "video" : coverImageAsset || store.cover_image ? "image" : null,
      cover_media_url: coverVideoAsset?.file_url ?? coverImageAsset?.file_url ?? store.cover_image ?? null,
      cover_video_url: coverVideoAsset?.file_url ?? null,
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

