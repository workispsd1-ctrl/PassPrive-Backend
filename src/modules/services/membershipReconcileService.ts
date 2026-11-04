import supabase from "../../database/supabase";
import { getIveriConfig } from "./iveriService";
import { verifyPaymentSessionWithIveri } from "./paymentVerificationService";
import { finalizeMembershipPayment } from "./membershipPaymentService";

const INTERVAL_MS = 5 * 60 * 1000;
const ABANDON_AFTER_MS = 30 * 60 * 1000;
const LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
const OPEN_LOOKBACK_MS = 24 * 60 * 60 * 1000;
const BATCH = 25;

let timer: NodeJS.Timeout | null = null;
let running = false;

export async function reconcileMembershipPayments() {
  const now = Date.now();
  const since = new Date(now - LOOKBACK_MS).toISOString();

  const { data: verified, error: verifiedError } = await supabase
    .from("payment_sessions")
    .select("*")
    .eq("payment_context", "MEMBERSHIP")
    .eq("status", "VERIFIED_SUCCESS")
    .gte("created_at", since)
    .limit(BATCH);
  if (verifiedError) throw verifiedError;

  for (const session of verified ?? []) {
    try {
      await finalizeMembershipPayment({ session, userId: session.user_id });
      console.log("[membership reconcile] finalized", session.id);
    } catch (err: any) {
      console.error("[membership reconcile] finalize failed", session.id, err?.message);
    }
  }

  const { data: open, error: openError } = await supabase
    .from("payment_sessions")
    .select("id")
    .eq("payment_context", "MEMBERSHIP")
    .in("status", ["PENDING", "RETURNED"])
    .eq("payment_provider", "IVERI")
    .gte("created_at", new Date(now - OPEN_LOOKBACK_MS).toISOString())
    .lte("created_at", new Date(now - ABANDON_AFTER_MS).toISOString())
    .limit(BATCH);
  if (openError) throw openError;

  if (!open?.length) return;
  const config = getIveriConfig();
  for (const session of open) {
    try {
      const result = await verifyPaymentSessionWithIveri({
        sessionId: session.id,
        applicationId: config.applicationId,
        authoriseInfoUrl: config.authoriseInfoUrl,
      });
      console.log("[membership reconcile] verified", session.id, result.session?.status);
    } catch (err: any) {
      console.error("[membership reconcile] verify failed", session.id, err?.message);
    }
  }
}

export function startMembershipReconcileWorker() {
  if (timer || process.env.MEMBERSHIP_RECONCILE_DISABLED === "true") return;

  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await reconcileMembershipPayments();
    } catch (err) {
      console.error("[membership reconcile] tick failed:", err);
    } finally {
      running = false;
    }
  };

  timer = setInterval(tick, INTERVAL_MS);
  timer.unref?.();
  void tick();
}
