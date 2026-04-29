import { createHmac, randomUUID } from "crypto";

export const PUBLIC_PAYMENT_PROVIDER = "IVERI";
export const PUBLIC_PAYMENT_CONTEXT = "BILL_PAYMENT";
export const MONEY_TOLERANCE = 0.02;

export type PublicMenuItem = {
  item_id: string;
  name: string;
  qty: number;
  unit_price: number;
};

export function toMinor(amountMajor: number) {
  return Math.round(amountMajor * 100);
}

export function roundMoney(value: number) {
  return Number(value.toFixed(2));
}

export function computeItemsSubtotal(items: PublicMenuItem[]) {
  const subtotal = items.reduce((acc, item) => acc + roundMoney(item.qty * item.unit_price), 0);
  return roundMoney(subtotal);
}

export function hasMoneyMismatch(a: number, b: number, tolerance = MONEY_TOLERANCE) {
  return Math.abs(roundMoney(a) - roundMoney(b)) > tolerance;
}

export function generatePublicMerchantTrace() {
  const compact = randomUUID().replace(/-/g, "").slice(0, 20).toUpperCase();
  return `PP-PUBLIC-BILL-${Date.now()}-${compact}`.slice(0, 64);
}

export function generatePublicTrackingId() {
  // payment_sessions.tracking_id is varchar(8), so keep total length exactly 8.
  const compact = randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase();
  return `PM${compact}`;
}

export function sanitizeOrderSnapshot(input: {
  table_no: number;
  customer_name: string;
  customer_phone?: string | null;
  notes?: string | null;
  items: PublicMenuItem[];
  subtotal_amount: number;
  tax_amount: number;
  total_amount: number;
  currency_code: string;
}) {
  return {
    table_no: input.table_no,
    customer_name: String(input.customer_name).trim().slice(0, 120),
    customer_phone: input.customer_phone ? String(input.customer_phone).trim().slice(0, 30) : null,
    notes: input.notes ? String(input.notes).trim().slice(0, 1000) : null,
    items: input.items.map((item) => ({
      item_id: item.item_id,
      name: String(item.name).trim().slice(0, 255),
      qty: item.qty,
      unit_price: roundMoney(item.unit_price),
      line_total: roundMoney(item.qty * item.unit_price),
    })),
    subtotal_amount: roundMoney(input.subtotal_amount),
    tax_amount: roundMoney(input.tax_amount),
    total_amount: roundMoney(input.total_amount),
    currency_code: String(input.currency_code).trim().toUpperCase().slice(0, 3),
  };
}

export function canonicalizeForSignature(payload: Record<string, any>) {
  const flattened: Array<[string, string]> = [];
  const walk = (prefix: string, value: any) => {
    if (value === null || value === undefined) return;
    if (Array.isArray(value)) {
      value.forEach((entry, index) => walk(`${prefix}[${index}]`, entry));
      return;
    }
    if (typeof value === "object") {
      const keys = Object.keys(value).sort();
      keys.forEach((key) => walk(prefix ? `${prefix}.${key}` : key, value[key]));
      return;
    }
    flattened.push([prefix, String(value)]);
  };

  walk("", payload);

  return flattened
    .filter(([key]) => key !== "")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
}

export function hmacHex(value: string, secret: string, algorithm: "sha256" | "sha512" = "sha256") {
  return createHmac(algorithm, secret).update(value, "utf8").digest("hex");
}
