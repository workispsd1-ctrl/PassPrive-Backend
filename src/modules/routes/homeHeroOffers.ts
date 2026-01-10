import { Router, Request, Response } from "express";
import supabase from "../../database/supabase";
import multer from "multer";

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
});

// ------------------- GET -------------------
router.get("/", async (req: Request, res: Response) => {
  try {
    const { data, error } = await supabase
      .from("homeherooffers")
      .select("*")
      .eq("is_active", true)
      .order("priority", { ascending: true });

    if (error) throw error;
    return res.json({ offers: data });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// ------------------- NORMAL INSERT (JSON) -------------------
router.post("/", async (req: Request, res: Response) => {
  try {
    const payload = req.body;

    const { data, error } = await supabase
      .from("homeherooffers")
      .insert([payload])
      .select();

    if (error) throw error;

    return res.json({ message: "Offer added", offer: data?.[0] });
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
      const fileName = `offer_${Date.now()}.${fileExt}`;

      const { error: uploadErr } = await supabase.storage
        .from("HomeHeroOffers")
        .upload(fileName, file.buffer, {
          contentType: file.mimetype,
        });

      if (uploadErr) throw uploadErr;

      const { data: publicUrl } = supabase.storage
        .from("HomeHeroOffers")
        .getPublicUrl(fileName);

      const payload = {
        title: body.title,
        type: body.type,
        media_url: publicUrl.publicUrl,
        priority: Number(body.priority),
        is_active: body.is_active === "true",
      };

      const { data, error } = await supabase
        .from("homeherooffers")
        .insert([payload])
        .select();

      if (error) throw error;

      return res.json({
        message: "Offer created",
        offer: data?.[0],
      });
    } catch (err: any) {
      console.error("UPLOAD ERROR:", err);
      return res.status(500).json({ error: err.message });
    }
  }
);

// ------------------- DELETE -------------------
router.delete("/:id", async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);

    const { error } = await supabase
      .from("homeherooffers")
      .delete()
      .eq("id", id);

    if (error) throw error;
    return res.json({ message: "Offer deleted" });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

export default router;
