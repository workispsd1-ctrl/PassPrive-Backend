import test from "node:test";
import assert from "node:assert/strict";
import { deriveIveriOutcome, inferStatusFromOutcome, normalizeIveriPayload } from "./iveriPayloadService";

function outcome(fields: Record<string, string>) {
  return deriveIveriOutcome(normalizeIveriPayload(fields));
}

test("iVeri approved (status 0) is the only success", () => {
  assert.equal(outcome({ Lite_Payment_Card_Status: "0", Lite_Result_Description: "Approved" }), "success");
});

test("iVeri text never turns a non-zero status into success", () => {
  assert.equal(outcome({ Lite_Payment_Card_Status: "2", Lite_Result_Description: "Approved" }), "fail");
  assert.equal(outcome({ Lite_Result_Description: "Approved" }), "pending");
  assert.equal(outcome({ Lite_Result_Description: "Not approved" }), "fail");
  assert.equal(outcome({}), "pending");
});

test("iVeri real-world non-success responses", () => {
  assert.equal(outcome({ Lite_Payment_Card_Status: "-255", Lite_Result_Description: "Transaction in progress" }), "pending");
  assert.equal(outcome({ Lite_Payment_Card_Status: "-255", Lite_Result_Description: "No Transaction found for [Lite_Merchant_Trace]" }), "pending");
  assert.equal(outcome({ Lite_Payment_Card_Status: "-14", Lite_Result_Description: "Invalid card number" }), "fail");
  assert.equal(outcome({ Lite_Payment_Card_Status: "2", Lite_Result_Description: "Denied" }), "fail");
  assert.equal(outcome({ Lite_Payment_Card_Status: "255", Lite_Result_Description: "Error" }), "fail");
});

test("iVeri outcome maps to session status", () => {
  assert.equal(inferStatusFromOutcome("success"), "VERIFIED_SUCCESS");
  assert.equal(inferStatusFromOutcome("fail"), "VERIFIED_FAILED");
  assert.equal(inferStatusFromOutcome("pending"), "RETURNED");
});
