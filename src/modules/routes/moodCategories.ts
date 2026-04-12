import { Router, Request, Response } from "express";
import supabase from "../../database/supabase";
import multer from "multer";

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
});

const BUCKET_NAME = "mood-category-images";
const TABLE_NAME = "restaurant_mood_categories";

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

const logPrefix = "[restaurant-mood-categories]";

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
    console.log(`${logPrefix} list start`);

    const { data, error } = await supabase
      .from(TABLE_NAME)
      .select("*")
      .order("sort_order", { ascending: true })
      .order("created_at", { ascending: true });

    if (error) throw error;

    console.log(`${logPrefix} list success`, { count: data?.length ?? 0 });
    return res.json({ categories: data || [] });
  } catch (err: any) {
    console.error(`${logPrefix} list failed`, {
      message: err?.message ?? String(err),
    });
    return res.status(500).json({ error: err.message });
  }
});

router.get("/:id", async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    console.log(`${logPrefix} get start`, { id });

    const { data, error } = await supabase
      .from(TABLE_NAME)
      .select("*")
      .eq("id", id)
      .single();

    if (error) {
      console.warn(`${logPrefix} get not found`, { id, message: error.message });
      return res.status(404).json({ error: "Category not found" });
    }

    console.log(`${logPrefix} get success`, { id });
    return res.json({ category: data });
  } catch (err: any) {
    console.error(`${logPrefix} get failed`, {
      id: req.params.id,
      message: err?.message ?? String(err),
    });
    return res.status(500).json({ error: err.message });
  }
});

router.post("/", upload.single("image"), async (req: Request, res: Response) => {
  try {
    const file = req.file;
    const body = req.body;
    const key = normalizeText(body.key);
    const slug = normalizeText(body.slug);
    const title = normalizeText(body.title);

    console.log(`${logPrefix} create start`, {
      hasFile: Boolean(file),
      key,
      slug,
      title,
    });

    if (!key || !slug || !title) {
      return res.status(400).json({
        error: "key, slug, and title are required",
      });
    }

    const payload: any = {
      key,
      slug,
      title,
      subtitle: normalizeText(body.subtitle) ?? null,
      description: normalizeText(body.description) ?? null,
      badge_text: normalizeText(body.badge_text) ?? null,
      selection_type: body.selection_type || "MULTI",
      sort_order: parseNumber(body.sort_order) ?? 100,
      is_active: parseBoolean(body.is_active) ?? true,
      metadata: parseMetadata(body.metadata) ?? {},
    };

    if (file) {
      Object.assign(payload, await uploadImage(file));
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

    console.log(`${logPrefix} create success`, { id: data?.id ?? null });
    return res.status(201).json({
      message: "Category created successfully",
      category: data,
    });
  } catch (err: any) {
    console.error(`${logPrefix} create failed`, {
      message: err?.message ?? String(err),
      details: err?.details ?? null,
      hint: err?.hint ?? null,
      code: err?.code ?? null,
    });
    return res.status(500).json({ error: err.message });
  }
});

router.put("/:id", upload.single("image"), async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const file = req.file;
    const body = req.body;
    console.log(`${logPrefix} update start`, { id, hasFile: Boolean(file) });

    const payload: any = {};

    if (body.key !== undefined) payload.key = normalizeText(body.key) ?? null;
    if (body.slug !== undefined) payload.slug = normalizeText(body.slug) ?? null;
    if (body.title !== undefined) payload.title = normalizeText(body.title) ?? null;
    if (body.subtitle !== undefined) payload.subtitle = normalizeText(body.subtitle) ?? null;
    if (body.description !== undefined) payload.description = normalizeText(body.description) ?? null;
    if (body.badge_text !== undefined) payload.badge_text = normalizeText(body.badge_text) ?? null;
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
        .from(TABLE_NAME)
        .select("image_path")
        .eq("id", id)
        .single();

      Object.assign(payload, await uploadImage(file));

      if (existingCategory?.image_path) {
        const { error: removeError } = await supabase.storage
          .from(BUCKET_NAME)
          .remove([existingCategory.image_path]);

        if (removeError) {
          console.warn(`${logPrefix} update old image cleanup failed`, {
            id,
            image_path: existingCategory.image_path,
            message: removeError.message,
          });
        }
      }
    } else {
      if (body.image_url !== undefined) payload.image_url = normalizeText(body.image_url) ?? null;
      if (body.image_path !== undefined) payload.image_path = normalizeText(body.image_path) ?? null;
    }

    if (Object.keys(payload).length === 0) {
      return res.status(400).json({ error: "No fields to update" });
    }

    const { data, error } = await supabase
      .from(TABLE_NAME)
      .update(payload)
      .eq("id", id)
      .select()
      .single();

    if (error) {
      console.warn(`${logPrefix} update not found`, { id, message: error.message });
      return res.status(404).json({ error: "Category not found" });
    }

    console.log(`${logPrefix} update success`, { id });
    return res.json({
      message: "Category updated successfully",
      category: data,
    });
  } catch (err: any) {
    console.error(`${logPrefix} update failed`, {
      id: req.params.id,
      message: err?.message ?? String(err),
      details: err?.details ?? null,
      hint: err?.hint ?? null,
      code: err?.code ?? null,
    });
    return res.status(500).json({ error: err.message });
  }
});

router.delete("/:id", async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    console.log(`${logPrefix} delete start`, { id });

    const { data: existingCategory } = await supabase
      .from(TABLE_NAME)
      .select("image_path")
      .eq("id", id)
      .single();

    if (existingCategory?.image_path) {
      const { error: removeError } = await supabase.storage
        .from(BUCKET_NAME)
        .remove([existingCategory.image_path]);

      if (removeError) {
        console.warn(`${logPrefix} delete image cleanup failed`, {
          id,
          image_path: existingCategory.image_path,
          message: removeError.message,
        });
      }
    }

    const { error } = await supabase
      .from(TABLE_NAME)
      .delete()
      .eq("id", id);

    if (error) throw error;

    console.log(`${logPrefix} delete success`, { id });
    return res.json({ message: "Category deleted successfully" });
  } catch (err: any) {
    console.error(`${logPrefix} delete failed`, {
      id: req.params.id,
      message: err?.message ?? String(err),
      details: err?.details ?? null,
      hint: err?.hint ?? null,
      code: err?.code ?? null,
    });
    return res.status(500).json({ error: err.message });
  }
});

export default router;
