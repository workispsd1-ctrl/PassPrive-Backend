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
});

const roundMoney = (value: number) => Math.round(value * 100) / 100;

router.post("/initiate", async (req, res) => {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const parsed = MiPSInitiateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ ok: false, error: "Invalid payload", details: parsed.error.flatten() });
  }

  const { payment_context, restaurant_id, store_id, total_amount, currency, custom_redirect_url, bill_id } = parsed.data;

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

router.all("/imn", async (req, res) => {
  try {
    const cryptedCallback = req.body?.crypted_callback || req.query?.crypted_callback;
    const idOrder = String(req.query?.id_order || req.body?.id_order || "");

    if (!cryptedCallback) {
      return res.status(400).send("Missing crypted_callback parameter");
    }

    const decrypted = await decryptMiPSIMN(String(cryptedCallback));
    const data = decrypted.data && typeof decrypted.data === "object" ? decrypted.data : null;
    if (!decrypted.ok || !data) {
      console.error("[mipsPayments] IMN decryption failed:", decrypted.statusCode);
      return res.status(400).send("Invalid Sender.");
    }

    const config = getMiPSConfig();
    if (!verifyMiPSChecksum(data, config.hashSalt)) {
      console.error("[mipsPayments] IMN checksum mismatch for order", idOrder);
      return res.status(400).send("Invalid Sender.");
    }

    const orderId = idOrder || String(data?.id_order || data?.order?.id_order || "");
    if (!orderId) {
      return res.status(400).send("Missing order reference");
    }

    const session = await getPaymentSessionById(orderId);
    if (!session || session.payment_provider !== "MIPS") {
      console.error("[mipsPayments] Session not found for IMN:", orderId);
      return res.status(404).send("Payment session not found");
    }

    const status = String(data.status || "").toLowerCase();

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
      return res.status(200).send("success");
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
    console.error("[mipsPayments] IMN webhook error:", err);
    return res.status(500).send("Internal webhook error");
  }
});

export default router;
