import net from "net";
import tls from "tls";

type RedisReply = string | number | null | Error | RedisReply[];

interface RedisConfig {
  enabled: boolean;
  host: string;
  port: number;
  username?: string;
  password?: string;
  db: number;
  useTls: boolean;
  rejectUnauthorized: boolean;
  connectTimeoutMs: number;
  socketTimeoutMs: number;
  label: string;
}

interface PendingRequest {
  resolve: (value: RedisReply) => void;
  reject: (error: Error) => void;
}

interface ParsedReply {
  value: RedisReply;
  offset: number;
}

const defaultConnectTimeoutMs = Number(process.env.REDIS_CONNECT_TIMEOUT_MS ?? 2500);
const defaultSocketTimeoutMs = Number(process.env.REDIS_SOCKET_TIMEOUT_MS ?? 2500);

function trim(value: unknown) {
  return String(value ?? "").trim();
}

function parseBoolean(value: unknown, fallback = false) {
  const normalized = trim(value).toLowerCase();
  if (!normalized) return fallback;
  return ["1", "true", "yes", "on"].includes(normalized);
}

function parseRedisConfig(): RedisConfig {
  const redisUrl = trim(process.env.REDIS_URL);
  const rawHost = trim(process.env.REDIS_HOST);
  const enabledFlag = parseBoolean(process.env.REDIS_ENABLED, true);
  const hasUrl = redisUrl.length > 0;
  const hasHost = rawHost.length > 0;
  const configured = hasUrl || hasHost;

  const url = hasUrl ? new URL(redisUrl) : null;
  const host = url?.hostname || rawHost || "127.0.0.1";
  const port = Number(url?.port || process.env.REDIS_PORT || 6379);
  const username = trim(url?.username || process.env.REDIS_USERNAME) || undefined;
  const password = trim(url?.password || process.env.REDIS_PASSWORD) || undefined;
  const dbFromUrl = url?.pathname ? Number(url.pathname.replace(/^\//, "")) : Number(process.env.REDIS_DB ?? 0);
  const db = Number.isFinite(dbFromUrl) && dbFromUrl >= 0 ? dbFromUrl : 0;
  const useTls = url?.protocol === "rediss:" || parseBoolean(process.env.REDIS_TLS, false);
  const rejectUnauthorized = parseBoolean(process.env.REDIS_TLS_REJECT_UNAUTHORIZED, true);
  const connectTimeoutMs = Number(process.env.REDIS_CONNECT_TIMEOUT_MS ?? defaultConnectTimeoutMs);
  const socketTimeoutMs = Number(process.env.REDIS_SOCKET_TIMEOUT_MS ?? defaultSocketTimeoutMs);

  return {
    enabled: enabledFlag && configured,
    host,
    port,
    username,
    password,
    db,
    useTls,
    rejectUnauthorized,
    connectTimeoutMs,
    socketTimeoutMs,
    label: redisUrl || `${host}:${port}`,
  };
}

function findCrlf(buffer: Buffer, startIndex: number) {
  for (let index = startIndex; index < buffer.length - 1; index += 1) {
    if (buffer[index] === 13 && buffer[index + 1] === 10) {
      return index;
    }
  }
  return -1;
}

function parseReply(buffer: Buffer, offset = 0): ParsedReply | null {
  if (offset >= buffer.length) return null;

  const prefix = String.fromCharCode(buffer[offset]);

  if (prefix === "+" || prefix === "-" || prefix === ":") {
    const lineEnd = findCrlf(buffer, offset + 1);
    if (lineEnd < 0) return null;
    const line = buffer.toString("utf8", offset + 1, lineEnd);
    if (prefix === "+") {
      return { value: line, offset: lineEnd + 2 };
    }
    if (prefix === ":") {
      return { value: Number(line), offset: lineEnd + 2 };
    }
    return { value: new Error(line), offset: lineEnd + 2 };
  }

  if (prefix === "$") {
    const lineEnd = findCrlf(buffer, offset + 1);
    if (lineEnd < 0) return null;
    const length = Number(buffer.toString("utf8", offset + 1, lineEnd));
    const dataStart = lineEnd + 2;
    if (length === -1) {
      return { value: null, offset: dataStart };
    }
    const dataEnd = dataStart + length;
    const terminatorEnd = dataEnd + 2;
    if (buffer.length < terminatorEnd) return null;
    return {
      value: buffer.toString("utf8", dataStart, dataEnd),
      offset: terminatorEnd,
    };
  }

  if (prefix === "*") {
    const lineEnd = findCrlf(buffer, offset + 1);
    if (lineEnd < 0) return null;
    const length = Number(buffer.toString("utf8", offset + 1, lineEnd));
    let currentOffset = lineEnd + 2;
    if (length === -1) {
      return { value: null, offset: currentOffset };
    }

    const items: RedisReply[] = [];
    for (let index = 0; index < length; index += 1) {
      const parsed = parseReply(buffer, currentOffset);
      if (!parsed) return null;
      items.push(parsed.value);
      currentOffset = parsed.offset;
    }

    return { value: items, offset: currentOffset };
  }

  return null;
}

function encodeCommand(args: Array<string | number>): Buffer {
  const chunks: Buffer[] = [Buffer.from(`*${args.length}\r\n`, "utf8")];
  for (const arg of args) {
    const value = Buffer.from(String(arg), "utf8");
    chunks.push(Buffer.from(`$${value.length}\r\n`, "utf8"));
    chunks.push(value);
    chunks.push(Buffer.from("\r\n", "utf8"));
  }
  return Buffer.concat(chunks);
}

class SimpleRedisClient {
  private socket: net.Socket | tls.TLSSocket | null = null;
  private buffer = Buffer.alloc(0);
  private pending: PendingRequest[] = [];
  private connecting: Promise<boolean> | null = null;
  private ready = false;
  private lastError: string | null = null;
  private nextRetryAt = 0;

  constructor(private readonly config: RedisConfig) {}

  get isConfigured() {
    return this.config.enabled;
  }

  get status() {
    return {
      configured: this.config.enabled,
      ready: this.ready,
      lastError: this.lastError,
      label: this.config.label,
      host: this.config.host,
      port: this.config.port,
      tls: this.config.useTls,
    };
  }

  async ensureReady(): Promise<boolean> {
    if (!this.config.enabled) return false;
    if (this.ready && this.socket && !this.socket.destroyed) return true;
    if (this.connecting) return this.connecting;
    if (Date.now() < this.nextRetryAt) return false;

    this.connecting = this.connect().finally(() => {
      this.connecting = null;
    });

    return this.connecting;
  }

  private async connect(): Promise<boolean> {
    try {
      await this.openSocket();
      await this.authenticateAndSelect();
      this.ready = true;
      this.lastError = null;
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.lastError = message;
      this.ready = false;
      this.nextRetryAt = Date.now() + 5000;
      this.cleanupSocket(error instanceof Error ? error : new Error(message));
      return false;
    }
  }

  private async openSocket() {
    this.cleanupSocket();
    this.buffer = Buffer.alloc(0);

    const connectOptions = {
      host: this.config.host,
      port: this.config.port,
      timeout: this.config.connectTimeoutMs,
      servername: this.config.host,
      rejectUnauthorized: this.config.rejectUnauthorized,
    };

    const socket = this.config.useTls
      ? tls.connect(connectOptions)
      : net.createConnection({
          host: this.config.host,
          port: this.config.port,
          timeout: this.config.connectTimeoutMs,
        });

    this.socket = socket;
    socket.setKeepAlive(true, this.config.socketTimeoutMs);
    socket.setNoDelay(true);

    socket.on("data", (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.drainResponses();
    });

    socket.on("error", (error) => {
      this.lastError = error.message;
      this.ready = false;
      this.rejectPending(error);
      this.socket = null;
    });

    socket.on("close", () => {
      this.ready = false;
      this.socket = null;
      this.rejectPending(new Error("Redis connection closed"));
    });

    await new Promise<void>((resolve, reject) => {
      const onConnect = () => {
        socket.off("error", onError);
        resolve();
      };
      const onError = (error: Error) => {
        socket.off("connect", onConnect);
        reject(error);
      };

      socket.once("connect", onConnect);
      socket.once("error", onError);
    });
  }

  private async authenticateAndSelect() {
    if (this.config.password) {
      if (this.config.username) {
        await this.executeRaw(["AUTH", this.config.username, this.config.password]);
      } else {
        await this.executeRaw(["AUTH", this.config.password]);
      }
    }

    if (this.config.db > 0) {
      await this.executeRaw(["SELECT", this.config.db]);
    }
  }

  private rejectPending(error: Error) {
    while (this.pending.length > 0) {
      const next = this.pending.shift();
      next?.reject(error);
    }
  }

  private cleanupSocket(error?: Error) {
    if (this.socket && !this.socket.destroyed) {
      this.socket.destroy(error);
    }
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.rejectPending(error ?? new Error("Redis connection reset"));
  }

  private drainResponses() {
    while (true) {
      const parsed = parseReply(this.buffer);
      if (!parsed) break;
      this.buffer = this.buffer.slice(parsed.offset);
      const pending = this.pending.shift();
      if (!pending) continue;

      if (parsed.value instanceof Error) {
        pending.reject(parsed.value);
      } else {
        pending.resolve(parsed.value);
      }
    }
  }

  private async executeRaw(args: Array<string | number>): Promise<RedisReply> {
    if (!this.socket || this.socket.destroyed) {
      throw new Error("Redis socket is not connected");
    }

    return new Promise<RedisReply>((resolve, reject) => {
      const pending: PendingRequest = { resolve, reject };
      this.pending.push(pending);

      const payload = encodeCommand(args);
      this.socket?.write(payload, (error) => {
        if (!error) return;
        const index = this.pending.indexOf(pending);
        if (index >= 0) this.pending.splice(index, 1);
        reject(error);
      });
    });
  }

  async execute(args: Array<string | number>): Promise<RedisReply | null> {
    if (!this.config.enabled) return null;
    const ready = await this.ensureReady();
    if (!ready || !this.socket || this.socket.destroyed) return null;

    const response = await this.executeRaw(args);
    return response;
  }
}

const redisClient = new SimpleRedisClient(parseRedisConfig());

export function getRedisStatus() {
  return redisClient.status;
}

export async function ensureRedisReady() {
  return redisClient.ensureReady();
}

export async function redisGet(key: string) {
  const response = await redisClient.execute(["GET", key]);
  return typeof response === "string" || response === null ? response : null;
}

export async function redisSet(key: string, value: string, ttlMs?: number) {
  const args: Array<string | number> = ["SET", key, value];
  if (typeof ttlMs === "number" && Number.isFinite(ttlMs) && ttlMs > 0) {
    args.push("PX", Math.floor(ttlMs));
  }

  const response = await redisClient.execute(args);
  return response === "OK";
}

export async function redisDel(...keys: string[]) {
  if (keys.length === 0) return 0;
  const response = await redisClient.execute(["DEL", ...keys]);
  return typeof response === "number" ? response : 0;
}

export async function redisIncr(key: string) {
  const response = await redisClient.execute(["INCR", key]);
  return typeof response === "number" ? response : 0;
}

export async function redisPttl(key: string) {
  const response = await redisClient.execute(["PTTL", key]);
  return typeof response === "number" ? response : -2;
}

export async function redisEval<T = RedisReply>(script: string, keys: string[], args: string[] = []) {
  const commandArgs: Array<string | number> = ["EVAL", script, keys.length, ...keys, ...args];
  const response = await redisClient.execute(commandArgs);
  return response as T;
}
