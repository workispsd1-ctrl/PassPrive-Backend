import { postForm } from "./iveriService";
import { getPaymentSessionById, updatePaymentSession } from "./paymentSessionService";
import {
  buildIveriIntegrityChecks,
  deriveIveriOutcome,
  inferStatusFromOutcome,
  normalizeIveriPayload,
} from "./iveriPayloadService";

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
    Lite_Merchant_ApplicationID: params.applicationId,
    Lite_Merchant_ApplicationId: params.applicationId,
    Lite_Merchant_Trace: session.merchant_trace,
  });

  const fields = extractKeyValuePayload(response.body);
  const normalizedPayload = normalizeIveriPayload(fields);
  const inferredOutcome = deriveIveriOutcome(normalizedPayload);
  let verificationStatus = inferStatusFromOutcome(inferredOutcome);
  const integrity = buildIveriIntegrityChecks({
    session,
    payload: normalizedPayload,
  });

  if (!integrity.ok && verificationStatus === "VERIFIED_SUCCESS") {
    verificationStatus = "VERIFIED_FAILED";
  }

  const gatewayStatus = normalizedPayload.canonical.card_status;
  const gatewayDescription = normalizedPayload.canonical.result_description;
  const transactionIndex = normalizedPayload.canonical.transaction_index;
  const authorizationCode = normalizedPayload.canonical.authorisation_code;
  const bankReference = normalizedPayload.canonical.bank_reference;

  const updated = await updatePaymentSession(params.sessionId, {
    status: verificationStatus,
    gateway_status: gatewayStatus ?? null,
    gateway_result_code: gatewayStatus ?? null,
    gateway_result_description: gatewayDescription ?? null,
    transaction_index: transactionIndex ?? null,
    authorization_code: authorizationCode ?? null,
    bank_reference: bankReference ?? null,
    verified_at: new Date().toISOString(),
    gateway_payload: {
      ...(session.gateway_payload ?? {}),
      authorise_info_request: {
        Lite_Merchant_ApplicationID: params.applicationId,
        Lite_Merchant_Trace: session.merchant_trace,
      },
      authorise_info_response: {
        status_code: response.statusCode,
        inferred_outcome: inferredOutcome,
        integrity,
        canonical_fields: normalizedPayload.canonical,
        fields,
      },
    },
  });

  return {
    session: updated,
    verification: {
      verified: verificationStatus === "VERIFIED_SUCCESS" && integrity.ok,
      status: verificationStatus,
      inferredOutcome,
      integrity,
      fields,
      rawStatusCode: response.statusCode,
    },
  };
}
