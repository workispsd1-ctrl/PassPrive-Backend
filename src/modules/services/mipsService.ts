import https from "https";

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

export function getMiPSConfig() {
  const baseUrl = (process.env.MIPS_BASE_URL || "https://my-warzone-assemble.mips.global/api").replace(/\/+$/, "");
  const authUser = process.env.MIPS_BASIC_USER || "the_merchant";
  const authPass = process.env.MIPS_BASIC_PASS || "jug8D5dRa4";
  const basicAuthHeader = `Basic ${Buffer.from(`${authUser}:${authPass}`).toString("base64")}`;

  const authentify: MiPSAuthentify = {
    id_merchant: process.env.MIPS_ID_MERCHANT || "X1iEfM7l85ewoMEPhzQvspHtFGNxd1WY",
    id_entity: process.env.MIPS_ID_ENTITY || "fWdcK0mLrWXQYBoC48p2Yq25Fte15gXT",
    id_operator: process.env.MIPS_ID_OPERATOR || "f5pGZdzeabaipA8UYpKHx9YG40J3fcst",
    operator_password:
      process.env.MIPS_OPERATOR_PASSWORD ||
      "4Kx0B0cZAMXSgAeo16bDfmNu4OvbDKosR5Y3tx3zNDXoqA5ORHVVrvd5PApEozKGJRgZkf2kSUZc0MKhw28ew1mGNk3jp9pkvaAEUWfqsrEAd0O9oATxtqMCFnfsaf9zkdGTUTI2XMHksJ8X4LofShAhI8kaxHXzdCG68PxL1dKU4NUJZwL4srQm5GiYo73lk6vn8ooHcefP1BFrKfnP83HV2fNswdUsihICk3vOgf1WZFqk2KhgszEO0jIKbUEb",
  };

  const hashSalt = process.env.MIPS_HASH_SALT || "yzDJRwmBNCgPVEpwM3BJgTJwCT3o6rnEKQCBQJWmYTkh0xmjNP";
  const cipherKey =
    process.env.MIPS_CIPHER_KEY ||
    "Fzmjo9TWHVk4hbOALdJUUtc8662q593XO8MIimaykKv0udmAPLD42GUAI9Ze0RmshbKw1cDFO9Ft8UyNnUn21UtOOhQ60iyXwutB";

  return {
    baseUrl,
    authUser,
    authPass,
    basicAuthHeader,
    authentify,
    hashSalt,
    cipherKey,
  };
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
    touchpoint: "web",
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
