import { Router, Request, Response } from "express";
import supabase from "../../database/supabase";
import multer from "multer";

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
});

// ------------------- GET ALL -------------------
router.get("/", async (req: Request, res: Response) => {
  try {
    const { data, error } = await supabase
      .from("homeherooffers")
      .select("*")
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

// ------------------- UPLOAD WITH FILE (form-data) -------------------
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

// ------------------- GET SINGLE OFFER BY ID -------------------
router.get("/:id", async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);

    if (isNaN(id)) {
      return res.status(400).json({ error: "Invalid ID format" });
    }

    const { data, error } = await supabase
      .from("homeherooffers")
      .select("*")
      .eq("id", id)
      .single();

    if (error) {
      console.error("Supabase error:", error);
      return res.status(404).json({ error: "Offer not found" });
    }
    
    if (!data) {
      return res.status(404).json({ error: "Offer not found" });
    }

    return res.json({ offer: data });
  } catch (err: any) {
    console.error("GET /:id error:", err);
    return res.status(500).json({ error: err.message });
  }
});

// ⭐ ADD THIS ROUTE - UPDATE OFFER ⭐
router.put(
  "/:id",
  upload.single("media"),
  async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      const file = req.file;
      const body = req.body;

      if (isNaN(id)) {
        return res.status(400).json({ error: "Invalid ID format" });
      }

      // Build update payload
      const payload: any = {
        title: body.title,
        type: body.type,
        priority: Number(body.priority),
        is_active: body.is_active === "true" || body.is_active === true,
      };

      // If new file uploaded, handle upload and add to payload
      if (file) {
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

        payload.media_url = publicUrl.publicUrl;

        // Optional: Delete old file from storage
        const { data: oldOffer } = await supabase
          .from("homeherooffers")
          .select("media_url")
          .eq("id", id)
          .single();

        if (oldOffer?.media_url) {
          const oldFileName = oldOffer.media_url.split("/").pop();
          if (oldFileName) {
            await supabase.storage
              .from("HomeHeroOffers")
              .remove([oldFileName]);
          }
        }
      }

      // Update the offer
      const { data, error } = await supabase
        .from("homeherooffers")
        .update(payload)
        .eq("id", id)
        .select();

      if (error) throw error;

      if (!data || data.length === 0) {
        return res.status(404).json({ error: "Offer not found" });
      }

      return res.json({
        message: "Offer updated successfully",
        offer: data[0],
      });
    } catch (err: any) {
      console.error("UPDATE ERROR:", err);
      return res.status(500).json({ error: err.message });
    }
  }
);

// ------------------- DELETE -------------------
router.delete("/:id", async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);

    if (isNaN(id)) {
      return res.status(400).json({ error: "Invalid ID format" });
    }

    // Optional: Delete media file from storage
    const { data: offer } = await supabase
      .from("homeherooffers")
      .select("media_url")
      .eq("id", id)
      .single();

    if (offer?.media_url) {
      const fileName = offer.media_url.split("/").pop();
      if (fileName) {
        await supabase.storage.from("HomeHeroOffers").remove([fileName]);
      }
    }

    const { error } = await supabase
      .from("homeherooffers")
      .delete()
      .eq("id", id);

    if (error) throw error;
    return res.json({ message: "Offer deleted successfully" });
  } catch (err: any) {
    console.error("DELETE ERROR:", err);
    return res.status(500).json({ error: err.message });
  }
});

export default router;