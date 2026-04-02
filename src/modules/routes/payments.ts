import { Router } from "express";
import { z } from "zod";
import supabase from "../../database/supabase";
import {
  getAuthenticatedCustomer,
  requireAuth,
} from "../services/authService";
import {
  BookingPayloadSchema,
  confirmRestaurantBooking,
  evaluateBookingPaymentRequirement,
} from "../services/restaurantBookingService";
import {
  BillPaymentValidationError,
  buildBillPaymentContext,
  finalizeBillPayment,
} from "../services/billPaymentService";
import {
  buildIveriAuthoriseRequest,
  generateMerchantTrace,
  getIveriConfig,
} from "../services/iveriService";
import {
  createPaymentSession,
  getPaymentSessionById,
  updatePaymentSession,
  updatePaymentSessionIfStatusIn,
} from "../services/paymentSessionService";
import { verifyPaymentSessionWithIveri } from "../services/paymentVerificationService";
import {
  buildIveriIntegrityChecks,
  deriveIveriOutcome,
  normalizeIveriPayload,
} from "../services/iveriPayloadService";

const router = Router();

const InitiateSchema = z.object({
  payment_context: z.enum(["BOOKING", "BILL_PAYMENT"]),
  restaurant_id: z.string().uuid().optional(),
  store_id: z.string().uuid().optional(),
  booking_payload: BookingPayloadSchema.optional(),
  bill_payload: z
    .object({
      bill_amount: z.coerce.number().positive(),
      booking_id: z.string().uuid().nullable().optional(),
      item_id: z.string().uuid().nullable().optional(),
      quantity: z.coerce.number().int().positive().optional(),
      selected_offer_ids: z.array(z.string().uuid()).optional(),
      payment_instrument_type: z.string().trim().nullable().optional(),
      card_network: z.string().trim().nullable().optional(),
      issuer_bank_name: z.string().trim().nullable().optional(),
      bin: z.string().trim().nullable().optional(),
      coupon_code: z.string().trim().nullable().optional(),
    })
    .optional(),
}).superRefine((value, ctx) => {
  const hasRestaurantId = !!value.restaurant_id;
  const hasStoreId = !!value.store_id;

  if (value.payment_context === "BOOKING") {
    if (!hasRestaurantId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["restaurant_id"], message: "restaurant_id is required for BOOKING" });
    }
    if (hasStoreId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["store_id"], message: "store_id is not allowed for BOOKING" });
    }
    if (!value.booking_payload) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["booking_payload"], message: "booking_payload is required for BOOKING" });
    }
    if (value.bill_payload) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["bill_payload"], message: "bill_payload is not allowed for BOOKING" });
    }
  }

  if (value.payment_context === "BILL_PAYMENT") {
    if (hasRestaurantId === hasStoreId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["restaurant_id"],
        message: "BILL_PAYMENT requires exactly one of restaurant_id or store_id",
      });
    }
    if (!value.bill_payload) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["bill_payload"], message: "bill_payload is required for BILL_PAYMENT" });
    }
    if (value.booking_payload) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["booking_payload"], message: "booking_payload is not allowed for BILL_PAYMENT" });
    }
  }
});

const VerifySchema = z.object({
  session_id: z.string().uuid(),
});

const FinalizeSchema = z.object({
  session_id: z.string().uuid(),
});

const LaunchParamsSchema = z.object({
  session_id: z.string().uuid(),
});

function splitName(fullName: string | null) {
  const trimmed = String(fullName ?? "").trim();
  if (!trimmed) return { firstName: "Guest", lastName: "Customer" };
  const [firstName, ...rest] = trimmed.split(/\s+/);
  return {
    firstName,
    lastName: rest.join(" ") || "Customer",
  };
}

function mapSessionStatusToAppOutcome(status: string) {
  if (status === "VERIFIED_SUCCESS" || status === "FINALIZED") return "success";
  if (status === "VERIFIED_FAILED" || status === "ERROR" || status === "CANCELLED") return "fail";
  return "pending";
}

function buildAppDeepLink(outcome: string, sessionId: string) {
  const path =
    outcome === "success"
      ? "success"
      : outcome === "fail" || outcome === "error"
      ? "fail"
      : "pending";
  return `passprive://payment/${path}?session_id=${encodeURIComponent(sessionId)}`;
}

function getBackendBaseUrl(req: any) {
  const configured =
    process.env.PUBLIC_BACKEND_BASE_URL?.trim() ||
    process.env.BACKEND_BASE_URL?.trim() ||
    "";

  if (configured) {
    return configured.replace(/\/+$/, "");
  }

  const protocol = req.headers["x-forwarded-proto"] || req.protocol || "http";
  const host = req.headers["x-forwarded-host"] || req.get("host");
  return `${protocol}://${host}`;
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function buildPendingDeepLink(sessionId: string) {
  return buildAppDeepLink("pending", sessionId);
}

function renderAppRedirectPage(params: {
  title: string;
  message: string;
  appUrl: string;
  sessionId: string;
  outcome: string;
}) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(params.title)}</title>
    <meta http-equiv="refresh" content="2;url=${escapeHtml(params.appUrl)}" />
    <style>
      body {
        font-family: Arial, sans-serif;
        background: #f6f4ef;
        color: #1f2937;
        margin: 0;
        min-height: 100vh;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 24px;
      }
      .card {
        width: 100%;
        max-width: 420px;
        background: white;
        border-radius: 16px;
        box-shadow: 0 10px 30px rgba(0,0,0,0.08);
        padding: 24px;
        text-align: center;
      }
      h1 { margin: 0 0 12px; font-size: 22px; }
      p { margin: 0 0 18px; line-height: 1.5; }
      a {
        display: inline-block;
        padding: 12px 18px;
        border-radius: 10px;
        background: #111827;
        color: white;
        text-decoration: none;
      }
      .meta {
        margin-top: 14px;
        font-size: 12px;
        color: #6b7280;
      }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>${escapeHtml(params.title)}</h1>
      <p>${escapeHtml(params.message)}</p>
      <a href="${escapeHtml(params.appUrl)}">Return to PassPrive</a>
      <div class="meta">
        Session: ${escapeHtml(params.sessionId)}<br />
        Outcome: ${escapeHtml(params.outcome)}
      </div>
    </div>
    <script>
      window.location.href = ${JSON.stringify(params.appUrl)};
      setTimeout(function () {
        window.location.href = ${JSON.stringify(params.appUrl)};
      }, 1200);
    </script>
  </body>
</html>`;
}

function buildSafeReturnSummary(payload: Record<string, any>) {
  const interestingKeys = [
    "outcome",
    "session_id",
    "passprive_session_id",
    "Lite_Merchant_ApplicationID",
    "LITE_MERCHANT_APPLICATIONID",
    "Lite_Merchant_Trace",
    "LITE_MERCHANT_TRACE",
    "Lite_Result_Description",
    "LITE_RESULT_DESCRIPTION",
    "Lite_Payment_Card_Status",
    "LITE_PAYMENT_CARD_STATUS",
    "Lite_TransactionIndex",
    "LITE_TRANSACTIONINDEX",
    "MerchantReference",
    "MERCHANTREFERENCE",
    "Lite_Order_Amount",
    "LITE_ORDER_AMOUNT",
  ];

  const summary: Record<string, any> = {};
  for (const key of interestingKeys) {
    if (!(key in payload)) continue;
    summary[key] = payload[key];
  }

  summary.body_key_count = Object.keys(payload).length;
  summary.body_keys = Object.keys(payload).sort();

  const safeEcho: Record<string, any> = {};
  for (const [key, value] of Object.entries(payload)) {
    const lowered = key.toLowerCase();
    if (
      lowered.includes("card_number") ||
      lowered.includes("cvv") ||
      lowered.includes("verification") ||
      lowered.includes("expdate") ||
      lowered.includes("token")
    ) {
      continue;
    }
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      safeEcho[key] = value;
    }
  }
  summary.safe_echo = safeEcho;
  return summary;
}

function buildSafeGatewayFieldSummary(fields: Record<string, string>) {
  const interestingKeys = [
    "Lite_Merchant_ApplicationID",
    "Lite_Order_Amount",
    "Lite_Order_DiscountAmount",
    "Lite_Order_LineItems_Product_1",
    "Lite_Order_LineItems_Quantity_1",
    "Lite_Order_LineItems_Amount_1",
    "Lite_Currency_AlphaCode",
    "Lite_Merchant_Trace",
    "MerchantReference",
    "Lite_Version",
    "Lite_Website_Successful_Url",
    "Lite_Website_Success_Url",
    "Lite_Website_Fail_Url",
    "Lite_Website_TryLater_Url",
    "Lite_Website_Error_Url",
    "Ecom_BillTo_Online_Email",
  ];

  const summary: Record<string, string | boolean | null> = {};
  for (const key of interestingKeys) {
    if (!(key in fields)) continue;

    if (key === "Ecom_BillTo_Online_Email") {
      const email = String(fields[key] ?? "");
      const [name, domain] = email.split("@");
      summary[key] = name && domain ? `${name.slice(0, 2)}***@${domain}` : "***";
      continue;
    }

    summary[key] = fields[key] ?? null;
  }

  return summary;
}

function buildGatewayDiagnostics(session: any, gatewayRequest: { fields: Record<string, string> }) {
  return {
    session_id: session.id,
    payment_context: session.payment_context,
    merchant_trace: session.merchant_trace,
    amount_major: session.amount_major,
    amount_minor: session.amount_minor,
    currency_code: session.currency_code,
    token_present: false,
    token_required: false,
    return_urls_public:
      Object.values({
        successful: gatewayRequest.fields.Lite_Website_Successful_Url,
        success: gatewayRequest.fields.Lite_Website_Success_Url,
        fail: gatewayRequest.fields.Lite_Website_Fail_Url,
        try_later: gatewayRequest.fields.Lite_Website_TryLater_Url,
        error: gatewayRequest.fields.Lite_Website_Error_Url,
      }).every((value) => String(value ?? "").startsWith("https://")),
  };
}

function validateIveriGatewayConfiguration(params: {
  authoriseUrl: string;
  currencyCode: string;
  mode: "TEST" | "LIVE";
}) {
  const allowNonCimForMur =
    String(process.env.IVERI_ALLOW_NON_CIM_FOR_MUR ?? "false").trim().toLowerCase() === "true";

  try {
    const url = new URL(params.authoriseUrl);
    const host = String(url.host ?? "").trim().toLowerCase();
    const currencyCode = String(params.currencyCode ?? "").trim().toUpperCase();

    if (
      currencyCode === "MUR" &&
      !allowNonCimForMur &&
      host === "portal.host.iveri.com"
    ) {
      const message =
        "iVeri gateway host is set to portal.host.iveri.com for MUR transactions. Configure IVERI_GATEWAY_BASE_URL to the distributor endpoint (for CIM use https://portal.merchant.cim.mu).";
      if (params.mode === "LIVE") {
        throw new Error(message);
      }
      console.warn(`[iVeri config warning] ${message}`);
    }
  } catch (err: any) {
    if (err instanceof TypeError) {
      throw new Error("Invalid iVeri authorise URL configuration");
    }
    throw err;
  }
}

router.post("/iveri/initiate", async (req, res) => {
  const parsed = InitiateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid payment initiation payload", details: parsed.error.flatten() });
  }

  const customer = await getAuthenticatedCustomer(req, res);
  if (!customer) return;

  try {
    const config = getIveriConfig();
    validateIveriGatewayConfiguration({
      authoriseUrl: config.authoriseUrl,
      currencyCode: "MUR",
      mode: config.mode,
    });
    const merchantTrace = generateMerchantTrace(parsed.data.payment_context);
    const { firstName, lastName } = splitName(customer.fullName);

    let paymentContext: "BOOKING" | "BILL_PAYMENT" = parsed.data.payment_context;
    let amountMajor = 0;
    let restaurantId: string | null = null;
    let storeId: string | null = null;
    let discountAmount = 0;
    let cashbackAmount = 0;
    let originalAmount = 0;
    let contextPayload: Record<string, any> = {};
    let merchantReference = merchantTrace.slice(-20);
    let lineItems: Array<{ description: string; quantity: number; unitAmountMajor: number }> = [];

    if (paymentContext === "BOOKING") {
      if (!parsed.data.booking_payload) {
        return res.status(400).json({ error: "booking_payload is required for BOOKING payment context" });
      }

      const bookingRestaurantId =
        typeof parsed.data.booking_payload.restaurant === "string"
          ? parsed.data.booking_payload.restaurant
          : parsed.data.booking_payload.restaurant.id;
      if (parsed.data.restaurant_id !== bookingRestaurantId) {
        return res.status(400).json({ error: "restaurant_id must match booking_payload.restaurant for BOOKING" });
      }

      const evaluation = await evaluateBookingPaymentRequirement(parsed.data.booking_payload, customer);
      if (!evaluation.ok) {
        return res.status(evaluation.status).json(evaluation.body);
      }
      if (!evaluation.paymentRequired) {
        return res.status(400).json({ error: "Selected booking does not require payment" });
      }

      amountMajor = evaluation.verifiedCoverChargeAmount;
      originalAmount = evaluation.verifiedCoverChargeAmount;
      restaurantId = evaluation.restaurantId;
      contextPayload = {
        restaurant_id: parsed.data.restaurant_id,
        booking_payload: parsed.data.booking_payload,
      };
      lineItems = [
        {
          description: evaluation.verifiedOffer?.title
            ? `Booking cover charge - ${evaluation.verifiedOffer.title}`
            : "Restaurant booking cover charge",
          quantity: 1,
          unitAmountMajor: amountMajor,
        },
      ];
    } else {
      if (!parsed.data.bill_payload) {
        return res.status(400).json({ error: "bill_payload is required for BILL_PAYMENT payment context" });
      }

      const billContext = await buildBillPaymentContext({
        restaurant_id: parsed.data.restaurant_id ?? null,
        store_id: parsed.data.store_id ?? null,
        ...parsed.data.bill_payload,
        user_id: customer.userId,
      });

      amountMajor = billContext.payableAmount;
      originalAmount = billContext.originalAmount;
      discountAmount = billContext.discountAmount;
      cashbackAmount = billContext.cashbackAmount;
      restaurantId = billContext.restaurant?.id ?? null;
      storeId = billContext.store?.id ?? null;
      contextPayload = {
        restaurant_id: parsed.data.restaurant_id ?? null,
        store_id: parsed.data.store_id ?? null,
        bill_payload: parsed.data.bill_payload,
      };
      lineItems = [
        {
          description: billContext.lineItemDescription,
          quantity: billContext.item ? billContext.quantity : 1,
          unitAmountMajor: billContext.item
            ? Number((billContext.originalAmount / billContext.quantity).toFixed(2))
            : billContext.originalAmount,
        },
      ];
    }

    const session = await createPaymentSession({
      payment_context: paymentContext,
      user_id: customer.userId,
      restaurant_id: restaurantId,
      store_id: storeId,
      merchant_trace: merchantTrace,
      merchant_application_id: config.applicationId,
      amount_major: amountMajor,
      amount_minor: Math.round(amountMajor * 100),
      currency_code: "MUR",
      discount_amount: discountAmount,
      cashback_amount: cashbackAmount,
      original_amount: originalAmount,
      status: "PENDING",
      gateway_payload: {
        context_payload: contextPayload,
        mode: config.mode,
      },
    });

    const gatewayRequest = buildIveriAuthoriseRequest({
      config,
      sessionId: session.id,
      merchantTrace,
      amountMajor,
      discountMajor: discountAmount,
      currencyCode: "MUR",
      merchantReference,
      customer: {
        email: customer.email ?? "payments@passprive.app",
        firstName,
        lastName,
        phone: customer.phone,
      },
      context: paymentContext,
      lineItems,
    });

    const updatedSession = await updatePaymentSession(session.id, {
      gateway_payload: {
        ...(session.gateway_payload ?? {}),
        gateway_request: gatewayRequest,
      },
    });
    const launchUrl = `${getBackendBaseUrl(req)}/api/payments/iveri/launch/${updatedSession.id}`;

    return res.status(201).json({
      session_id: updatedSession.id,
      merchant_trace: updatedSession.merchant_trace,
      launch_url: launchUrl,
      mobile_redirect_url: launchUrl,
      expected_amount: {
        major: updatedSession.amount_major,
        minor: updatedSession.amount_minor,
        currency_code: updatedSession.currency_code,
      },
      gateway: {
        url: gatewayRequest.gatewayUrl,
        method: "POST",
        fields: gatewayRequest.fields,
      },
      redirect: {
        success_url:
          gatewayRequest.fields.Lite_Website_Successful_Url ??
          gatewayRequest.fields.Lite_Website_Success_Url,
        fail_url: gatewayRequest.fields.Lite_Website_Fail_Url,
        try_later_url: gatewayRequest.fields.Lite_Website_TryLater_Url,
        error_url: gatewayRequest.fields.Lite_Website_Error_Url,
        app_deep_links: {
          success: buildAppDeepLink("success", updatedSession.id),
          fail: buildAppDeepLink("fail", updatedSession.id),
          pending: buildAppDeepLink("pending", updatedSession.id),
        },
      },
    });
  } catch (err: any) {
    if (err instanceof BillPaymentValidationError) {
      return res.status(err.status).json({ error: err.message });
    }
    return res.status(500).json({ error: err?.message || "Failed to initiate iVeri payment" });
  }
});

router.get("/iveri/launch/:session_id", async (req, res) => {
  const parsed = LaunchParamsSchema.safeParse(req.params);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid session id" });
  }

  try {
    const session = await getPaymentSessionById(parsed.data.session_id);
    if (!session) {
      return res.status(404).json({ error: "Payment session not found" });
    }

    const gatewayRequest = session.gateway_payload?.gateway_request;
    if (!gatewayRequest?.gatewayUrl || !gatewayRequest?.fields) {
      return res.status(409).json({ error: "Payment launch data is not available for this session" });
    }

    console.log("[iVeri launch] Preparing hosted payment redirect", {
      session_id: session.id,
      payment_context: session.payment_context,
      merchant_trace: session.merchant_trace,
      gateway_url: gatewayRequest.gatewayUrl,
      field_count: Object.keys(gatewayRequest.fields).length,
      field_summary: buildSafeGatewayFieldSummary(gatewayRequest.fields as Record<string, string>),
    });
    console.log(
      "[iVeri diagnostics]",
      buildGatewayDiagnostics(session, {
        fields: gatewayRequest.fields as Record<string, string>,
      })
    );

    const hiddenInputs = Object.entries(gatewayRequest.fields as Record<string, string>)
      .map(
        ([key, value]) =>
          `<input type="hidden" name="${escapeHtml(String(key))}" value="${escapeHtml(String(value))}" />`
      )
      .join("\n");

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(200).send(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Redirecting to iVeri</title>
  </head>
  <body>
    <p>Redirecting to secure payment page...</p>
    <form id="iveri-launch-form" method="POST" action="${escapeHtml(String(gatewayRequest.gatewayUrl))}">
      ${hiddenInputs}
    </form>
    <script>
      document.getElementById("iveri-launch-form").submit();
      setTimeout(function () {
        window.location.href = ${JSON.stringify(buildPendingDeepLink(session.id))};
      }, 15000);
    </script>
  </body>
</html>`);
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || "Failed to build payment launch page" });
  }
});

async function handleIveriReturn(req: any, res: any) {
  const sourcePayload = {
    ...(req.method === "POST" ? req.body ?? {} : {}),
    ...(req.query ?? {}),
  };
  const normalizedPayload = normalizeIveriPayload(sourcePayload);
  const sessionId = String(
    normalizedPayload.canonical.session_id ?? sourcePayload.session_id ?? sourcePayload.passprive_session_id ?? ""
  ).trim();
  if (!sessionId) {
    return res.status(400).json({ error: "Missing session_id" });
  }

  try {
    let session = await getPaymentSessionById(sessionId);
    if (!session) {
      return res.status(404).json({ error: "Payment session not found" });
    }

    const inferredOutcome = deriveIveriOutcome(normalizedPayload);
    const integrity = buildIveriIntegrityChecks({
      session,
      payload: normalizedPayload,
    });

    const previousReturnEvents = Array.isArray(session.gateway_payload?.return_events)
      ? session.gateway_payload.return_events
      : [];
    const returnEvent = {
      received_at: new Date().toISOString(),
      method: req.method,
      inferred_outcome: inferredOutcome,
      integrity,
      canonical_payload: normalizedPayload.canonical,
      payload_summary: buildSafeReturnSummary(sourcePayload),
    };

    console.log("[iVeri return]", {
      session_id: sessionId,
      method: req.method,
      inferred_outcome: inferredOutcome,
      integrity,
      lite_status: normalizedPayload.canonical.card_status,
      lite_result_description: normalizedPayload.canonical.result_description,
      lite_transaction_index: normalizedPayload.canonical.transaction_index,
      payload_summary: buildSafeReturnSummary(sourcePayload),
    });

    const sessionAfterReturn = await updatePaymentSessionIfStatusIn({
      sessionId,
      allowedCurrentStatuses: ["CREATED", "PENDING", "RETURNED", "VERIFIED_FAILED", "ERROR"],
      updates: {
        status: "RETURNED",
        gateway_status: normalizedPayload.canonical.card_status ?? session.gateway_status ?? null,
        gateway_result_code: normalizedPayload.canonical.card_status ?? session.gateway_result_code ?? null,
        gateway_result_description:
          normalizedPayload.canonical.result_description ?? session.gateway_result_description ?? null,
        transaction_index: normalizedPayload.canonical.transaction_index ?? session.transaction_index ?? null,
        authorization_code: normalizedPayload.canonical.authorisation_code ?? session.authorization_code ?? null,
        bank_reference: normalizedPayload.canonical.bank_reference ?? session.bank_reference ?? null,
        gateway_payload: {
          ...(session.gateway_payload ?? {}),
          return_events: [...previousReturnEvents.slice(-9), returnEvent],
          return_request: {
            method: req.method,
            query: req.query ?? {},
            body: req.body ?? {},
            inferred_outcome: inferredOutcome,
            integrity,
            canonical_payload: normalizedPayload.canonical,
          },
        },
      },
    });

    if (sessionAfterReturn) {
      session = sessionAfterReturn;
    } else {
      session = (await getPaymentSessionById(sessionId)) ?? session;
    }

    if (session.status !== "FINALIZED" && session.status !== "VERIFIED_SUCCESS" && integrity.ok) {
      try {
        const config = getIveriConfig();
        const verification = await verifyPaymentSessionWithIveri({
          sessionId,
          applicationId: config.applicationId,
          authoriseInfoUrl: config.authoriseInfoUrl,
        });
        session = verification.session;
      } catch (verifyErr: any) {
        await updatePaymentSession(sessionId, {
          gateway_payload: {
            ...(session.gateway_payload ?? {}),
            verification_error_on_return: {
              message: verifyErr?.message || "Unknown verification error",
              at: new Date().toISOString(),
            },
          },
        });
      }
    } else if (!integrity.ok) {
      await updatePaymentSessionIfStatusIn({
        sessionId,
        allowedCurrentStatuses: ["CREATED", "PENDING", "RETURNED"],
        updates: {
          status: "ERROR",
          gateway_payload: {
            ...(session.gateway_payload ?? {}),
            integrity_error_on_return: integrity,
          },
        },
      });
      session = (await getPaymentSessionById(sessionId)) ?? session;
    }

    const outcome = mapSessionStatusToAppOutcome(session.status);
    const appUrl = buildAppDeepLink(outcome, sessionId);

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(200).send(
      renderAppRedirectPage({
        title:
          outcome === "success"
            ? "Payment Completed"
            : outcome === "fail"
            ? "Payment Failed"
            : "Payment Pending",
        message:
          outcome === "success"
            ? "Your payment has been verified. We are taking you back to PassPrive."
            : outcome === "fail"
            ? "The payment did not verify successfully. Returning to PassPrive."
            : "The payment is still being processed. Returning to PassPrive.",
        appUrl,
        sessionId,
        outcome,
      })
    );
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || "Failed to handle iVeri return" });
  }
}

router.get("/iveri/return", handleIveriReturn);
router.post("/iveri/return", handleIveriReturn);

router.post("/iveri/verify", async (req, res) => {
  const parsed = VerifySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid verify payload", details: parsed.error.flatten() });
  }

  const auth = await requireAuth(req, res);
  if (!auth) return;

  try {
    const config = getIveriConfig();
    const session = await getPaymentSessionById(parsed.data.session_id);
    if (!session) {
      return res.status(404).json({ error: "Payment session not found" });
    }
    if (session.user_id !== auth.user.id) {
      return res.status(403).json({ error: "Access denied" });
    }

    const verification = await verifyPaymentSessionWithIveri({
      sessionId: parsed.data.session_id,
      applicationId: config.applicationId,
      authoriseInfoUrl: config.authoriseInfoUrl,
    });

    return res.json({
      session_id: verification.session.id,
      merchant_trace: verification.session.merchant_trace,
      verified: verification.verification.verified,
      status: verification.verification.status,
      inferred_outcome: verification.verification.inferredOutcome,
      integrity: verification.verification.integrity,
      gateway_status: verification.session.gateway_status,
      result_description: verification.session.gateway_result_description,
      amount: {
        major: verification.session.amount_major,
        minor: verification.session.amount_minor,
        currency_code: verification.session.currency_code,
      },
      transaction: {
        transaction_index: verification.session.transaction_index,
        authorization_code: verification.session.authorization_code,
        bank_reference: verification.session.bank_reference,
      },
      raw_fields: verification.verification.fields,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || "Failed to verify iVeri payment" });
  }
});

router.post("/iveri/finalize-booking", async (req, res) => {
  const parsed = FinalizeSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid finalize payload", details: parsed.error.flatten() });
  }

  const customer = await getAuthenticatedCustomer(req, res);
  if (!customer) return;

  try {
    const session = await getPaymentSessionById(parsed.data.session_id);
    if (!session) {
      return res.status(404).json({ error: "Payment session not found" });
    }
    if (session.user_id !== customer.userId) {
      return res.status(403).json({ error: "Access denied" });
    }
    if (session.payment_context !== "BOOKING") {
      return res.status(400).json({ error: "Payment session is not a booking payment" });
    }
    if (session.status === "FINALIZED") {
      return res.json({
        session_id: session.id,
        finalized: true,
        booking_reference_id: session.context_reference_id ?? null,
      });
    }
    if (session.status !== "VERIFIED_SUCCESS") {
      return res.status(409).json({ error: "Payment session has not been verified as successful" });
    }

    const bookingPayload = session.gateway_payload?.context_payload?.booking_payload;
    const parsedBooking = BookingPayloadSchema.safeParse(bookingPayload);
    if (!parsedBooking.success) {
      return res.status(500).json({ error: "Stored booking payload is invalid" });
    }

    const result = await confirmRestaurantBooking(
      {
        ...parsedBooking.data,
        payment: {
          amount: session.amount_major,
          status: "verified",
          method: "IVERI_HOSTED",
          reference: session.transaction_index ?? session.bank_reference ?? session.merchant_trace,
          verified: true,
          paymentSessionId: session.id,
        },
      },
      customer
    );

    if (!result.ok) {
      return res.status(result.status).json(result.body);
    }

    const bookingReferenceId = result.body.booking.id;
    const updated = await updatePaymentSessionIfStatusIn({
      sessionId: session.id,
      allowedCurrentStatuses: ["VERIFIED_SUCCESS"],
      updates: {
        status: "FINALIZED",
        context_reference_id: bookingReferenceId,
        gateway_payload: {
          ...(session.gateway_payload ?? {}),
          finalized_booking: result.body.booking,
        },
      },
    });
    const effectiveSession = updated ?? (await getPaymentSessionById(session.id));

    return res.json({
      session_id: session.id,
      finalized: true,
      booking: result.body.booking,
      duplicate: result.body.duplicate ?? false,
      booking_reference_id: effectiveSession?.context_reference_id ?? bookingReferenceId,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || "Failed to finalize booking payment" });
  }
});

router.post("/iveri/finalize-bill", async (req, res) => {
  const parsed = FinalizeSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid finalize payload", details: parsed.error.flatten() });
  }

  const auth = await requireAuth(req, res);
  if (!auth) return;

  try {
    const session = await getPaymentSessionById(parsed.data.session_id);
    if (!session) {
      return res.status(404).json({ error: "Payment session not found" });
    }
    if (session.user_id !== auth.user.id) {
      return res.status(403).json({ error: "Access denied" });
    }
    if (session.payment_context !== "BILL_PAYMENT") {
      return res.status(400).json({ error: "Payment session is not a bill payment" });
    }
    if (session.status === "FINALIZED") {
      return res.json({
        session_id: session.id,
        finalized: true,
        bill_payment_reference_id: session.context_reference_id ?? null,
      });
    }
    if (session.status !== "VERIFIED_SUCCESS") {
      return res.status(409).json({ error: "Payment session has not been verified as successful" });
    }

    const result = await finalizeBillPayment({
      session,
      userId: auth.user.id,
    });

    const linkedBookingId = session.gateway_payload?.context_payload?.bill_payload?.booking_id ?? null;
    let linkedBooking: any = null;
    if (linkedBookingId) {
      const paymentReference = session.transaction_index ?? session.bank_reference ?? session.merchant_trace ?? null;
      console.info("[finalize bill] Syncing linked booking after verified payment", {
        session_id: session.id,
        booking_id: linkedBookingId,
        user_id: auth.user.id,
        payment_amount: session.amount_major,
        payment_reference: paymentReference,
      });

      const { data: updatedBooking, error: bookingUpdateError } = await supabase
        .from("restaurant_bookings")
        .update({
          payment_status: "paid",
          payment_method: "IVERI_HOSTED",
          payment_reference: paymentReference,
          payment_amount: session.amount_major,
          status: "payment_successfull",
          updated_at: new Date().toISOString(),
        })
        .eq("id", linkedBookingId)
        .eq("customer_user_id", auth.user.id)
        .select("id, status, payment_status, payment_amount, payment_reference")
        .single();

      if (bookingUpdateError) {
        console.error("[finalize bill] Linked booking payment sync failed", {
          session_id: session.id,
          booking_id: linkedBookingId,
          error: bookingUpdateError.message,
        });
      } else {
        linkedBooking = updatedBooking;
        console.info("[finalize bill] Linked booking payment sync complete", {
          session_id: session.id,
          booking_id: updatedBooking.id,
          status: updatedBooking.status,
          payment_status: updatedBooking.payment_status,
          payment_amount: updatedBooking.payment_amount,
          payment_reference: updatedBooking.payment_reference,
        });
      }
    } else {
      console.info("[finalize bill] No linked booking_id found in bill payload; skipping restaurant_bookings sync", {
        session_id: session.id,
      });
    }

    const updated = await updatePaymentSessionIfStatusIn({
      sessionId: session.id,
      allowedCurrentStatuses: ["VERIFIED_SUCCESS"],
      updates: {
        status: "FINALIZED",
        context_reference_id: result.billPayment.id,
        gateway_payload: {
          ...(session.gateway_payload ?? {}),
          finalized_bill_payment: result.billPayment,
        },
      },
    });
    const effectiveSession = updated ?? (await getPaymentSessionById(session.id));

    return res.json({
      session_id: session.id,
      finalized: true,
      bill_payment: result.billPayment,
      redemptions: result.redemptions,
      duplicate: result.duplicate,
      bill_payment_reference_id: effectiveSession?.context_reference_id ?? result.billPayment.id,
      linked_booking: linkedBooking,
    });
  } catch (err: any) {
    if (err instanceof BillPaymentValidationError) {
      return res.status(err.status).json({ error: err.message });
    }
    return res.status(500).json({ error: err?.message || "Failed to finalize bill payment" });
  }
});

export default router;
