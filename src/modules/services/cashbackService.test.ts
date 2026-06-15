import test from "node:test";
import assert from "node:assert/strict";
import { validateCashbackSpend } from "./cashbackService";

function createDbMock(params: {
  rules?: any;
  merchant?: any;
  transactions?: any[];
  lots?: any[];
}) {
  const db = {
    from(table: string) {
      const state: {
        eqFilters: Record<string, any>;
        gtFilters: Record<string, any>[];
        gteFilters: Record<string, any>;
      } = {
        eqFilters: {},
        gtFilters: [],
        gteFilters: {},
      };

      const chain = {
        select(cols?: string) {
          return chain;
        },
        eq(key: string, value: any) {
          state.eqFilters[key] = value;
          return chain;
        },
        gt(key: string, value: any) {
          state.gtFilters.push({ key, value });
          return chain;
        },
        gte(key: string, value: any) {
          state.gteFilters[key] = value;
          return chain;
        },
        async maybeSingle() {
          if (table === "cashback_rules") {
            return { data: params.rules ?? null, error: null };
          }
          if (table === "users") {
            const mId = state.eqFilters.id;
            if (params.merchant && String(params.merchant.id) === String(mId)) {
              return { data: params.merchant, error: null };
            }
            return { data: null, error: null };
          }
          return { data: null, error: null };
        },
        async then(resolve: any) {
          if (table === "cashback_transactions") {
            // Filter by user_id and type
            let data = params.transactions || [];
            if (state.eqFilters.user_id) {
              data = data.filter((t) => t.user_id === state.eqFilters.user_id);
            }
            if (state.eqFilters.type) {
              data = data.filter((t) => t.type === state.eqFilters.type);
            }
            resolve({ data, error: null });
            return;
          }
          if (table === "cashback_lots") {
            let data = params.lots || [];
            if (state.eqFilters.user_id) {
              data = data.filter((l) => l.user_id === state.eqFilters.user_id);
            }
            resolve({ data, error: null });
            return;
          }
          resolve({ data: [], error: null });
        },
      };

      return chain;
    },
  };

  return db;
}

test("validateCashbackSpend returns failure when active rules are not found", async () => {
  const db = createDbMock({
    rules: null,
  });

  const res = await validateCashbackSpend("user-1", 100, "merchant-1", 1000, db);
  assert.equal(res.valid, false);
  assert.equal(res.error, "Active cashback rules configuration not found");
});

test("validateCashbackSpend returns failure when merchant is not whitelisted", async () => {
  const db = createDbMock({
    rules: {
      min_purchase_amount: 500,
      max_use_per_transaction: 500,
      max_use_per_month: 2000,
      max_transactions_per_month: 5,
    },
    merchant: {
      id: "merchant-1",
      cashback_enabled: false,
    },
  });

  const res = await validateCashbackSpend("user-1", 100, "merchant-1", 1000, db);
  assert.equal(res.valid, false);
  assert.equal(res.error, "Merchant is not whitelisted or eligible for cashback");
});

test("validateCashbackSpend returns failure when purchase amount is below minimum", async () => {
  const db = createDbMock({
    rules: {
      min_purchase_amount: 500,
      max_use_per_transaction: 500,
      max_use_per_month: 2000,
      max_transactions_per_month: 5,
    },
    merchant: {
      id: "merchant-1",
      cashback_enabled: true,
    },
  });

  const res = await validateCashbackSpend("user-1", 100, "merchant-1", 400, db);
  assert.equal(res.valid, false);
  assert.ok(res.error?.includes("below the minimum required amount"));
});

test("validateCashbackSpend returns failure when spend amount exceeds single limit", async () => {
  const db = createDbMock({
    rules: {
      min_purchase_amount: 500,
      max_use_per_transaction: 150,
      max_use_per_month: 2000,
      max_transactions_per_month: 5,
    },
    merchant: {
      id: "merchant-1",
      cashback_enabled: true,
    },
  });

  const res = await validateCashbackSpend("user-1", 200, "merchant-1", 1000, db);
  assert.equal(res.valid, false);
  assert.ok(res.error?.includes("exceeds single transaction limit"));
});

test("validateCashbackSpend returns failure when monthly transaction count limit is reached", async () => {
  const db = createDbMock({
    rules: {
      min_purchase_amount: 500,
      max_use_per_transaction: 500,
      max_use_per_month: 2000,
      max_transactions_per_month: 2,
    },
    merchant: {
      id: "merchant-1",
      cashback_enabled: true,
    },
    transactions: [
      { user_id: "user-1", amount: -100, type: "spend", created_at: new Date().toISOString() },
      { user_id: "user-1", amount: -150, type: "spend", created_at: new Date().toISOString() },
    ],
  });

  const res = await validateCashbackSpend("user-1", 100, "merchant-1", 1000, db);
  assert.equal(res.valid, false);
  assert.ok(res.error?.includes("Monthly cashback transaction limit of 2 uses"));
});

test("validateCashbackSpend returns failure when monthly total limit is exceeded", async () => {
  const db = createDbMock({
    rules: {
      min_purchase_amount: 500,
      max_use_per_transaction: 500,
      max_use_per_month: 500,
      max_transactions_per_month: 5,
    },
    merchant: {
      id: "merchant-1",
      cashback_enabled: true,
    },
    transactions: [
      { user_id: "user-1", amount: -200, type: "spend", created_at: new Date().toISOString() },
      { user_id: "user-1", amount: -250, type: "spend", created_at: new Date().toISOString() },
    ],
  });

  const res = await validateCashbackSpend("user-1", 100, "merchant-1", 1000, db);
  assert.equal(res.valid, false);
  assert.ok(res.error?.includes("Monthly cashback spend limit of 500 has been exceeded"));
});

test("validateCashbackSpend returns failure when user has insufficient active balance", async () => {
  const db = createDbMock({
    rules: {
      min_purchase_amount: 500,
      max_use_per_transaction: 500,
      max_use_per_month: 2000,
      max_transactions_per_month: 5,
    },
    merchant: {
      id: "merchant-1",
      cashback_enabled: true,
    },
    transactions: [],
    lots: [
      { user_id: "user-1", remaining_amount: 50 },
    ],
  });

  const res = await validateCashbackSpend("user-1", 100, "merchant-1", 1000, db);
  assert.equal(res.valid, false);
  assert.ok(res.error?.includes("Insufficient cashback balance"));
});

test("validateCashbackSpend returns success when all validations pass", async () => {
  const db = createDbMock({
    rules: {
      min_purchase_amount: 500,
      max_use_per_transaction: 500,
      max_use_per_month: 2000,
      max_transactions_per_month: 5,
    },
    merchant: {
      id: "merchant-1",
      cashback_enabled: true,
    },
    transactions: [],
    lots: [
      { user_id: "user-1", remaining_amount: 150 },
    ],
  });

  const res = await validateCashbackSpend("user-1", 100, "merchant-1", 1000, db);
  assert.equal(res.valid, true);
  assert.equal(res.error, undefined);
});
