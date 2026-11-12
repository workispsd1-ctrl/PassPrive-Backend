import crypto from "crypto";
import supabase from "../../database/supabase";

export class OtpService {
  /**
   * Hashes an OTP string using SHA-256.
   */
  private static hashOtp(otp: string): string {
    return crypto.createHash("sha256").update(otp).digest("hex");
  }

  /**
   * Generates a 6-digit OTP, checks rate limits/cooldown, and saves the hashed value in the database.
   * Returns the plain-text OTP code to be sent.
   */
  static async generateAndSaveOtp(phone: string): Promise<string> {
    const cleanPhone = phone.trim();
    if (!/^\+?2305[0-9]{7}$/.test(cleanPhone)) {
      throw new Error("Please enter a valid Mauritius mobile number.");
    }

    const now = new Date();

    // 1. Retrieve any existing OTP record for the phone number
    const { data: record, error: fetchError } = await supabase
      .from("user_otps")
      .select("*")
      .eq("phone", cleanPhone)
      .maybeSingle();

    if (fetchError) {
      throw new Error(`Database error while fetching OTP status: ${fetchError.message}`);
    }

    let nextHourlyCount = 1;

    if (record) {
      const lastRequested = new Date(record.last_requested_at);
      const secondsSinceLast = Math.floor((now.getTime() - lastRequested.getTime()) / 1000);

      // Cooldown check (60 seconds)
      if (secondsSinceLast < 60) {
        throw new Error(`Please wait ${60 - secondsSinceLast} seconds before requesting a new OTP.`);
      }

      // Hourly limit check (Max 5 requests per hour)
      const hoursSinceLast = (now.getTime() - lastRequested.getTime()) / (1000 * 60 * 60);
      if (hoursSinceLast < 1) {
        if (record.hourly_requests >= 5) {
          throw new Error("Hourly OTP request limit exceeded. Please try again later.");
        }
        nextHourlyCount = record.hourly_requests + 1;
      } else {
        nextHourlyCount = 1;
      }
    }

    // 2. Generate a 6-digit OTP
    const otp = crypto.randomInt(100000, 1000000).toString();
    const otpHash = this.hashOtp(otp);
    const expiresAt = new Date(now.getTime() + 5 * 60 * 1000).toISOString(); // 5-minute TTL

    // 3. Upsert record in database
    const { error: upsertError } = await supabase.from("user_otps").upsert({
      phone: cleanPhone,
      otp_hash: otpHash,
      expires_at: expiresAt,
      attempts: 0,
      last_requested_at: now.toISOString(),
      hourly_requests: nextHourlyCount,
    });

    if (upsertError) {
      throw new Error(`Failed to save OTP: ${upsertError.message}`);
    }

    return otp;
  }

  /**
   * Verifies the OTP, checks expiry/attempts limits, and deletes the OTP record upon success.
   */
  static async verifyOtp(phone: string, code: string): Promise<{ success: boolean; message: string }> {
    const cleanPhone = phone.trim();
    const cleanCode = code.trim();

    if (!cleanPhone || !cleanCode) {
      return { success: false, message: "Phone number and OTP code are required." };
    }

    const { data: attempt } = await supabase.rpc("otp_take_attempt", { p_phone: cleanPhone });
    if (!attempt) {
      return { success: false, message: "This code has expired or was tried too many times. Please request a new one." };
    }

    if (this.hashOtp(cleanCode) === attempt.otp_hash) {
      await supabase.from("user_otps").delete().eq("phone", cleanPhone);
      return { success: true, message: "OTP verified successfully." };
    }

    const remaining = 3 - Number(attempt.attempts);
    if (remaining <= 0) {
      return { success: false, message: "Incorrect OTP. Verification attempts limit exceeded. Please request a new one." };
    }
    return { success: false, message: `Incorrect OTP. ${remaining} attempts remaining.` };
  }
}
