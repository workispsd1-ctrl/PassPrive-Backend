import test from "node:test";
import assert from "node:assert/strict";
import { InitiateSchema } from "../routes/payments";
import {
  buildMembershipPaymentContext,
  finalizeMembershipPayment,
  MembershipPaymentValidationError,
} from "./membershipPaymentService";

function createDbMock(params: {
  subscription?: any;
  promosByCode?: Record<string, any>;
}) {
  const updates: { users?: any } = {};

  const db = {
    updates,
    from(table: string) {
      const state: {
        eqFilters: Record<string, any>;
        updatePayload: any;
      } = {
        eqFilters: {},
        updatePayload: null,
      };

      const chain = {
        select() {
          return chain;
        },
        eq(key: string, value: any) {
          state.eqFilters[key] = value;
          return chain;
        },
        update(payload: any) {
          state.updatePayload = payload;
          return chain;
        },
        async maybeSingle() {
          if (table === "subscription") {
            const subscription = params.subscription ?? null;
            const matches =
              subscription && (!state.eqFilters.id || String(subscription.id) === String(state.eqFilters.id));
            return { data: matches ? subscription : null, error: null };
          }
          if (table === "promos") {
            const code = String(state.eqFilters.code ?? "");
            return { data: params.promosByCode?.[code] ?? null, error: null };
          }
          return { data: null, error: null };
        },
        async single() {
          if (table === "users" && state.updatePayload && state.eqFilters.id) {
            updates.users = state.updatePayload;
            return {
              data: { id: state.eqFilters.id, ...state.updatePayload },
              error: null,
            };
          }
          return { data: null, error: new Error("No mock single() result configured") };
        },
      };

      return chain;
    },
  };

  return db;
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
  const db = createDbMock({
    subscription: null,
  });

  await assert.rejects(
    () =>
      buildMembershipPaymentContext({
        userId: "u1",
        payload: {
          plan_id: "c48cfa19-39dc-4505-bc14-ff96ea03c2f4",
          plan_name: "Premium",
          price_id: "price_123",
          product_id: "prod_123",
          amount: 999,
          payment_instrument_type: "CARD",
        },
        db,
      }),
    (error: any) =>
      error instanceof MembershipPaymentValidationError &&
      error.status === 404 &&
      String(error.message).includes("Invalid membership plan")
  );
});

test("MEMBERSHIP invalid promo is rejected", async () => {
  const db = createDbMock({
    subscription: {
      id: "c48cfa19-39dc-4505-bc14-ff96ea03c2f4",
      plan_name: "Premium",
      amount: 1000,
      type: "month",
      product_id: "prod_123",
      price_id: "price_123",
    },
    promosByCode: {},
  });

  await assert.rejects(
    () =>
      buildMembershipPaymentContext({
        userId: "u1",
        payload: {
          plan_id: "c48cfa19-39dc-4505-bc14-ff96ea03c2f4",
          plan_name: "Premium",
          price_id: "price_123",
          product_id: "prod_123",
          amount: 1000,
          promo_code: "BADCODE",
          payment_instrument_type: "CARD",
        },
        db,
      }),
    (error: any) =>
      error instanceof MembershipPaymentValidationError &&
      error.status === 400 &&
      String(error.message).includes("Invalid promo code")
  );
});

test("MEMBERSHIP valid promo applies server-side discount", async () => {
  const db = createDbMock({
    subscription: {
      id: "c48cfa19-39dc-4505-bc14-ff96ea03c2f4",
      plan_name: "Premium",
      amount: 1000,
      type: "month",
      product_id: "prod_123",
      price_id: "price_123",
    },
    promosByCode: {
      NEW10: {
        code: "NEW10",
        plans: ["Premium"],
        discount: 10,
        valid_date: "2099-12-31",
        valid_time: null,
      },
    },
  });

  const context = await buildMembershipPaymentContext({
    userId: "u1",
    payload: {
      plan_id: "c48cfa19-39dc-4505-bc14-ff96ea03c2f4",
      plan_name: "Premium",
      price_id: "price_123",
      product_id: "prod_123",
      amount: 1000,
      promo_code: "NEW10",
      payment_instrument_type: "CARD",
    },
    db,
  });

  assert.equal(context.originalAmount, 1000);
  assert.equal(context.discountAmount, 100);
  assert.equal(context.finalAmount, 900);
  assert.equal(context.promo?.code, "NEW10");
});

test("MEMBERSHIP finalize updates users and is idempotent", async () => {
  const db = createDbMock({
    subscription: {
      id: "c48cfa19-39dc-4505-bc14-ff96ea03c2f4",
      plan_name: "Premium",
      amount: 1000,
      type: "month",
      product_id: "prod_123",
      price_id: "price_123",
    },
  });

  const first = await finalizeMembershipPayment({
    session: {
      id: "sess_1",
      merchant_trace: "trace_1",
      gateway_payload: {
        membership_purchase: {
          plan_id: "c48cfa19-39dc-4505-bc14-ff96ea03c2f4",
          plan_name: "Premium",
          promo_code: "NEW10",
          validity_type: "month",
        },
      },
    },
    userId: "user_1",
    db,
  });

  assert.equal(first.duplicate, false);
  assert.equal(first.user?.membership, "active");
  assert.ok(first.user?.membership_expiry);
  assert.ok(db.updates.users);

  const second = await finalizeMembershipPayment({
    session: {
      id: "sess_1",
      merchant_trace: "trace_1",
      gateway_payload: {
        finalized_membership: {
          applied: true,
          user_id: "user_1",
          plan_id: "c48cfa19-39dc-4505-bc14-ff96ea03c2f4",
        },
      },
    },
    userId: "user_1",
    db,
  });

  assert.equal(second.duplicate, true);
});
