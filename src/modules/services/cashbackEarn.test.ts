import test from "node:test";
import assert from "node:assert/strict";
import { earnTransactionCashback } from "./cashbackService";

// Minimal Supabase-style client mock. Per table, `select` results and `insert`
// results can differ; builders are thenable and expose maybeSingle/single.
function createClientMock(cfg: {
  quote?: any;
  restaurant?: any;
  existingCredits?: { source: string }[];
  onInsertLot?: (row: any) => void;
  onInsertTx?: (row: any) => void;
}) {
  function builder(table: string) {
    let inserted = false;
    let insertedRow: any = null;
    const b: any = {
      select: () => b,
      eq: () => b,
      gt: () => b,
      maybeSingle: async () => resolve(),
      single: async () => resolve(),
      insert: (row: any) => {
        inserted = true;
        insertedRow = row;
        if (table === "cashback_lots") cfg.onInsertLot?.(row);
        if (table === "cashback_transactions") cfg.onInsertTx?.(row);
        return b;
      },
      then: (res: any, rej: any) => Promise.resolve(resolve()).then(res, rej),
    };
    function resolve() {
      if (table === "cashback_transactions") {
        if (inserted) return { data: { id: "tx1", ...insertedRow }, error: null };
        return { data: cfg.existingCredits ?? [], error: null };
      }
      if (table === "cashback_lots") return { data: { id: "lot1", ...insertedRow }, error: null };
      if (table === "cashback_rules") return { data: { expiry_days: 30 }, error: null };
      if (table === "restaurants") return { data: cfg.restaurant ?? null, error: null };
      return { data: null, error: null };
    }
    return b;
  }
  return {
    from: (table: string) => builder(table),
    rpc: async (fn: string, args: any) => {
      if (fn === "credit_cashback_points_secure") {
        cfg.onInsertLot?.({ amount: args.p_amount });
        cfg.onInsertTx?.({ amount: args.p_amount, source: "membership" });
        cfg.onInsertTx?.({ amount: args.p_amount, source: "merchant_funded" });
        return { data: { success: true, lot_id: "lot1", transaction_id: "tx1" }, error: null };
      }
      return { data: cfg.quote, error: null };
    },
  };
}

test("credits membership cashback from cashback_quote", async () => {
  const lots: any[] = [];
  const txs: any[] = [];
  const db = createClientMock({
    quote: [{ applicable: true, cashback_amount: 5 }],
    restaurant: { merchant_type: "verified", merchant_reward_rate: null },
    onInsertLot: (r) => lots.push(r),
    onInsertTx: (r) => txs.push(r),
  });
  const res = await earnTransactionCashback({
    userId: "u1", restaurantId: "r1", baseAmount: 1000, sessionId: "s1", db: db as any,
  });
  assert.equal(res.membership, 5);
  assert.equal(res.merchantFunded, 0);
  assert.equal(lots.length, 1);
  assert.equal(lots[0].amount, 5);
  assert.equal(txs.find((t) => t.source === "membership")?.amount, 5);
});

test("adds merchant-funded lot for Preferred with reward rate", async () => {
  const txs: any[] = [];
  const db = createClientMock({
    quote: [{ applicable: true, cashback_amount: 20 }], // 2% Premium on Preferred
    restaurant: { merchant_type: "preferred", merchant_reward_rate: 10 },
    onInsertTx: (r) => txs.push(r),
  });
  const res = await earnTransactionCashback({
    userId: "u1", restaurantId: "r1", baseAmount: 1000, sessionId: "s1", db: db as any,
  });
  assert.equal(res.membership, 20);
  assert.equal(res.merchantFunded, 100); // 10% of 1000
  assert.ok(txs.some((t) => t.source === "merchant_funded" && t.amount === 100));
});

test("is idempotent: skips sources already credited for the session", async () => {
  const lots: any[] = [];
  const db = createClientMock({
    quote: [{ applicable: true, cashback_amount: 5 }],
    restaurant: { merchant_type: "preferred", merchant_reward_rate: 10 },
    existingCredits: [{ source: "membership" }, { source: "merchant_funded" }],
    onInsertLot: (r) => lots.push(r),
  });
  const res = await earnTransactionCashback({
    userId: "u1", restaurantId: "r1", baseAmount: 1000, sessionId: "s1", db: db as any,
  });
  assert.equal(res.membership, 0);
  assert.equal(res.merchantFunded, 0);
  assert.equal(lots.length, 0);
});

test("credits nothing for an unclassified merchant / zero base", async () => {
  const db = createClientMock({
    quote: [{ applicable: false, cashback_amount: 0 }],
    restaurant: { merchant_type: null, merchant_reward_rate: null },
  });
  const res = await earnTransactionCashback({
    userId: "u1", restaurantId: "r1", baseAmount: 1000, sessionId: "s1", db: db as any,
  });
  assert.deepEqual(res, { membership: 0, merchantFunded: 0 });

  const zero = await earnTransactionCashback({
    userId: "u1", restaurantId: "r1", baseAmount: 0, sessionId: "s1", db: db as any,
  });
  assert.deepEqual(zero, { membership: 0, merchantFunded: 0 });
});
