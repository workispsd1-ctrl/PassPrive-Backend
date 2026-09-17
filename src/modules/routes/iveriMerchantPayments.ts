import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../services/authService";
import {
  deactivateUserCardToken,
  executeIveriMerchantCharge,
  getUserCardTokens,
  saveUserCardToken,
} from "../services/iveriMerchantService";
import { getPaymentSessionById } from "../services/paymentSessionService";

const router = Router();

const ChargeSchema = z.object({
  token_id: z.string().uuid(),
  partner_type: z.enum(["RESTAURANT", "STORE"]),
  restaurant_id: z.string().uuid().optional(),
  store_id: z.string().uuid().optional(),
  amount_major: z.coerce.number().positive(),
  currency_code: z.string().trim().length(3).optional(),
  description: z.string().trim().max(500).optional(),
  plan_code: z.string().trim().max(50).optional(),
  duration_months: z.coerce.number().int().positive().optional(),
}).superRefine((data, ctx) => {
  if (data.partner_type === "RESTAURANT" && !data.restaurant_id) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["restaurant_id"], message: "restaurant_id required for RESTAURANT partner" });
  }
  if (data.partner_type === "STORE" && !data.store_id) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["store_id"], message: "store_id required for STORE partner" });
  }
});

const SaveTokenFromSessionSchema = z.object({
  payment_session_id: z.string().uuid(),
  partner_type: z.enum(["RESTAURANT", "STORE", "GLOBAL"]).default("GLOBAL"),
  restaurant_id: z.string().uuid().optional(),
  store_id: z.string().uuid().optional(),
});

router.get("/tokens", async (req, res) => {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  try {
    const restaurantId = typeof req.query.restaurant_id === "string" ? req.query.restaurant_id.trim() : null;
    const storeId = typeof req.query.store_id === "string" ? req.query.store_id.trim() : null;

    const tokens = await getUserCardTokens({
      userId: auth.user.id,
      restaurantId,
      storeId,
    });

    return res.json({ ok: true, tokens });
  } catch (err: any) {
    return res.status(500).json({ ok: false, message: err?.message || "Failed to fetch card tokens" });
  }
});

router.post("/save-token", async (req, res) => {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const parsed = SaveTokenFromSessionSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ ok: false, error: "Invalid save-token payload", details: parsed.error.flatten() });
  }

  try {
    const session = await getPaymentSessionById(parsed.data.payment_session_id);
    if (!session) {
      return res.status(404).json({ ok: false, message: "Payment session not found" });
    }
    if (session.user_id !== auth.user.id) {
      return res.status(403).json({ ok: false, message: "Access denied" });
    }
    if (session.status !== "VERIFIED_SUCCESS" && session.status !== "FINALIZED") {
      return res.status(409).json({ ok: false, message: `Session status ${session.status} is not verified` });
    }
    if (!session.transaction_index) {
      return res.status(400).json({ ok: false, message: "No transaction_index token returned by gateway" });
    }

    const maskedPan =
      session.gateway_payload?.authorise_info_response?.fields?.Ecom_Payment_Card_Number ||
      session.gateway_payload?.last_webhook_payload?.Ecom_Payment_Card_Number ||
      "4242....4242";

    const cardBrand =
      session.gateway_payload?.authorise_info_response?.fields?.Ecom_Payment_Card_Type ||
      session.gateway_payload?.last_webhook_payload?.Ecom_Payment_Card_Type ||
      "CARD";

    const savedToken = await saveUserCardToken({
      userId: auth.user.id,
      partnerType: parsed.data.partner_type,
      restaurantId: parsed.data.restaurant_id || session.restaurant_id,
      storeId: parsed.data.store_id || session.store_id,
      transactionIndex: session.transaction_index,
      maskedPan,
      cardBrand,
    });

    return res.status(201).json({ ok: true, token: savedToken });
  } catch (err: any) {
    return res.status(500).json({ ok: false, message: err?.message || "Failed to save card token" });
  }
});

router.post("/charge", async (req, res) => {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const parsed = ChargeSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ ok: false, error: "Invalid charge payload", details: parsed.error.flatten() });
  }

  try {
    const result = await executeIveriMerchantCharge({
      userId: auth.user.id,
      tokenId: parsed.data.token_id,
      partnerType: parsed.data.partner_type,
      restaurantId: parsed.data.restaurant_id,
      storeId: parsed.data.store_id,
      amountMajor: parsed.data.amount_major,
      currencyCode: parsed.data.currency_code,
      description: parsed.data.description,
      planCode: parsed.data.plan_code,
      durationMonths: parsed.data.duration_months,
    });

    if (!result.ok) {
      return res.status(400).json({
        ok: false,
        code: "CHARGE_DECLINED",
        message: result.error || "Payment was declined by gateway",
        session_id: result.session?.id ?? null,
      });
    }

    return res.status(200).json({
      ok: true,
      session_id: result.session?.id,
      status: result.session?.status,
      transaction_index: result.transaction_index,
      subscription: result.subscription,
    });
  } catch (err: any) {
    return res.status(500).json({ ok: false, message: err?.message || "Failed to execute merchant charge" });
  }
});

router.delete("/tokens/:id", async (req, res) => {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  try {
    const deactivated = await deactivateUserCardToken(req.params.id, auth.user.id);
    if (!deactivated) {
      return res.status(404).json({ ok: false, message: "Token not found" });
    }
    return res.json({ ok: true, deactivated_id: deactivated.id });
  } catch (err: any) {
    return res.status(500).json({ ok: false, message: err?.message || "Failed to deactivate card token" });
  }
});

export default router;
