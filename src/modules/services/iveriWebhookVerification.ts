import { canonicalizeForSignature, hmacHex } from "./publicMenuPaymentUtils";

function normalizeHex(input: string | null | undefined) {
  return String(input ?? "").trim().toLowerCase();
}

function getSignatureFromPayload(payload: Record<string, any>) {
  const keys = ["signature", "Signature", "hash", "Hash", "HASH", "Lite_Signature"];
  for (const key of keys) {
    const value = payload[key];
    if (value !== undefined && value !== null && String(value).trim() !== "") {
      return String(value).trim();
    }
  }
  return null;
}

function stripSignatureFields(payload: Record<string, any>) {
  const clone = { ...payload };
  delete clone.signature;
  delete clone.Signature;
  delete clone.hash;
  delete clone.Hash;
  delete clone.HASH;
  delete clone.Lite_Signature;
  return clone;
}

export function verifyIveriWebhookSignature(params: {
  payload: Record<string, any>;
  headers: Record<string, any>;
}) {
  const secret = process.env.IVERI_WEBHOOK_SECRET?.trim();
  if (!secret) {
    throw new Error("Missing IVERI_WEBHOOK_SECRET");
  }

  const headerName = (process.env.IVERI_WEBHOOK_SIGNATURE_HEADER?.trim() || "x-iveri-signature").toLowerCase();
  const algorithm = String(process.env.IVERI_WEBHOOK_SIGNATURE_ALGO ?? "sha256").trim().toLowerCase() === "sha512"
    ? "sha512"
    : "sha256";

  const headerSignature = Object.entries(params.headers ?? {}).find(
    ([key]) => String(key).toLowerCase() === headerName
  )?.[1];

  const received =
    (Array.isArray(headerSignature) ? String(headerSignature[0] ?? "") : String(headerSignature ?? "")).trim() ||
    getSignatureFromPayload(params.payload);

  if (!received) {
    return { ok: false, reason: "SIGNATURE_MISSING", expected: null, received: null };
  }

  const canonicalBody = canonicalizeForSignature(stripSignatureFields(params.payload));
  const expected = hmacHex(canonicalBody, secret, algorithm);

  const ok = normalizeHex(received) === normalizeHex(expected);
  return {
    ok,
    reason: ok ? null : "SIGNATURE_MISMATCH",
    expected,
    received,
    algorithm,
  };
}
