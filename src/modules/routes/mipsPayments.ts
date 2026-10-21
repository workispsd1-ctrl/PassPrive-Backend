import { Router } from "express";
import { z } from "zod";
import { randomUUID } from "crypto";
import supabase from "../../database/supabase";
import { requireAuth } from "../services/authService";
import { validateCashbackSpend, earnTransactionCashback } from "../services/cashbackService";
import { createPaymentSession, getPaymentSessionById, updatePaymentSession, updatePaymentSessionIfStatusIn } from "../services/paymentSessionService";
import { decryptMiPSIMN, getMiPSConfig, loadMiPSPaymentZone, verifyMiPSChecksum } from "../services/mipsService";

const router = Router();

const MiPSInitiateSchema = z.object({
  payment_context: z.literal("BILL_PAYMENT"),
  restaurant_id: z.string().uuid().optional(),
  store_id: z.string().uuid().optional(),
  total_amount: z.coerce.number().positive(),
  coins_amount: z.coerce.number().nonnegative().default(0),
  currency: z.string().trim().default("MUR"),
  custom_redirect_url: z.string().trim().optional(),
  bill_id: z.string().uuid().optional(),
  order_items: z
    .array(z.object({ id: z.string().min(1).max(100), qty: z.coerce.number().int().min(1).max(50) }))
    .min(1)
    .max(50)
    .optional(),
});

const roundMoney = (value: number) => Math.round(value * 100) / 100;

const clip = (value: unknown, max = 600) => {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? null);
  return text && text.length > max ? `${text.slice(0, max)}…` : text;
};

async function priceOrderItems(restaurantId: string, requested: { id: string; qty: number }[]) {
  const { data, error } = await supabase
    .from("restaurants")
    .select("order_collect_enabled, menu_json")
    .eq("id", restaurantId)
    .maybeSingle();
  if (error) throw error;
  if (!data?.order_collect_enabled) return null;
  const menu = new Map<string, { name: string; price: number }>();
  for (const section of Array.isArray(data.menu_json?.sections) ? data.menu_json.sections : []) {
    for (const item of Array.isArray(section?.items) ? section.items : []) {
      const price = Number(item?.price);
      if (item?.id != null && item.is_available !== false && price > 0) {
        menu.set(String(item.id), { name: String(item.name || "").trim(), price });
      }
    }
  }
  const items = [];
  for (const line of requested) {
    const found = menu.get(line.id);
    if (!found) return null;
    items.push({ id: line.id, name: found.name, price: found.price, qty: line.qty });
  }
  const subtotal = roundMoney(items.reduce((sum, it) => sum + it.price * it.qty, 0));
  return { items, subtotal };
}

async function createPaidOrder(session: any) {
  const order = session.gateway_payload?.order_payload;
  if (!order || !session.restaurant_id) return;
  const { data: existing } = await supabase
    .from("restaurant_orders")
    .select("id")
    .eq("metadata->>payment_session_id", session.id)
    .maybeSingle();
  if (existing) return;
  const { data: customer } = await supabase
    .from("users")
    .select("full_name, phone")
    .eq("id", session.user_id)
    .maybeSingle();
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const { error } = await supabase.from("restaurant_orders").insert({
    restaurant_id: session.restaurant_id,
    order_number: `PP-${day}-${randomUUID().slice(0, 6).toUpperCase()}`,
    customer_name: customer?.full_name || "PassPrivé customer",
    customer_phone: customer?.phone || null,
    items: order.items,
    subtotal: order.subtotal,
    total_amount: Number(session.original_amount ?? order.subtotal),
    discount_amount: Number(session.discount_amount ?? 0),
    payment_method: "ONLINE",
    payment_status: "PAID",
    order_status: "NEW",
    pickup_code: String(Math.floor(1000 + Math.random() * 9000)),
    metadata: { payment_session_id: session.id, source: "order_collect", user_id: session.user_id },
  });
  if (error) throw error;
}

const MiPSClientEventSchema = z.object({
  session_id: z.string().uuid(),
  event: z.string().trim().min(1).max(60),
  detail: z.any().optional(),
});

router.post("/initiate", async (req, res) => {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const parsed = MiPSInitiateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ ok: false, error: "Invalid payload", details: parsed.error.flatten() });
  }

  const { payment_context, restaurant_id, store_id, total_amount, currency, custom_redirect_url, bill_id, order_items } = parsed.data;

  if (!!restaurant_id === !!store_id) {
    return res.status(400).json({ ok: false, error: "Provide exactly one of restaurant_id or store_id" });
  }

  try {
    const { data: merchant, error: merchantError } = await supabase
      .from(restaurant_id ? "restaurants" : "stores")
      .select("id, owner_user_id")
      .eq("id", (restaurant_id || store_id) as string)
      .maybeSingle();
    if (merchantError) throw merchantError;
    if (!merchant) {
      return res.status(404).json({ ok: false, error: "Merchant not found" });
    }

    const totalAmount = roundMoney(total_amount);
    let orderPayload: { items: any[]; subtotal: number } | null = null;
    if (order_items) {
      if (!restaurant_id) {
        return res.status(400).json({ ok: false, error: "ORDER_NOT_SUPPORTED", message: "Orders are only available for restaurants" });
      }
      orderPayload = await priceOrderItems(restaurant_id, order_items);
      if (!orderPayload) {
        return res.status(400).json({ ok: false, error: "ORDER_ITEMS_INVALID", message: "Some items are no longer available. Please refresh the menu." });
      }
      if (orderPayload.subtotal !== totalAmount) {
        return res.status(400).json({ ok: false, error: "ORDER_TOTAL_MISMATCH", message: "Menu prices have changed. Please review your order." });
      }
    }
    let coinsAmount = roundMoney(parsed.data.coins_amount);
    if (coinsAmount > 0) {
      const merchantUserId = merchant.owner_user_id as string | null;
      if (!merchantUserId) {
        return res.status(400).json({ ok: false, error: "WALLET_NOT_SUPPORTED", message: "Privé Credits are not supported for this merchant yet" });
      }
      coinsAmount = Math.min(coinsAmount, roundMoney(Math.max(0, totalAmount - 1)));
      if (coinsAmount > 0) {
        const validation = await validateCashbackSpend(auth.user.id, coinsAmount, merchantUserId, totalAmount);
        if (!validation.valid) {
          return res.status(400).json({
            ok: false,
            error: "COIN_SPEND_INVALID",
            message: validation.error || "Requested coin amount cannot be applied to this purchase",
          });
        }
      }
    }

    const customerAmount = roundMoney(Math.max(0, totalAmount - coinsAmount));
    const merchantTrace = `PP_MIPS_${Date.now()}_${randomUUID().slice(0, 8)}`;
    const redemptionId = coinsAmount > 0 ? `RED_${Date.now()}_${randomUUID().slice(0, 6)}` : undefined;
    const config = getMiPSConfig();

    const session = await createPaymentSession({
      user_id: auth.user.id,
      payment_provider: "MIPS",
      payment_context,
      restaurant_id: restaurant_id ?? null,
      store_id: store_id ?? null,
      merchant_trace: merchantTrace,
      merchant_application_id: config.authentify.id_merchant,
      amount_major: customerAmount,
      amount_minor: Math.round(customerAmount * 100),
      currency_code: currency,
      original_amount: totalAmount,
      discount_amount: coinsAmount,
      cashback_amount: coinsAmount,
      status: "CREATED",
      gateway_payload: {
        payment_gateway: "MIPS",
        mips_redemption_id: redemptionId,
        coins_redeemed: coinsAmount,
        bill_id,
        ...(orderPayload ? { order_payload: orderPayload } : {}),
        ...(coinsAmount > 0
          ? {
              context_payload: {
                wallet_spend: {
                  amount: coinsAmount,
                  merchant_user_id: merchant.owner_user_id,
                  bill_amount: totalAmount,
                },
              },
            }
          : {}),
      },
    });

    console.log("[mips:initiate] session", session.id, {
      user: auth.user.id,
      merchant: restaurant_id || store_id,
      total: totalAmount,
      coins: coinsAmount,
      customer: customerAmount,
      redirect: custom_redirect_url || null,
    });

    const mipsResponse = await loadMiPSPaymentZone({
      orderId: session.id,
      currency,
      totalAmount,
      coinsAmount,
      redemptionId,
      userRef: auth.user.id,
      customRedirectUrl: custom_redirect_url,
    });

    if (!mipsResponse.ok || !mipsResponse.paymentZoneData) {
      console.error("[mips:initiate] load_payment_zone failed", session.id, mipsResponse.statusCode, clip(mipsResponse.rawBody));
      await updatePaymentSession(session.id, {
        status: "VERIFIED_FAILED",
        gateway_result_description: "Failed to initialize MiPS payment zone",
      });
      return res.status(502).json({
        ok: false,
        error: "MIPS_INIT_FAILED",
        message: "Failed to initialize MiPS payment zone",
      });
    }

    console.log("[mips:initiate] zone ready", session.id, mipsResponse.statusCode);
    await updatePaymentSession(session.id, {
      status: "PENDING",
      gateway_payload: {
        ...(session.gateway_payload ?? {}),
        mips_init_response: mipsResponse.data,
      },
    });

    return res.status(200).json({
      ok: true,
      session_id: session.id,
      merchant_trace: merchantTrace,
      total_amount: totalAmount,
      coins_amount: coinsAmount,
      customer_payable_amount: customerAmount,
      currency,
      payment_zone_html: mipsResponse.paymentZoneData,
    });
  } catch (err: any) {
    console.error("[mipsPayments] Initiate error:", err);
    const walletError = err?.hint === "WALLET_SPEND_INVALID" || err?.code === "P0001";
    return res.status(walletError ? 400 : 500).json({
      ok: false,
      error: walletError ? "COIN_SPEND_INVALID" : "INTERNAL_ERROR",
      message: walletError ? err?.message : "Could not start the payment. Please try again.",
    });
  }
});

function amountMatches(reported: unknown, session: any): boolean {
  const value = Number(reported);
  if (!Number.isFinite(value)) return false;
  const minor = Number(session.amount_minor ?? Math.round(Number(session.amount_major) * 100));
  const major = Number(session.amount_major);
  return Math.round(value) === minor || Math.abs(value - major) < 0.005;
}

const RETURN_PAGE = `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>PassPriv\u00e9</title><style>body{margin:0;display:flex;align-items:center;justify-content:center;min-height:100vh;font-family:-apple-system,Roboto,sans-serif;background:#fff;color:#1C1007;text-align:center}p{margin:0 24px;font-size:16px}</style></head><body><p>Payment received. Returning to the app\u2026</p><script>try{var m={type:"PP_RETURN",url:location.href};if(window.ReactNativeWebView)window.ReactNativeWebView.postMessage(JSON.stringify(m));if(window.parent&&window.parent!==window)window.parent.postMessage(m,"*");}catch(e){}</script></body></html>`;

router.all("/return", (_req, res) => {
  res.set("Cache-Control", "no-store");
  res.type("html").send(RETURN_PAGE);
});

router.post("/client-event", async (req, res) => {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const parsed = MiPSClientEventSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ ok: false });
  const { session_id, event, detail } = parsed.data;
  try {
    const session = await getPaymentSessionById(session_id);
    if (!session || session.user_id !== auth.user.id || session.payment_provider !== "MIPS") {
      return res.status(404).json({ ok: false });
    }
    console.log("[mips:client]", session_id, event, session.status, clip(detail));
    const events = Array.isArray(session.gateway_payload?.client_events) ? session.gateway_payload.client_events : [];
    await updatePaymentSession(session_id, {
      gateway_payload: {
        ...(session.gateway_payload ?? {}),
        client_events: [...events, { event, detail: detail ?? null, at: new Date().toISOString() }].slice(-20),
      },
    });
    return res.json({ ok: true });
  } catch (err: any) {
    console.error("[mips:client] error", session_id, event, err?.message || err);
    return res.status(500).json({ ok: false });
  }
});

router.all("/imn", async (req, res) => {
  try {
    const cryptedCallback = req.body?.crypted_callback || req.query?.crypted_callback;
    const idOrder = String(req.query?.id_order || req.body?.id_order || "");

    console.log("[mips:imn] received", {
      method: req.method,
      ip: req.headers["x-forwarded-for"] || req.ip,
      contentType: req.headers["content-type"] || null,
      queryKeys: Object.keys(req.query || {}),
      bodyKeys: Object.keys(req.body || {}),
      idOrder: idOrder || null,
      hasCallback: !!cryptedCallback,
    });

    if (!cryptedCallback) {
      console.error("[mips:imn] missing crypted_callback", clip(req.body));
      return res.status(400).send("Missing crypted_callback parameter");
    }

    const decrypted = await decryptMiPSIMN(String(cryptedCallback));
    const data =
      decrypted.data && typeof decrypted.data === "object" && decrypted.data.operation_status !== "error"
        ? decrypted.data
        : null;
    if (!decrypted.ok || !data) {
      console.error("[mips:imn] decrypt failed", idOrder, decrypted.statusCode, clip(decrypted.rawBody));
      return res.status(400).send("Invalid Sender.");
    }

    const { checksum: _checksum, ...visible } = data as any;
    console.log("[mips:imn] decrypted", idOrder, clip(visible));

    const config = getMiPSConfig();
    if (!verifyMiPSChecksum(data, config.hashSalt)) {
      console.error("[mips:imn] checksum mismatch", idOrder, { amount: data.amount, currency: data.currency, status: data.status });
      return res.status(400).send("Invalid Sender.");
    }

    const orderId = String(data?.id_order || data?.merchant_id_order || data?.order?.id_order || "");
    if (!orderId) {
      console.error("[mips:imn] no order reference", clip(visible));
      return res.status(400).send("Missing order reference");
    }
    if (idOrder && idOrder !== orderId) {
      console.error("[mips:imn] order mismatch", { query: idOrder, decrypted: orderId });
      return res.status(400).send("Invalid Sender.");
    }

    const session = await getPaymentSessionById(orderId);
    if (!session || session.payment_provider !== "MIPS") {
      console.error("[mips:imn] session not found", orderId);
      return res.status(404).send("Payment session not found");
    }

    const status = String(data.status || "").toLowerCase();
    console.log("[mips:imn] session", session.id, "current", session.status, "gateway", status);

    if (status !== "success") {
      await updatePaymentSessionIfStatusIn({
        sessionId: session.id,
        allowedCurrentStatuses: ["CREATED", "PENDING", "RETURNED"],
        updates: {
          status: "VERIFIED_FAILED",
          gateway_status: data.status,
          gateway_result_description: "MiPS reported the payment as not successful",
          gateway_payload: { ...(session.gateway_payload ?? {}), imn_decrypted: data },
        },
      });
      console.warn("[mips:imn] not successful", session.id, data.status);
      return res.status(200).send("fail");
    }

    if (!amountMatches(data.amount, session) || String(data.currency || "").toUpperCase() !== String(session.currency_code || "MUR").toUpperCase()) {
      console.error("[mipsPayments] Amount/currency mismatch:", { reported: data.amount, currency: data.currency, expected: session.amount_major });
      await updatePaymentSessionIfStatusIn({
        sessionId: session.id,
        allowedCurrentStatuses: ["CREATED", "PENDING", "RETURNED"],
        updates: {
          status: "VERIFIED_FAILED",
          gateway_status: data.status,
          gateway_result_description: `Amount mismatch: reported ${data.amount} ${data.currency}, expected ${session.amount_major} ${session.currency_code}`,
          gateway_payload: { ...(session.gateway_payload ?? {}), imn_decrypted: data },
        },
      });
      return res.status(200).send("fail");
    }

    const claimed = await updatePaymentSessionIfStatusIn({
      sessionId: session.id,
      allowedCurrentStatuses: ["CREATED", "PENDING", "RETURNED"],
      updates: {
        status: "VERIFIED_SUCCESS",
        gateway_status: data.status,
        verified_at: new Date().toISOString(),
        gateway_payload: { ...(session.gateway_payload ?? {}), imn_decrypted: data },
      },
    });

    if (!claimed) {
      console.log("[mips:imn] already processed", session.id);
      return res.status(200).send("success");
    }
    console.log("[mips:imn] verified", session.id, session.amount_major, session.currency_code);

    try {
      await createPaidOrder(claimed);
    } catch (orderErr: any) {
      console.error("[mipsPayments] Error creating order:", orderErr?.message || orderErr);
    }

    const paidAmount = Number(session.amount_major);
    if (session.user_id && (session.restaurant_id || session.store_id) && paidAmount > 0) {
      try {
        const cashbackCredited = await earnTransactionCashback({
          userId: session.user_id,
          restaurantId: session.restaurant_id || undefined,
          storeId: session.store_id || undefined,
          baseAmount: paidAmount,
          sessionId: session.id,
        });
        await updatePaymentSession(session.id, {
          gateway_payload: { ...(claimed.gateway_payload ?? {}), cashback_credited: cashbackCredited },
        });
      } catch (earnErr: any) {
        console.error("[mipsPayments] Error earning cashback:", earnErr);
      }
    }

    return res.status(200).send("success");
  } catch (err: any) {
    console.error("[mips:imn] error", err?.message || err, err?.stack);
    return res.status(500).send("Internal webhook error");
  }
});

export default router;
