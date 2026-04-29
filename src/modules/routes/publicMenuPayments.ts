import { Router } from "express";
import { z } from "zod";
import { buildIveriAuthoriseRequest, generateMerchantTrace, getIveriConfig, postForm } from "../services/iveriService";
import { normalizeIveriPayload } from "../services/iveriPayloadService";
import { supabaseServiceRole } from "../services/supabaseServiceRole";
import {
  PUBLIC_PAYMENT_CONTEXT,
  PUBLIC_PAYMENT_PROVIDER,
  computeItemsSubtotal,
  generatePublicTrackingId,
  hasMoneyMismatch,
  roundMoney,
  sanitizeOrderSnapshot,
  toMinor,
} from "../services/publicMenuPaymentUtils";
import { verifyIveriWebhookSignature } from "../services/iveriWebhookVerification";

const router = Router();

const CreateSessionSchema = z.object({
  restaurant_id: z.string().uuid(),
  table_no: z.coerce.number().int().positive(),
  customer_name: z.string().trim().min(1).max(120),
  customer_phone: z.string().trim().max(30).optional(),
  notes: z.string().trim().max(1000).optional(),
  items: z
    .array(
      z.object({
        item_id: z.string().min(1),
        name: z.string().trim().min(1).max(255),
        qty: z.coerce.number().int().positive(),
        unit_price: z.coerce.number().positive(),
      })
    )
    .min(1),
  subtotal_amount: z.coerce.number().positive(),
  tax_amount: z.coerce.number().nonnegative(),
  total_amount: z.coerce.number().positive(),
  currency_code: z.string().trim().length(3),
});

const FinalizeSchema = z.object({
  payment_session_id: z.string().uuid().optional(),
  tracking_id: z.string().trim().min(4).optional(),
}).superRefine((value, ctx) => {
  if (!value.payment_session_id && !value.tracking_id) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Provide payment_session_id or tracking_id" });
  }
});

function requirePublicSystemUserId() {
  const userId = process.env.PUBLIC_MENU_SYSTEM_USER_ID?.trim();
  if (!userId) {
    throw new Error("Missing PUBLIC_MENU_SYSTEM_USER_ID");
  }
  return userId;
}

function logWithCorrelation(level: "info" | "warn" | "error", message: string, meta: Record<string, any>) {
  const payload = { source: "public_menu_payment", message, ...meta };
  if (level === "error") {
    console.error(payload);
    return;
  }
  if (level === "warn") {
    console.warn(payload);
    return;
  }
  console.info(payload);
}

function isAlreadyFinal(session: any) {
  return session.status === "FINALIZED" || session.status === "VERIFIED_SUCCESS" || session.status === "VERIFIED_FAILED";
}

router.post("/create-session", async (req, res) => {
  const parsed = CreateSessionSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ ok: false, code: "VALIDATION_ERROR", message: "Invalid request payload", details: parsed.error.flatten() });
  }

  try {
    const systemUserId = requirePublicSystemUserId();
    const payload = parsed.data;

    const currencyCode = payload.currency_code.trim().toUpperCase();
    const serverSubtotal = computeItemsSubtotal(payload.items);
    const serverTax = roundMoney(payload.tax_amount);
    const serverTotal = roundMoney(serverSubtotal + serverTax);

    if (hasMoneyMismatch(payload.subtotal_amount, serverSubtotal)) {
      return res.status(400).json({ ok: false, code: "SUBTOTAL_MISMATCH", message: "subtotal_amount does not match server item totals" });
    }
    if (hasMoneyMismatch(payload.total_amount, serverTotal)) {
      return res.status(400).json({ ok: false, code: "TOTAL_MISMATCH", message: "total_amount does not match server totals" });
    }

    const config = getIveriConfig();
    const merchantTrace = generateMerchantTrace("BILL_PAYMENT");
    const trackingId = generatePublicTrackingId();
    const orderSnapshot = sanitizeOrderSnapshot({
      table_no: payload.table_no,
      customer_name: payload.customer_name,
      customer_phone: payload.customer_phone,
      notes: payload.notes,
      items: payload.items,
      subtotal_amount: serverSubtotal,
      tax_amount: serverTax,
      total_amount: serverTotal,
      currency_code: currencyCode,
    });

    const { data: session, error: createError } = await supabaseServiceRole
      .from("payment_sessions")
      .insert({
        payment_provider: PUBLIC_PAYMENT_PROVIDER,
        payment_context: PUBLIC_PAYMENT_CONTEXT,
        user_id: systemUserId,
        restaurant_id: payload.restaurant_id,
        merchant_trace: merchantTrace,
        merchant_application_id: config.applicationId,
        tracking_id: trackingId,
        amount_major: serverTotal,
        amount_minor: toMinor(serverTotal),
        currency_code: currencyCode,
        original_amount: serverSubtotal,
        discount_amount: 0,
        cashback_amount: 0,
        discount_source: "NONE",
        discount_code: null,
        discount_name: null,
        discount_meta: {},
        status: "CREATED",
        gateway_payload: {
          source: "public_menu",
          order_snapshot: orderSnapshot,
          webhook_events: [],
        },
      })
      .select("*")
      .single();

    if (createError || !session) {
      throw createError ?? new Error("Failed to create payment session");
    }

    const lineItems = orderSnapshot.items.map((item: any) => ({
      description: item.name,
      quantity: item.qty,
      unitAmountMajor: item.unit_price,
    }));

    const gatewayRequest = buildIveriAuthoriseRequest({
      config,
      sessionId: session.id,
      merchantTrace,
      amountMajor: serverTotal,
      currencyCode,
      merchantReference: trackingId,
      customer: {
        email: "public.menu@guest.local",
        firstName: "Guest",
        lastName: "Customer",
        phone: payload.customer_phone,
      },
      context: "BILL_PAYMENT",
      lineItems,
      additionalFields: {
        PassPriveTrackingId: trackingId,
        PassPriveSource: "public_menu",
      },
    });

    const initResponse = await postForm(gatewayRequest.gatewayUrl, gatewayRequest.fields);

    const { error: updateError } = await supabaseServiceRole
      .from("payment_sessions")
      .update({
        status: "PENDING",
        gateway_payload: {
          ...(session.gateway_payload ?? {}),
          gateway_request: {
            url: gatewayRequest.gatewayUrl,
            method: "POST",
            field_count: Object.keys(gatewayRequest.fields).length,
            fields: gatewayRequest.fields,
          },
          gateway_init_response: {
            status_code: initResponse.statusCode,
            body_preview: String(initResponse.body ?? "").slice(0, 1000),
          },
          transitions: [
            { at: new Date().toISOString(), from: "CREATED", to: "PENDING", reason: "gateway_init" },
          ],
        },
      })
      .eq("id", session.id);

    if (updateError) {
      throw updateError;
    }

    logWithCorrelation("info", "public menu create-session success", {
      tracking_id: trackingId,
      payment_session_id: session.id,
      merchant_trace: merchantTrace,
      restaurant_id: payload.restaurant_id,
      total_amount: serverTotal,
      currency_code: currencyCode,
    });

    return res.status(201).json({
      ok: true,
      payment_session_id: session.id,
      tracking_id: trackingId,
      merchant_trace: merchantTrace,
      redirect_url: gatewayRequest.gatewayUrl,
      payload: {
        method: "POST",
        fields: gatewayRequest.fields,
      },
    });
  } catch (err: any) {
    return res.status(500).json({ ok: false, code: "CREATE_SESSION_FAILED", message: err?.message || "Unexpected error" });
  }
});

router.post("/webhook", async (req, res) => {
  try {
    const rawPayload = { ...(req.body ?? {}), ...(req.query ?? {}) };
    const signature = verifyIveriWebhookSignature({
      payload: rawPayload,
      headers: req.headers as Record<string, any>,
    });

    if (!signature.ok && signature.reason === "SIGNATURE_MISSING") {
      return res.status(401).json({ ok: false, code: "SIGNATURE_MISSING", message: "Missing webhook signature" });
    }
    if (!signature.ok) {
      return res.status(403).json({ ok: false, code: "SIGNATURE_INVALID", message: "Invalid webhook signature" });
    }

    const normalized = normalizeIveriPayload(rawPayload);
    const merchantTrace = normalized.canonical.merchant_trace ?? null;
    const trackingId = String(rawPayload.tracking_id ?? rawPayload.PassPriveTrackingId ?? "").trim() || null;

    let query = supabaseServiceRole.from("payment_sessions").select("*").limit(1);
    if (merchantTrace) {
      query = query.eq("merchant_trace", merchantTrace);
    } else if (trackingId) {
      query = query.eq("tracking_id", trackingId);
    } else {
      return res.status(400).json({ ok: false, code: "SESSION_KEY_MISSING", message: "No merchant_trace or tracking_id in webhook" });
    }

    const { data: session, error: findError } = await query.maybeSingle();
    if (findError) throw findError;
    if (!session) {
      return res.status(404).json({ ok: false, code: "SESSION_NOT_FOUND", message: "Payment session not found" });
    }

    const outcomeStatus = String(normalized.canonical.card_status ?? "").trim();
    const success = outcomeStatus === "0";
    const nextStatus = success ? "VERIFIED_SUCCESS" : "VERIFIED_FAILED";

    const previousEvents = Array.isArray(session.gateway_payload?.webhook_events)
      ? session.gateway_payload.webhook_events
      : [];

    const webhookEvent = {
      at: new Date().toISOString(),
      payload: rawPayload,
      canonical: normalized.canonical,
      signature: {
        algorithm: signature.algorithm,
        received: signature.received,
      },
    };

    if (isAlreadyFinal(session) && session.status === nextStatus) {
      logWithCorrelation("info", "public menu webhook duplicate", {
        tracking_id: session.tracking_id,
        payment_session_id: session.id,
        status: session.status,
      });
      return res.status(200).json({ ok: true });
    }

    const updatePayload: Record<string, any> = {
      gateway_status: outcomeStatus || null,
      gateway_result_code: outcomeStatus || null,
      gateway_result_description: normalized.canonical.result_description ?? null,
      transaction_index: normalized.canonical.transaction_index ?? null,
      authorization_code: normalized.canonical.authorisation_code ?? null,
      bank_reference: normalized.canonical.bank_reference ?? null,
      status: nextStatus,
      gateway_payload: {
        ...(session.gateway_payload ?? {}),
        last_webhook_payload: rawPayload,
        webhook_events: [...previousEvents.slice(-19), webhookEvent],
      },
    };

    if (success) {
      updatePayload.verified_at = new Date().toISOString();
    }

    const { error: updateError } = await supabaseServiceRole
      .from("payment_sessions")
      .update(updatePayload)
      .eq("id", session.id)
      .in("status", ["CREATED", "PENDING", "RETURNED", "VERIFIED_SUCCESS", "VERIFIED_FAILED"]);

    if (updateError) throw updateError;

    logWithCorrelation("info", "public menu webhook processed", {
      tracking_id: session.tracking_id,
      payment_session_id: session.id,
      status: nextStatus,
    });

    return res.status(200).json({ ok: true });
  } catch (err: any) {
    return res.status(500).json({ ok: false, code: "WEBHOOK_FAILED", message: err?.message || "Unexpected error" });
  }
});

router.post("/finalize", async (req, res) => {
  const parsed = FinalizeSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ ok: false, code: "VALIDATION_ERROR", message: "Invalid finalize payload", details: parsed.error.flatten() });
  }

  try {
    let query = supabaseServiceRole.from("payment_sessions").select("*").limit(1);
    if (parsed.data.payment_session_id) {
      query = query.eq("id", parsed.data.payment_session_id);
    } else {
      query = query.eq("tracking_id", parsed.data.tracking_id!);
    }

    const { data: session, error: findError } = await query.maybeSingle();
    if (findError) throw findError;
    if (!session) {
      return res.status(404).json({ ok: false, code: "SESSION_NOT_FOUND", message: "Payment session not found" });
    }

    if (session.payment_context !== PUBLIC_PAYMENT_CONTEXT) {
      return res.status(409).json({ ok: false, code: "INVALID_CONTEXT", message: "Payment session is not BILL_PAYMENT" });
    }

    if (session.status === "FINALIZED") {
      return res.status(200).json({
        ok: true,
        status: "FINALIZED",
        payment_session_id: session.id,
        tracking_id: session.tracking_id,
        table_booking_id: session.finalized_booking_id ?? null,
      });
    }

    if (session.status !== "VERIFIED_SUCCESS") {
      return res.status(409).json({ ok: false, code: "INVALID_STATE", message: `Cannot finalize from status ${session.status}` });
    }

    const snapshot = session.gateway_payload?.order_snapshot;
    if (!snapshot || !Array.isArray(snapshot.items) || !snapshot.table_no) {
      return res.status(500).json({ ok: false, code: "SNAPSHOT_MISSING", message: "Stored order snapshot is missing or invalid" });
    }

    const paymentReference = session.transaction_index || session.bank_reference || session.tracking_id;

    const { data: booking, error: bookingError } = await supabaseServiceRole
      .from("restaurant_table_bookings")
      .insert({
        restaurant_id: session.restaurant_id,
        table_no: snapshot.table_no,
        customer_name: snapshot.customer_name,
        customer_phone: snapshot.customer_phone,
        order_items: snapshot.items,
        order_details: {
          source: "public_menu",
          payment_session_id: session.id,
          merchant_trace: session.merchant_trace,
          gateway: {
            transaction_index: session.transaction_index,
            authorization_code: session.authorization_code,
            bank_reference: session.bank_reference,
          },
        },
        subtotal_amount: snapshot.subtotal_amount,
        tax_amount: snapshot.tax_amount,
        total_amount: snapshot.total_amount,
        payment_method: "IVERI",
        payment_status: "PAID",
        payment_reference: paymentReference,
        booking_status: "PLACED",
        source: "public_menu",
        notes: snapshot.notes,
      })
      .select("id")
      .single();

    if (bookingError || !booking) {
      throw bookingError ?? new Error("Failed to create table booking");
    }

    const { data: finalized, error: finalizeError } = await supabaseServiceRole
      .from("payment_sessions")
      .update({
        status: "FINALIZED",
        finalized_booking_id: booking.id,
        context_reference_id: booking.id,
        gateway_payload: {
          ...(session.gateway_payload ?? {}),
          finalized_booking_id: booking.id,
          transitions: [
            ...((session.gateway_payload?.transitions ?? []) as any[]),
            { at: new Date().toISOString(), from: "VERIFIED_SUCCESS", to: "FINALIZED", reason: "public_menu_finalize" },
          ],
        },
      })
      .eq("id", session.id)
      .eq("status", "VERIFIED_SUCCESS")
      .is("finalized_booking_id", null)
      .select("id, tracking_id, finalized_booking_id")
      .maybeSingle();

    if (finalizeError) throw finalizeError;

    if (!finalized) {
      const { data: current, error: currentErr } = await supabaseServiceRole
        .from("payment_sessions")
        .select("id, tracking_id, status, finalized_booking_id")
        .eq("id", session.id)
        .maybeSingle();
      if (currentErr) throw currentErr;

      if (current?.status === "FINALIZED") {
        return res.status(200).json({
          ok: true,
          status: "FINALIZED",
          payment_session_id: current.id,
          tracking_id: current.tracking_id,
          table_booking_id: current.finalized_booking_id,
        });
      }

      return res.status(409).json({ ok: false, code: "FINALIZE_RACE", message: "Payment session changed while finalizing" });
    }

    logWithCorrelation("info", "public menu finalize success", {
      tracking_id: session.tracking_id,
      payment_session_id: session.id,
      table_booking_id: booking.id,
    });

    return res.status(200).json({
      ok: true,
      status: "FINALIZED",
      payment_session_id: session.id,
      tracking_id: session.tracking_id,
      table_booking_id: booking.id,
    });
  } catch (err: any) {
    return res.status(500).json({ ok: false, code: "FINALIZE_FAILED", message: err?.message || "Unexpected error" });
  }
});

export default router;
