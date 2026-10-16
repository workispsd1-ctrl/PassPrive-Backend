import https from "https";
import { createHash, timingSafeEqual } from "crypto";

export interface MiPSAuthentify {
  id_merchant: string;
  id_entity: string;
  id_operator: string;
  operator_password: string;
}

export interface MiPSOrder {
  id_order: string;
  currency: string;
  amount: number;
}

export interface MiPSIframeBehavior {
  height?: number;
  width?: number;
  custom_redirection_url?: string;
  language?: string;
}

export interface MiPSAdjustment {
  type: "LOYALTY" | "REWARD" | "CASHBACK" | string;
  original_amount: number;
  discount_amount: number;
  customer_amount: number;
  program_id?: string;
  program_name?: string;
  program_provider?: string;
  redemption_id?: string;
  points_redeemed?: number;
  funding_amount?: number;
  funding_party?: string;
  funding_provider?: string;
  funding_provider_id?: string;
}

export interface MiPSAdditionalParam {
  param_name: string;
  param_value: string | number;
}

export interface MiPSLoadPaymentZoneParams {
  orderId: string;
  currency?: string;
  totalAmount: number;
  coinsAmount?: number;
  redemptionId?: string;
  userRef?: string;
  customRedirectUrl?: string;
  language?: string;
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(`MiPS is not configured: missing ${name}`);
  }
  return value.trim();
}

export function getMiPSConfig() {
  const baseUrl = requiredEnv("MIPS_BASE_URL").replace(/\/+$/, "");
  const authUser = requiredEnv("MIPS_BASIC_USER");
  const authPass = requiredEnv("MIPS_BASIC_PASS");
  const basicAuthHeader = `Basic ${Buffer.from(`${authUser}:${authPass}`).toString("base64")}`;

  const authentify: MiPSAuthentify = {
    id_merchant: requiredEnv("MIPS_ID_MERCHANT"),
    id_entity: requiredEnv("MIPS_ID_ENTITY"),
    id_operator: requiredEnv("MIPS_ID_OPERATOR"),
    operator_password: requiredEnv("MIPS_OPERATOR_PASSWORD"),
  };

  return {
    baseUrl,
    basicAuthHeader,
    authentify,
    hashSalt: requiredEnv("MIPS_HASH_SALT"),
    cipherKey: requiredEnv("MIPS_CIPHER_KEY"),
  };
}

export function verifyMiPSChecksum(data: any, salt: string): boolean {
  const amount = data?.amount;
  const currency = data?.currency;
  const status = data?.status;
  const checksum = data?.checksum;
  if (amount == null || currency == null || status == null || typeof checksum !== "string") return false;
  const expected = createHash("sha256").update(`${amount}${currency}${status}${salt}`).digest("hex");
  const a = Buffer.from(expected.toLowerCase());
  const b = Buffer.from(checksum.trim().toLowerCase());
  return a.length === b.length && timingSafeEqual(a, b);
}

function callMiPSApi(endpoint: string, payload: any): Promise<{ statusCode: number; data: any; rawBody: string }> {
  const config = getMiPSConfig();
  const dataString = JSON.stringify(payload);
  const url = new URL(`${config.baseUrl}${endpoint}`);

  return new Promise((resolve, reject) => {
    const options: https.RequestOptions = {
      hostname: url.hostname,
      port: 443,
      path: url.pathname + url.search,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(dataString),
        Authorization: config.basicAuthHeader,
        "user-agent": "PassPrive-Backend/1.0",
      },
    };

    const req = https.request(options, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        try {
          const parsed = JSON.parse(body);
          resolve({ statusCode: res.statusCode || 200, data: parsed, rawBody: body });
        } catch {
          resolve({ statusCode: res.statusCode || 200, data: null, rawBody: body });
        }
      });
    });

    req.on("error", (err) => reject(err));
    req.write(dataString);
    req.end();
  });
}

/**
 * Initiates a MiPS payment zone with support for split payments (coins/cashback adjustment).
 */
export async function loadMiPSPaymentZone(params: MiPSLoadPaymentZoneParams) {
  const config = getMiPSConfig();
  const coinsAmount = Math.max(0, params.coinsAmount || 0);
  const totalAmount = Math.max(0, params.totalAmount);
  const customerAmount = Math.max(0, totalAmount - coinsAmount);
  const currency = params.currency || "MUR";

  const hasAdjustment = coinsAmount > 0;

  const payload: any = {
    authentify: config.authentify,
    order: {
      id_order: params.orderId,
      currency,
      amount: customerAmount,
    },
    request_mode: "simple",
    touchpoint: process.env.MIPS_TOUCHPOINT?.trim() || "web",
    iframe_behavior: {
      height: 600,
      width: 400,
      custom_redirection_url: params.customRedirectUrl || process.env.MIPS_CUSTOM_REDIRECT_URL || "",
      language: params.language || "EN",
    },
  };

  if (hasAdjustment) {
    const adjustment: MiPSAdjustment = {
      type: "LOYALTY",
      original_amount: totalAmount,
      discount_amount: coinsAmount,
      customer_amount: customerAmount,
      program_id: "PASSPRIVE_001",
      program_name: "PassPrive Coins Loyalty",
      program_provider: "PASSPRIVE",
      redemption_id: params.redemptionId || `RED_${Date.now()}`,
      points_redeemed: coinsAmount,
      funding_amount: coinsAmount,
      funding_party: "FINANCIAL_INSTITUTION",
      funding_provider: "CIM",
      funding_provider_id: "8YVHa565gceqxTV44af4VpwxjPtjnvMZ",
    };
    payload.adjustment = adjustment;
  }

  const additional_params: MiPSAdditionalParam[] = [
    { param_name: "has_adjustment", param_value: hasAdjustment ? 1 : 0 },
  ];
  if (params.userRef) {
    additional_params.push({ param_name: "customer_ref", param_value: params.userRef });
  }
  payload.additional_params = additional_params;

  const res = await callMiPSApi("/load_payment_zone", payload);
  return {
    statusCode: res.statusCode,
    ok: res.statusCode === 200 && res.data?.answer?.operation_status === "success",
    data: res.data,
    rawBody: res.rawBody,
    paymentZoneData: res.data?.answer?.payment_zone_data ?? null,
  };
}

/**
 * Decrypts MiPS Instant Merchant Notification (IMN) webhook data.
 */
export async function decryptMiPSIMN(cryptedCallback: string) {
  const config = getMiPSConfig();
  const payload = {
    authentify: config.authentify,
    salt: config.hashSalt,
    cipher_key: config.cipherKey,
    received_crypted_data: cryptedCallback,
  };

  const res = await callMiPSApi("/decrypt_imn_data", payload);
  return {
    statusCode: res.statusCode,
    ok: res.statusCode === 200,
    data: res.data,
    rawBody: res.rawBody,
  };
}
