import supabase from "../../database/supabase";
import { evaluateApplicableOffers } from "../routes/offers";

interface BillContextInput {
  restaurant_id?: string | null;
  store_id?: string | null;
  item_id?: string | null;
  bill_amount: number;
  quantity?: number;
  selected_offer_ids?: string[];
  payment_instrument_type?: string | null;
  card_network?: string | null;
  issuer_bank_name?: string | null;
  bin?: string | null;
  coupon_code?: string | null;
  user_id?: string | null;
  
}

export class BillPaymentValidationError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "BillPaymentValidationError";
    this.status = status;
  }
}

function validateBillEntitySelection(input: BillContextInput) {
  const hasRestaurantId = typeof input.restaurant_id === "string" && input.restaurant_id.trim().length > 0;
  const hasStoreId = typeof input.store_id === "string" && input.store_id.trim().length > 0;

  if (hasRestaurantId === hasStoreId) {
    throw new BillPaymentValidationError(
      "Bill payment must include exactly one of restaurant_id or store_id"
    );
  }

  return {
    hasRestaurantId,
    hasStoreId,
  };
}

function parseNumeric(value: any) {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
}

function normalizeText(value: any) {
  return String(value ?? "").trim().toUpperCase();
}

function extractOfferCouponCode(offer: any) {
  const candidates = [
    offer?.coupon_code,
    offer?.promo_code,
    offer?.payment_rules?.coupon_code,
    offer?.metadata?.coupon_code,
  ];

  for (const value of candidates) {
    const normalized = String(value ?? "").trim();
    if (normalized.length > 0) return normalized;
  }

  return null;
}

function computeOfferBenefit(offer: any, baseAmount: number) {
  let value = 0;
  if (offer.benefit_percent !== null && offer.benefit_percent !== undefined) {
    value = (baseAmount * Number(offer.benefit_percent)) / 100;
  } else if (offer.benefit_value !== null && offer.benefit_value !== undefined) {
    value = Number(offer.benefit_value);
  }

  const cap = parseNumeric(offer.max_discount_amount);
  if (cap > 0) {
    value = Math.min(value, cap);
  }
  return Math.max(0, Number(value.toFixed(2)));
}

function isCashbackOffer(offer: any) {
  const offerType = normalizeText(offer.offer_type);
  const rewardType = normalizeText(offer.metadata?.reward_type);
  return offerType.includes("CASHBACK") || rewardType === "CASHBACK";
}

function validateSelectedOffers(offers: any[]) {
  const nonStackable = offers.find((offer) => offer.is_stackable !== true);
  if (nonStackable && offers.length > 1) {
    throw new BillPaymentValidationError(
      `Offer ${nonStackable.id} cannot be stacked with other offers`
    );
  }

  const seenGroups = new Set<string>();
  for (const offer of offers) {
    const stackGroup = String(offer.stack_group ?? "").trim();
    if (!stackGroup) continue;
    if (seenGroups.has(stackGroup)) {
      throw new BillPaymentValidationError(
        `Offers in stack group ${stackGroup} cannot be combined`
      );
    }
    seenGroups.add(stackGroup);
  }
}

function offerPriorityValue(offer: any) {
  const raw = Number(offer?.priority ?? offer?.sort_order ?? 0);
  return Number.isFinite(raw) ? raw : 0;
}

function pickBestOffer(candidates: any[], baseAmount: number) {
  if (!candidates.length) return null;
  const scored = [...candidates].sort((a, b) => {
    const benefitDiff = computeOfferBenefit(b, baseAmount) - computeOfferBenefit(a, baseAmount);
    if (benefitDiff !== 0) return benefitDiff;
    const priorityDiff = offerPriorityValue(b) - offerPriorityValue(a);
    if (priorityDiff !== 0) return priorityDiff;
    return String(b?.id ?? "").localeCompare(String(a?.id ?? ""));
  });
  return scored[0] ?? null;
}

function normalizeOffersForStacking(offers: any[], baseAmount: number) {
  if (offers.length <= 1) return offers;

  const nonStackables = offers.filter((offer) => offer.is_stackable !== true);
  if (nonStackables.length > 0) {
    const best = pickBestOffer(nonStackables, baseAmount);
    return best ? [best] : [];
  }

  const bestByGroup = new Map<string, any>();
  const withoutGroup: any[] = [];

  for (const offer of offers) {
    const group = String(offer?.stack_group ?? "").trim();
    if (!group) {
      withoutGroup.push(offer);
      continue;
    }

    const currentBest = bestByGroup.get(group);
    if (!currentBest) {
      bestByGroup.set(group, offer);
      continue;
    }

    const better = pickBestOffer([currentBest, offer], baseAmount);
    bestByGroup.set(group, better);
  }

  return [...withoutGroup, ...Array.from(bestByGroup.values())];
}

function normalizeDiscountSource(value: any): "NONE" | "BANK" | "PLATFORM" | "PARTNER" {
  const normalized = normalizeText(value);
  if (normalized === "BANK") return "BANK";
  if (normalized === "PARTNER" || normalized === "MERCHANT") return "PARTNER";
  if (normalized === "PLATFORM") return "PLATFORM";
  return "NONE";
}

function deriveDiscountSourceFromOffers(offers: any[]): "NONE" | "BANK" | "PLATFORM" | "PARTNER" {
  if (!offers.length) return "NONE";
  const mapped = offers.map((offer) =>
    normalizeDiscountSource(offer?.source_type ?? offer?.sponsor_type ?? offer?.metadata?.discount_source)
  );
  if (mapped.includes("BANK")) return "BANK";
  if (mapped.includes("PARTNER")) return "PARTNER";
  if (mapped.includes("PLATFORM")) return "PLATFORM";
  return "NONE";
}

function extractRestaurantMinimumBillAmount(offer: any) {
  if (offer === null || offer === undefined) return null;

  if (typeof offer === "object" && !Array.isArray(offer)) {
    const rawAmount = (offer as Record<string, any>).minimum_bill_amount;
    if (rawAmount === "" || rawAmount === null || rawAmount === undefined) return null;
    const parsed = Number(rawAmount);
    if (!Number.isFinite(parsed) || parsed < 0) return null;
    return parsed;
  }

  return null;
}

export async function buildBillPaymentContext(input: BillContextInput) {
  const quantity = input.quantity ?? 1;
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new BillPaymentValidationError("Quantity must be a positive integer");
  }

  const { hasRestaurantId, hasStoreId } = validateBillEntitySelection(input);
  const originalAmount = Number(parseNumeric(input.bill_amount).toFixed(2));
  if (originalAmount <= 0) {
    throw new BillPaymentValidationError("bill_amount must be greater than zero");
  }

  let entityType: "RESTAURANT" | "STORE";
  let entityId: string;
  let entity: any;
  let item: any = null;

  if (hasRestaurantId) {
    const { data: restaurant, error: restaurantError } = await supabase
      .from("restaurants")
      .select("*")
      .eq("id", input.restaurant_id!)
      .maybeSingle();

    if (restaurantError) throw restaurantError;
    if (!restaurant || restaurant.is_active !== true) {
      throw new BillPaymentValidationError("Restaurant not found", 404);
    }

    const minimumBillAmount = extractRestaurantMinimumBillAmount(restaurant.offer);
    if (minimumBillAmount !== null && originalAmount < minimumBillAmount) {
      throw new BillPaymentValidationError("Minimum bill not met");
    }

    entityType = "RESTAURANT";
    entityId = restaurant.id;
    entity = restaurant;
  } else {
    const { data: store, error: storeError } = await supabase
      .from("stores")
      .select("*")
      .eq("id", input.store_id!)
      .maybeSingle();

    if (storeError) throw storeError;
    if (!store) throw new BillPaymentValidationError("Store not found", 404);


    if (input.item_id) {
      const { data: storeItem, error: itemError } = await supabase
        .from("store_catalogue_items")
        .select("*")
        .eq("id", input.item_id)
        .eq("store_id", input.store_id!)
        .maybeSingle();

      if (itemError) throw itemError;
      if (!storeItem) throw new BillPaymentValidationError("Billable item not found", 404);
      if (storeItem.is_billable !== true) {
        throw new BillPaymentValidationError("Selected item is not billable");
      }

      item = storeItem;
    }

    entityType = "STORE";
    entityId = store.id;
    entity = store;
  }

  const offerEvaluation = await evaluateApplicableOffers({
    entityType,
    entityId,
    query: {
      payment_flow: "BILL_PAYMENT",
      bill_amount: originalAmount,
      payment_instrument_type: input.payment_instrument_type ?? undefined,
      card_network: input.card_network ?? undefined,
      issuer_bank_name: input.issuer_bank_name ?? undefined,
      bin: input.bin ?? undefined,
      user_id: input.user_id ?? undefined,
      coupon_code: input.coupon_code ?? undefined,
    },
  });

  if (offerEvaluation.status !== 200) {
    throw new Error("Failed to evaluate offers for bill payment");
  }

  const selectedOfferIds = input.selected_offer_ids ?? [];
  const eligibleOffers = offerEvaluation.body.items ?? [];
  const normalizedCouponCode = String(input.coupon_code ?? "").trim().toUpperCase();
  let selectedOffers = eligibleOffers.filter((offer: any) => selectedOfferIds.includes(offer.id));

  if (selectedOfferIds.length === 0 && normalizedCouponCode) {
    selectedOffers = eligibleOffers.filter((offer: any) => {
      const offerCoupon = extractOfferCouponCode(offer);
      return offerCoupon ? offerCoupon.toUpperCase() === normalizedCouponCode : false;
    });

    if (selectedOffers.length === 0) {
      throw new BillPaymentValidationError("Provided coupon code is not eligible for this bill");
    }
  }

  if (selectedOfferIds.length === 0 && !normalizedCouponCode) {
    selectedOffers = eligibleOffers.filter((offer: any) => offer?.is_auto_apply === true);
  }

  if (selectedOfferIds.length > 0 && selectedOffers.length !== selectedOfferIds.length) {
    throw new BillPaymentValidationError("One or more selected offers are no longer eligible");
  }

  selectedOffers = normalizeOffersForStacking(selectedOffers, originalAmount);
  validateSelectedOffers(selectedOffers);

  let discountAmount = 0;
  let cashbackAmount = 0;
  for (const offer of selectedOffers) {
    const benefit = computeOfferBenefit(offer, originalAmount);
    if (isCashbackOffer(offer)) {
      cashbackAmount += benefit;
    } else {
      discountAmount += benefit;
    }
  }

  discountAmount = Number(discountAmount.toFixed(2));
  cashbackAmount = Number(cashbackAmount.toFixed(2));
  const payableAmount = Number(Math.max(0, originalAmount - discountAmount).toFixed(2));
  const discountSource = deriveDiscountSourceFromOffers(selectedOffers);
  const primaryOffer = selectedOffers[0] ?? null;
  const derivedDiscountCode = [
    input.coupon_code,
    primaryOffer?.coupon_code,
    primaryOffer?.promo_code,
    primaryOffer?.payment_rules?.coupon_code,
    primaryOffer?.metadata?.coupon_code,
  ]
    .map((value) => String(value ?? "").trim())
    .find((value) => value.length > 0) ?? null;

  return {
    entityType,
    entity,
    restaurant: entityType === "RESTAURANT" ? entity : null,
    store: entityType === "STORE" ? entity : null,
    item,
    quantity,
    originalAmount,
    discountAmount,
    cashbackAmount,
    payableAmount,
    selectedOffers,
    discountSource,
    discountCode: derivedDiscountCode,
    discountName: primaryOffer ? String(primaryOffer.title ?? primaryOffer.offer_type ?? "Offer") : null,
    discountMeta: {
      selected_offer_ids: selectedOffers.map((offer: any) => offer.id),
      selected_offers: selectedOffers.map((offer: any) => ({
        id: offer.id,
        title: offer.title,
        source_type: offer.source_type ?? null,
        offer_type: offer.offer_type ?? null,
      })),
    },
    eligibleOffers,
    lineItemDescription:
      item?.title ??
      (entityType === "RESTAURANT"
        ? `Restaurant bill payment - ${entity.name ?? entity.title ?? entity.id}`
        : `Store bill payment - ${entity.name ?? entity.title ?? entity.id}`),
  };
}

export async function finalizeBillPayment(params: {
  session: any;
  userId: string;
}) {
  const contextPayload = params.session.gateway_payload?.context_payload;
  if (!contextPayload) {
    throw new Error("Missing bill payment context payload");
  }

  const billPayload =
    contextPayload.bill_payload && typeof contextPayload.bill_payload === "object"
      ? contextPayload.bill_payload
      : contextPayload;

  const recalculated = await buildBillPaymentContext({
    restaurant_id: contextPayload.restaurant_id ?? billPayload.restaurant_id ?? null,
    store_id: contextPayload.store_id ?? billPayload.store_id ?? null,
    ...billPayload,
    user_id: params.userId,
  });

  if (Number(recalculated.payableAmount.toFixed(2)) !== Number(params.session.amount_major)) {
    throw new Error("Verified bill amount does not match the initiated payment session");
  }

  const existing = await supabase
    .from("bill_payments")
    .select("*")
    .eq("payment_session_id", params.session.id)
    .maybeSingle();

  if (existing.error) throw existing.error;
  if (existing.data) {
    return {
      billPayment: existing.data,
      redemptions: [],
      duplicate: true,
    };
  }

  const { data: billPayment, error: billPaymentError } = await supabase
    .from("bill_payments")
    .insert({
      payment_session_id: params.session.id,
      user_id: params.userId,
      restaurant_id: recalculated.restaurant?.id ?? null,
      store_id: recalculated.store?.id ?? null,
      item_id: recalculated.item?.id ?? null,
      quantity: recalculated.quantity,
      currency_code: params.session.currency_code,
      original_amount: recalculated.originalAmount,
      discount_amount: recalculated.discountAmount,
      cashback_amount: recalculated.cashbackAmount,
      final_paid_amount: recalculated.payableAmount,
      payment_provider: "IVERI",
      gateway_transaction_index: params.session.transaction_index ?? null,
      gateway_authorization_code: params.session.authorization_code ?? null,
      gateway_bank_reference: params.session.bank_reference ?? null,
      status: "PAID",
      offer_breakdown: recalculated.selectedOffers.map((offer: any) => ({
        id: offer.id,
        title: offer.title,
        offer_type: offer.offer_type,
      })),
    })
    .select("*")
    .single();

  if (billPaymentError) throw billPaymentError;

  const redemptions: any[] = [];
  for (const offer of recalculated.selectedOffers) {
    const benefit = computeOfferBenefit(offer, recalculated.originalAmount);
    const isRestaurant = recalculated.entityType === "RESTAURANT";
    const paymentReference =
      params.session.transaction_index ?? params.session.bank_reference ?? params.session.merchant_trace ?? null;
    const finalAmount = Number(Math.max(0, recalculated.originalAmount - benefit).toFixed(2));
    const { data: redemption, error: redemptionError } = await supabase
      .from("offer_redemptions")
      .insert({
        offer_id: offer.id,
        entity_type: recalculated.entityType,
        restaurant_id: isRestaurant ? recalculated.restaurant.id : null,
        store_id: isRestaurant ? null : recalculated.store.id,
        user_id: params.userId,
        order_reference: billPayment.id,
        payment_reference: paymentReference,
        original_amount: recalculated.originalAmount,
        discount_amount: benefit,
        final_amount: finalAmount,
        currency_code: params.session.currency_code,
        redemption_status: "APPLIED",
        redeemed_at: new Date().toISOString(),
        metadata: {
          payment_session_id: params.session.id,
          payment_context: "BILL_PAYMENT",
          cashback: isCashbackOffer(offer),
        },
      })
      .select("*")
      .single();

    if (redemptionError) throw redemptionError;
    redemptions.push(redemption);
  }

  return {
    billPayment,
    redemptions,
    duplicate: false,
  };
}
