// Deterministic fake chat model: returns pre-scripted tool-call batches, no API.
// Ports the Python ScriptedLlmE2E/ToolCallingLlm pattern. Satisfies the LangChain
// surface the orchestrator/subagent use: bindTools(tools, opts?) + invoke(messages, config).
// bindTools returns a bound view (not the model itself) that remembers the tool names it was bound
// with, so a shared scripted model used for more than one role (for example X-091's same-person call
// alongside the master adjudicator) can tell which of its scripted batches belong to which caller.

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

  bindTools(tools: unknown, _opts?: unknown): { invoke: (messages: unknown, config?: unknown) => Promise<ScriptedResponse> } {
    const bound = Array.isArray(tools)
      ? tools.map((t) => (t as { name?: unknown } | null)?.name).filter((n): n is string => typeof n === "string")
      : [];
    return { invoke: (messages: unknown, config?: unknown) => this.invoke(messages, config, bound) };
  }

  async invoke(_messages: unknown, _config?: unknown, bound?: readonly string[]): Promise<ScriptedResponse> {
    // A call bound to tools that the next batch never names is a call this script does not cover (for example the
    // X-091 same-person call on a shared master model): it fails loudly, leaving the batch intact for the call it
    // was written for, rather than answering empty — an empty answer here would hide a mis-scripted worker turn.
    // resolve_same_person catches this for the pair call. Unbound invokes, empty batches and an exhausted script
    // behave as before.
    const next = this.batches[this.index];
    if (bound !== undefined && bound.length > 0 && next !== undefined && next.length > 0 && !next.some((c) => bound.includes(c.name))) {
      throw new Error(
        `ScriptedChatModel: no scripted batch for tools [${bound.join(", ")}]; the next batch calls [${next.map((c) => c.name).join(", ")}]`,
      );
    }
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
