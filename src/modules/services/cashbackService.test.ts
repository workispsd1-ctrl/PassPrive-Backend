import test from "node:test";
import assert from "node:assert/strict";
import { validateCashbackSpend } from "./cashbackService";

function createDbMock(result: { data?: any; error?: any }) {
  const calls: any[] = [];
  const db = {
    calls,
    async rpc(name: string, args: any) {
      calls.push({ name, args });
      return { data: result.data ?? null, error: result.error ?? null };
    },
  };
  return db;
}

test("validateCashbackSpend sends the spend to cashback_burn_check", async () => {
  const db = createDbMock({ data: [{ ok: true, code: "OK", message: "OK" }] });
  const res = await validateCashbackSpend("user-1", 40, "merchant-1", 900, db);
  assert.equal(res.valid, true);
  assert.deepEqual(db.calls[0], {
    name: "cashback_burn_check",
    args: { p_user_id: "user-1", p_amount: 40, p_merchant_user_id: "merchant-1", p_bill_amount: 900 },
  });
});

test("validateCashbackSpend surfaces the plan rule message when blocked", async () => {
  const db = createDbMock({
    data: [{ ok: false, code: "BELOW_MIN_BALANCE", message: "You need at least 25 Privé Credits to start using them." }],
  });
  const res = await validateCashbackSpend("user-1", 20, "merchant-1", 900, db);
  assert.equal(res.valid, false);
  assert.equal(res.error, "You need at least 25 Privé Credits to start using them.");
});

test("validateCashbackSpend accepts a single-row object result", async () => {
  const db = createDbMock({ data: { ok: false, code: "USES_EXHAUSTED", message: "limit reached" } });
  const res = await validateCashbackSpend("user-1", 20, "merchant-1", 900, db);
  assert.equal(res.valid, false);
  assert.equal(res.error, "limit reached");
});

test("validateCashbackSpend fails closed on database error", async () => {
  const db = createDbMock({ error: { message: "boom" } });
  const res = await validateCashbackSpend("user-1", 20, "merchant-1", 900, db);
  assert.equal(res.valid, false);
  assert.equal(res.error, "Could not check Privé Credits right now");
});

test("validateCashbackSpend fails closed on empty result", async () => {
  const db = createDbMock({ data: [] });
  const res = await validateCashbackSpend("user-1", 20, "merchant-1", 900, db);
  assert.equal(res.valid, false);
});
