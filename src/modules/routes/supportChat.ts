import { Router } from "express";
import { z } from "zod";
import supabase from "../../database/supabase";
import { getBearerToken, supabaseAuthed } from "../services/authService";
import https from "https";
import crypto from "crypto";

const router = Router();

const SUPPORT_MODEL = process.env.OPENAI_SUPPORT_MODEL || "gpt-4.1-mini";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";

const StartSessionSchema = z.object({
  guest_identifier: z.string().trim().max(200).optional(),
  channel: z.string().trim().max(60).optional(),
  metadata: z.record(z.string(), z.any()).optional(),
});

const MessageSchema = z.object({
  chat_id: z.string().uuid().optional(),
  message: z.string().trim().min(1).max(4000),
  guest_identifier: z.string().trim().max(200).optional(),
  channel: z.string().trim().max(60).optional(),
  metadata: z.record(z.string(), z.any()).optional(),
  confirm_handoff: z.boolean().optional(),
  user_context: z
    .object({
      full_name: z.string().trim().max(140).optional(),
      phone: z.string().trim().max(40).optional(),
      email: z.string().trim().email().optional(),
    })
    .optional(),
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

function jsonResponse(statusCode: number, payload: any) {
  return { statusCode, payload };
}

function callOpenAIChat(input: {
  systemPrompt: string;
  conversation: Array<{ role: "user" | "assistant"; content: string }>;
}): Promise<{ text: string; raw: any }> {
  if (!OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is missing");
  }

  const body = JSON.stringify({
    model: SUPPORT_MODEL,
    messages: [
      { role: "system", content: input.systemPrompt },
      ...input.conversation.map((m) => ({ role: m.role, content: m.content })),
    ],
    temperature: 0.2,
  });

  return new Promise((resolve, reject) => {
    const req = https.request(
      "https://api.openai.com/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          Authorization: `Bearer ${OPENAI_API_KEY}`,
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          try {
            const parsed = JSON.parse(data || "{}");
            if (res.statusCode && res.statusCode >= 400) {
              return reject(new Error(parsed?.error?.message || `OpenAI request failed (${res.statusCode})`));
            }
            const text = parsed?.choices?.[0]?.message?.content;
            if (!text || typeof text !== "string") {
              return reject(new Error("OpenAI response did not include assistant text"));
            }
            return resolve({ text: text.trim(), raw: parsed });
          } catch (error: any) {
            return reject(new Error(error?.message || "Failed to parse OpenAI response"));
          }
        });
      }
    );

    req.on("error", (error) => reject(error));
    req.write(body);
    req.end();
  });
}

async function resolveIdentity(req: any) {
  const token = getBearerToken(req);
  if (!token) return { userId: null as string | null, isLoggedIn: false };

  const authed = supabaseAuthed(req);
  if (!authed) return { userId: null as string | null, isLoggedIn: false };

  const { data, error } = await authed.auth.getUser();
  if (error || !data?.user) return { userId: null as string | null, isLoggedIn: false };

  return { userId: data.user.id, isLoggedIn: true };
}

async function fetchKnowledgeBase(query: string) {
  const queryTerms = query
    .toLowerCase()
    .split(/\s+/)
    .map((x) => x.trim())
    .filter((x) => x.length > 2)
    .slice(0, 8);

  const baseHelpQ = supabase
    .from("help_topics")
    .select("id, category, title, content, tags, source, display_order")
    .eq("is_published", true)
    .order("display_order", { ascending: true })
    .order("updated_at", { ascending: false })
    .limit(12);

  const baseFaqQ = supabase
    .from("faq_entries")
    .select("id, question, answer, tags, source, display_order")
    .eq("is_published", true)
    .order("display_order", { ascending: true })
    .order("updated_at", { ascending: false })
    .limit(12);

  let topics: any[] = [];
  let faqs: any[] = [];

  if (queryTerms.length > 0) {
    const likes = queryTerms.map((term) => term.replace(/[%_]/g, ""));
    const orHelp = likes
      .map((term) => `title.ilike.%${term}%,content.ilike.%${term}%,category.ilike.%${term}%,tags.cs.{${term}}`)
      .join(",");
    const orFaq = likes
      .map((term) => `question.ilike.%${term}%,answer.ilike.%${term}%,tags.cs.{${term}}`)
      .join(",");

    const [{ data: filteredTopics, error: topicErr }, { data: filteredFaqs, error: faqErr }] =
      await Promise.all([baseHelpQ.or(orHelp), baseFaqQ.or(orFaq)]);

    if (topicErr) throw topicErr;
    if (faqErr) throw faqErr;

    topics = filteredTopics || [];
    faqs = filteredFaqs || [];
  }

  if (topics.length === 0 && faqs.length === 0) {
    const [{ data: fallbackTopics, error: topicErr }, { data: fallbackFaqs, error: faqErr }] = await Promise.all([
      baseHelpQ,
      baseFaqQ,
    ]);

    if (topicErr) throw topicErr;
    if (faqErr) throw faqErr;
    topics = fallbackTopics || [];
    faqs = fallbackFaqs || [];
  }

  return {
    topics,
    faqs,
  };
}

async function ensureConversation(params: {
  chatId?: string;
  userId: string | null;
  guestIdentifier?: string;
  channel?: string;
  metadata?: Record<string, any>;
}) {
  if (params.chatId) {
    const { data, error } = await supabase
      .from("chat_conversations")
      .select("*")
      .eq("id", params.chatId)
      .maybeSingle();
    if (error) throw error;
    if (data) return data;
  }

  const { data, error } = await supabase
    .from("chat_conversations")
    .insert({
      user_id: params.userId,
      guest_identifier: params.userId ? null : params.guestIdentifier || `guest_${Date.now()}`,
      channel: params.channel || "mobile_app",
      metadata: params.metadata || {},
      status: "OPEN",
    })
    .select("*")
    .single();

  if (error) throw error;
  return data;
}

function canAccessConversation(params: {
  conversation: any;
  userId: string | null;
  guestIdentifier?: string;
}) {
  if (params.conversation.user_id) {
    return Boolean(params.userId && params.conversation.user_id === params.userId);
  }

  return Boolean(
    params.guestIdentifier &&
      params.conversation.guest_identifier &&
      params.guestIdentifier === params.conversation.guest_identifier
  );
}

function userAskedForHumanSupport(message: string) {
  const normalized = message.toLowerCase();
  return [
    "human",
    "agent",
    "customer care",
    "customer support",
    "support team",
    "call me",
    "raise ticket",
    "escalate",
  ].some((keyword) => normalized.includes(keyword));
}

async function insertMessage(params: {
  conversationId: string;
  role: "user" | "assistant" | "system";
  message: string;
  messageType?: "text" | "escalation_prompt" | "escalation_confirmation" | "system_note";
  model?: string | null;
  sources?: any;
  tokenUsage?: Record<string, any>;
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
    model: params.model || null,
    sources: params.sources || [],
    token_usage: params.tokenUsage || {},
    created_at: new Date().toISOString(),
  };

  const existingTranscript = Array.isArray((row as any)?.transcript) ? (row as any).transcript : [];
  const nextTranscript = [...existingTranscript, nextMessage];

  const { error } = await supabase.from("chat_messages").upsert(
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

  if (error) throw error;
}

async function buildTranscript(conversationId: string) {
  const { data, error } = await supabase
    .from("chat_messages")
    .select("transcript")
    .eq("conversation_id", conversationId)
    .maybeSingle();

  if (error) throw error;
  const transcript = Array.isArray((data as any)?.transcript) ? (data as any).transcript : [];
  return transcript.map((entry: any) => ({
    role: entry.role,
    message: entry.message,
    created_at: entry.created_at,
  }));
}

async function createTicketFromConversation(params: {
  conversationId: string;
  userId: string | null;
  guestIdentifier: string | null;
  latestUserMessage: string;
}) {
  const { data: existingTicket, error: existingErr } = await supabase
    .from("support_tickets")
    .select("*")
    .eq("conversation_id", params.conversationId)
    .maybeSingle();

  if (existingErr) throw existingErr;
  if (existingTicket) {
    const { error: convoErr } = await supabase
      .from("chat_conversations")
      .update({
        status: "HANDED_OFF",
        handed_off_at: new Date().toISOString(),
        ticket_id: existingTicket.id,
      })
      .eq("id", params.conversationId);

    if (convoErr) throw convoErr;
    return existingTicket;
  }

  const transcript = await buildTranscript(params.conversationId);

  const subject = `Support from chat ${params.conversationId.slice(0, 8)}`;
  const summary = params.latestUserMessage.slice(0, 500);

  const { data: ticket, error: ticketErr } = await supabase
    .from("support_tickets")
    .upsert(
      {
        conversation_id: params.conversationId,
        user_id: params.userId,
        guest_identifier: params.userId ? null : params.guestIdentifier,
        subject,
        summary,
        transcript,
        status: "OPEN",
        priority: "NORMAL",
        source: "chatbot",
      },
      { onConflict: "conversation_id" }
    )
    .select("*")
    .single();

  if (ticketErr) throw ticketErr;

  const { error: convoErr } = await supabase
    .from("chat_conversations")
    .update({
      status: "HANDED_OFF",
      handed_off_at: new Date().toISOString(),
      ticket_id: ticket.id,
    })
    .eq("id", params.conversationId);

  if (convoErr) throw convoErr;

  return ticket;
}

router.post("/session", async (req, res) => {
  try {
    const parsed = StartSessionSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid payload", issues: parsed.error.issues });
    }

    const identity = await resolveIdentity(req);
    const guestIdentifier =
      parsed.data.guest_identifier ||
      (identity.userId ? undefined : `guest_${Date.now()}`);

    let existingQuery = supabase
      .from("chat_conversations")
      .select("*")
      .order("updated_at", { ascending: false })
      .limit(1);

    if (identity.userId) {
      existingQuery = existingQuery.eq("user_id", identity.userId);
    } else {
      existingQuery = existingQuery.eq("guest_identifier", guestIdentifier || "");
    }

    const { data: existingRows, error: existingErr } = await existingQuery;
    if (existingErr) throw existingErr;
    const latestConversation = (existingRows || [])[0] || null;

    // Reuse same thread until it is explicitly CLOSED.
    const convo =
      latestConversation && latestConversation.status !== "CLOSED"
        ? latestConversation
        : await ensureConversation({
            userId: identity.userId,
            guestIdentifier,
            channel: parsed.data.channel,
            metadata: parsed.data.metadata,
          });

    return res.status(201).json({
      chat_id: convo.id,
      status: convo.status,
      is_logged_in: identity.isLoggedIn,
      ai_enabled: convo.status === "OPEN" || convo.status === "HANDOFF_REQUESTED",
    });
  } catch (error: any) {
    console.error("[support-chat/session]", error);
    return res.status(500).json({ error: error?.message || "Failed to create chat session" });
  }
});

router.post("/message", async (req, res) => {
  try {
    const parsed = MessageSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid payload", issues: parsed.error.issues });
    }

    const payload = parsed.data;
    const identity = await resolveIdentity(req);

    const convo = await ensureConversation({
      chatId: payload.chat_id,
      userId: identity.userId,
      guestIdentifier: payload.guest_identifier,
      channel: payload.channel,
      metadata: payload.metadata,
    });

    if (
      payload.chat_id &&
      !canAccessConversation({
        conversation: convo,
        userId: identity.userId,
        guestIdentifier: payload.guest_identifier,
      })
    ) {
      return res.status(403).json({ error: "You cannot access this chat" });
    }

    await insertMessage({
      conversationId: convo.id,
      role: "user",
      message: payload.message,
      messageType: "text",
    });

    // Once handed off, AI must not respond in this conversation.
    if (["HANDED_OFF", "RESOLVED", "CLOSED"].includes(String(convo.status || ""))) {
      return res.status(200).json({
        chat_id: convo.id,
        response:
          "Your chat is now with our support team. Please continue here and an agent will respond shortly.",
        status: convo.status,
        handoff_requested: true,
        ticket_id: convo.ticket_id || null,
        ai_disabled: true,
      });
    }

    if (payload.confirm_handoff === true || convo.status === "HANDOFF_REQUESTED") {
      const ticket = await createTicketFromConversation({
        conversationId: convo.id,
        userId: identity.userId,
        guestIdentifier: convo.guest_identifier,
        latestUserMessage: payload.message,
      });

      const assistantText = `Thanks for confirming. I have created support ticket ${ticket.id} and you will be connected to the agent soon.`;
      await insertMessage({
        conversationId: convo.id,
        role: "assistant",
        message: assistantText,
        messageType: "escalation_confirmation",
      });

      return res.status(200).json(
        jsonResponse(200, {
          chat_id: convo.id,
          response: assistantText,
          status: "HANDED_OFF",
          handoff_requested: true,
          ticket_id: ticket.id,
        }).payload
      );
    }

    const kb = await fetchKnowledgeBase(payload.message);

    const kbText = [
      "Help topics:",
      ...kb.topics.map((t: any, index: number) => `${index + 1}. [${t.category}] ${t.title}: ${t.content}`),
      "FAQ entries:",
      ...kb.faqs.map((f: any, index: number) => `${index + 1}. Q: ${f.question} A: ${f.answer}`),
    ].join("\n");

    const conversationForModel: Array<{ role: "user" | "assistant"; content: string }> = [
      {
        role: "user",
        content: `User message: ${payload.message}`,
      },
    ];

    const systemPrompt = [
      "You are a concise support chatbot for a consumer app.",
      "Use only provided knowledge base context when possible.",
      "If question is out-of-scope or answer is not in context, reply exactly with: ESCALATE_TO_SUPPORT_CONFIRMATION",
      "When answering from KB, keep to 2-5 sentences and be specific.",
      "Knowledge base context:",
      kbText,
    ].join("\n");

    const completion = await callOpenAIChat({
      systemPrompt,
      conversation: conversationForModel,
    });

    let assistantText = completion.text;
    let handoffRequested = false;
    let status = "OPEN";
    let messageType: "text" | "escalation_prompt" = "text";
    const previousOutOfScopeCount = Number(convo?.metadata?.out_of_scope_count || 0);
    const explicitHumanSupport = userAskedForHumanSupport(payload.message);
    let nextMetadata = convo?.metadata || {};

    if (assistantText.includes("ESCALATE_TO_SUPPORT_CONFIRMATION")) {
      if (explicitHumanSupport || previousOutOfScopeCount >= 1) {
        handoffRequested = true;
        status = "HANDOFF_REQUESTED";
        messageType = "escalation_prompt";
        assistantText =
          "Please confirm if you want to connect to support. Reply with yes to continue.";
        nextMetadata = { ...(convo?.metadata || {}), out_of_scope_count: 0 };
      } else {
        handoffRequested = false;
        status = "OPEN";
        messageType = "text";
        assistantText =
          "I want to help with this. Could you share a bit more detail or ask in another way? I can answer from PassPrive help topics and FAQs, or connect you to support if you prefer.";
        nextMetadata = { ...(convo?.metadata || {}), out_of_scope_count: previousOutOfScopeCount + 1 };
      }
    } else {
      nextMetadata = { ...(convo?.metadata || {}), out_of_scope_count: 0 };
    }

    const { error: updateErr } = await supabase
      .from("chat_conversations")
      .update({
        status,
        handoff_requested_at: handoffRequested ? new Date().toISOString() : null,
        metadata: nextMetadata,
      })
      .eq("id", convo.id);

    if (updateErr) throw updateErr;

    await insertMessage({
      conversationId: convo.id,
      role: "assistant",
      message: assistantText,
      messageType,
      model: SUPPORT_MODEL,
      tokenUsage: completion.raw?.usage || {},
      sources: {
        help_topics: kb.topics.map((x: any) => x.id),
        faq_entries: kb.faqs.map((x: any) => x.id),
      } as any,
    });

    return res.status(200).json({
      chat_id: convo.id,
      response: assistantText,
      status,
      handoff_requested: handoffRequested,
      ticket_id: null,
      used_sources: {
        help_topics: kb.topics.map((x: any) => ({ id: x.id, title: x.title, category: x.category })),
        faq_entries: kb.faqs.map((x: any) => ({ id: x.id, question: x.question })),
      },
    });
  } catch (error: any) {
    console.error("[support-chat/message]", error);
    return res.status(500).json({ error: error?.message || "Failed to process message" });
  }
});

router.get("/conversation/:chatId", async (req, res) => {
  try {
    const chatId = String(req.params.chatId || "").trim();
    if (!chatId) return res.status(400).json({ error: "chatId is required" });

    const identity = await resolveIdentity(req);
    const { data: convo, error: convoErr } = await supabase
      .from("chat_conversations")
      .select("*")
      .eq("id", chatId)
      .maybeSingle();

    if (convoErr) throw convoErr;
    if (!convo) return res.status(404).json({ error: "Conversation not found" });
    const guestIdentifier = String(req.query.guest_identifier || "").trim();
    if (
      !canAccessConversation({
        conversation: convo,
        userId: identity.userId,
        guestIdentifier,
      })
    ) {
      return res.status(403).json({ error: "You cannot access this chat" });
    }

    const { data: messages, error: msgErr } = await supabase
      .from("chat_messages")
      .select("transcript")
      .eq("conversation_id", chatId)
      .maybeSingle();

    if (msgErr) throw msgErr;
    const transcript = Array.isArray((messages as any)?.transcript) ? (messages as any).transcript : [];

    return res.status(200).json({
      conversation: convo,
      messages: transcript,
    });
  } catch (error: any) {
    console.error("[support-chat/conversation]", error);
    return res.status(500).json({ error: error?.message || "Failed to fetch conversation" });
  }
});

export default router;
