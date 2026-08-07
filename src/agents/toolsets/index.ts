// The retrieval-mode factory the orchestrator uses to build the subagent toolset.
//   "tools"       — the typed operations PLUS the guarded SQL hatch (exploratory; the default).
//   "typed_tools" — the typed operations only (bounded; no ad-hoc query surface at all).
import type { RetrievalToolset } from "./base.ts";
import { SqlToolset } from "./sql_toolset.ts";
import { TypedToolset } from "./typed_toolset.ts";

export { Diagnostics } from "./base.ts";
export type { RetrievalToolset } from "./base.ts";
export { SqlToolset } from "./sql_toolset.ts";
export { TypedToolset } from "./typed_toolset.ts";

export function make_toolset(retrieval_mode: string): RetrievalToolset {
  if (retrieval_mode === "typed_tools") {
    return new TypedToolset();
  }
  return new SqlToolset();
}
