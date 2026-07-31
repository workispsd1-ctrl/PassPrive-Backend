import https from "https";

export interface SmsResponse {
  success: boolean;
  provider: string;
  message: string;
  statusCode?: number;
}

export interface SmsProvider {
  send(phone: string, message: string): Promise<SmsResponse>;
}

export class EmtelProvider implements SmsProvider {
  async send(phone: string, message: string): Promise<SmsResponse> {
    const baseUrl = process.env.EMTEL_BASE_URL || "https://api.emtel.com";
    const username = process.env.EMTEL_USERNAME || "";
    const password = process.env.EMTEL_PASSWORD || "";
    const apiKey = process.env.EMTEL_API_KEY || "";

    const url = `${baseUrl}/sendsms?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}&coding=2&charset=utf-8&to=${encodeURIComponent(phone)}&text=${encodeURIComponent(message)}`;

    return new Promise<SmsResponse>((resolve) => {
      const req = https.get(
        url,
        {
          headers: {
            "X-Emtel-Api-Key": apiKey,
          },
        },
        (res) => {
          let data = "";
          res.on("data", (chunk) => {
            data += chunk;
          });
          res.on("end", () => {
            resolve({
              success: res.statusCode === 202,
              provider: "Emtel",
              message: data,
              statusCode: res.statusCode,
            });
          });
        }
      );

      req.on("error", (err) => {
        resolve({
          success: false,
          provider: "Emtel",
          message: err.message,
        });
      });
    });
  }
}
