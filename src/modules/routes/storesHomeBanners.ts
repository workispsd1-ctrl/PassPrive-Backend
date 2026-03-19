import { Router, Request, Response } from "express";
import supabase from "../../database/supabase";
import multer from "multer";

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
});

router.get("/", async (req: Request, res: Response) => {
  try {
    const { data, error } = await supabase
      .from("storeshomebanners")
      .select("*")
      .eq("is_active", true)
      .order("priority", { ascending: true });

    if (error) throw error;
    return res.json({ banners: data });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

router.post("/", async (req: Request, res: Response) => {
  try {
    const payload = req.body;

    const { data, error } = await supabase
      .from("storeshomebanners")
      .insert([payload])
      .select();

    if (error) throw error;

    return res.json({ message: "Banner added", banner: data?.[0] });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

router.post(
  "/upload",
  upload.single("media"),
  async (req: Request, res: Response) => {
    try {
      const file = req.file;
      const body = req.body;

      if (!file) {
        return res.status(400).json({ error: "No file uploaded" });
      }

      const fileExt = file.originalname.split(".").pop();
      const fileName = `banner_${Date.now()}.${fileExt}`;

      const { error: uploadErr } = await supabase.storage
        .from("StoresHomeBanners")
        .upload(fileName, file.buffer, {
          contentType: file.mimetype,
        });

      if (uploadErr) throw uploadErr;

      const { data: publicUrl } = supabase.storage
        .from("StoresHomeBanners")
        .getPublicUrl(fileName);

      const payload = {
        title: body.title,
        type: body.type,
        media_url: publicUrl.publicUrl,
        thumbnail_url: body.thumbnail_url || null,
        cta_text: body.cta_text || null,
        cta_link: body.cta_link || null,
        priority: Number(body.priority),
        is_active: body.is_active === "true",
        start_at: body.start_at || null,
        end_at: body.end_at || null,
      };

      const { data, error } = await supabase
        .from("storeshomebanners")
        .insert([payload])
        .select();

      if (error) throw error;

      return res.json({
        message: "Banner created",
        banner: data?.[0],
      });
    } catch (err: any) {
      console.error("UPLOAD ERROR:", err);
      return res.status(500).json({ error: err.message });
    }
  }
);

router.delete("/:id", async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);

    const { error } = await supabase
      .from("storeshomebanners")
      .delete()
      .eq("id", id);

    if (error) throw error;
    return res.json({ message: "Banner deleted" });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

export default router;
