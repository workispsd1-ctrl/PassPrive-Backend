import https from "https";

export type LLMProvider = "openai" | "groq" | "together" | "custom";

export interface LLMMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  tool_calls?: any[];
  tool_call_id?: string;
}

export interface LLMToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, any>;
  };
}

export interface LLMCompletionResult {
  content: string | null;
  tool_calls: Array<{
    id: string;
    type: "function";
    function: {
      name: string;
      arguments: string;
    };
  }>;
  model: string;
  tokens_in: number;
  tokens_out: number;
}

/**
 * Resolves current provider configuration from environment variables
 */
export function getLLMConfig(): {
  provider: LLMProvider;
  apiKey: string;
  model: string;
  endpoint: string;
} {
  const provider = (process.env.AI_RECOMMENDER_PROVIDER || "groq").toLowerCase() as LLMProvider;

  if (provider === "groq") {
    return {
      provider: "groq",
      apiKey: process.env.GROQ_API_KEY || process.env.AI_RECOMMENDER_API_KEY || "",
      model: process.env.AI_RECOMMENDER_MODEL || "llama-3.3-70b-versatile",
      endpoint: "https://api.groq.com/openai/v1/chat/completions",
    };
  }

  if (provider === "together") {
    return {
      provider: "together",
      apiKey: process.env.TOGETHER_API_KEY || process.env.AI_RECOMMENDER_API_KEY || "",
      model: process.env.AI_RECOMMENDER_MODEL || "meta-llama/Llama-3.3-70B-Instruct-Turbo",
      endpoint: "https://api.together.xyz/v1/chat/completions",
    };
  }

  // Default to OpenAI
  return {
    provider: "openai",
    apiKey: process.env.OPENAI_API_KEY || process.env.AI_RECOMMENDER_API_KEY || "",
    model: process.env.AI_RECOMMENDER_MODEL || "gpt-4o-mini",
    endpoint: "https://api.openai.com/v1/chat/completions",
  };
}

/**
 * Execute chat completion with strict tool calling support
 */
export async function callLLMChat(input: {
  messages: LLMMessage[];
  tools?: LLMToolDefinition[];
  tool_choice?: "auto" | "required" | { type: "function"; function: { name: string } };
  temperature?: number;
  max_tokens?: number;
}): Promise<LLMCompletionResult> {
  const config = getLLMConfig();
  if (!config.apiKey) {
    throw new Error(
      `API key missing for AI provider '${config.provider}'. Set ${
        config.provider === "groq" ? "GROQ_API_KEY" : "OPENAI_API_KEY"
      } in your .env file.`
    );
  }

  const payloadObj: Record<string, any> = {
    model: config.model,
    messages: input.messages,
    temperature: input.temperature ?? 0.2,
    max_tokens: input.max_tokens ?? 400,
  };

  if (input.tools && input.tools.length > 0) {
    payloadObj.tools = input.tools;
    if (input.tool_choice) {
      payloadObj.tool_choice = input.tool_choice;
    }
  }

  const body = JSON.stringify(payloadObj);
  const url = new URL(config.endpoint);

  return new Promise<LLMCompletionResult>((resolve, reject) => {
    const req = https.request(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          Authorization: `Bearer ${config.apiKey}`,
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (chunk) => {
          raw += chunk;
        });
        res.on("end", () => {
          try {
            const data = JSON.parse(raw || "{}");
            if (res.statusCode && res.statusCode >= 400) {
              return reject(
                new Error(data?.error?.message || `LLM request failed with HTTP ${res.statusCode} from ${config.provider}`)
              );
            }

            const choice = data?.choices?.[0];
            const message = choice?.message;
            const toolCalls = message?.tool_calls || [];
            const textContent = message?.content || null;

            resolve({
              content: textContent,
              tool_calls: Array.isArray(toolCalls) ? toolCalls : [],
              model: data?.model || config.model,
              tokens_in: data?.usage?.prompt_tokens || 0,
              tokens_out: data?.usage?.completion_tokens || 0,
            });
          } catch (err: any) {
            reject(new Error(`Failed to parse response from ${config.provider}: ${err?.message}`));
          }
        });
      }
    );

    req.on("error", (err) => {
      reject(new Error(`Network error communicating with ${config.provider}: ${err.message}`));
    });

    req.setTimeout(12000, () => {
      req.destroy();
      reject(new Error(`AI model request timed out after 12s on ${config.provider}`));
    });

    req.write(body);
    req.end();
  });
}

