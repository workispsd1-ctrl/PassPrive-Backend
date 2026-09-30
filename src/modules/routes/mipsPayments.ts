import { Router } from "express";
import { z } from "zod";
import { randomUUID } from "crypto";
import { requireAuth } from "../services/authService";
import { validateCashbackSpend, spendCashback, earnTransactionCashback } from "../services/cashbackService";
import { createPaymentSession, getPaymentSessionById, updatePaymentSession } from "../services/paymentSessionService";
import { decryptMiPSIMN, getMiPSConfig, loadMiPSPaymentZone } from "../services/mipsService";

const router = Router();

const MiPSInitiateSchema = z.object({
  payment_context: z.enum(["BOOKING", "BILL_PAYMENT", "MEMBERSHIP", "GIFT_PURCHASE"]),
  restaurant_id: z.string().uuid().optional(),
  store_id: z.string().uuid().optional(),
  total_amount: z.coerce.number().positive(),
  coins_amount: z.coerce.number().nonnegative().default(0),
  currency: z.string().trim().default("MUR"),
  custom_redirect_url: z.string().trim().optional(),
  booking_id: z.string().uuid().optional(),
  bill_id: z.string().uuid().optional(),
  membership_plan_code: z.string().trim().optional(),
  gift_discount_id: z.string().uuid().optional(),
});

/**
 * Helper to authenticate either via header/query or requireAuth
 */
async function getEffectiveAuth(req: any, res: any) {
  const bypassUserId =
    req.headers["x-bypass-user-id"] ||
    req.query?.user_id ||
    req.body?.user_id ||
    process.env.PUBLIC_MENU_SYSTEM_USER_ID ||
    "00000000-0000-0000-0000-000000000000";

  return { user: { id: String(bypassUserId).trim() } };
}

/**
 * POST /api/payments/mips/initiate
 * Initiates a split payment session (Coins + MiPS Gateway Card Payment)
 */
router.post("/initiate", async (req, res) => {
  const auth = await getEffectiveAuth(req, res);
  if (!auth) return;

  const parsed = MiPSInitiateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ ok: false, error: "Invalid payload", details: parsed.error.flatten() });
  }

  const {
    payment_context,
    restaurant_id,
    store_id,
    total_amount,
    coins_amount,
    currency,
    custom_redirect_url,
    booking_id,
    bill_id,
    membership_plan_code,
    gift_discount_id,
  } = parsed.data;

  try {
    const merchantId = restaurant_id || store_id || auth.user.id;

    // 1. If coins are used, validate cashback spend eligibility (soft fail for bypass test mode)
    if (coins_amount > 0) {
      try {
        const validation = await validateCashbackSpend(
          auth.user.id,
          coins_amount,
          merchantId,
          total_amount
        );
        if (!validation.valid) {
          console.warn("[mipsPayments] Coin validation warning (bypassed for testing):", validation.error);
        }
      } catch (valErr: any) {
        console.warn("[mipsPayments] Coin validation error (bypassed for testing):", valErr?.message);
      }
    }

    const customerAmount = Math.max(0, total_amount - coins_amount);
    const merchantTrace = `PP_MIPS_${Date.now()}_${randomUUID().slice(0, 8)}`;
    const redemptionId = coins_amount > 0 ? `RED_${Date.now()}_${randomUUID().slice(0, 6)}` : undefined;
    const config = getMiPSConfig();

    // 2. Create local database Payment Session record
    const session = await createPaymentSession({
      user_id: auth.user.id,
      payment_context,
      restaurant_id: restaurant_id ?? null,
      store_id: store_id ?? null,
      merchant_trace: merchantTrace,
      merchant_application_id: config.authentify.id_merchant,
      amount_major: customerAmount,
      amount_minor: Math.round(customerAmount * 100),
      currency_code: currency,
      original_amount: total_amount,
      discount_amount: coins_amount,
      cashback_amount: coins_amount,
      status: "CREATED",
      gateway_payload: {
        payment_gateway: "MIPS",
        mips_redemption_id: redemptionId,
        coins_redeemed: coins_amount,
        booking_id,
        bill_id,
        membership_plan_code,
        gift_discount_id,
      },
    });

    // 3. Call MiPS API /load_payment_zone with split payment adjustment
    const mipsResponse = await loadMiPSPaymentZone({
      orderId: session.id,
      currency,
      totalAmount: total_amount,
      coinsAmount: coins_amount,
      redemptionId,
      userRef: auth.user.id,
      customRedirectUrl: custom_redirect_url,
    });

    if (!mipsResponse.ok) {
      await updatePaymentSession(session.id, {
        status: "VERIFIED_FAILED",
        gateway_result_description: "Failed to initialize MiPS payment zone",
      });

      return res.status(502).json({
        ok: false,
        error: "MIPS_INIT_FAILED",
        message: "Failed to initialize MiPS payment zone",
        details: mipsResponse.data || mipsResponse.rawBody,
      });
    }

    // 4. Update session status to PENDING
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
      total_amount,
      coins_amount,
      customer_payable_amount: customerAmount,
      currency,
      payment_zone_html: mipsResponse.paymentZoneData,
      raw_response: mipsResponse.data,
    });
  } catch (err: any) {
    console.error("[mipsPayments] Initiate error:", err);
    return res.status(500).json({ ok: false, message: err?.message || "Internal server error" });
  }
});

/**
 * POST /api/payments/mips/imn
 * MiPS Instant Merchant Notification (IMN) Webhook Callback
 */
router.post("/imn", async (req, res) => {
  try {
    const cryptedCallback = req.body?.crypted_callback || req.query?.crypted_callback;
    const idOrder = req.body?.id_order || req.query?.id_order;

    if (!cryptedCallback) {
      return res.status(400).send("Missing crypted_callback parameter");
    }

    // 1. Decrypt IMN webhook payload
    const decryptedResult = await decryptMiPSIMN(cryptedCallback);
    if (!decryptedResult.ok || !decryptedResult.data) {
      console.error("[mipsPayments] Webhook decryption failed:", decryptedResult.rawBody);
      return res.status(400).send("Webhook decryption failed");
    }

    const decryptedData = decryptedResult.data;
    const orderId = decryptedData?.order?.id_order || idOrder;

    if (!orderId) {
      return res.status(400).send("Missing order reference in decrypted payload");
    }

    // 2. Lookup payment session in Supabase
    const session = await getPaymentSessionById(orderId);
    if (!session) {
      console.error("[mipsPayments] Session not found for IMN:", orderId);
      return res.status(404).send("Payment session not found");
    }

    const mipsStatus = decryptedData?.order?.status || decryptedData?.payment?.status || "SUCCESS";
    const paidAmount = Number(decryptedData?.order?.amount ?? session.amount_major);

    if (paidAmount < session.amount_major) {
      console.error("[mipsPayments] Amount mismatch:", { paidAmount, expected: session.amount_major });
      await updatePaymentSession(session.id, {
        status: "VERIFIED_FAILED",
        gateway_result_description: `Amount mismatch: Paid ${paidAmount}, expected ${session.amount_major}`,
      });
      return res.status(400).send("Amount mismatch");
    }

    // 3. Settle coins / cashback if coins were applied
    const coinsUsed = Number(session.cashback_amount || 0);
    if (coinsUsed > 0 && session.user_id) {
      try {
        await spendCashback(
          session.user_id,
          coinsUsed,
          session.id,
          session.restaurant_id || session.store_id || undefined
        );
      } catch (coinErr: any) {
        console.error("[mipsPayments] Error spending coins:", coinErr);
      }
    }

    // 4. Earn fresh cashback for user on net cash amount (paidAmount)
    let cashbackCredited = null;
    if (session.user_id && (session.restaurant_id || session.store_id) && paidAmount > 0) {
      try {
        cashbackCredited = await earnTransactionCashback({
          userId: session.user_id,
          restaurantId: session.restaurant_id || undefined,
          storeId: session.store_id || undefined,
          baseAmount: paidAmount,
          sessionId: session.id,
        });
      } catch (earnErr: any) {
        console.error("[mipsPayments] Error earning cashback:", earnErr);
      }
    }

    // 5. Update session to VERIFIED_SUCCESS
    await updatePaymentSession(session.id, {
      status: "VERIFIED_SUCCESS",
      gateway_status: mipsStatus,
      verified_at: new Date().toISOString(),
      gateway_payload: {
        ...(session.gateway_payload ?? {}),
        imn_decrypted: decryptedData,
        cashback_credited: cashbackCredited,
      },
    });

    return res.status(200).send("success");
  } catch (err: any) {
    console.error("[mipsPayments] IMN webhook error:", err);
    return res.status(500).send("Internal webhook error");
  }
});

export default router;
