import { postForm } from "./iveriService";
import { getPaymentSessionById, updatePaymentSession } from "./paymentSessionService";

function decodeHtml(value: string) {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function extractKeyValuePayload(body: string) {
  const fields: Record<string, string> = {};

  if (!body) return fields;

  const queryParams = new URLSearchParams(body);
  for (const [key, value] of queryParams.entries()) {
    fields[key] = value;
  }

  const inputRegex = /name=["']([^"']+)["'][^>]*value=["']([^"']*)["']/gi;
  for (const match of body.matchAll(inputRegex)) {
    fields[match[1]] = decodeHtml(match[2]);
  }

  const textRegex = /(Lite_[A-Za-z0-9_]+|MerchantReference|Ecom_[A-Za-z0-9_]+)\s*[:=]\s*([^\r\n<]+)/g;
  for (const match of body.matchAll(textRegex)) {
    fields[match[1]] = decodeHtml(match[2].trim());
  }

  return fields;
}

function normalizeStatus(fields: Record<string, string>) {
  const cardStatus = String(fields.Lite_Payment_Card_Status ?? "").trim().toLowerCase();
  const resultDescription = String(fields.Lite_Result_Description ?? "").trim().toLowerCase();
  const joined = `${cardStatus} ${resultDescription}`;

  if (
    ["successful", "success", "approved", "authorised", "authorized", "paid", "captured"].some((term) =>
      joined.includes(term)
    )
  ) {
    return "VERIFIED_SUCCESS";
  }

  if (
    ["failed", "fail", "declined", "cancelled", "canceled", "error", "invalid"].some((term) =>
      joined.includes(term)
    )
  ) {
    return "VERIFIED_FAILED";
  }

  return "RETURNED";
}

export async function verifyPaymentSessionWithIveri(params: {
  sessionId: string;
  applicationId: string;
  authoriseInfoUrl: string;
}) {
  const session = await getPaymentSessionById(params.sessionId);
  if (!session) {
    throw new Error("Payment session not found");
  }

  const response = await postForm(params.authoriseInfoUrl, {
    Lite_Merchant_ApplicationId: params.applicationId,
    Lite_Merchant_Trace: session.merchant_trace,
  });

  const fields = extractKeyValuePayload(response.body);
  const verificationStatus = normalizeStatus(fields);
  const updated = await updatePaymentSession(params.sessionId, {
    status: verificationStatus,
    gateway_status: fields.Lite_Payment_Card_Status ?? null,
    gateway_result_code: fields.Lite_Payment_Card_Status ?? null,
    gateway_result_description: fields.Lite_Result_Description ?? null,
    transaction_index: fields.Lite_TransactionIndex ?? null,
    authorization_code: fields.Lite_Order_AuthorisationCode ?? null,
    bank_reference: fields.Lite_BankReference ?? null,
    verified_at: new Date().toISOString(),
    gateway_payload: {
      ...(session.gateway_payload ?? {}),
      authorise_info_request: {
        Lite_Merchant_ApplicationId: params.applicationId,
        Lite_Merchant_Trace: session.merchant_trace,
      },
      authorise_info_response: {
        status_code: response.statusCode,
        fields,
      },
    },
  });

  return {
    session: updated,
    verification: {
      verified: verificationStatus === "VERIFIED_SUCCESS",
      status: verificationStatus,
      fields,
      rawStatusCode: response.statusCode,
    },
  };
}
