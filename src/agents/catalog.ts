// Port of occupancy_engine/agents/catalog.py.
//
// PORT NOTE (import source): Python imports `get_heuristic_catalog` from `occupancy_engine.engine`,
// which just re-exports the heuristics catalog. The already-ported engine layer lives under
// ../heuristics/index.ts, so we import it from there directly.
//
// PORT NOTE (ValueError): Python raises `ValueError` on an unknown heuristic id. The TS codebase's
// convention (see heuristics/*.ts) is a plain `Error` with the identical message.
import { get_heuristic_catalog } from "../heuristics/index.ts";

export function selected_heuristics(
  allowlist: string[] | null = null,
  blocklist: string[] | null = null,
): Array<Record<string, unknown>> {
  const blocked = new Set<string>(blocklist ?? []);
  const allowed = new Set<string>(allowlist ?? []);
  const catalog = get_heuristic_catalog();
  const catalog_ids = new Set<string>(catalog.map((item) => pyStr(item["id"])));
  const unknown = [...new Set<string>([...allowed, ...blocked])].filter((id) => !catalog_ids.has(id)).sort();
  if (unknown.length > 0) {
    const valid = [...catalog_ids].sort().join(", ");
    throw new Error(`Unknown heuristic id(s): ${unknown.join(", ")}. Valid heuristic ids: ${valid}`);
  }
  const selected: Array<Record<string, unknown>> = [];
  for (const item of catalog) {
    const heuristic_id = pyStr(item["id"]);
    if (allowed.size > 0 && !allowed.has(heuristic_id)) {
      continue;
    }
    if (blocked.has(heuristic_id)) {
      continue;
    }
    selected.push(item);
  }
  return selected;
}

/** Python str(): None -> "None", True/False -> "True"/"False", else String(). */
function pyStr(value: unknown): string {
  if (value === null || value === undefined) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  return String(value);
}
