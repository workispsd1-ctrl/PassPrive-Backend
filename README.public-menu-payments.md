# Public Menu iVeri Payment Flow

## 1) Create Session
`POST /api/public-menu/payments/create-session`

Request:
```json
{
  "restaurant_id": "9e39e8bc-31e6-4c1a-b9c7-fdc8c0e53d4b",
  "table_no": 12,
  "customer_name": "Guest",
  "customer_phone": "+230 5777 1234",
  "notes": "No onion",
  "items": [{ "item_id": "abc", "name": "Burger", "qty": 2, "unit_price": 120.0 }],
  "subtotal_amount": 240.0,
  "tax_amount": 36.0,
  "total_amount": 276.0,
  "currency_code": "MUR"
}
```

Response:
```json
{
  "ok": true,
  "payment_session_id": "...",
  "tracking_id": "PM...",
  "merchant_trace": "PP-BILL_PAYMENT-...",
  "redirect_url": "https://.../Lite/Authorise.aspx",
  "payload": {
    "method": "POST",
    "fields": {
      "Lite_Merchant_ApplicationId": "..."
    }
  }
}
```

## 2) Webhook
`POST /api/public-menu/payments/webhook`

- Verifies HMAC signature using `IVERI_WEBHOOK_SECRET`.
- Signature header defaults to `x-iveri-signature` (override via `IVERI_WEBHOOK_SIGNATURE_HEADER`).
- Returns `{ "ok": true }` for valid duplicate callbacks.

## 3) Finalize
`POST /api/public-menu/payments/finalize`

Request:
```json
{
  "payment_session_id": "..."
}
```

Or:
```json
{
  "tracking_id": "PMABCDE12"
}
```

Response:
```json
{
  "ok": true,
  "status": "FINALIZED",
  "payment_session_id": "...",
  "tracking_id": "PM...",
  "table_booking_id": "..."
}
```
