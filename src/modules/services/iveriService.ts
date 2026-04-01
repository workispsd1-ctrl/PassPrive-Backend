import { randomUUID } from "crypto";
import https from "https";
import { URL } from "url";

export interface IveriConfig {
  mode: "TEST" | "LIVE";
  applicationId: string;
  authoriseUrl: string;
  authoriseInfoUrl: string;
  returnSuccessUrl: string;
  returnFailUrl: string;
  returnTryLaterUrl: string;
  returnErrorUrl: string;
}

export function getIveriConfig(): IveriConfig {
  const mode = String(process.env.IVERI_MODE ?? "TEST").trim().toUpperCase() === "LIVE" ? "LIVE" : "TEST";
  const applicationId =
    mode === "LIVE" ? process.env.IVERI_APPLICATION_ID_LIVE : process.env.IVERI_APPLICATION_ID_TEST;

  if (!applicationId) {
    throw new Error(`Missing iVeri application id for ${mode} mode`);
  }

  const configuredBaseUrl = process.env.IVERI_GATEWAY_BASE_URL?.trim().replace(/\/+$/, "") ?? "";
  const allowNonCimForMur =
    String(process.env.IVERI_ALLOW_NON_CIM_FOR_MUR ?? "false").trim().toLowerCase() === "true";

  const normalizedBaseUrl = (() => {
    if (!configuredBaseUrl) return "";
    try {
      const host = new URL(configuredBaseUrl).host.toLowerCase();
      if (!allowNonCimForMur && mode === "TEST" && host === "portal.host.iveri.com") {
        return "https://portal.merchant.cim.mu";
      }
    } catch {
      return configuredBaseUrl;
    }
    return configuredBaseUrl;
  })();

  return {
    mode,
    applicationId,
    authoriseUrl:
      process.env.IVERI_AUTHORISE_URL?.trim() ||
      (normalizedBaseUrl
        ? `${normalizedBaseUrl}/Lite/Authorise.aspx`
        : "https://portal.merchant.cim.mu/Lite/Authorise.aspx"),
    authoriseInfoUrl:
      process.env.IVERI_AUTHORISE_INFO_URL?.trim() ||
      (normalizedBaseUrl
        ? `${normalizedBaseUrl}/Lite/AuthoriseInfo.aspx`
        : "https://portal.merchant.cim.mu/Lite/AuthoriseInfo.aspx"),
    returnSuccessUrl: requireEnv("IVERI_RETURN_SUCCESS_URL"),
    returnFailUrl: requireEnv("IVERI_RETURN_FAIL_URL"),
    returnTryLaterUrl: requireEnv("IVERI_RETURN_TRY_LATER_URL"),
    returnErrorUrl: requireEnv("IVERI_RETURN_ERROR_URL"),
  };
}

function requireEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function majorToMinor(amountMajor: number) {
  return Math.round(amountMajor * 100);
}

function withQuery(urlString: string, params: Record<string, string>) {
  const url = new URL(urlString);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

export function generateMerchantTrace(context: string) {
  const compactUuid = randomUUID().replace(/-/g, "").slice(0, 20).toUpperCase();
  return `PP-${context}-${Date.now()}-${compactUuid}`.slice(0, 64);
}

export function buildIveriAuthoriseRequest(params: {
  config: IveriConfig;
  sessionId: string;
  merchantTrace: string;
  amountMajor: number;
  discountMajor?: number;
  currencyCode: string;
  merchantReference: string;
  customer: {
    email: string;
    firstName?: string | null;
    lastName?: string | null;
    phone?: string | null;
  };
  context: "BOOKING" | "BILL_PAYMENT";
  lineItems?: Array<{
    description: string;
    quantity: number;
    unitAmountMajor: number;
  }>;
  additionalFields?: Record<string, string>;
}) {
  const amountMinor = majorToMinor(params.amountMajor);
  const consumerOrderId = params.merchantTrace.replace(/[^A-Za-z0-9]/g, "").slice(0, 20) || params.sessionId.replace(/-/g, "").slice(0, 20);
  const fields: Record<string, string> = {
    Lite_Merchant_ApplicationId: params.config.applicationId,
    Lite_Order_Amount: String(amountMinor),
    Lite_Currency_AlphaCode: params.currencyCode,
    Lite_Merchant_Trace: params.merchantTrace,
    MerchantReference: params.merchantReference.slice(0, 20),
    Ecom_ConsumerOrderID: consumerOrderId,
    Lite_ConsumerOrderID_Prefix: consumerOrderId.slice(0, 8) || "PASSPRIV",
    Lite_ConsumerOrderIDPrefix: consumerOrderId.slice(0, 8) || "PASSPRIV",
    Lite_Version: "4.0",
    Ecom_BillTo_Online_Email: params.customer.email,
    Lite_Website_Successful_Url: withQuery(params.config.returnSuccessUrl, {
      session_id: params.sessionId,
      outcome: "success",
    }),
    Lite_Website_Success_Url: withQuery(params.config.returnSuccessUrl, {
      session_id: params.sessionId,
      outcome: "success",
    }),
    Lite_Website_Fail_Url: withQuery(params.config.returnFailUrl, {
      session_id: params.sessionId,
      outcome: "fail",
    }),
    Lite_Website_TryLater_Url: withQuery(params.config.returnTryLaterUrl, {
      session_id: params.sessionId,
      outcome: "pending",
    }),
    Lite_Website_Error_Url: withQuery(params.config.returnErrorUrl, {
      session_id: params.sessionId,
      outcome: "error",
    }),
  };

  const lineItems = (params.lineItems ?? []).filter(
    (item) =>
      item &&
      typeof item.description === "string" &&
      item.description.trim().length > 0 &&
      Number.isFinite(item.quantity) &&
      item.quantity > 0 &&
      Number.isFinite(item.unitAmountMajor) &&
      item.unitAmountMajor >= 0
  );

  for (let index = 0; index < lineItems.length; index += 1) {
    const item = lineItems[index];
    const position = String(index + 1);
    fields[`Lite_Order_LineItems_Product_${position}`] = item.description.slice(0, 255);
    fields[`Lite_Order_LineItems_Quantity_${position}`] = String(item.quantity);
    fields[`Lite_Order_LineItems_Amount_${position}`] = String(majorToMinor(item.unitAmountMajor));
  }

  if (params.discountMajor && params.discountMajor > 0) {
    fields.Lite_Order_DiscountAmount = String(majorToMinor(params.discountMajor));
  }

  for (const [key, value] of Object.entries(params.additionalFields ?? {})) {
    if (value !== undefined && value !== null) {
      fields[key] = String(value);
    }
  }

  return {
    gatewayUrl: params.config.authoriseUrl,
    amountMinor,
    fields,
  };
}

export async function postForm(urlString: string, formFields: Record<string, string>) {
  const url = new URL(urlString);
  const body = new URLSearchParams(formFields).toString();

  return new Promise<{ statusCode: number; headers: Record<string, string | string[] | undefined>; body: string }>(
    (resolve, reject) => {
      const request = https.request(
        {
          method: "POST",
          protocol: url.protocol,
          hostname: url.hostname,
          port: url.port || undefined,
          path: `${url.pathname}${url.search}`,
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "Content-Length": Buffer.byteLength(body),
          },
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
          response.on("end", () => {
            resolve({
              statusCode: response.statusCode ?? 0,
              headers: response.headers,
              body: Buffer.concat(chunks).toString("utf8"),
            });
          });
        }
      );

      request.on("error", reject);
      request.write(body);
      request.end();
    }
  );
}
