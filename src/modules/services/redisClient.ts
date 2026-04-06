import { createClient } from "redis";

type AppRedisClient = ReturnType<typeof createClient>;

let client: AppRedisClient | null = null;
let connectPromise: Promise<AppRedisClient | null> | null = null;
let lastLoggedError = "";

function isRedisEnabled() {
  return String(process.env.REDIS_ENABLED ?? "true").trim().toLowerCase() !== "false";
}

function buildRedisUrl() {
  const directUrl = String(process.env.REDIS_URL ?? "").trim();
  if (directUrl) return directUrl;

  const host = String(process.env.REDIS_HOST ?? "").trim();
  if (!host) return "";

  const port = Number(process.env.REDIS_PORT ?? 6379);
  const password = String(process.env.REDIS_PASSWORD ?? "").trim();
  const username = String(process.env.REDIS_USERNAME ?? "default").trim();
  const database = Number(process.env.REDIS_DB ?? 0);

  const credentials = password
    ? `${encodeURIComponent(username)}:${encodeURIComponent(password)}@`
    : "";

  return `redis://${credentials}${host}:${port}/${database}`;
}

export function isRedisConfigured() {
  return isRedisEnabled() && buildRedisUrl().length > 0;
}

function buildRedisClient() {
  const url = buildRedisUrl();
  if (!url) return null;

  const nextClient = createClient({
    url,
    socket: {
      connectTimeout: Number(process.env.REDIS_CONNECT_TIMEOUT_MS ?? 5000),
      reconnectStrategy(retries) {
        return Math.min(retries * 250, 3000);
      },
    },
  });

  nextClient.on("error", (error: any) => {
    const message = String(error?.message ?? error ?? "Unknown Redis error");
    if (message === lastLoggedError) return;
    lastLoggedError = message;
    console.warn("[redis] Client error, falling back to in-memory behavior when needed", {
      message,
    });
  });

  nextClient.on("ready", () => {
    console.info("[redis] Connected");
  });

  nextClient.on("reconnecting", () => {
    console.warn("[redis] Reconnecting");
  });

  return nextClient;
}

export async function getRedisClient() {
  if (!isRedisConfigured()) return null;
  if (client?.isOpen) return client;
  if (connectPromise) return connectPromise;

  connectPromise = (async () => {
    try {
      client = buildRedisClient();
      if (!client) return null;
      if (!client.isOpen) {
        await client.connect();
      }
      return client;
    } catch (error: any) {
      console.warn("[redis] Unable to establish connection, using in-memory fallback", {
        message: String(error?.message ?? error ?? "Unknown Redis connection error"),
      });
      connectPromise = null;
      client = null;
      return null;
    }
  })();

  const connectedClient = await connectPromise;
  connectPromise = null;
  return connectedClient;
}

export async function initializeRedisClient() {
  await getRedisClient();
}
