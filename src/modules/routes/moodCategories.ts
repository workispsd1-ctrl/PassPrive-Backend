import { Router, Request, Response } from "express";
import supabase from "../../database/supabase";
import multer from "multer";

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
});

const BUCKET_NAME = "mood-category-images";

const parseBoolean = (value: any) => {
  if (value === undefined) return undefined;
  if (typeof value === "boolean") return value;
  return value === "true";
};

const parseNumber = (value: any) => {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number(value);
  return Number.isNaN(parsed) ? undefined : parsed;
};

const parseMetadata = (value: any) => {
  if (value === undefined) return undefined;
  if (typeof value === "object" && value !== null) return value;
  if (typeof value === "string" && value.trim() !== "") {
    return JSON.parse(value);
  }
  return {};
};

const uploadImage = async (file: Express.Multer.File) => {
  const fileExt = file.originalname.split(".").pop();
  const fileName = `mood_category_${Date.now()}.${fileExt}`;

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

router.get("/", async (req: Request, res: Response) => {
  try {
    const { data, error } = await supabase
      .from("mood_categories")
      .select("*")
      .order("sort_order", { ascending: true })
      .order("created_at", { ascending: true });

    if (error) throw error;

    return res.json({ categories: data || [] });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

router.get("/:id", async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const { data, error } = await supabase
      .from("mood_categories")
      .select("*")
      .eq("id", id)
      .single();

    if (error) {
      return res.status(404).json({ error: "Category not found" });
    }

    return res.json({ category: data });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

router.post("/", upload.single("image"), async (req: Request, res: Response) => {
  try {
    const file = req.file;
    const body = req.body;

    const payload: any = {
      key: body.key,
      slug: body.slug,
      title: body.title,
      subtitle: body.subtitle || null,
      description: body.description || null,
      badge_text: body.badge_text || null,
      selection_type: body.selection_type || "MULTI",
      sort_order: parseNumber(body.sort_order) ?? 100,
      is_active: parseBoolean(body.is_active) ?? true,
      metadata: parseMetadata(body.metadata) ?? {},
    };

    if (file) {
      Object.assign(payload, await uploadImage(file));
    } else {
      payload.image_url = body.image_url || null;
      payload.image_path = body.image_path || null;
    }

    const { data, error } = await supabase
      .from("mood_categories")
      .insert([payload])
      .select()
      .single();

    if (error) throw error;

    return res.json({
      message: "Category created successfully",
      category: data,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

router.put("/:id", upload.single("image"), async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const file = req.file;
    const body = req.body;

    const payload: any = {};

    if (body.key !== undefined) payload.key = body.key;
    if (body.slug !== undefined) payload.slug = body.slug;
    if (body.title !== undefined) payload.title = body.title;
    if (body.subtitle !== undefined) payload.subtitle = body.subtitle || null;
    if (body.description !== undefined) payload.description = body.description || null;
    if (body.badge_text !== undefined) payload.badge_text = body.badge_text || null;
    if (body.selection_type !== undefined) payload.selection_type = body.selection_type;

    const parsedSortOrder = parseNumber(body.sort_order);
    if (parsedSortOrder !== undefined) payload.sort_order = parsedSortOrder;

    const parsedIsActive = parseBoolean(body.is_active);
    if (parsedIsActive !== undefined) payload.is_active = parsedIsActive;

    if (body.metadata !== undefined) {
      payload.metadata = parseMetadata(body.metadata);
    }

    if (file) {
      const { data: existingCategory } = await supabase
        .from("mood_categories")
        .select("image_path")
        .eq("id", id)
        .single();

      Object.assign(payload, await uploadImage(file));

      if (existingCategory?.image_path) {
        await supabase.storage
          .from(BUCKET_NAME)
          .remove([existingCategory.image_path])
          .catch(() => undefined);
      }
    } else {
      if (body.image_url !== undefined) payload.image_url = body.image_url || null;
      if (body.image_path !== undefined) payload.image_path = body.image_path || null;
    }

    if (Object.keys(payload).length === 0) {
      return res.status(400).json({ error: "No fields to update" });
    }

    const { data, error } = await supabase
      .from("mood_categories")
      .update(payload)
      .eq("id", id)
      .select()
      .single();

    if (error) {
      return res.status(404).json({ error: "Category not found" });
    }

    return res.json({
      message: "Category updated successfully",
      category: data,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

router.delete("/:id", async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const { data: existingCategory } = await supabase
      .from("mood_categories")
      .select("image_path")
      .eq("id", id)
      .single();

    if (existingCategory?.image_path) {
      await supabase.storage
        .from(BUCKET_NAME)
        .remove([existingCategory.image_path])
        .catch(() => undefined);
    }

    const { error } = await supabase
      .from("mood_categories")
      .delete()
      .eq("id", id);

    if (error) throw error;

    return res.json({ message: "Category deleted successfully" });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

export default router;
