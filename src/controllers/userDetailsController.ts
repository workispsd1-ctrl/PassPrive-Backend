// controllers/userDetailsController.ts

import { Request, Response } from "express";
import supabase from "../database/supabase";

export const saveUserDetails = async (req: Request, res: Response) => {
  try {
    const { id, full_name, phone } = req.body;

    if (!id || !full_name || !phone) {
      return res.status(400).json({
        success: false,
        message: "Missing required fields",
      });
    }

    // Check if user exists
    const { data: existingUser, error: selectErr } = await supabase
      .from("users")
      .select("*")
      .eq("id", id)
      .single();

    // If error and not "row not found"
    if (selectErr && selectErr.code !== "PGRST116") {
      console.log(selectErr);
      return res.status(500).json({ success: false, message: "DB error" });
    }

    let result;

    if (existingUser) {
      // Update user
      const { data, error } = await supabase
        .from("users")
        .update({
          full_name,
          phone,
          updated_at: new Date().toISOString(),
        })
        .eq("id", id)
        .select()
        .single();

      if (error) throw error;
      result = data;
    } else {
      // Create new user
      const { data, error } = await supabase
        .from("users")
        .insert({
          id,
          full_name,
          phone,
        })
        .select()
        .single();

      if (error) throw error;
      result = data;
    }

    return res.status(200).json({
      success: true,
      message: "User details saved successfully",
      user: result,
    });

  } catch (error) {
    console.error("saveUserDetails error:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
};
