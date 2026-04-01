export interface NormalizedIveriPayload {
  raw: Record<string, any>;
  normalized: Record<string, any>;
  canonical: Record<string, any>;
}

function canonicalizeKey(value: string) {
  return value.trim().replace(/[^a-z0-9]/gi, "").toUpperCase();
}

function pickFirstPresent(payload: Record<string, any>, candidates: string[]) {
  for (const candidate of candidates) {
    const value = payload[candidate];
    if (value !== undefined && value !== null && String(value).trim() !== "") {
      return String(value).trim();
    }
  }
  return null;
}

export function normalizeIveriPayload(payload: Record<string, any>): NormalizedIveriPayload {
  const normalized: Record<string, any> = {};
  for (const [key, value] of Object.entries(payload ?? {})) {
    if (value === undefined) continue;
    normalized[canonicalizeKey(key)] = value;
  }

  const canonical: Record<string, any> = {
    session_id: pickFirstPresent(normalized, ["SESSIONID", "PASSPRIVESESSIONID"]),
    merchant_trace: pickFirstPresent(normalized, ["LITEMERCHANTTRACE", "PASSPRIVETRACEGUARD"]),
    merchant_reference: pickFirstPresent(normalized, ["MERCHANTREFERENCE"]),
    merchant_application_id: pickFirstPresent(normalized, ["LITEMERCHANTAPPLICATIONID"]),
    amount_minor: pickFirstPresent(normalized, ["LITEORDERAMOUNT"]),
    currency_code: pickFirstPresent(normalized, ["LITECURRENCYALPHACODE"]),
    card_status: pickFirstPresent(normalized, ["LITEPAYMENTCARDSTATUS"]),
    result_description: pickFirstPresent(normalized, ["LITERESULTDESCRIPTION"]),
    transaction_index: pickFirstPresent(normalized, ["LITETRANSACTIONINDEX"]),
    authorisation_code: pickFirstPresent(normalized, ["LITEORDERAUTHORISATIONCODE"]),
    bank_reference: pickFirstPresent(normalized, ["LITEBANKREFERENCE"]),
    trace_guard: pickFirstPresent(normalized, ["PASSPRIVETRACEGUARD"]),
    payment_context: pickFirstPresent(normalized, ["PASSPRIVEPAYMENTCONTEXT"]),
    outcome_hint: pickFirstPresent(normalized, ["OUTCOME"]),
  };

  return {
    raw: payload,
    normalized,
    canonical,
  };
}

function normalizeText(value: string | null | undefined) {
  return String(value ?? "").trim().toLowerCase();
}

export function deriveIveriOutcome(payload: NormalizedIveriPayload) {
  const code = normalizeText(payload.canonical.card_status);
  const description = normalizeText(payload.canonical.result_description);
  const hint = normalizeText(payload.canonical.outcome_hint);
  const joined = `${code} ${description} ${hint}`;

  if (code === "0") return "success";

  if (["3", "4", "5", "14", "255"].includes(code)) return "fail";
  if (["9"].includes(code)) return "pending";

  if (["success", "successful", "approved", "authorised", "authorized", "paid", "captured"].some((term) => joined.includes(term))) {
    return "success";
  }

  if (["fail", "failed", "declined", "cancelled", "canceled", "error", "invalid", "denied", "unable", "hot card", "hotcard"].some((term) => joined.includes(term))) {
    return "fail";
  }

  if (["later", "pending", "timeout", "processing", "in progress"].some((term) => joined.includes(term))) {
    return "pending";
  }

  return "pending";
}

export function inferStatusFromOutcome(outcome: string): "VERIFIED_SUCCESS" | "VERIFIED_FAILED" | "RETURNED" {
  if (outcome === "success") return "VERIFIED_SUCCESS";
  if (outcome === "fail") return "VERIFIED_FAILED";
  return "RETURNED";
}

export function buildIveriIntegrityChecks(params: {
  session: any;
  payload: NormalizedIveriPayload;
}) {
  const mismatches: string[] = [];
  const payloadSessionId = params.payload.canonical.session_id;
  if (payloadSessionId && payloadSessionId !== params.session.id) {
    mismatches.push("session_id mismatch");
  }

  const payloadTrace = params.payload.canonical.merchant_trace;
  if (payloadTrace && payloadTrace !== params.session.merchant_trace) {
    mismatches.push("merchant_trace mismatch");
  }

  const payloadTraceGuard = params.payload.canonical.trace_guard;
  if (payloadTraceGuard && payloadTraceGuard !== params.session.merchant_trace) {
    mismatches.push("trace_guard mismatch");
  }

  const payloadAmountMinor = Number(params.payload.canonical.amount_minor ?? NaN);
  if (Number.isFinite(payloadAmountMinor) && payloadAmountMinor !== Number(params.session.amount_minor)) {
    mismatches.push("amount mismatch");
  }

  const payloadCurrency = String(params.payload.canonical.currency_code ?? "").trim().toUpperCase();
  if (payloadCurrency && payloadCurrency !== String(params.session.currency_code ?? "").trim().toUpperCase()) {
    mismatches.push("currency mismatch");
  }

  const payloadApplicationId = String(params.payload.canonical.merchant_application_id ?? "").trim();
  if (payloadApplicationId && payloadApplicationId !== String(params.session.merchant_application_id ?? "").trim()) {
    mismatches.push("merchant application id mismatch");
  }

  return {
    ok: mismatches.length === 0,
    mismatches,
  };
}
