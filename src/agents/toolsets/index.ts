// The retrieval-mode factory the orchestrator uses to build the subagent toolset.
import { GraphQLToolset } from "./graphql_toolset.ts";
import { TypedToolset } from "./typed_toolset.ts";
import type { RetrievalToolset } from "./base.ts";

export { Diagnostics } from "./base.ts";
export type { RetrievalToolset } from "./base.ts";
export { GraphQLToolset } from "./graphql_toolset.ts";
export { TypedToolset } from "./typed_toolset.ts";

export function make_toolset(retrieval_mode: string, include_shortcuts: boolean): RetrievalToolset {
  if (retrieval_mode === "typed_tools") {
    return new TypedToolset();
  }
  return new GraphQLToolset({ include_shortcuts });
}
