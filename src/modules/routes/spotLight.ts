import express, { Request, Response } from "express";
import supabase from "../../database/supabase";
import multer from "multer";

const router = express.Router();

// Multer: store file in memory
const upload = multer({ storage: multer.memoryStorage() });

interface SpotlightItem {
  title: string;
  subtitle?: string;
  media_type: "image" | "video";
  media_url: string;
  thumbnail_url?: string;
  module_type: "dining" | "stores" | "events" | "global";
}

/* ----------------------------------------------------
   Helper: Upload to Supabase Storage
-----------------------------------------------------*/
async function uploadToSupabase(file: Express.Multer.File, folder: string) {
  const ext = file.originalname.split(".").pop();
  const name = `${Date.now()}.${ext}`;
  const path = `${folder}/${name}`;

  // Upload
  const { error } = await supabase.storage
    .from("spotlight")
    .upload(path, file.buffer, {
      upsert: false,
      contentType: file.mimetype,
    });

  if (error) throw error;

  // Public URL
  const publicUrl = supabase.storage
    .from("spotlight")
    .getPublicUrl(path).data.publicUrl;

  return publicUrl;
}

/* ----------------------------------------------------
   GET ALL (OPTIONAL FILTER)
-----------------------------------------------------*/
router.get("/", async (req: Request, res: Response) => {
  try {
    const module_type = req.query.module_type as string;

    let q = supabase
      .from("spotlight_items")
      .select("*")
      .eq("is_active", true)
      .order("order_index", { ascending: true });

    if (module_type) q = q.eq("module_type", module_type);

    const { data, error } = await q;
    if (error) throw error;

    res.json(data);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/* ----------------------------------------------------
   CREATE SPOTLIGHT
-----------------------------------------------------*/
router.post("/", upload.single("file"), async (req: Request, res: Response) => {
  try {
    const { title, subtitle, media_type, module_type } = req.body;

    let media_url = "";
    let thumbnail_url = "";

    if (req.file) {
      media_url = await uploadToSupabase(
        req.file,
        media_type === "video" ? "videos" : "images"
      );

      if (media_type === "video") {
        thumbnail_url = "https://placehold.co/300x400?text=Video+Preview";
      }
    }

    // Find next order index
    const { data: maxRow } = await supabase
      .from("spotlight_items")
      .select("order_index")
      .order("order_index", { ascending: false })
      .limit(1);

    const nextOrder = maxRow?.[0]?.order_index + 1 || 1;

    // Insert into DB
    const { data, error } = await supabase
      .from("spotlight_items")
      .insert([
        {
          title,
          subtitle,
          media_type,
          media_url,
          thumbnail_url,
          module_type: module_type || "global",
          order_index: nextOrder,
        },
      ])
      .select("*")
      .single();

    if (error) throw error;

    res.json(data);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/* ----------------------------------------------------
   UPDATE SPOTLIGHT
-----------------------------------------------------*/
router.put("/:id", upload.single("file"), async (req: Request, res: Response) => {
  try {
    const id = req.params.id;

    const updateData: any = {
      title: req.body.title,
      subtitle: req.body.subtitle,
      media_type: req.body.media_type,
      module_type: req.body.module_type,
      updated_at: new Date().toISOString(),
    };

    // If new file was uploaded
    if (req.file) {
      updateData.media_url = await uploadToSupabase(
        req.file,
        req.body.media_type === "video" ? "videos" : "images"
      );

      if (req.body.media_type === "video") {
        updateData.thumbnail_url = "https://placehold.co/300x400?text=Preview";
      }
    }

    const { data, error } = await supabase
      .from("spotlight_items")
      .update(updateData)
      .eq("id", id)
      .select("*")
      .single();

    if (error) throw error;

    res.json(data);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/* ----------------------------------------------------
   DELETE (SOFT)
-----------------------------------------------------*/
router.delete("/:id", async (req: Request, res: Response) => {
  try {
    await supabase
      .from("spotlight_items")
      .update({ is_active: false })
      .eq("id", req.params.id);

    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/* ----------------------------------------------------
   REORDER
-----------------------------------------------------*/
router.put("/reorder/list", async (req: Request, res: Response) => {
  try {
    const order = req.body.order;

    const jobs = order.map((o: any) =>
      supabase
        .from("spotlight_items")
        .update({ order_index: o.order_index })
        .eq("id", o.id)
    );

    await Promise.all(jobs);

    res.json({ message: "Order updated" });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
