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
    console.log("GET / - Fetching all offers");
    const { data, error } = await supabase
      .from("homeherooffers")
      .select("*")
      .order("priority", { ascending: true });

    if (error) {
      console.error("GET / - Supabase error:", error);
      throw error;
    }
    
    console.log(`GET / - Found ${data?.length || 0} offers`);
    return res.json({ offers: data || [] });
  } catch (err: any) {
    console.error("GET / - Error:", err);
    return res.status(500).json({ error: err.message });
  }
});

// ------------------- GET SINGLE OFFER BY ID -------------------
router.get("/:id", async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    console.log("GET /:id - Requested ID:", req.params.id, "Parsed ID:", id);

    if (isNaN(id)) {
      console.error("GET /:id - Invalid ID format:", req.params.id);
      return res.status(400).json({ error: "Invalid ID format" });
    }

    const { data, error } = await supabase
      .from("homeherooffers")
      .select("*")
      .eq("id", id)
      .single();

    if (error) {
      console.error("GET /:id - Supabase error:", error);
      return res.status(404).json({ error: "Offer not found", details: error.message });
    }
    
    if (!data) {
      console.error("GET /:id - No data returned for ID:", id);
      return res.status(404).json({ error: "Offer not found" });
    }

    console.log("GET /:id - Success, returning offer:", data.id);
    return res.json({ offer: data });
  } catch (err: any) {
    console.error("GET /:id - Unexpected error:", err);
    return res.status(500).json({ error: err.message });
  }
});

// ------------------- NORMAL INSERT (JSON) -------------------
router.post("/", async (req: Request, res: Response) => {
  try {
    console.log("POST / - Creating offer (JSON):", req.body);
    const payload = req.body;

    const { data, error } = await supabase
      .from("homeherooffers")
      .insert([payload])
      .select();

    if (error) {
      console.error("POST / - Supabase error:", error);
      throw error;
    }

    console.log("POST / - Success, offer created:", data?.[0]?.id);
    return res.json({ message: "Offer added", offer: data?.[0] });
  } catch (err: any) {
    console.error("POST / - Error:", err);
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
      console.log("POST /upload - Body:", body, "Has file:", !!file);

      if (!file) {
        console.error("POST /upload - No file uploaded");
        return res.status(400).json({ error: "No file uploaded" });
      }

      const fileExt = file.originalname.split(".").pop();
      const fileName = `offer_${Date.now()}.${fileExt}`;
      console.log("POST /upload - Uploading file:", fileName);

      const { error: uploadErr } = await supabase.storage
        .from("HomeHeroOffers")
        .upload(fileName, file.buffer, {
          contentType: file.mimetype,
        });

      if (uploadErr) {
        console.error("POST /upload - Storage upload error:", uploadErr);
        throw uploadErr;
      }

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

      console.log("POST /upload - Inserting to DB:", payload);

      const { data, error } = await supabase
        .from("homeherooffers")
        .insert([payload])
        .select();

      if (error) {
        console.error("POST /upload - DB insert error:", error);
        throw error;
      }

      console.log("POST /upload - Success:", data?.[0]?.id);
      return res.json({
        message: "Offer created",
        offer: data?.[0],
      });
    } catch (err: any) {
      console.error("POST /upload - Unexpected error:", err);
      return res.status(500).json({ error: err.message });
    }
  }
);

// ------------------- UPDATE OFFER -------------------
router.put(
  "/:id",
  upload.single("media"),
  async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      const file = req.file;
      const body = req.body;

      console.log("PUT /:id - Received:", { id, body, hasFile: !!file });

      if (isNaN(id)) {
        console.error("PUT /:id - Invalid ID format:", req.params.id);
        return res.status(400).json({ error: "Invalid ID format" });
      }

      // Build update payload - only include fields that are provided
      const payload: any = {};

      if (body.title !== undefined && body.title !== "") {
        payload.title = body.title;
      }

      if (body.type !== undefined && body.type !== "") {
        payload.type = body.type;
      }

      if (body.priority !== undefined && body.priority !== "") {
        payload.priority = Number(body.priority);
      }

      if (body.is_active !== undefined) {
        payload.is_active = body.is_active === "true" || body.is_active === true;
      }

      // If new file uploaded, handle upload and add to payload
      if (file) {
        console.log("PUT /:id - Processing new file upload");
        const fileExt = file.originalname.split(".").pop();
        const fileName = `offer_${Date.now()}.${fileExt}`;

        const { error: uploadErr } = await supabase.storage
          .from("HomeHeroOffers")
          .upload(fileName, file.buffer, {
            contentType: file.mimetype,
          });

        if (uploadErr) {
          console.error("PUT /:id - Storage upload error:", uploadErr);
          throw uploadErr;
        }

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
            console.log("PUT /:id - Deleting old file:", oldFileName);
            await supabase.storage
              .from("HomeHeroOffers")
              .remove([oldFileName])
              .catch((err) => console.error("Failed to delete old file:", err));
          }
        }
      }

      // Check if there's anything to update
      if (Object.keys(payload).length === 0) {
        console.error("PUT /:id - No fields to update");
        return res.status(400).json({ error: "No fields to update" });
      }

      console.log("PUT /:id - Updating with payload:", payload);

      // Update the offer
      const { data, error } = await supabase
        .from("homeherooffers")
        .update(payload)
        .eq("id", id)
        .select();

      if (error) {
        console.error("PUT /:id - Update error:", error);
        throw error;
      }

      if (!data || data.length === 0) {
        console.error("PUT /:id - Offer not found:", id);
        return res.status(404).json({ error: "Offer not found" });
      }

      console.log("PUT /:id - Success:", data[0].id);
      return res.json({
        message: "Offer updated successfully",
        offer: data[0],
      });
    } catch (err: any) {
      console.error("PUT /:id - Unexpected error:", err);
      return res.status(500).json({ error: err.message });
    }
  }
);

// ------------------- DELETE -------------------
router.delete("/:id", async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    console.log("DELETE /:id - Requested ID:", id);

    if (isNaN(id)) {
      console.error("DELETE /:id - Invalid ID format:", req.params.id);
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
        console.log("DELETE /:id - Deleting file:", fileName);
        await supabase.storage
          .from("HomeHeroOffers")
          .remove([fileName])
          .catch((err) => console.error("Failed to delete file:", err));
      }
    }

    const { error } = await supabase
      .from("homeherooffers")
      .delete()
      .eq("id", id);

    if (error) {
      console.error("DELETE /:id - Delete error:", error);
      throw error;
    }

    console.log("DELETE /:id - Success");
    return res.json({ message: "Offer deleted successfully" });
  } catch (err: any) {
    console.error("DELETE /:id - Unexpected error:", err);
    return res.status(500).json({ error: err.message });
  }
});

export default router;