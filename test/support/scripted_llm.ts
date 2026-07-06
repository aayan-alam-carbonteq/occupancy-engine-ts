// Deterministic fake chat model: returns pre-scripted tool-call batches, no API.
// Ports the Python ScriptedLlmE2E/ToolCallingLlm pattern. Satisfies the LangChain
// surface the orchestrator/subagent use: bindTools(tools, opts?) + invoke(messages, config).

export interface ScriptedToolCall {
  name: string;
  args: Record<string, unknown>;
  id?: string;
}

export interface ScriptedResponse {
  content: string;
  tool_calls: Array<{ name: string; args: Record<string, unknown>; id: string; type: "tool_call" }>;
  usage_metadata: Record<string, unknown>;
}

const ZERO_USAGE = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };

export class ScriptedChatModel {
  private index = 0;
  constructor(
    private readonly batches: ScriptedToolCall[][],
    private readonly usage: Record<string, unknown> = ZERO_USAGE,
  ) {}

  bindTools(_tools: unknown, _opts?: unknown): this {
    return this;
  }

  async invoke(_messages: unknown, _config?: unknown): Promise<ScriptedResponse> {
    if (this.index >= this.batches.length) {
      throw new Error(`ScriptedChatModel exhausted after ${this.index} calls`);
    }
    const batch = this.batches[this.index];
    if (!batch) {
      throw new Error(`ScriptedChatModel exhausted after ${this.index} calls`);
    }
    const callIndex = this.index;
    this.index += 1;
    const tool_calls = batch.map((c, i) => ({
      name: c.name,
      args: c.args,
      id: c.id ?? `call_${c.name}_${callIndex}${batch.length > 1 ? `_${i}` : ""}`,
      type: "tool_call" as const,
    }));
    return { content: "", tool_calls, usage_metadata: this.usage };
  }
}
