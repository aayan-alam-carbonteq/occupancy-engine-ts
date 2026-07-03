// Port of occupancy_engine/agents/llm.py.
//
// PORT NOTE (dependency guard): Python wraps each provider import in try/except ImportError ->
// AgentDependencyError. JS uses static imports and the LangChain provider packages are declared
// dependencies, so there is no runtime ImportError to catch. AgentDependencyError is preserved as an
// exported error class (for API parity) but is no longer thrown from a missing-import path.
//
// PORT NOTE (timeout units): Python (httpx) `timeout` is in seconds; the JS SDKs use milliseconds.
// timeout_seconds is multiplied by 1000 so the wall-clock timeout behaviour is preserved.
import { ChatAnthropic } from "@langchain/anthropic";
import { ChatOpenAI } from "@langchain/openai";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";

export class AgentDependencyError extends Error {
  constructor(message?: string) {
    super(message);
    this.name = "AgentDependencyError";
  }
}

export class AgentConfigurationError extends Error {
  constructor(message?: string) {
    super(message);
    this.name = "AgentConfigurationError";
  }
}

export type LlmProvider = "auto" | "openai" | "gemini" | "anthropic";

export interface LlmConfig {
  model?: string | null;
  provider?: LlmProvider;
  api_key?: string | null;
  base_url?: string | null;
  timeout_seconds?: number;
  max_retries?: number;
  temperature?: number | null;
}

const DEFAULT_TIMEOUT_SECONDS = 120.0;
const DEFAULT_MAX_RETRIES = 2;

export function createChatModel(config: LlmConfig): BaseChatModel {
  const provider = resolveProvider(config.provider ?? "auto");
  if (provider === "openai") {
    return createOpenAiModel(config);
  }
  if (provider === "gemini") {
    return createGeminiModel(config);
  }
  if (provider === "anthropic") {
    return createAnthropicModel(config);
  }
  throw new AgentConfigurationError(`Unsupported LLM provider: ${provider}`);
}

export function resolveProvider(provider: LlmProvider = "auto"): "openai" | "gemini" | "anthropic" {
  if (provider !== "auto") {
    return provider;
  }
  if (envAny("OPENAI_API_KEY", "OPENAI_ADMIN_KEY")) {
    return "openai";
  }
  if (envAny("GEMINI_API_KEY", "GOOGLE_API_KEY")) {
    return "gemini";
  }
  if (envAny("ANTHROPIC_API_KEY")) {
    return "anthropic";
  }
  throw new AgentConfigurationError(
    "No LLM provider credentials found. Set OPENAI_API_KEY, GEMINI_API_KEY/GOOGLE_API_KEY, " +
      "or ANTHROPIC_API_KEY, or pass --provider with the required key.",
  );
}

function createOpenAiModel(config: LlmConfig): BaseChatModel {
  const apiKey = config.api_key || process.env.OPENAI_API_KEY || process.env.OPENAI_ADMIN_KEY;
  const baseURL = config.base_url || process.env.OPENAI_BASE_URL;
  const model = config.model || process.env.OPENAI_MODEL || "gpt-4.1-mini";
  return new ChatOpenAI({
    model,
    timeout: (config.timeout_seconds ?? DEFAULT_TIMEOUT_SECONDS) * 1000,
    maxRetries: config.max_retries ?? DEFAULT_MAX_RETRIES,
    ...(config.temperature != null ? { temperature: config.temperature } : {}),
    ...(apiKey ? { apiKey } : {}),
    ...(baseURL ? { configuration: { baseURL } } : {}),
  });
}

function createGeminiModel(config: LlmConfig): BaseChatModel {
  const apiKey = config.api_key || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    throw new AgentConfigurationError("Gemini provider requires GEMINI_API_KEY or GOOGLE_API_KEY.");
  }
  const model = config.model || process.env.GEMINI_MODEL || "gemini-2.5-flash";
  // PORT NOTE: JS ChatGoogleGenerativeAI exposes no `timeout` field, so timeout_seconds is not
  // forwarded (Python passes it to langchain_google_genai). All other kwargs map directly.
  return new ChatGoogleGenerativeAI({
    model,
    apiKey,
    maxRetries: config.max_retries ?? DEFAULT_MAX_RETRIES,
    ...(config.temperature != null ? { temperature: config.temperature } : {}),
  });
}

function createAnthropicModel(config: LlmConfig): BaseChatModel {
  const apiKey = config.api_key || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new AgentConfigurationError("Anthropic provider requires ANTHROPIC_API_KEY.");
  }
  const model = config.model || process.env.ANTHROPIC_MODEL || "claude-3-5-sonnet-latest";
  return new ChatAnthropic({
    model,
    apiKey,
    maxRetries: config.max_retries ?? DEFAULT_MAX_RETRIES,
    clientOptions: { timeout: (config.timeout_seconds ?? DEFAULT_TIMEOUT_SECONDS) * 1000 },
    ...(config.temperature != null ? { temperature: config.temperature } : {}),
  });
}

function envAny(...names: string[]): boolean {
  return names.some((name) => Boolean(process.env[name]));
}
