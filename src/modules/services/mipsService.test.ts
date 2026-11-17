import test from "node:test";
import assert from "node:assert/strict";
import { getMiPSConfigForMerchant } from "./mipsService";

Object.assign(process.env, {
  MIPS_BASE_URL: "https://mips.test",
  MIPS_BASIC_USER: "u",
  MIPS_BASIC_PASS: "p",
  MIPS_ID_MERCHANT: "GLOBAL_M",
  MIPS_ID_ENTITY: "GLOBAL_E",
  MIPS_ID_OPERATOR: "OP",
  MIPS_OPERATOR_PASSWORD: "OPPW",
  MIPS_HASH_SALT: "salt",
  MIPS_CIPHER_KEY: "key",
});

const db = (data: any) => {
  const calls: any[] = [];
  return { calls, async rpc(name: string, args: any) { calls.push({ name, args }); return { data, error: null }; } };
};

test("merchant MiPS ids override the global merchant and entity only", async () => {
  const mock = db({ id_merchant: "M1", id_entity: "APP1" });
  const config = await getMiPSConfigForMerchant(null, "store-1", mock);
  assert.deepEqual(mock.calls[0], { name: "get_merchant_mips_credentials", args: { p_kind: "store", p_merchant_id: "store-1" } });
  assert.deepEqual(config.authentify, { id_merchant: "M1", id_entity: "APP1", id_operator: "OP", operator_password: "OPPW" });
});

test("merchants without saved ids fall back to the global env", async () => {
  const config = await getMiPSConfigForMerchant("rest-1", null, db(null));
  assert.equal(config.authentify.id_merchant, "GLOBAL_M");
  assert.equal(config.authentify.id_entity, "GLOBAL_E");
});

test("a half-saved credential is ignored", async () => {
  const config = await getMiPSConfigForMerchant("rest-1", null, db({ id_merchant: "M1", id_entity: "" }));
  assert.equal(config.authentify.id_merchant, "GLOBAL_M");
});
