// LLM provider factory: builds a configured chat model per provider.
//
// The LangChain provider packages are declared dependencies and imported statically, so there is no
// missing-module error to guard against at runtime. AgentDependencyError is preserved as an exported
// error class but is no longer thrown from a missing-import path.
//
// Timeout units: the SDKs use milliseconds, so timeout_seconds is multiplied by 1000 to preserve the
// wall-clock timeout behaviour.
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
  // ChatGoogleGenerativeAI exposes no `timeout` field, so timeout_seconds is not forwarded. All other
  // options map directly.
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
  const model = config.model || process.env.ANTHROPIC_MODEL || "claude-haiku-4-5";
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
