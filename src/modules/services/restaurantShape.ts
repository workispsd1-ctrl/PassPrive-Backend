import supabase from "../../database/supabase";

export const RESTAURANT_PREVIEW_SELECT = [
  "id",
  "name",
  "slug",
  "description",
  "city",
  "area",
  "full_address",
  "cover_image",
  "latitude",
  "longitude",
  "is_active",
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

function average(values: any[]) {
  const numbers = values
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value));

  if (!numbers.length) return null;
  return Math.round((numbers.reduce((sum, value) => sum + value, 0) / numbers.length) * 10) / 10;
}

function getWeekdayName(dayOfWeek: number) {
  const names = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  return names[dayOfWeek] ?? null;
}

function addOpeningHourEntry(
  bucket: Record<string, { open: string; close: string; is_closed?: boolean }>,
  dayOfWeek: number,
  value: { open: string; close: string; is_closed?: boolean }
) {
  bucket[String(dayOfWeek)] = value;
  const weekdayName = getWeekdayName(dayOfWeek);
  if (weekdayName) {
    bucket[weekdayName] = value;
    bucket[weekdayName.slice(0, 3)] = value;
  }
}

export async function hydrateRestaurantPreviewRows(baseRestaurants: any[]) {
  const restaurants = Array.isArray(baseRestaurants) ? baseRestaurants : [];
  const restaurantIds = Array.from(new Set(restaurants.map((restaurant) => restaurant?.id).filter(Boolean)));
  if (!restaurantIds.length) return restaurants;

  const [tagsResp, mediaResp, hoursResp, offersResp, reviewsResp, subscriptionsResp] = await Promise.all([
    supabase
      .from("restaurant_tags")
      .select("restaurant_id,tag_type,tag_value,sort_order,created_at")
      .in("restaurant_id", restaurantIds)
      .in("tag_type", ["cuisine", "facility", "highlight", "worth_visit", "mood"]),
    supabase
      .from("restaurant_media_assets")
      .select("restaurant_id,asset_type,file_url,sort_order,created_at,is_active")
      .in("restaurant_id", restaurantIds)
      .eq("is_active", true)
      .in("asset_type", ["food", "ambience", "menu"]),
    supabase
      .from("restaurant_opening_hours")
      .select("restaurant_id,day_of_week,open_time,close_time,is_closed,created_at")
      .in("restaurant_id", restaurantIds),
    supabase
      .from("restaurant_offers")
      .select("id,restaurant_id,title,description,badge_text,offer_type,discount_value,min_spend,start_at,end_at,is_active,metadata,created_at")
      .in("restaurant_id", restaurantIds),
    supabase
      .from("restaurant_reviews")
      .select("restaurant_id,rating,food_rating,service_rating,ambience_rating,drinks_rating,crowd_rating,is_approved")
      .in("restaurant_id", restaurantIds)
      .eq("is_approved", true),
    supabase
      .from("restaurant_subscriptions")
      .select("restaurant_id,plan_code,status,unlock_all,time_slot_enabled,repeat_rewards_enabled,dish_discounts_enabled,starts_at,expires_at,created_at")
      .in("restaurant_id", restaurantIds),
  ]);

  for (const response of [tagsResp, mediaResp, hoursResp, offersResp, reviewsResp, subscriptionsResp]) {
    if (response.error) throw response.error;
  }

  const tagsByRestaurant = new Map<string, Record<string, string[]>>();
  for (const row of sortByOrderAndCreatedAt(tagsResp.data ?? [])) {
    const bucket = tagsByRestaurant.get(row.restaurant_id) ?? {};
    const values = bucket[row.tag_type] ?? [];
    values.push(row.tag_value);
    bucket[row.tag_type] = values;
    tagsByRestaurant.set(row.restaurant_id, bucket);
  }

  const mediaByRestaurant = new Map<string, Record<string, string[]>>();
  for (const row of sortByOrderAndCreatedAt(mediaResp.data ?? [])) {
    const bucket = mediaByRestaurant.get(row.restaurant_id) ?? {};
    const values = bucket[row.asset_type] ?? [];
    values.push(row.file_url);
    bucket[row.asset_type] = values;
    mediaByRestaurant.set(row.restaurant_id, bucket);
  }

  const hoursByRestaurant = new Map<
    string,
    Record<string, { open: string; close: string; is_closed?: boolean }>
  >();
  for (const row of sortByOrderAndCreatedAt(hoursResp.data ?? [])) {
    const bucket = hoursByRestaurant.get(row.restaurant_id) ?? {};
    const normalizedHour = row.is_closed
      ? { open: "", close: "", is_closed: true }
      : { open: row.open_time, close: row.close_time };
    addOpeningHourEntry(bucket, Number(row.day_of_week), normalizedHour);
    hoursByRestaurant.set(row.restaurant_id, bucket);
  }

  const now = new Date();
  const offersByRestaurant = new Map<string, any[]>();
  for (const row of sortByOrderAndCreatedAt(offersResp.data ?? [])) {
    const startsAt = row.start_at ? new Date(row.start_at) : null;
    const endsAt = row.end_at ? new Date(row.end_at) : null;
    if (row.is_active === false) continue;
    if (startsAt && startsAt > now) continue;
    if (endsAt && endsAt < now) continue;

    const offers = offersByRestaurant.get(row.restaurant_id) ?? [];
    offers.push({
      id: row.id,
      title: row.title,
      description: row.description,
      badge_text: row.badge_text,
      offer_type: row.offer_type,
      discount_value: row.discount_value,
      minimum_bill_amount: row.min_spend,
      start_at: row.start_at,
      end_at: row.end_at,
      metadata: row.metadata ?? {},
    });
    offersByRestaurant.set(row.restaurant_id, offers);
  }

  const reviewStatsByRestaurant = new Map<string, any[]>();
  for (const row of reviewsResp.data ?? []) {
    const reviews = reviewStatsByRestaurant.get(row.restaurant_id) ?? [];
    reviews.push(row);
    reviewStatsByRestaurant.set(row.restaurant_id, reviews);
  }

  const activeSubscriptionsByRestaurant = new Map<string, any>();
  for (const row of sortByOrderAndCreatedAt(subscriptionsResp.data ?? [])) {
    const startsAt = row.starts_at ? new Date(row.starts_at) : null;
    const expiresAt = row.expires_at ? new Date(row.expires_at) : null;
    if (String(row.status || "").toLowerCase() !== "active") continue;
    if (startsAt && startsAt > now) continue;
    if (expiresAt && expiresAt < now) continue;
    if (!activeSubscriptionsByRestaurant.has(row.restaurant_id)) {
      activeSubscriptionsByRestaurant.set(row.restaurant_id, row);
    }
  }

  return restaurants.map((restaurant) => {
    const tags = tagsByRestaurant.get(restaurant.id) ?? {};
    const media = mediaByRestaurant.get(restaurant.id) ?? {};
    const offers = offersByRestaurant.get(restaurant.id) ?? [];
    const activeSubscription = activeSubscriptionsByRestaurant.get(restaurant.id) ?? null;
    const reviews = reviewStatsByRestaurant.get(restaurant.id) ?? [];

    const aggregate = {
      rating: average(reviews.map((row) => row.rating)) ?? 0,
      total_ratings: reviews.length,
      food_rating: average(reviews.map((row) => row.food_rating)),
      service_rating: average(reviews.map((row) => row.service_rating)),
      ambience_rating: average(reviews.map((row) => row.ambience_rating)),
      drinks_rating: average(reviews.map((row) => row.drinks_rating)),
      crowd_rating: average(reviews.map((row) => row.crowd_rating)),
    };

    return {
      ...restaurant,
      location_name: null,
      lat: restaurant.latitude ?? null,
      lng: restaurant.longitude ?? null,
      logo_url: null,
      cover_image_url: restaurant.cover_image ?? null,
      cuisines: tags.cuisine ?? [],
      facilities: tags.facility ?? [],
      highlights: tags.highlight ?? [],
      worth_visit: tags.worth_visit ?? [],
      mood_tags: tags.mood ?? [],
      distance: null,
      offer: offers,
      offers,
      food_images: media.food ?? [],
      ambience_images: media.ambience ?? [],
      menu_images: media.menu ?? [],
      opening_hours: hoursByRestaurant.get(restaurant.id) ?? {},
      subscribed: Boolean(activeSubscription),
      subscribed_plan: activeSubscription?.plan_code ?? null,
      premium_unlock_all: activeSubscription?.unlock_all ?? false,
      premium_time_slot_enabled: activeSubscription?.time_slot_enabled ?? false,
      premium_repeat_rewards_enabled: activeSubscription?.repeat_rewards_enabled ?? false,
      premium_dish_discounts_enabled: activeSubscription?.dish_discounts_enabled ?? false,
      premium_expires_at: activeSubscription?.expires_at ?? null,
      ...aggregate,
    };
  });
}
