// Heuristic catalog selection: filter the catalog by optional allow/block lists.
import { get_heuristic_catalog } from "../heuristics/index.ts";

export function selected_heuristics(
  allowlist: string[] | null = null,
  blocklist: string[] | null = null,
): Array<Record<string, unknown>> {
  const blocked = new Set<string>(blocklist ?? []);
  const allowed = new Set<string>(allowlist ?? []);
  const catalog = get_heuristic_catalog();
  const catalog_ids = new Set<string>(catalog.map((item) => String(item["id"])));
  const unknown = [...new Set<string>([...allowed, ...blocked])].filter((id) => !catalog_ids.has(id)).sort();
  if (unknown.length > 0) {
    const valid = [...catalog_ids].sort().join(", ");
    throw new Error(`Unknown heuristic id(s): ${unknown.join(", ")}. Valid heuristic ids: ${valid}`);
  }
  const selected: Array<Record<string, unknown>> = [];
  for (const item of catalog) {
    const heuristic_id = String(item["id"]);
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
