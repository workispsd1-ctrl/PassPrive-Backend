import { Router, Request, Response } from "express";
import supabase from "../../database/supabase";
import multer from "multer";
import { requireAdmin } from "../services/authService";

const router = Router();
const upload = multer({
  storage: multer.memoryStorage(),
});

const BUCKET_NAME = "gift-event-images";
const TABLE_NAME = "gift_events";

const normalizeText = (value: any) => {
  if (value === undefined || value === null) return undefined;
  const text = String(value).trim();
  return text.length ? text : undefined;
};

const parseBoolean = (value: any) => {
  if (value === undefined) return undefined;
  if (typeof value === "boolean") return value;
  return value === "true";
};

const uploadEventImage = async (file: Express.Multer.File) => {
  const fileExt = file.originalname.split(".").pop();
  const fileName = `gift_event_${Date.now()}.${fileExt}`;

  const { error: uploadErr } = await supabase.storage
    .from(BUCKET_NAME)
    .upload(fileName, file.buffer, {
      contentType: file.mimetype,
    });

  if (uploadErr) throw uploadErr;

  const { data: publicUrl } = supabase.storage
    .from(BUCKET_NAME)
    .getPublicUrl(fileName);

  return {
    image_url: publicUrl.publicUrl,
    image_path: fileName,
  };
};

// POST /api/gift-events
// Admin-only endpoint to set/save a gift event with an image upload
router.post("/", upload.single("image"), async (req: Request, res: Response) => {
  try {
    const admin = await requireAdmin(req, res);
    if (!admin) return;

    const file = req.file;
    const body = req.body;
    
    const title = normalizeText(body.title);
    if (!title) {
      return res.status(400).json({ error: "title is required" });
    }

    const payload: any = {
      title,
      description: normalizeText(body.description) ?? null,
      start_date: normalizeText(body.start_date) ?? null,
      end_date: normalizeText(body.end_date) ?? null,
      is_active: parseBoolean(body.is_active) ?? true,
    };

    if (file) {
      const uploadResult = await uploadEventImage(file);
      payload.image_url = uploadResult.image_url;
      payload.image_path = uploadResult.image_path;
    } else {
      payload.image_url = normalizeText(body.image_url) ?? null;
      payload.image_path = normalizeText(body.image_path) ?? null;
    }

    const { data, error } = await supabase
      .from(TABLE_NAME)
      .insert([payload])
      .select()
      .single();

    if (error) throw error;

    return res.status(201).json({
      success: true,
      message: "Gift event created successfully",
      gift_event: data,
    });
  } catch (err: any) {
    console.error("[gift-events] Create event failed:", err);
    return res.status(500).json({ error: err.message || "Failed to create gift event" });
  }
});

export default router;
