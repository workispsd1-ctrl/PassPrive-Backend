import { Router } from "express";
import { z } from "zod";
import supabase from "../../database/supabase";

const router = Router();

const SHARE_BASE_URL = (process.env.SHARE_BASE_URL ?? "https://link.district.in/DSTRKT").replace(/\/+$/, "");

const IdSchema = z.string().uuid();

const CHARS = "abcdefghijklmnopqrstuvwxyz0123456789";

function generateCode(len = 8): string {
  let code = "";
  for (let i = 0; i < len; i++) {
    code += CHARS[Math.floor(Math.random() * CHARS.length)];
  }
  return code;
}

// POST /api/share/:id
router.post("/:id", async (req, res) => {
  const idParsed = IdSchema.safeParse(req.params.id);
  if (!idParsed.success) {
    return res.status(400).json({ error: "Invalid id" });
  }

  const entityId = idParsed.data;

  // Check for existing share link first (idempotent)
  const { data: existing, error: existingErr } = await supabase
    .from("share_links")
    .select("code")
    .eq("entity_id", entityId)
    .maybeSingle();

  if (existingErr) return res.status(500).json({ error: existingErr.message });

  if (existing) {
    return res.json({ url: `${SHARE_BASE_URL}/${existing.code}` });
  }

  // Confirm entity exists — check restaurants then stores
  const [{ data: restaurant }, { data: store }] = await Promise.all([
    supabase.from("restaurants").select("id").eq("id", entityId).maybeSingle(),
    supabase.from("stores").select("id").eq("id", entityId).maybeSingle(),
  ]);

  if (!restaurant && !store) {
    return res.status(404).json({ error: "Entity not found" });
  }

  const entityType = restaurant ? "restaurant" : "store";

  // Generate a unique code, retrying on collision (astronomically unlikely)
  let code = generateCode();
  for (let attempt = 0; attempt < 5; attempt++) {
    const { data: inserted, error: insertErr } = await supabase
      .from("share_links")
      .insert({ entity_id: entityId, entity_type: entityType, code })
      .select("code")
      .single();

    if (!insertErr && inserted) {
      return res.json({ url: `${SHARE_BASE_URL}/${inserted.code}` });
    }

    // Unique violation on code — try a new one
    if (insertErr?.code === "23505") {
      code = generateCode();
      continue;
    }

    return res.status(500).json({ error: insertErr?.message ?? "Failed to create share link" });
  }

  return res.status(500).json({ error: "Failed to generate unique code" });
});

// GET /r/:code
router.get("/:code", async (req, res) => {
  const code = req.params.code;

  if (!code || !/^[a-z0-9]{1,32}$/i.test(code)) {
    return res.status(400).json({ error: "Invalid code" });
  }

  const { data, error } = await supabase
    .from("share_links")
    .select("entity_id, entity_type")
    .eq("code", code)
    .maybeSingle();

  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: "Link not found" });

  const deepLink = `district://store/${data.entity_id}`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Opening in District…</title>
  <meta http-equiv="refresh" content="0; url=${deepLink}" />
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
           display: flex; flex-direction: column; align-items: center;
           justify-content: center; min-height: 100vh; margin: 0;
           background: #f9f9f9; color: #222; text-align: center; padding: 24px; }
    a { display: inline-block; margin: 12px 8px; padding: 14px 28px;
        border-radius: 10px; font-size: 16px; font-weight: 600;
        text-decoration: none; color: #fff; }
    .ios { background: #000; }
    .android { background: #01875f; }
    p { color: #666; font-size: 14px; margin-top: 24px; }
  </style>
</head>
<body>
  <h2>Opening District…</h2>
  <p>If the app doesn't open automatically, download it here:</p>
  <a class="ios" href="https://apps.apple.com/app/district/id6741501494">Download on the App Store</a>
  <a class="android" href="https://play.google.com/store/apps/details?id=com.district.app">Get it on Google Play</a>
  <p>Already have the app? <a href="${deepLink}">Open in District</a></p>
</body>
</html>`;

  res.status(301)
    .setHeader("Location", deepLink)
    .setHeader("Content-Type", "text/html; charset=utf-8")
    .send(html);
});

export default router;
