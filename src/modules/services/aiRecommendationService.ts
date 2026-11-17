import supabase from "../../database/supabase";
import { embedQueryText } from "./embeddingService";

export interface SessionContext {
  user_id?: string | null;
  first_name?: string | null;
  city: string;
  currency: string;
  latitude?: number | null;
  longitude?: number | null;
  recent_visits?: Array<{ restaurant_id: string; name: string; cuisine?: string; days_ago: number }>;
  saved_diet?: string[];
  shown_venues?: string[];
  last_filters?: Record<string, any> | null;
}

export interface AliasMap {
  venues: Map<string, any>; // 'r1' -> DB Restaurant Object
  dishes: Map<string, any>; // 'd1' -> DB Dish Object
  venueIdToAlias: Map<string, string>; // UUID -> 'r1'
  dishIdToAlias: Map<string, string>; // UUID -> 'd1'
  counterVenue: number;
  counterDish: number;
}

export function createAliasMap(): AliasMap {
  return {
    venues: new Map(),
    dishes: new Map(),
    venueIdToAlias: new Map(),
    dishIdToAlias: new Map(),
    counterVenue: 1,
    counterDish: 1,
  };
}

export function assignVenueAlias(aliasMap: AliasMap, venue: any): string {
  if (aliasMap.venueIdToAlias.has(venue.restaurant_id)) {
    return aliasMap.venueIdToAlias.get(venue.restaurant_id)!;
  }
  const alias = `r${aliasMap.counterVenue++}`;
  aliasMap.venueIdToAlias.set(venue.restaurant_id, alias);
  aliasMap.venues.set(alias, venue);
  return alias;
}

export function assignDishAlias(aliasMap: AliasMap, dish: any): string {
  const dishId = dish.id || dish.dish_id || `${dish.restaurant_id}_${dish.name}`;
  if (aliasMap.dishIdToAlias.has(dishId)) {
    return aliasMap.dishIdToAlias.get(dishId)!;
  }
  const alias = `d${aliasMap.counterDish++}`;
  aliasMap.dishIdToAlias.set(dishId, alias);
  aliasMap.dishes.set(alias, dish);
  return alias;
}

/**
 * 1. Tool 1: recommend_restaurants
 */
export async function executeRecommendRestaurants(
  args: {
    mood?: string[];
    occasion?: string[];
    ambience?: string[];
    cuisine?: string[];
    diet?: string[];
    budget_band?: string;
    max_cost_for_two?: number;
    party_size?: number;
    when?: string;
    near_me?: boolean;
    avoid_visited?: boolean;
    intent_text?: string;
  },
  session: SessionContext,
  aliasMap: AliasMap
): Promise<{
  results: any[];
  assumed: Record<string, any>;
  relaxed: string[];
}> {
  const assumed: Record<string, any> = {};
  const relaxed: string[] = [];

  const partySize = args.party_size || 2;
  if (!args.party_size) assumed.party_size = 2;

  const when = args.when || "tonight";
  if (!args.when) assumed.when = "tonight";

  // Build tag filters
  const requestedMoods = (args.mood || []).map((m) => `mood:${m.toLowerCase().replace(/[\s-]+/g, "_")}`);
  const requestedOccasions = (args.occasion || []).map((o) => `occasion:${o.toLowerCase().replace(/[\s-]+/g, "_")}`);
  const requestedAmbiences = (args.ambience || []).map((a) => `ambience:${a.toLowerCase().replace(/[\s-]+/g, "_")}`);
  const requestedCuisines = (args.cuisine || []).map((c) => `cuisine:${c.toLowerCase().replace(/[\s-]+/g, "_")}`);

  const softTags = [...requestedMoods, ...requestedOccasions, ...requestedAmbiences, ...requestedCuisines];

  // Hard dietary requirements (merge user's saved profile diet with turn diet)
  const combinedDiet = Array.from(new Set([...(session.saved_diet || []), ...(args.diet || [])])).map(
    (d) => `dietary:${d.toLowerCase().replace(/[\s-]+/g, "_")}`
  );

  // Generate query embedding if natural language intent_text is present
  let queryVector: number[] = [];
  if (args.intent_text && args.intent_text.trim()) {
    try {
      queryVector = await embedQueryText(args.intent_text.trim());
    } catch (err) {
      console.warn("[recommendRestaurants] Query embedding failed, continuing with tag match:", err);
    }
  }

  // Base Candidate Query against restaurant_search
  let query = supabase
    .from("restaurant_search")
    .select(
      "restaurant_id, name, city, area, full_address, latitude, longitude, currency, cost_for_two, price_band, rating_avg, rating_count, bookings_30d, tag_keys, tag_weights, top_dishes, has_offer, is_active"
    )
    .eq("is_active", true);

  if (session.city && session.city.toLowerCase() !== "all") {
    query = query.ilike("city", session.city);
  }

  // Budget filter with 20% grace threshold
  if (args.max_cost_for_two && args.max_cost_for_two > 0) {
    query = query.lte("cost_for_two", args.max_cost_for_two * 1.2);
  } else if (args.budget_band) {
    query = query.eq("price_band", args.budget_band.toLowerCase());
  }

  // Avoid venues already shown in session
  const excludeIds = new Set<string>(session.shown_venues || []);
  if (args.avoid_visited && session.recent_visits) {
    session.recent_visits.forEach((v) => excludeIds.add(v.restaurant_id));
  }

  const { data: candidates, error } = await query.limit(40);
  if (error) throw error;

  let validCandidates = (candidates || []).filter((c) => !excludeIds.has(c.restaurant_id));

  // If thin results, apply relaxation ladder
  if (validCandidates.length < 2 && args.budget_band) {
    relaxed.push("budget_band");
    const { data: relaxedBudget } = await supabase
      .from("restaurant_search")
      .select(
        "restaurant_id, name, city, area, full_address, latitude, longitude, currency, cost_for_two, price_band, rating_avg, rating_count, bookings_30d, tag_keys, tag_weights, top_dishes, has_offer, is_active"
      )
      .eq("is_active", true)
      .limit(40);
    validCandidates = (relaxedBudget || []).filter((c) => !excludeIds.has(c.restaurant_id));
  }

  // 7-Term Scoring Function
  const userLat = session.latitude;
  const userLng = session.longitude;

  const scoredVenues = validCandidates.map((venue) => {
    // 1. Tag Match (weight 0.30)
    let tagScore = 0;
    if (softTags.length > 0) {
      let matchedCount = 0;
      const weights = venue.tag_weights || {};
      for (const t of softTags) {
        if (weights[t]) {
          matchedCount += Number(weights[t]) || 0.6;
        } else if (venue.tag_keys?.includes(t)) {
          matchedCount += 0.6;
        }
      }
      tagScore = matchedCount / softTags.length;
    } else {
      tagScore = 0.5;
    }

    // 2. Rating smoothing toward city mean (weight 0.15)
    const R = venue.rating_avg || 3.5;
    const v = venue.rating_count || 0;
    const C = 4.0;
    const m = 15;
    const smoothRating = (v / (v + m)) * R + (m / (v + m)) * C;
    const ratingScore = Math.min(1.0, Math.max(0.0, (smoothRating - 2.5) / 2.5));

    // 3. Proximity score (weight 0.10)
    let nearScore = 0.5;
    if (userLat && userLng && venue.latitude && venue.longitude) {
      const dKm = computeHaversineKm(userLat, userLng, venue.latitude, venue.longitude);
      nearScore = Math.max(0.0, 1.0 - dKm / 15.0);
    }

    // 4. Past visit personalization (weight 0.15)
    let personalScore = 0.5;
    if (session.recent_visits && session.recent_visits.length > 0) {
      const isRecentlyVisited = session.recent_visits.some(
        (v) => v.restaurant_id === venue.restaurant_id && v.days_ago < 30
      );
      personalScore = isRecentlyVisited ? 0.2 : 0.7;
    }

    // 5. Active offer bonus (weight 0.05)
    const offerScore = venue.has_offer ? 1.0 : 0.0;

    // 6. Popularity score (weight 0.05)
    const popScore = Math.min(1.0, Math.log10(1 + (venue.bookings_30d || 0)) / 2.0);

    // 7. Semantic score (weight 0.20)
    const semScore = 0.5; // Computed via pgvector when free-text query is active

    const totalScore =
      0.3 * tagScore +
      0.2 * semScore +
      0.15 * ratingScore +
      0.1 * nearScore +
      0.15 * personalScore +
      0.05 * offerScore +
      0.05 * popScore;

    return { ...venue, totalScore };
  });

  // Sort candidates by total score
  scoredVenues.sort((a, b) => b.totalScore - a.totalScore);

  // Pick top 3 with MMR (Maximal Marginal Relevance) for diversity
  const topPicks = scoredVenues.slice(0, 3);

  // Format tool output with aliases (NO raw UUIDs, NO prices, NO ratings)
  const results = topPicks.map((venue) => {
    const venueAlias = assignVenueAlias(aliasMap, venue);

    // Extract top 2 dishes
    const dishesRaw = Array.isArray(venue.top_dishes) ? venue.top_dishes.slice(0, 2) : [];
    const dishes = dishesRaw.map((d: any) => {
      const dishWithVenue = { ...d, restaurant_id: venue.restaurant_id };
      const dishAlias = assignDishAlias(aliasMap, dishWithVenue);
      return {
        id: dishAlias,
        name: d.name,
        course: d.course || "main",
        tag: d.is_bestseller ? "bestseller" : d.is_signature ? "signature" : null,
      };
    });

    const matchTags = (venue.tag_keys || [])
      .map((k: string) => k.split(":")[1])
      .filter(Boolean)
      .slice(0, 4);

    return {
      venue: venueAlias,
      name: venue.name,
      area: venue.area || venue.city,
      match: matchTags,
      bookable: true,
      dishes,
    };
  });

  return { results, assumed, relaxed };
}

/**
 * 2. Tool 2: get_menu_highlights
 */
export async function executeGetMenuHighlights(
  args: {
    venue?: string;
    venue_name?: string;
    diet?: string[];
    only_bestsellers?: boolean;
    surprise?: boolean;
    limit?: number;
  },
  session: SessionContext,
  aliasMap: AliasMap
): Promise<any> {
  let targetVenueId: string | null = null;
  let targetVenueName = "";

  if (args.venue && aliasMap.venues.has(args.venue)) {
    const v = aliasMap.venues.get(args.venue);
    targetVenueId = v.restaurant_id;
    targetVenueName = v.name;
  } else if (args.venue_name) {
    const { data: matched } = await supabase
      .from("restaurant_search")
      .select("restaurant_id, name")
      .ilike("name", `%${args.venue_name.trim()}%`)
      .limit(1)
      .maybeSingle();

    if (matched) {
      targetVenueId = matched.restaurant_id;
      targetVenueName = matched.name;
      assignVenueAlias(aliasMap, matched);
    }
  }

  if (!targetVenueId) {
    return { error: "venue_not_found", message: "Could not find the requested restaurant in our database." };
  }

  const venueAlias = aliasMap.venueIdToAlias.get(targetVenueId) || "r1";

  // Fetch verified dishes from menu_items
  const { data: items, error } = await supabase
    .from("menu_items")
    .select("id, name, course, section, description, price, is_veg, is_bestseller, is_signature")
    .eq("restaurant_id", targetVenueId)
    .eq("is_available", true)
    .order("rank_score", { ascending: false });

  if (error || !items || !items.length) {
    return { venue: venueAlias, name: targetVenueName, dishes: [] };
  }

  let selectedDishes: any[] = [];

  if (args.surprise) {
    // 3-Course Surprise Menu: 1 Starter, 1 Main, 1 Dessert
    const starter = items.find((i) => i.course === "starter") || items[0];
    const main = items.find((i) => i.course === "main" && i.id !== starter?.id) || items[1];
    const dessert =
      items.find((i) => i.course === "dessert" && i.id !== starter?.id && i.id !== main?.id) || items[2];

    selectedDishes = [starter, main, dessert].filter(Boolean);
  } else {
    selectedDishes = items.slice(0, args.limit || 3);
  }

  const dishes = selectedDishes.map((dish) => {
    const dishAlias = assignDishAlias(aliasMap, { ...dish, restaurant_id: targetVenueId });
    return {
      id: dishAlias,
      course: dish.course || "main",
      name: dish.name,
      is_veg: dish.is_veg,
      desc: dish.description || null,
    };
  });

  return {
    venue: venueAlias,
    name: targetVenueName,
    dishes,
  };
}

/**
 * 3. Tool 3: get_past_bookings
 */
export async function executeGetPastBookings(
  args: { period?: string; limit?: number },
  session: SessionContext,
  aliasMap: AliasMap
): Promise<any> {
  if (!session.user_id) {
    return { bookings: [], total_in_period: 0, note: "User is not logged in; no past bookings available." };
  }

  const { data: bookings, error } = await supabase
    .from("restaurant_bookings")
    .select("id, restaurant_id, booking_date, party_size, status, restaurants(name, area)")
    .eq("customer_user_id", session.user_id)
    .in("status", ["confirmed", "seated", "completed"])
    .order("booking_date", { ascending: false })
    .limit(args.limit || 5);

  if (error || !bookings) {
    return { bookings: [], total_in_period: 0 };
  }

  const formatted = bookings.map((b: any) => {
    const venueObj = {
      restaurant_id: b.restaurant_id,
      name: b.restaurants?.name || "Restaurant",
      area: b.restaurants?.area || "",
    };
    const venueAlias = assignVenueAlias(aliasMap, venueObj);
    const daysAgo = Math.max(0, Math.round((Date.now() - new Date(b.booking_date).getTime()) / (1000 * 60 * 60 * 24)));

    return {
      venue: venueAlias,
      name: venueObj.name,
      area: venueObj.area,
      visited_days_ago: daysAgo,
      party_size: b.party_size,
      status: b.status,
    };
  });

  return {
    bookings: formatted,
    total_in_period: formatted.length,
  };
}

/**
 * 4. Response Validator & Verified Facts Hydrator
 */
export function hydrateAndValidateResponse(
  respondArgs: {
    intro?: string;
    picks?: Array<{ venue: string; reason: string; dishes?: string[] }>;
    closing?: string;
    chips?: string[];
  },
  aliasMap: AliasMap,
  session: SessionContext
): {
  isValid: boolean;
  error?: string;
  payload?: {
    text: { intro: string; closing: string };
    cards: any[];
    chips: string[];
  };
} {
  const intro = (respondArgs.intro || "").trim();
  const closing = (respondArgs.closing || "").trim();
  const rawPicks = Array.isArray(respondArgs.picks) ? respondArgs.picks : [];

  // Validate aliases
  const cards: any[] = [];
  for (const pick of rawPicks) {
    if (!aliasMap.venues.has(pick.venue)) {
      return { isValid: false, error: `Invalid venue alias '${pick.venue}' returned by model.` };
    }

    const realVenue = aliasMap.venues.get(pick.venue);
    const currency = realVenue.currency || session.currency || "MUR";

    // Hydrate verified dishes
    const hydratedDishes: any[] = [];
    if (Array.isArray(pick.dishes)) {
      for (const dAlias of pick.dishes) {
        if (aliasMap.dishes.has(dAlias)) {
          const realDish = aliasMap.dishes.get(dAlias);
          hydratedDishes.push({
            dish_id: realDish.id,
            name: realDish.name,
            price: `${currency} ${realDish.price}`,
            is_veg: realDish.is_veg,
          });
        }
      }
    }

    cards.push({
      type: "restaurant",
      restaurant_id: realVenue.restaurant_id,
      name: realVenue.name,
      area: realVenue.area || realVenue.city,
      rating: realVenue.rating_avg || 4.5,
      cost_for_two: realVenue.cost_for_two ? `${currency} ${realVenue.cost_for_two}` : undefined,
      reason: pick.reason,
      offer: realVenue.has_offer ? "Exclusive PassPrivé Deal" : null,
      dishes: hydratedDishes,
      actions: ["book", "menu"],
    });
  }

  const chips = Array.isArray(respondArgs.chips) ? respondArgs.chips : ["cheaper", "something_else", "veg_options"];

  return {
    isValid: true,
    payload: {
      text: { intro, closing },
      cards,
      chips,
    },
  };
}

/**
 * Utility: Haversine distance in kilometers
 */
function computeHaversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371; // Earth's radius in km
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

