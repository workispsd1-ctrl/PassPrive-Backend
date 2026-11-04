import test from "node:test";
import assert from "node:assert/strict";
import { InitiateSchema } from "../routes/payments";
import {
  buildMembershipPaymentContext,
  finalizeMembershipPayment,
  MembershipPaymentValidationError,
} from "./membershipPaymentService";

const PLAN_ID = "c48cfa19-39dc-4505-bc14-ff96ea03c2f4";

function createDbMock(params: {
  subscription?: any;
  currentTier?: string;
  membershipExpiry?: string | null;
  rpcResult?: { data: any; error: any };
}) {
  const calls: { rpc: Array<{ name: string; args: any }> } = { rpc: [] };

  const db = {
    calls,
    from(table: string) {
      const filters: Record<string, any> = {};
      const chain = {
        select() {
          return chain;
        },
        eq(key: string, value: any) {
          filters[key] = value;
          return chain;
        },
        async maybeSingle() {
          if (table === "subscription") {
            const row = params.subscription ?? null;
            const matches = row && (!filters.id || String(row.id) === String(filters.id));
            return { data: matches ? row : null, error: null };
          }
          if (table === "users") {
            return { data: { membership_expiry: params.membershipExpiry ?? null }, error: null };
          }
          return { data: null, error: null };
        },
      };
      return chain;
    },
    async rpc(name: string, args: any) {
      calls.rpc.push({ name, args });
      if (name === "user_tier_slug") return { data: params.currentTier ?? "free", error: null };
      return params.rpcResult ?? { data: null, error: null };
    },
  };

  return db;
}

function plan(overrides: Record<string, any> = {}) {
  return {
    id: PLAN_ID,
    plan_name: "Privé Black",
    amount: "583",
    type: "month",
    tier: "black",
    product_id: "black_tier",
    price_id: "black_tier",
    ...overrides,
  };
}

function payload(overrides: Record<string, any> = {}) {
  return {
    plan_id: PLAN_ID,
    plan_name: "Privé Black",
    price_id: "black_tier",
    product_id: "black_tier",
    amount: 583,
    payment_instrument_type: "CARD",
    ...overrides,
  };
}

test("BOOKING initiate payload remains valid", () => {
  const result = InitiateSchema.safeParse({
    payment_context: "BOOKING",
    restaurant_id: "5e3cee2c-ae92-44dd-bf9b-94ff75fa9424",
    booking_payload: {
      restaurant: "5e3cee2c-ae92-44dd-bf9b-94ff75fa9424",
      selectedDate: "2099-01-01",
      selectedTime: "19:30",
      guests: 2,
    },
  });
  assert.equal(result.success, true);
});

test("BILL_PAYMENT initiate payload remains valid", () => {
  const result = InitiateSchema.safeParse({
    payment_context: "BILL_PAYMENT",
    store_id: "6028c12d-db7c-4c23-9864-ff787cc3d259",
    bill_payload: {
      bill_amount: 1200,
      quantity: 1,
    },
  });
  assert.equal(result.success, true);
});

test("MEMBERSHIP initiate payload validation works", () => {
  const result = InitiateSchema.safeParse({
    payment_context: "MEMBERSHIP",
    membership_payload: {
      plan_id: "c48cfa19-39dc-4505-bc14-ff96ea03c2f4",
      plan_name: "Premium 3 Months",
      price_id: "price_123",
      product_id: "prod_123",
      amount: 1000,
      original_amount: 1000,
      discount_amount: 0,
      promo_code: "NEW10",
      payment_instrument_type: "CARD",
    },
  });
  assert.equal(result.success, true);
});

test("MEMBERSHIP invalid plan is rejected", async () => {
  const db = createDbMock({ subscription: null });
  await assert.rejects(
    () => buildMembershipPaymentContext({ userId: "u1", payload: payload(), db }),
    (error: any) => error instanceof MembershipPaymentValidationError && error.status === 404
  );
});

test("MEMBERSHIP price, duration and plan name come from the plan row, not the client", async () => {
  const db = createDbMock({ subscription: plan() });
  const context = await buildMembershipPaymentContext({
    userId: "u1",
    payload: payload({ amount: 1, plan_name: "Privé Black Lifetime", validity_days: 3650, subscription_type: "1year" }),
    db,
  });
  assert.equal(context.finalAmount, 583);
  assert.equal(context.originalAmount, 583);
  assert.equal(context.discountAmount, 0);
  assert.equal(context.durationDays, 30);
  assert.equal(context.membershipTier, "Privé Black");
  assert.equal(context.metadata.membership_purchase.validity_type, "month");
});

test("MEMBERSHIP promo codes are rejected", async () => {
  const db = createDbMock({ subscription: plan() });
  await assert.rejects(
    () => buildMembershipPaymentContext({ userId: "u1", payload: payload({ promo_code: "NEW10" }), db }),
    (error: any) => error instanceof MembershipPaymentValidationError && error.status === 400
  );
});

test("MEMBERSHIP price_id mismatch is rejected", async () => {
  const db = createDbMock({ subscription: plan() });
  await assert.rejects(
    () => buildMembershipPaymentContext({ userId: "u1", payload: payload({ price_id: "other" }), db }),
    (error: any) => error instanceof MembershipPaymentValidationError && error.status === 400
  );
});

test("MEMBERSHIP free tier cannot be purchased", async () => {
  const db = createDbMock({ subscription: plan({ tier: "free", amount: "100" }) });
  await assert.rejects(
    () => buildMembershipPaymentContext({ userId: "u1", payload: payload(), db }),
    (error: any) => error instanceof MembershipPaymentValidationError && error.status === 400
  );
});

test("MEMBERSHIP downgrade while a higher plan is active is rejected", async () => {
  const db = createDbMock({ subscription: plan({ tier: "plus", plan_name: "Privé Premium" }), currentTier: "black" });
  await assert.rejects(
    () => buildMembershipPaymentContext({ userId: "u1", payload: payload(), db }),
    (error: any) => error instanceof MembershipPaymentValidationError && error.status === 409
  );
});

test("MEMBERSHIP same-tier renewal is allowed when the plan has an end date", async () => {
  const db = createDbMock({ subscription: plan(), currentTier: "black", membershipExpiry: "2099-01-01T00:00:00Z" });
  const context = await buildMembershipPaymentContext({ userId: "u1", payload: payload(), db });
  assert.equal(context.finalAmount, 583);
});

test("MEMBERSHIP same-tier renewal of a membership without end date is rejected", async () => {
  const db = createDbMock({ subscription: plan(), currentTier: "black", membershipExpiry: null });
  await assert.rejects(
    () => buildMembershipPaymentContext({ userId: "u1", payload: payload(), db }),
    (error: any) => error instanceof MembershipPaymentValidationError && error.status === 409
  );
});

test("MEMBERSHIP upgrade from plus to black is allowed", async () => {
  const db = createDbMock({ subscription: plan(), currentTier: "plus" });
  const context = await buildMembershipPaymentContext({ userId: "u1", payload: payload(), db });
  assert.equal(context.finalAmount, 583);
});

test("MEMBERSHIP finalize delegates to the locked database function", async () => {
  const db = createDbMock({
    rpcResult: {
      data: { duplicate: false, membership: { applied: true, mode: "new" }, user: { id: "user_1", membership: "active" } },
      error: null,
    },
  });
  const result = await finalizeMembershipPayment({ session: { id: "sess_1", user_id: "user_1" }, userId: "user_1", db });
  assert.equal(result.duplicate, false);
  assert.equal(result.membership?.mode, "new");
  assert.deepEqual(db.calls.rpc[db.calls.rpc.length - 1], { name: "finalize_membership_session", args: { p_session_id: "sess_1" } });
});

test("MEMBERSHIP finalize reports duplicates from the database", async () => {
  const db = createDbMock({ rpcResult: { data: { duplicate: true, membership: { applied: true } }, error: null } });
  const result = await finalizeMembershipPayment({ session: { id: "sess_1", user_id: "user_1" }, userId: "user_1", db });
  assert.equal(result.duplicate, true);
});

test("MEMBERSHIP finalize refuses another user's session", async () => {
  const db = createDbMock({});
  await assert.rejects(
    () => finalizeMembershipPayment({ session: { id: "sess_1", user_id: "someone_else" }, userId: "user_1", db }),
    (error: any) => error instanceof MembershipPaymentValidationError && error.status === 403
  );
  assert.equal(db.calls.rpc.length, 0);
});

test("MEMBERSHIP finalize maps an unverified session to 409", async () => {
  const db = createDbMock({
    rpcResult: { data: null, error: { code: "22023", message: "Payment session has not been verified as successful" } },
  });
  await assert.rejects(
    () => finalizeMembershipPayment({ session: { id: "sess_1", user_id: "user_1" }, userId: "user_1", db }),
    (error: any) => error instanceof MembershipPaymentValidationError && error.status === 409
  );
});

test("GIFT_PURCHASE initiate payload remains valid if <= 2000", () => {
  const result = InitiateSchema.safeParse({
    payment_context: "GIFT_PURCHASE",
    original_amount: 1500,
  });
  assert.equal(result.success, true);
});

test("GIFT_PURCHASE initiate payload is rejected if > 2000", () => {
  const result = InitiateSchema.safeParse({
    payment_context: "GIFT_PURCHASE",
    original_amount: 2500,
  });
  assert.equal(result.success, false);
  if (!result.success) {
    assert.ok(result.error.message.includes("original_amount cannot exceed 2000 for GIFT_PURCHASE"));
  }
});
