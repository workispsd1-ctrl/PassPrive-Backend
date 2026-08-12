const FULLE_BASE_URL = "https://api.fulleapps.io";

export interface FullePOSResponse {
  list?: any[];
  [key: string]: any;
}

/**
 * In-memory client-side outbound rate-limiter and queue.
 * Ensures that API requests to Fulle using the same mutual authorization key
 * do not exceed the 40 Requests Per Minute (RPM) threshold.
 */
class OutboundRateLimiter {
  private static limiters = new Map<string, OutboundRateLimiter>();

  private lastRequestTimes: number[] = [];
  private pendingQueue: (() => Promise<void>)[] = [];
  private isProcessing = false;

  private constructor() {}

  static getLimiter(key: string): OutboundRateLimiter {
    if (!this.limiters.has(key)) {
      this.limiters.set(key, new OutboundRateLimiter());
    }
    return this.limiters.get(key)!;
  }

  async acquireToken(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.pendingQueue.push(async () => {
        resolve();
      });
      this.processQueue();
    });
  }

  private async processQueue() {
    if (this.isProcessing) return;
    this.isProcessing = true;

    while (this.pendingQueue.length > 0) {
      const now = Date.now();
      // Keep only timestamps of requests executed within the last 60 seconds
      this.lastRequestTimes = this.lastRequestTimes.filter((t) => now - t < 60000);

      // Capped at 40 requests per minute
      if (this.lastRequestTimes.length >= 40) {
        const oldestRequestTime = this.lastRequestTimes[0];
        const waitTime = 60000 - (now - oldestRequestTime) + 100; // adding 100ms safety buffer
        if (waitTime > 0) {
          await new Promise((resolve) => setTimeout(resolve, waitTime));
          continue;
        }
      }

      const nextRequest = this.pendingQueue.shift();
      if (nextRequest) {
        this.lastRequestTimes.push(Date.now());
        await nextRequest();
      }
    }

    this.isProcessing = false;
  }
}

/**
 * Perform a request to Fulle API using native fetch with outbound rate limiting
 */
async function fulleRequest(
  method: "GET" | "POST",
  path: string,
  mutualKey: string,
  queryParams?: Record<string, any>,
  body?: any
): Promise<any> {
  // Enforce client-side rate limit queue per partner mutual key
  const limiter = OutboundRateLimiter.getLimiter(mutualKey);
  await limiter.acquireToken();

  let url = `${FULLE_BASE_URL}${path}`;
  if (queryParams) {
    const searchParams = new URLSearchParams();
    for (const [key, val] of Object.entries(queryParams)) {
      if (val !== undefined && val !== null) {
        searchParams.append(key, String(val));
      }
    }
    const queryString = searchParams.toString();
    if (queryString) {
      url += `?${queryString}`;
    }
  }

  const headers: Record<string, string> = {
    "Authorization": `Mutual ${mutualKey}`,
    "Accept": "application/json",
  };

  if (body) {
    headers["Content-Type"] = "application/json";
  }

  const response = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    const errorText = await response.text();
    let parsedError;
    try {
      parsedError = JSON.parse(errorText);
    } catch {
      parsedError = errorText;
    }
    throw new Error(
      `Fulle API request failed: Status ${response.status} - ${
        typeof parsedError === "object" ? JSON.stringify(parsedError) : parsedError
      }`
    );
  }

  const contentType = response.headers.get("content-type");
  if (contentType && contentType.includes("application/json")) {
    return response.json();
  }
  return response.text();
}

export class FulleService {
  /**
   * Fetch all points of sale for a given mutual key.
   */
  static async getPointsOfSale(mutualKey: string, base64?: string): Promise<FullePOSResponse> {
    return fulleRequest("GET", "/points_of_sale", mutualKey, base64 ? { base64 } : undefined);
  }

  /**
   * Fetch booking settings/services.
   */
  static async getBookingServices(
    mutualKey: string,
    idPointOfSale: number,
    day?: number
  ): Promise<any> {
    const params: Record<string, any> = { id_point_of_sale: idPointOfSale };
    if (day !== undefined && day !== null) {
      params.day = day;
    }
    return fulleRequest("GET", "/booking_settings/services", mutualKey, params);
  }

  /**
   * Create a booking in Fulle.
   */
  static async createBooking(mutualKey: string, payload: any): Promise<any> {
    return fulleRequest("POST", "/bookings", mutualKey, undefined, payload);
  }

  /**
   * Update a booking in Fulle.
   */
  static async updateBooking(mutualKey: string, externalBookingId: number, payload: any): Promise<any> {
    return fulleRequest("POST", `/bookings/${externalBookingId}`, mutualKey, undefined, payload);
  }

  /**
   * Change booking level (e.g. status -1 for cancel).
   */
  static async updateBookingLevel(
    mutualKey: string,
    externalBookingId: number,
    idBookingLevel: number,
    comment?: string
  ): Promise<any> {
    const payload: Record<string, any> = { id_booking_level: idBookingLevel };
    if (comment !== undefined) {
      payload.comment = comment;
    }
    return fulleRequest("POST", `/bookings/level/${externalBookingId}`, mutualKey, undefined, payload);
  }

  /**
   * Fetch products.
   */
  static async getProducts(mutualKey: string, queryParams?: Record<string, any>): Promise<any> {
    return fulleRequest("GET", "/products", mutualKey, queryParams);
  }

  /**
   * Fetch product pictures gallery.
   */
  static async getProductGallery(mutualKey: string, productId: number): Promise<any> {
    return fulleRequest("GET", `/products_gallery/${productId}`, mutualKey);
  }

  /**
   * Create a client in Fulle.
   */
  static async createClient(mutualKey: string, payload: any): Promise<any> {
    return fulleRequest("POST", "/clients", mutualKey, undefined, payload);
  }

  /**
   * Search for client by email in Fulle.
   */
  static async getClientByEmail(mutualKey: string, email: string): Promise<any> {
    return fulleRequest("GET", "/clients", mutualKey, { mail: email });
  }
}
