import https from "https";
import crypto from "crypto";
import supabase from "../../database/supabase";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const EMBEDDING_MODEL = process.env.OPENAI_EMBEDDING_MODEL || "text-embedding-3-small";
const EMBEDDING_DIMENSIONS = 1536;

// In-memory query embedding cache (TTL: 1 hour) to save token cost on repeated user searches
const queryEmbeddingCache = new Map<string, { vector: number[]; expiresAt: number }>();
const QUERY_CACHE_TTL_MS = 60 * 60 * 1000;

/**
 * Call OpenAI REST API directly to generate a 1536-dimension embedding vector
 */
export async function callOpenAIEmbedding(text: string): Promise<number[]> {
  const apiKey = (process.env.OPENAI_API_KEY || OPENAI_API_KEY).trim();
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not configured in backend environment variables.");
  }

  const cleanText = text.replace(/\n+/g, " ").trim();
  if (!cleanText) {
    throw new Error("Text to embed cannot be empty.");
  }

  const payload = JSON.stringify({
    model: EMBEDDING_MODEL,
    input: cleanText,
    dimensions: EMBEDDING_DIMENSIONS,
  });

  return new Promise<number[]>((resolve, reject) => {
    const req = https.request(
      "https://api.openai.com/v1/embeddings",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
          Authorization: `Bearer ${apiKey}`,
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (chunk) => {
          raw += chunk;
        });
        res.on("end", () => {
          try {
            const data = JSON.parse(raw || "{}");
            if (res.statusCode && res.statusCode >= 400) {
              return reject(new Error(data?.error?.message || `OpenAI Embeddings API error (${res.statusCode})`));
            }
            const vector = data?.data?.[0]?.embedding;
            if (!Array.isArray(vector) || vector.length === 0) {
              return reject(new Error("OpenAI Embeddings API returned no vector data."));
            }
            resolve(vector);
          } catch (err: any) {
            reject(new Error(`Failed to parse OpenAI Embeddings response: ${err?.message}`));
          }
        });
      }
    );

    req.on("error", (err) => {
      reject(new Error(`Network error calling OpenAI Embeddings API: ${err.message}`));
    });

    req.setTimeout(10000, () => {
      req.destroy();
      reject(new Error("OpenAI Embeddings API request timed out after 10 seconds."));
    });

    req.write(payload);
    req.end();
  });
}

/**
 * Embed free-text search query with in-memory caching
 */
export async function embedQueryText(query: string): Promise<number[]> {
  const normalized = query.toLowerCase().trim();
  if (!normalized) return [];

  const cacheKey = `${EMBEDDING_MODEL}:${normalized}`;
  const cached = queryEmbeddingCache.get(cacheKey);
  const now = Date.now();

  if (cached && cached.expiresAt > now) {
    return cached.vector;
  }

  const vector = await callOpenAIEmbedding(normalized);
  queryEmbeddingCache.set(cacheKey, { vector, expiresAt: now + QUERY_CACHE_TTL_MS });
  return vector;
}

/**
 * Builds the semantic string for a restaurant to generate high-quality dining embeddings
 */
export function buildRestaurantSemanticText(r: {
  name: string;
  city?: string | null;
  area?: string | null;
  tag_keys?: string[] | null;
  top_dishes?: any[] | null;
}): string {
  const parts: string[] = [r.name];

  if (r.area) parts.push(`Area: ${r.area}.`);
  if (r.city && r.city.toLowerCase() !== "all") parts.push(`City: ${r.city}.`);

  // Extract tags by type (e.g. 'mood:romantic_dining' -> 'Romantic dining')
  const tagKeys = Array.isArray(r.tag_keys) ? r.tag_keys : [];
  const moods: string[] = [];
  const cuisines: string[] = [];
  const ambience: string[] = [];

  for (const k of tagKeys) {
    const [type, slug] = String(k).split(":");
    if (!slug) continue;
    const humanName = slug.replace(/_/g, " ");
    if (type === "mood") moods.push(humanName);
    else if (type === "cuisine") cuisines.push(humanName);
    else if (type === "ambience") ambience.push(humanName);
  }

  if (cuisines.length) parts.push(`Cuisines: ${cuisines.join(", ")}.`);
  if (moods.length) parts.push(`Mood: ${moods.join(", ")}.`);
  if (ambience.length) parts.push(`Ambience: ${ambience.join(", ")}.`);

  // Known standout dishes from top_dishes
  const topDishes = Array.isArray(r.top_dishes) ? r.top_dishes : [];
  if (topDishes.length) {
    const dishNames = topDishes.map((d: any) => d.name).filter(Boolean);
    if (dishNames.length) {
      parts.push(`Known for: ${dishNames.join(", ")}.`);
    }
  }

  return parts.join(" ");
}

/**
 * Computes MD5 hash of text to detect real content changes and avoid duplicate API calls
 */
export function computeTextHash(text: string): string {
  return crypto.createHash("md5").update(text.trim()).digest("hex");
}

/**
 * Process a single restaurant's vector embedding from restaurant_search
 */
export async function processSingleRestaurantEmbedding(restaurantId: string): Promise<{
  updated: boolean;
  skipped: boolean;
  error?: string;
}> {
  try {
    // 1. Fetch current search record
    const { data: searchRow, error: fetchErr } = await supabase
      .from("restaurant_search")
      .select("restaurant_id, name, city, area, tag_keys, top_dishes, embedding_hash, embedding")
      .eq("restaurant_id", restaurantId)
      .maybeSingle();

    if (fetchErr) throw fetchErr;
    if (!searchRow) {
      // If no search row exists yet, rebuild it first
      await supabase.rpc("rebuild_restaurant_search_record", { target_restaurant_id: restaurantId });
    }

    // Refetch to get newly hydrated search record
    const { data: record, error: refetchErr } = await supabase
      .from("restaurant_search")
      .select("restaurant_id, name, city, area, tag_keys, top_dishes, embedding_hash, embedding")
      .eq("restaurant_id", restaurantId)
      .single();

    if (refetchErr) throw refetchErr;

    // 2. Build semantic representation
    const semanticText = buildRestaurantSemanticText(record);
    const newHash = computeTextHash(semanticText);

    // 3. Skip API call if content hash is identical and vector exists
    if (record.embedding && record.embedding_hash === newHash) {
      await supabase.from("embedding_jobs").delete().eq("restaurant_id", restaurantId);
      return { updated: false, skipped: true };
    }

    // 4. Generate vector using OpenAI API
    const vector = await callOpenAIEmbedding(semanticText);

    // 5. Update restaurant_search with embedding vector and metadata
    const { error: updateErr } = await supabase
      .from("restaurant_search")
      .update({
        embedding: vector,
        embedding_model: EMBEDDING_MODEL,
        embedding_hash: newHash,
        embedded_at: new Date().toISOString(),
      })
      .eq("restaurant_id", restaurantId);

    if (updateErr) throw updateErr;

    // 6. Remove completed job from queue
    await supabase.from("embedding_jobs").delete().eq("restaurant_id", restaurantId);

    return { updated: true, skipped: false };
  } catch (err: any) {
    // Record failure in embedding_jobs for retry tracking
    await supabase
      .from("embedding_jobs")
      .update({
        attempts: supabase.rpc("increment"),
        last_error: err?.message || String(err),
      })
      .eq("restaurant_id", restaurantId);

    return { updated: false, skipped: false, error: err?.message || String(err) };
  }
}

/**
 * Worker: Process all pending embedding jobs from queue
 */
export async function processAllPendingEmbeddingJobs(batchSize = 10): Promise<{
  processed: number;
  updated: number;
  skipped: number;
  errors: number;
}> {
  const { data: jobs, error } = await supabase
    .from("embedding_jobs")
    .select("restaurant_id, attempts")
    .order("queued_at", { ascending: true })
    .limit(batchSize);

  if (error || !jobs || !jobs.length) {
    return { processed: 0, updated: 0, skipped: 0, errors: 0 };
  }

  let updated = 0;
  let skipped = 0;
  let errors = 0;

  for (const job of jobs) {
    const res = await processSingleRestaurantEmbedding(job.restaurant_id);
    if (res.updated) updated++;
    else if (res.skipped) skipped++;
    else if (res.error) errors++;
  }

  return { processed: jobs.length, updated, skipped, errors };
}

