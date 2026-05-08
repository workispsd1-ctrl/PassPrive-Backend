import { Router } from "express";
import { z } from "zod";
import supabase from "../../database/supabase";
import { requireAdmin } from "../services/authService";
import crypto from "crypto";

const router = Router();

const TicketListQuerySchema = z.object({
  status: z.string().trim().optional(),
  priority: z.string().trim().optional(),
  assigned_to: z.string().trim().optional(),
  search: z.string().trim().optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
});

const TicketPatchSchema = z
  .object({
    status: z.enum(["OPEN", "IN_PROGRESS", "WAITING_USER", "RESOLVED", "CLOSED"]).optional(),
    priority: z.enum(["LOW", "NORMAL", "HIGH", "URGENT"]).optional(),
    assigned_to: z.string().uuid().nullable().optional(),
  })
  .refine((value) => value.status || value.priority || value.assigned_to !== undefined, {
    message: "At least one field is required",
  });

const TicketReplySchema = z.object({
  message: z.string().trim().min(1).max(4000),
});

type ChatTranscriptMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  message: string;
  message_type: "text" | "escalation_prompt" | "escalation_confirmation" | "system_note";
  model: string | null;
  token_usage: Record<string, any>;
  sources: any;
  created_at: string;
};

async function getAdmin(req: any, res: any) {
  const admin = await requireAdmin(req, res);
  if (!admin) return null;
  return admin;
}

async function appendConversationMessage(params: {
  conversationId: string;
  role: "user" | "assistant" | "system";
  message: string;
  messageType?: "text" | "escalation_prompt" | "escalation_confirmation" | "system_note";
}) {
  const { data: row, error: fetchErr } = await supabase
    .from("chat_messages")
    .select("conversation_id, transcript")
    .eq("conversation_id", params.conversationId)
    .maybeSingle();
  if (fetchErr) throw fetchErr;

  const nextMessage: ChatTranscriptMessage = {
    id: crypto.randomUUID(),
    role: params.role,
    message: params.message,
    message_type: params.messageType || "text",
    model: null,
    token_usage: {},
    sources: [],
    created_at: new Date().toISOString(),
  };

  const existingTranscript = Array.isArray((row as any)?.transcript) ? (row as any).transcript : [];
  const nextTranscript = [...existingTranscript, nextMessage];

  const { error: upsertErr } = await supabase.from("chat_messages").upsert(
    {
      conversation_id: params.conversationId,
      role: "system",
      message: "[transcript stored in transcript jsonb]",
      message_type: "system_note",
      model: null,
      token_usage: {},
      sources: [],
      transcript: nextTranscript,
      created_at: row ? undefined : new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
    { onConflict: "conversation_id" }
  );
  if (upsertErr) throw upsertErr;

  return nextMessage;
}

router.get("/tickets", async (req, res) => {
  try {
    const admin = await getAdmin(req, res);
    if (!admin) return;

    const parsed = TicketListQuerySchema.safeParse(req.query || {});
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid query params", issues: parsed.error.issues });
    }

    const { status, priority, assigned_to, search, page, limit } = parsed.data;
    const from = (page - 1) * limit;
    const to = from + limit - 1;

    let query = supabase
      .from("support_tickets")
      .select("*", { count: "exact" })
      .order("updated_at", { ascending: false })
      .range(from, to);

    if (status) query = query.eq("status", status);
    if (priority) query = query.eq("priority", priority);
    if (assigned_to === "unassigned") query = query.is("assigned_to", null);
    else if (assigned_to) query = query.eq("assigned_to", assigned_to);
    if (search) query = query.or(`subject.ilike.%${search}%,summary.ilike.%${search}%,id::text.ilike.%${search}%`);

    const { data: tickets, error: ticketsErr, count } = await query;
    if (ticketsErr) throw ticketsErr;

    const userIds = Array.from(new Set((tickets || []).map((t: any) => t.user_id).filter(Boolean)));
    const conversationIds = (tickets || []).map((t: any) => t.conversation_id);

    let usersById = new Map<string, any>();
    if (userIds.length > 0) {
      const { data: users, error: usersErr } = await supabase
        .from("users")
        .select("id, full_name, email, phone")
        .in("id", userIds);
      if (usersErr) throw usersErr;
      usersById = new Map((users || []).map((u: any) => [u.id, u]));
    }

    let latestByConversation = new Map<string, any>();
    if (conversationIds.length > 0) {
      const { data: messages, error: msgErr } = await supabase
        .from("chat_messages")
        .select("conversation_id, updated_at");
      if (msgErr) throw msgErr;
      const filtered = (messages || []).filter((m: any) => conversationIds.includes(m.conversation_id));
      for (const m of filtered) {
        latestByConversation.set(m.conversation_id, m);
      }
    }

    const items = (tickets || []).map((t: any) => ({
      ticket_id: t.id,
      conversation_id: t.conversation_id,
      status: t.status,
      priority: t.priority,
      subject: t.subject,
      summary: t.summary,
      user: t.user_id
        ? {
            id: t.user_id,
            full_name: usersById.get(t.user_id)?.full_name || null,
            email: usersById.get(t.user_id)?.email || null,
            phone: usersById.get(t.user_id)?.phone || null,
          }
        : null,
      guest_identifier: t.guest_identifier || null,
      last_message_at: latestByConversation.get(t.conversation_id)?.updated_at || t.updated_at,
      unread_count: 0,
      assigned_to: t.assigned_to,
      created_at: t.created_at,
      updated_at: t.updated_at,
    }));

    return res.status(200).json({
      items,
      page,
      limit,
      total: count || 0,
    });
  } catch (error: any) {
    console.error("[support-admin/tickets]", error);
    return res.status(500).json({ error: error?.message || "Failed to list tickets" });
  }
});

router.get("/tickets/stats", async (req, res) => {
  try {
    const admin = await getAdmin(req, res);
    if (!admin) return;

    const { data: tickets, error } = await supabase
      .from("support_tickets")
      .select("id, status, created_at, resolved_at");
    if (error) throw error;

    const now = new Date();
    const todayUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

    let open = 0;
    let inProgress = 0;
    let waitingUser = 0;
    let resolvedToday = 0;

    for (const t of tickets || []) {
      if (t.status === "OPEN") open += 1;
      if (t.status === "IN_PROGRESS") inProgress += 1;
      if (t.status === "WAITING_USER") waitingUser += 1;
      if (t.resolved_at && new Date(t.resolved_at) >= todayUtc) resolvedToday += 1;
    }

    return res.status(200).json({
      open,
      in_progress: inProgress,
      waiting_user: waitingUser,
      resolved_today: resolvedToday,
      avg_first_response_seconds: null,
    });
  } catch (error: any) {
    console.error("[support-admin/tickets/stats]", error);
    return res.status(500).json({ error: error?.message || "Failed to fetch ticket stats" });
  }
});

router.get("/tickets/:ticketId", async (req, res) => {
  try {
    const admin = await getAdmin(req, res);
    if (!admin) return;

    const ticketId = String(req.params.ticketId || "").trim();
    if (!ticketId) return res.status(400).json({ error: "ticketId is required" });

    const { data: ticket, error: ticketErr } = await supabase
      .from("support_tickets")
      .select("*")
      .eq("id", ticketId)
      .maybeSingle();
    if (ticketErr) throw ticketErr;
    if (!ticket) return res.status(404).json({ error: "Ticket not found" });

    const { data: conversation, error: convoErr } = await supabase
      .from("chat_conversations")
      .select("*")
      .eq("id", ticket.conversation_id)
      .maybeSingle();
    if (convoErr) throw convoErr;

    const { data: messages, error: msgErr } = await supabase
      .from("chat_messages")
      .select("transcript")
      .eq("conversation_id", ticket.conversation_id)
      .maybeSingle();
    if (msgErr) throw msgErr;
    const transcript = Array.isArray((messages as any)?.transcript) ? (messages as any).transcript : [];

    return res.status(200).json({
      ticket,
      conversation,
      messages: transcript,
    });
  } catch (error: any) {
    console.error("[support-admin/ticket-detail]", error);
    return res.status(500).json({ error: error?.message || "Failed to fetch ticket detail" });
  }
});

router.post("/tickets/:ticketId/reply", async (req, res) => {
  try {
    const admin = await getAdmin(req, res);
    if (!admin) return;

    const parsed = TicketReplySchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid payload", issues: parsed.error.issues });
    }

    const ticketId = String(req.params.ticketId || "").trim();
    if (!ticketId) return res.status(400).json({ error: "ticketId is required" });

    const { data: ticket, error: ticketErr } = await supabase
      .from("support_tickets")
      .select("*")
      .eq("id", ticketId)
      .maybeSingle();
    if (ticketErr) throw ticketErr;
    if (!ticket) return res.status(404).json({ error: "Ticket not found" });

    await appendConversationMessage({
      conversationId: ticket.conversation_id,
      role: "assistant",
      message: parsed.data.message,
      messageType: "text",
    });

    const nextStatus = ticket.status === "OPEN" ? "IN_PROGRESS" : ticket.status;

    const { data: updatedTicket, error: updateErr } = await supabase
      .from("support_tickets")
      .update({
        status: nextStatus,
        assigned_to: ticket.assigned_to || admin.callerId,
        updated_at: new Date().toISOString(),
      })
      .eq("id", ticketId)
      .select("*")
      .single();
    if (updateErr) throw updateErr;

    return res.status(200).json({
      success: true,
      ticket: updatedTicket,
    });
  } catch (error: any) {
    console.error("[support-admin/reply]", error);
    return res.status(500).json({ error: error?.message || "Failed to send reply" });
  }
});

router.patch("/tickets/:ticketId", async (req, res) => {
  try {
    const admin = await getAdmin(req, res);
    if (!admin) return;

    const parsed = TicketPatchSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid payload", issues: parsed.error.issues });
    }

    const ticketId = String(req.params.ticketId || "").trim();
    if (!ticketId) return res.status(400).json({ error: "ticketId is required" });

    const patch: Record<string, any> = {
      updated_at: new Date().toISOString(),
    };

    if (parsed.data.status) patch.status = parsed.data.status;
    if (parsed.data.priority) patch.priority = parsed.data.priority;
    if (parsed.data.assigned_to !== undefined) patch.assigned_to = parsed.data.assigned_to;
    if (parsed.data.status === "RESOLVED") patch.resolved_at = new Date().toISOString();
    if (parsed.data.status === "CLOSED") patch.closed_at = new Date().toISOString();

    const { data: ticket, error } = await supabase
      .from("support_tickets")
      .update(patch)
      .eq("id", ticketId)
      .select("*")
      .maybeSingle();
    if (error) throw error;
    if (!ticket) return res.status(404).json({ error: "Ticket not found" });

    return res.status(200).json({ ticket });
  } catch (error: any) {
    console.error("[support-admin/patch-ticket]", error);
    return res.status(500).json({ error: error?.message || "Failed to update ticket" });
  }
});

router.post("/tickets/:ticketId/mark-read", async (req, res) => {
  try {
    const admin = await getAdmin(req, res);
    if (!admin) return;

    const ticketId = String(req.params.ticketId || "").trim();
    if (!ticketId) return res.status(400).json({ error: "ticketId is required" });

    return res.status(200).json({
      success: true,
      note: "Unread tracking table is not implemented yet; returning success placeholder.",
    });
  } catch (error: any) {
    console.error("[support-admin/mark-read]", error);
    return res.status(500).json({ error: error?.message || "Failed to mark read" });
  }
});

router.post("/tickets/:ticketId/close", async (req, res) => {
  try {
    const admin = await getAdmin(req, res);
    if (!admin) return;

    const ticketId = String(req.params.ticketId || "").trim();
    if (!ticketId) return res.status(400).json({ error: "ticketId is required" });

    const { data: ticket, error: ticketErr } = await supabase
      .from("support_tickets")
      .select("*")
      .eq("id", ticketId)
      .maybeSingle();
    if (ticketErr) throw ticketErr;
    if (!ticket) return res.status(404).json({ error: "Ticket not found" });

    const nowIso = new Date().toISOString();

    const { data: updatedTicket, error: updateTicketErr } = await supabase
      .from("support_tickets")
      .update({
        status: "CLOSED",
        closed_at: nowIso,
        updated_at: nowIso,
      })
      .eq("id", ticketId)
      .select("*")
      .single();
    if (updateTicketErr) throw updateTicketErr;

    const { data: updatedConversation, error: updateConvoErr } = await supabase
      .from("chat_conversations")
      .update({
        status: "CLOSED",
        updated_at: nowIso,
      })
      .eq("id", ticket.conversation_id)
      .select("*")
      .single();
    if (updateConvoErr) throw updateConvoErr;

    // Add a system note to transcript for traceability.
    await appendConversationMessage({
      conversationId: ticket.conversation_id,
      role: "system",
      message: "Conversation closed by support agent.",
      messageType: "system_note",
    });

    return res.status(200).json({
      success: true,
      ticket: updatedTicket,
      conversation: updatedConversation,
    });
  } catch (error: any) {
    console.error("[support-admin/close-ticket]", error);
    return res.status(500).json({ error: error?.message || "Failed to close ticket" });
  }
});

export default router;
