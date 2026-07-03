// Port of occupancy_engine/agents/prompts.py.
//
// Prompt TEXT is behavior-critical: every string literal below is reproduced VERBATIM from the
// Python source (character-for-character, including punctuation, newlines, capitalization, and
// exact wording). Do not "improve", rewrap, or paraphrase.
//
// The module is self-contained (Python imported only `json` and `typing.Any`). Inputs are plain
// dicts modelled here as `Record<string, any>`.

type Dict = Record<string, any>;

// ---------------------------------------------------------------------------
// Python-semantics helpers (truthiness, str(), int(), json.dumps).
// ---------------------------------------------------------------------------

/** Mirror Python truthiness: None/False/0/""/[]/{} are falsy, everything else truthy. */
function truthy(value: any): boolean {
  if (value === null || value === undefined) return false;
  if (value === false) return false;
  if (value === true) return true;
  if (typeof value === "number") return value !== 0 && !Number.isNaN(value);
  if (typeof value === "string") return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return Boolean(value);
}

/** Mirror Python's `value or fallback`. */
function orElse<T>(value: any, fallback: T): any {
  return truthy(value) ? value : fallback;
}

/** Mirror Python str(): None -> "None", True -> "True", False -> "False", else String(). */
// PORT NOTE: Python f-string interpolation uses str(); a missing dict key becomes None -> "None"
// and bools render as "True"/"False" (not JS "undefined"/"true"/"false"). pyStr preserves that.
// Float-vs-int distinction (Python 5.0 -> "5.0") is not representable in JS (single number type);
// integer-valued floats render as "5" here. In practice these interpolations carry ints/strings.
function pyStr(value: any): string {
  if (value === null || value === undefined) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  return String(value);
}

/** Mirror Python int(): truncate toward zero. */
function pyInt(value: any): number {
  return Math.trunc(Number(value));
}

/** Mirror Python len() for the container shapes used here. */
function pyLen(value: any): number {
  if (typeof value === "string") return value.length;
  if (Array.isArray(value)) return value.length;
  if (value && typeof value === "object") return Object.keys(value).length;
  return 0;
}

function isDict(value: any): boolean {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Code-point ordering, matching Python's default sort of str keys. */
function codePointCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// PORT NOTE: json.dumps(x, indent=2, sort_keys=True) is reproduced faithfully here rather than via
// JSON.stringify, because the rendered text is part of behavior-critical prompt output. Differences
// replicated: (1) object keys sorted RECURSIVELY by code point; (2) ensure_ascii=True — every char
// < 0x20 or >= 0x7f is escaped as \uXXXX (lowercase hex, UTF-16 code units incl. surrogate pairs),
// with short escapes \" \\ \b \t \n \f \r; (3) None/undefined -> null (undefined-valued object keys
// are kept, not dropped as JSON.stringify would). Float-valued integers (Python 5.0 -> "5.0") cannot
// be distinguished in JS and render as "5"; the dicts passed here carry ints/strings/None in practice.
function pyJsonEscapeString(s: string): string {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    switch (c) {
      case 0x22:
        out += '\\"';
        break;
      case 0x5c:
        out += "\\\\";
        break;
      case 0x08:
        out += "\\b";
        break;
      case 0x09:
        out += "\\t";
        break;
      case 0x0a:
        out += "\\n";
        break;
      case 0x0c:
        out += "\\f";
        break;
      case 0x0d:
        out += "\\r";
        break;
      default:
        if (c < 0x20 || c > 0x7e) {
          out += "\\u" + c.toString(16).padStart(4, "0");
        } else {
          out += s[i];
        }
    }
  }
  return out + '"';
}

function pyJsonDumps(value: any, indent = 2): string {
  const unit = " ".repeat(indent);
  const serialize = (v: any, level: number): string => {
    if (v === null || v === undefined) return "null";
    if (v === true) return "true";
    if (v === false) return "false";
    if (typeof v === "number") return String(v);
    if (typeof v === "string") return pyJsonEscapeString(v);
    if (Array.isArray(v)) {
      if (v.length === 0) return "[]";
      const pad = unit.repeat(level + 1);
      const items = v.map((item) => pad + serialize(item, level + 1));
      return "[\n" + items.join(",\n") + "\n" + unit.repeat(level) + "]";
    }
    if (typeof v === "object") {
      const keys = Object.keys(v).sort(codePointCompare);
      if (keys.length === 0) return "{}";
      const pad = unit.repeat(level + 1);
      const items = keys.map((k) => pad + pyJsonEscapeString(k) + ": " + serialize(v[k], level + 1));
      return "{\n" + items.join(",\n") + "\n" + unit.repeat(level) + "}";
    }
    return "null";
  };
  return serialize(value, 0);
}

// ---------------------------------------------------------------------------
// Module constants.
// ---------------------------------------------------------------------------

export const GRAPHQL_PRIMER =
  "Use named read-only query operations with variables. Address ids are Int; person ids are String. " +
  "Prefer neutral entity associations first: resolveAddress, Address.personAssociations, " +
  "Address.propertyAssociations, Person.addressAssociations, and sourceRecord for provenance. " +
  "Connections expose totalCount, hasMore, and nodes. Use describe_schema(target) for unfamiliar fields. " +
  "Do not use mutations, subscriptions, or GraphQL ID.";

export const MINI_SCHEMA_GUIDE = GRAPHQL_PRIMER;

export const ADDRESS_SOURCE_FIELDS: Record<string, string> = {
  base: "baseRecords",
  tax: "taxProperties",
  utility: "utilityRecords",
  trace: "traceRecords",
  auto: "autoRecords",
  loan: "loanRecords",
  drive: "driveRecords",
  voter: "voterRecords",
  criminal: "criminalRecords",
};

export const PERSON_SOURCE_FIELDS: Record<string, string> = {
  base: "baseRecords",
  tax: "taxRecords",
  trace: "traceRecords",
  auto: "autoRecords",
  loan: "loanRecords",
  drive: "driveRecords",
  voter: "voterRecords",
  criminal: "criminalRecords",
};

export const ORCHESTRATOR_REPORT_PROMPT = `You are a senior investigative analyst at True-Occupancy, the mortgage-fraud detection unit of a regional lender. You report to the Director of Risk Investigations.

Your task is to draft a formal case summary from the structured heuristic findings submitted by field analysts. This summary will be reviewed by the Director and may inform a referral decision.

Write with the precision and restraint expected of a professional investigator: distinguish direct evidence from circumstantial, corroborated findings from isolated signals, and note where the picture is incomplete or ambiguous. Do not reach a fraud conclusion. Do not query external sources.

Your reader is a senior decision-maker who needs a clear, defensible narrative — not a data dump. State what the evidence supports, what it mitigates, and what remains unresolved.
`;

export const MASTER_ADJUDICATION_SYSTEM_PROMPT = `You are the Lead Case Adjudicator at True-Occupancy, the occupancy-fraud detection unit of a regional lender. Field analysts have completed their heuristic reviews and submitted their findings. You now conduct the final review.

Your role is that of a senior investigator reviewing a case file — not an aggregator. The analyst scores are advisory; your job is to apply judgment across the full picture, weigh corroborating and conflicting signals, and produce a calibrated case-level assessment.

You are accountable for the quality and defensibility of this verdict. A referral based on a poorly-reasoned assessment has real consequences for a borrower. An under-flagged case has real consequences for the lender. Reason carefully.

As you adjudicate, distinguish: direct evidence from circumstantial; family or household context from unrelated occupancy; owner-present signals from absentee-owner signals; current rental-market evidence from stale or ambiguous records.

Do not query external sources. Do not issue a fraud determination — produce an investigative verdict band only. Submit your verdict using the submit_case_adjudication tool exactly once.

Output budget — your verdict is read by machines and busy reviewers, and generation time is a real cost. Do NOT write any analysis text before the tool call; put ALL reasoning inside the tool fields. Keep reasoning_summary to at most 3 sentences. Give at most 2 items each in why_not_higher and why_not_lower, one sentence each. Include a score_adjustment only when you actually adjust the score, with a one-sentence reason. Never restate evidence the workers already reported — reference it.
`;

export const HEURISTIC_SYSTEM_PROMPT = `You are a field analyst at True-Occupancy, the occupancy-fraud detection unit of a regional lender. You specialize in reviewing a single assigned heuristic signal per case.

Your findings will be reviewed by the Lead Case Adjudicator, who weighs your submission alongside several others. A vague or unsupported submission wastes the adjudicator's time. An overconfident one risks misleading the final verdict. Be precise, be honest about uncertainty, and be complete.

Work only from the local GraphQL database. No external lookups — your value is in rigorous local-evidence analysis, not in reaching beyond your dataset. Follow the schema guide exactly; if a query fails, revise it using the schema guide rather than inventing fields or types.

Submit your findings using the assigned submission tool — not as free-form text. Your submission is a professional record and will be treated as such by the adjudicator.

Tool workflow: use the provided tools to inspect the local GraphQL database; submit exactly one assigned submission tool call when finished.

For evidence citations, cite source/table/rowid/record_id and a compact summary. Do not copy full row payloads into evidence_for, evidence_against, or evidence_refs unless a specific field value is needed to make the finding understandable.

Output budget: do NOT write analysis text in the message body — every response must be tool calls only, with all reasoning carried in the tool-call fields themselves. Narrating your plan or restating fetched rows before a tool call wastes real generation time and adds nothing the adjudicator will see.
`;

export const TYPED_TOOLS_HEURISTIC_SYSTEM_PROMPT = `You are a field analyst at True-Occupancy, the occupancy-fraud detection unit of a regional lender. You specialize in reviewing a single assigned heuristic signal per case.

Your findings will be reviewed by the Lead Case Adjudicator. Be precise, honest about uncertainty, and complete.

You investigate using a fixed set of typed retrieval tools, each of which takes only an address (the resolved subject, used by default) or a person id and returns one shape of records. You cannot write raw queries — use the tools provided. To follow an owner who may live elsewhere: get their name from tax records, resolve them with search_people, then pull that person's records with the person id.

Submit your findings using submit_heuristic_result exactly once when finished.

Output budget: do NOT write analysis text in the message body — every response must be tool calls only, with all reasoning carried in the tool-call fields themselves. Narrating your plan or restating fetched rows before a tool call wastes real generation time and adds nothing the adjudicator will see.
`;

// ---------------------------------------------------------------------------
// Prompt builders.
// ---------------------------------------------------------------------------

export function heuristic_user_prompt(
  heuristic: Dict,
  context: Dict,
  tool_guide: string | null = null,
  include_shortcuts = false,
): string {
  context = { ...context };
  const plan = context["_heuristic_plan"] ?? null;
  delete context["_heuristic_plan"];
  const schema_context = schema_context_for_heuristic(heuristic);
  const query_requirements = [
    `- ${GRAPHQL_PRIMER}`,
    "- If execute_graphql returns a validation error, revise using its hints and query skeletons. Do not repeat invalid fields.",
  ];
  if (include_shortcuts) {
    query_requirements.splice(
      1,
      0,
      "- Prefer get_address_records/get_people_at_address/get_person_records before custom GraphQL.",
    );
  }
  if (truthy(heuristic["packet"])) {
    let retrieval_section: string[];
    if (tool_guide != null) {
      retrieval_section = ["Available tools:", tool_guide, ""];
    } else {
      retrieval_section = [
        "GraphQL Query Requirements",
        ...query_requirements,
        "",
        "Relevant Schema Context",
        schema_context,
        "",
      ];
    }
    return [
      "You have been assigned the following heuristic packet for review. Investigate it thoroughly",
      "using the local GraphQL database and submit your findings.",
      "",
      "Heuristic Brief",
      _heuristic_brief(heuristic),
      "",
      "Master-Assigned Mission",
      render_plan_section(orElse(plan, {})),
      "",
      "Case Context",
      render_context_sections(context),
      "",
      ...retrieval_section,
      "Submission Requirements",
      "- Submit with submit_heuristic_result exactly once.",
      "- Include: heuristic_id, status, direction, score, confidence, finding, interpretation, evidence_for, evidence_against, missing_evidence, caveats, needs_second_pass.",
      "- Be concise. State each fact once in the most appropriate field; do not repeat the conclusion across finding/evidence/caveats. Put genuine data gaps in missing_evidence, interpretation caveats in caveats.",
      '- evidence_for is REQUIRED when status is triggered (cite at least one supporting source/table/rowid); evidence_against or missing_evidence is required when not_triggered. Citing rows is not "repeating the conclusion" — these structured citations are mandatory anchors, separate from the finding narrative.',
      "- finding: ONE concise paragraph stating the conclusion, the key reasoning, and the per-sub-signal outcomes. Do not pad or repeat.",
      "- Use triggered only when local evidence supports the heuristic.",
      "- Use not_triggered only when local evidence contradicts or reasonably disproves the signal.",
      "- Use inconclusive when data availability, query failure, identity ambiguity, staleness, or conflicting evidence prevents a defensible triggered/not_triggered conclusion.",
      "- Use score 0 for inconclusive.",
    ].join("\n");
  }
  let lines = [
    "You have been assigned the following heuristic for review. Investigate it thoroughly",
    "using the local GraphQL database and submit your findings.",
    "",
    "Heuristic brief:",
    _heuristic_brief(heuristic),
    "",
    "Master-assigned mission:",
    pyJsonDumps(orElse(plan, {})),
    "",
    "Case context:",
    pyJsonDumps(context),
    "",
  ];
  if (tool_guide != null) {
    lines = lines.concat(["Available tools:", tool_guide, ""]);
  } else {
    lines = lines.concat([
      "GraphQL query requirements:",
      ...query_requirements,
      "",
      "Relevant schema context:",
      schema_context,
      "",
    ]);
  }
  return lines
    .concat([
      "Your submission via submit_heuristic_result must include:",
      "  heuristic_id, status, direction, score, confidence, finding,",
      "  interpretation, evidence_for, evidence_against, missing_evidence,",
      "  caveats, needs_second_pass.",
      "",
      "Be concise. State each fact once in the most appropriate field; do not repeat the conclusion across finding/evidence/caveats. Put genuine data gaps in missing_evidence, interpretation caveats in caveats.",
      'evidence_for is REQUIRED when status is triggered (cite at least one supporting source/table/rowid); evidence_against or missing_evidence is required when not_triggered. Citing rows is not "repeating the conclusion" — these structured citations are mandatory anchors, separate from the finding narrative.',
      "finding: ONE concise paragraph stating the conclusion, the key reasoning, and the per-sub-signal outcomes. Do not pad or repeat.",
      "Use triggered only when local evidence supports the heuristic.",
      "Use not_triggered only when local evidence contradicts or reasonably disproves the signal.",
      "Use inconclusive when data availability, query failure, identity ambiguity, staleness,",
      "or conflicting evidence prevents a defensible triggered/not_triggered conclusion.",
      "Scores are advisory and must stay within the heuristic score guidance.",
      "Use score 0 for inconclusive.",
      "Separate supporting rows in evidence_for, contradicting/mitigating rows in evidence_against,",
      "and unavailable or insufficient facts in missing_evidence.",
    ])
    .join("\n");
}

/**
 * Render one shared-context prompt for a group of packets evaluated in a single conversation.
 *
 * The case context is rendered exactly once. Each packet gets its own brief + mission. The
 * submission block requires one submit_heuristic_result per packet, keyed by heuristic_id.
 */
export function grouped_heuristic_user_prompt(
  heuristics: Dict[],
  context: Dict,
  plans: Dict[] | null = null,
  tool_guide: string | null = null,
  include_shortcuts = false,
): string {
  context = { ...context };
  delete context["_heuristic_plan"];
  let plansArr: Dict[] = truthy(plans) ? Array.from(plans as Dict[]) : heuristics.map(() => ({}));
  // Present the most source-heavy packet first. The grouped agent tends to front-load the first
  // packet, so leading with the harder (more sources) one keeps a later, source-richer packet from
  // being skimmed (n=12: owner_identity_and_mailing lost ~0.10 data coverage when it trailed the
  // simpler property_tax_context). Python's sort is stable, so equal-weight packets keep their order.
  // PORT NOTE: Python sorted(..., reverse=True) is stable (ties keep original order). Reproduced with
  // a stable descending sort (weightB - weightA); do NOT sort ascending then reverse, which would
  // flip ties.
  const weightOf = (h: Dict): number =>
    pyLen(orElse(orElse(h["context_scope"], h["input_sources"]), []));
  const order = heuristics.map((_, i) => i).sort((a, b) => weightOf(heuristics[b]!) - weightOf(heuristics[a]!));
  heuristics = order.map((i) => heuristics[i]!);
  plansArr = order.map((i) => plansArr[i]!);
  const ids = heuristics.map((h) => pyStr(h["id"]));

  let retrieval_section: string[];
  if (tool_guide != null) {
    retrieval_section = ["Available tools:", tool_guide, ""];
  } else {
    const all_sources: string[] = [];
    for (const h of heuristics) {
      for (const s of _heuristic_sources(h)) {
        if (!all_sources.includes(s)) {
          all_sources.push(s);
        }
      }
    }
    const merged_schema = schema_context_for_heuristic({ input_sources: all_sources, context_scope: all_sources });
    retrieval_section = [
      "GraphQL Query Requirements",
      `- ${GRAPHQL_PRIMER}`,
      "- If execute_graphql returns a validation error, revise using its hints and query skeletons. Do not repeat invalid fields.",
      ...(include_shortcuts
        ? ["- Prefer get_address_records/get_people_at_address/get_person_records before custom GraphQL."]
        : []),
      "",
      "Relevant Schema Context",
      merged_schema,
      "",
    ];
  }

  const packet_blocks: string[] = [];
  for (let index = 0; index < heuristics.length; index++) {
    const heuristic = heuristics[index]!;
    const plan = index < plansArr.length ? plansArr[index] : {};
    packet_blocks.push(
      `### Heuristic ${index + 1} of ${heuristics.length}: ${pyStr(heuristic["id"])}`,
      _heuristic_brief(heuristic),
      "Master-Assigned Mission",
      render_plan_section(orElse(plan, {})),
      "",
    );
  }

  return [
    `You have been assigned ${heuristics.length} related heuristic packets that share the same ` +
      "case evidence. Investigate them together: fetch the shared sources once, reason across all " +
      "of them, and submit a SEPARATE, fully-evidenced finding for each. Sharing one conversation " +
      "saves repeated fetching — it must NOT reduce the depth of any packet: evaluate and cite each " +
      "heuristic as thoroughly as if it were the only one assigned.",
    "",
    "Shared Case Context (applies to every heuristic below)",
    render_context_sections(context),
    "",
    "Assigned heuristics (evaluate each):",
    ...packet_blocks,
    ...retrieval_section,
    "Submission Requirements",
    `- Call submit_heuristic_result once for EACH of these heuristic_ids: ${ids.join(", ")}.`,
    "- Each call is one packet's final result; set heuristic_id to that packet's id exactly.",
    "- Do not combine packets into one submission and do not skip any assigned heuristic.",
    "- Include for each: heuristic_id, status, direction, score, confidence, finding, interpretation, evidence_for, evidence_against, missing_evidence, caveats, needs_second_pass.",
    "- Be concise. State each fact once in the most appropriate field.",
    "- evidence_for is REQUIRED when status is triggered (cite source/table/rowid); evidence_against or missing_evidence is required when not_triggered.",
    "- Per-packet completeness: for EACH heuristic, cite ALL supporting rows in evidence_for AND every contradicting or mitigating row in evidence_against (source/table/rowid). Do not drop a packet's counter-evidence or abbreviate its citations because other packets share this conversation.",
    "- Distribute retrieval and analysis effort EQUALLY across the assigned heuristics. Do not thoroughly investigate the first and skim later ones — fetch each heuristic's own sources and give every packet the same depth.",
    "- finding: ONE concise paragraph per packet stating the conclusion, the key reasoning, and the per-sub-signal outcomes. Do not pad or repeat.",
    "- Use inconclusive (score 0) when data availability, query failure, identity ambiguity, or conflicting evidence prevents a defensible conclusion for that packet.",
  ].join("\n");
}

export function schema_context_for_heuristic(heuristic: Dict): string {
  const sources = _heuristic_sources(heuristic);
  const source_enums = sources.map((source) => _source_enum_name(source));
  const lines = [
    "- Preferred root entrypoints: resolveAddress(query: String!, zip: String), person(id: String), sourceRecord(source: Source!, rowid: Int!).",
    "- Prefer entity associations over raw source buckets: Address.personAssociations, Address.propertyAssociations, Person.addressAssociations, Person.propertyAssociations, Person.organizationAssociations.",
    "- Fetch raw source data only as provenance fallback with sourceRecord(source, rowid) or sourceRecords(...).",
    "- Connection pattern: someConnection(limit: $limit) { totalCount hasMore nodes { ... } }.",
  ];
  if (truthy(source_enums)) {
    lines.push("- Relevant Source enum values: " + [...new Set(source_enums)].join(", ") + ".");
  }
  lines.push("");
  lines.push("Example address association query:");
  lines.push("```graphql");
  lines.push("query AddressAssociations($query: String!, $zip: String, $limit: Int = 50) {");
  lines.push("  resolveAddress(query: $query, zip: $zip) {");
  lines.push("    id");
  lines.push("    fullAddress");
  lines.push("    personAssociations(limit: $limit) {");
  lines.push("      totalCount");
  lines.push("      hasMore");
  lines.push("      nodes {");
  lines.push("        role");
  lines.push("        source");
  lines.push("        confidence");
  lines.push("        person { id name firstname lastname }");
  lines.push("        sourceRecord { source rowid recordId summary }");
  lines.push("      }");
  lines.push("    }");
  lines.push("    propertyAssociations(role: SITUS_ADDRESS, limit: 10) {");
  lines.push("      nodes { property { id propertyKey people(role: OWNER) { nodes { displayName person { id name } provenance { source rowid summary } } } } }");
  lines.push("    }");
  lines.push("    sourceRecords(source: UTILITY, role: SERVICE_ADDRESS, limit: 50) {");
  lines.push("      totalCount");
  lines.push("      nodes { source rowid recordId summary }");
  lines.push("    }");
  lines.push("  }");
  lines.push("}");
  lines.push("```");
  lines.push("");
  lines.push("Example person elsewhere query:");
  lines.push("```graphql");
  lines.push("query PersonElsewhere($personId: String!, $limit: Int = 50) {");
  lines.push("  person(id: $personId) {");
  lines.push("    id");
  lines.push("    name");
  lines.push("    addressAssociations(limit: $limit) {");
  lines.push("    totalCount");
  lines.push("    hasMore");
  lines.push("      nodes { role source address { id fullAddress } sourceRecord { source rowid summary } }");
  lines.push("    }");
  lines.push("  }");
  lines.push("}");
  lines.push("```");
  lines.push("");
  lines.push("Example raw provenance fallback:");
  lines.push("```graphql");
  lines.push("query RawSourceRow($source: Source!, $rowid: Int!) {");
  lines.push("  sourceRecord(source: $source, rowid: $rowid) { source table rowid recordId summary data }");
  lines.push("}");
  lines.push("```");
  return lines.join("\n");
}

function _source_enum_name(source: string): string {
  return source.trim().toUpperCase();
}

function _heuristic_sources(heuristic: Dict): string[] {
  const values: string[] = [];
  for (const key of ["context_scope", "input_sources", "required_evidence_packs"]) {
    const raw = heuristic[key];
    if (typeof raw === "string") {
      values.push(raw);
    } else if (Array.isArray(raw)) {
      for (const item of raw) {
        values.push(String(item));
      }
    }
  }
  const normalized: string[] = [];
  for (const value of values) {
    const source = String(value).trim().toLowerCase();
    if (
      Object.prototype.hasOwnProperty.call(ADDRESS_SOURCE_FIELDS, source) &&
      !normalized.includes(source)
    ) {
      normalized.push(source);
    }
  }
  return normalized;
}

export function master_planning_user_prompt(context: Dict, heuristics: Dict[], sectioned = false): string {
  const compact_heuristics = heuristics.map((item) => ({
    id: item["id"],
    title: item["title"],
    category: item["category"],
    input_sources: item["input_sources"],
    required_evidence_packs: item["required_evidence_packs"],
    description: item["description"],
    subquestions: item["subquestions"],
    scoring_guidance: item["scoring_guidance"],
  }));
  return [
    "Build a case investigation plan for the heuristic subagents.",
    "The plan controls which workers run and what each worker should investigate.",
    "",
    "Resolved address and evidence map:",
    sectioned ? render_context_sections(context) : pyJsonDumps(context),
    "",
    "Candidate heuristics:",
    sectioned ? render_heuristic_sections(compact_heuristics) : pyJsonDumps(compact_heuristics),
    "",
    "Planning rules:",
    "- Use submit_investigation_plan exactly once.",
    "- Candidate allow/block filtering has already happened; only use heuristic ids shown above.",
    "- Source availability is advisory, not a hard gate.",
    "- Use decision=run when the heuristic has relevant evidence or could materially affect the case.",
    "- Use decision=run_for_absence when source absence or lack of records is itself important to document.",
    "- Use decision=skip when the heuristic is not useful for this address and absence does not need a worker.",
    "- expected_sources should name likely source groups.",
    "- known_data_gaps should copy relevant source gaps from the evidence map.",
    "- mission should be specific enough that the worker knows what to prove, disprove, or mark inconclusive.",
    "- Favor fewer high-value workers, but do not skip a heuristic merely because its primary source has zero rows if alternate reasoning paths could matter.",
  ].join("\n");
}

export function master_adjudication_user_prompt(
  context: Dict,
  raw_score: Dict,
  worker_results: Dict[],
  conflicts: Dict[],
  sectioned = false,
): string {
  return [
    "The field analysts have completed their reviews. You now have the full case file.",
    "Conduct your adjudication and submit the final verdict.",
    "",
    "Resolved address context:",
    sectioned ? render_context_sections(context) : pyJsonDumps(context),
    "",
    "Raw heuristic score summary:",
    sectioned ? render_mapping_section(raw_score) : pyJsonDumps(raw_score),
    "",
    "Detected structured conflicts:",
    sectioned ? render_conflict_sections(conflicts) : pyJsonDumps(conflicts),
    "",
    "Analyst submissions:",
    sectioned ? render_worker_sections(worker_results) : pyJsonDumps(worker_results),
    "",
    "Adjudication requirements:",
    "- Keep raw_score equal to raw_score.final_score.",
    "- calibrated_score must reflect case-level interpretation, not just the raw sum.",
    "- clarity_score is 0-10; higher for coherent, corroborated, low-ambiguity cases.",
    "- Use score_adjustments to explain meaningful departures from raw_score.",
    '- Each score_adjustments item: {"heuristic_ids": ["id"], "delta": 1, "reason": "..."}',
    "  Do not use 'heuristic_id' or 'adjustment' as keys.",
    "- why_not_higher and why_not_lower must be arrays of strings, even if only one reason.",
    "- Same-family or same-surname non-owner evidence is meaningful but distinct from",
    "  unrelated-occupant evidence — weigh accordingly.",
    "- Inconclusive worker results are not risk points; use them to lower clarity or explain",
    "  evidence gaps when appropriate.",
    "- Review evidence_for, evidence_against, and missing_evidence separately. Do not treat",
    "  missing evidence as proof of absence unless a worker gave concrete contrary evidence.",
    "- Internal non-owner occupancy is not equivalent to rental use. Escalate to",
    "  clear_absentee_rental only when absentee-owner evidence is paired with unrelated",
    "  non-owner occupancy from higher-reliability sources, or with loan/rental-tenure evidence.",
    "- Use non_rental_absentee_owner when owner absence or owner-elsewhere evidence is",
    "  plausible but rental-use evidence is absent, utility-only, trace-only, stale,",
    "  or too weak after source-reliability discounts.",
    "- Utility-only or trace-only non-owner evidence should usually calibrate as",
    "  non_rental_absentee_owner, ambiguous_nonowner_occupancy, or monitor unless",
    "  corroborated by stronger sources.",
    "- Use family_household_rental only when same-surname/family context is paired with",
    "  non-owner loan-renter evidence or non-owner drive evidence at the subject.",
    "- Corroborated internal evidence across tax, legal, loan, utility, and trace sources",
    "  generally warrants higher clarity than isolated or family-only evidence.",
    "- Be concise. State each fact once across reasoning_summary, why_not_higher, and",
    "  why_not_lower; do not repeat the same evidence in more than one field.",
    "- reasoning_summary: one tight paragraph (2-3 sentences) giving the verdict rationale —",
    "  not a re-listing of every signal.",
    "- why_not_higher and why_not_lower: at most 2 terse bullets each, one distinct fact per",
    "  bullet; do not restate reasoning_summary.",
    "- Submit using submit_case_adjudication. Include keys: raw_score, calibrated_score,",
    "  clarity_score, verdict_band, case_archetype, score_adjustments, reasoning_summary,",
    "  why_not_higher, why_not_lower.",
  ].join("\n");
}

export function prompt_context(
  context: Dict,
  profile = "compact",
  source_scope: string[] | readonly string[] | null = null,
): Dict {
  if (profile === "full") {
    return context;
  }
  const evidence_map = orElse(context["evidence_map"], {});
  const selected = context["selected"];
  const compact: Dict = {
    input_address: context["input_address"],
    input_zip: context["input_zip"],
    selected: selected,
    ambiguous: context["ambiguous"],
    source_counts: orElse(context["source_counts"], orElse(evidence_map["source_counts"], {})),
    property_types: orElse(context["property_types"], orElse(evidence_map["property_types"], [])),
    evidence_map: compact_evidence_map(evidence_map, source_scope),
    schema_mini_guide: MINI_SCHEMA_GUIDE,
  };
  if (truthy(context["ambiguous"])) {
    compact["candidates"] = orElse(context["candidates"], []);
  }
  return compact;
}

export function compact_evidence_map(
  evidence_map: Dict,
  source_scope: string[] | readonly string[] | null = null,
): Dict {
  const scope = new Set<string>(orElse(source_scope, []) as string[]);
  let refs: any[] = orElse(evidence_map["evidence_refs"], []);
  if (scope.size > 0) {
    refs = refs.filter((ref) => isDict(ref) && scope.has(String(orElse(ref["source"], ""))));
  }
  return {
    address_id: evidence_map["address_id"],
    normalized_address: evidence_map["normalized_address"],
    zip5: evidence_map["zip5"],
    source_counts: orElse(evidence_map["source_counts"], {}),
    property_types: orElse(evidence_map["property_types"], []),
    rental_market_summary: orElse(evidence_map["rental_market_summary"], []),
    owner_summaries: orElse(evidence_map["owner_summaries"], []),
    people_at_address: orElse(evidence_map["people_at_address"], []),
    owner_presence_hints: orElse(evidence_map["owner_presence_hints"], []),
    owner_elsewhere_hints: orElse(evidence_map["owner_elsewhere_hints"], []),
    nonowner_occupancy_hints: orElse(evidence_map["nonowner_occupancy_hints"], []),
    freshness_hints: orElse(evidence_map["freshness_hints"], []),
    data_gaps: orElse(evidence_map["data_gaps"], []),
    evidence_refs: refs.slice(0, 8).filter((ref) => isDict(ref)).map((ref) => _compact_ref(ref)),
  };
}

function _compact_ref(ref: Dict): Dict {
  return {
    source: ref["source"],
    table: ref["table"],
    rowid: ref["rowid"],
    record_id: ref["record_id"],
    summary: orElse(ref["summary"], ""),
  };
}

export function render_plan_section(plan: Dict): string {
  if (!truthy(plan)) {
    return "- No master plan was provided.";
  }
  const lines = [
    `- Heuristic: ${pyStr(orElse(plan["heuristic_id"], "unknown"))}`,
    `- Decision: ${pyStr(orElse(plan["decision"], "unknown"))}`,
    `- Priority: ${pyStr(orElse(plan["priority"], "medium"))}`,
  ];
  if (truthy(plan["reason"])) {
    lines.push(`- Reason: ${pyStr(plan["reason"])}`);
  }
  if (truthy(plan["expected_sources"])) {
    lines.push(`- Expected sources: ${_list_text(plan["expected_sources"])}`);
  }
  if (truthy(plan["known_data_gaps"])) {
    lines.push(`- Known data gaps: ${_list_text(plan["known_data_gaps"])}`);
  }
  if (truthy(plan["mission"])) {
    lines.push(`- Mission: ${pyStr(plan["mission"])}`);
  }
  return lines.join("\n");
}

export function render_context_sections(context: Dict): string {
  const evidence_map = orElse(context["evidence_map"], {});
  const selected = orElse(context["selected"], {});
  const source_counts = orElse(context["source_counts"], orElse(evidence_map["source_counts"], {}));
  const lines = [
    "Address Resolution",
    `- Input: ${pyStr(orElse(context["input_address"], ""))} ${pyStr(orElse(context["input_zip"], ""))}`.trim(),
    `- Selected: ${pyStr(
      orElse(
        orElse(selected["norm_address"], orElse(selected["normAddress"], evidence_map["normalized_address"])),
        "none",
      ),
    )} ${pyStr(orElse(selected["zip5"], orElse(evidence_map["zip5"], "")))}`.trim(),
    `- Ambiguous: ${pyStr(context["ambiguous"])}`,
    "",
    "Source Availability",
    `- ${_source_count_text(source_counts)}`,
  ];
  lines.push(
    ..._section_items("Property Types", orElse(context["property_types"], orElse(evidence_map["property_types"], []))),
  );
  lines.push(
    ..._section_items("Owners", _summary_items(orElse(evidence_map["owner_summaries"], []), "owner_name", "summaries")),
  );
  lines.push(..._section_items("People At Address", _people_items(orElse(evidence_map["people_at_address"], []))));
  lines.push(
    ..._section_items("Signals", [
      ..._prefixed_items("owner presence", orElse(evidence_map["owner_presence_hints"], [])),
      ..._prefixed_items("owner elsewhere", orElse(evidence_map["owner_elsewhere_hints"], [])),
      ..._prefixed_items("non-owner occupancy", orElse(evidence_map["nonowner_occupancy_hints"], [])),
      ..._prefixed_items("freshness", orElse(evidence_map["freshness_hints"], [])),
    ]),
  );
  lines.push(..._section_items("Data Gaps", orElse(evidence_map["data_gaps"], [])));
  lines.push(
    ..._section_items(
      "Evidence References",
      (orElse(evidence_map["evidence_refs"], []) as any[]).map((ref) => _ref_text(ref)),
    ),
  );
  return lines.join("\n");
}

export function render_heuristic_sections(heuristics: Dict[]): string {
  if (!truthy(heuristics)) {
    return "- none";
  }
  const blocks: string[] = [];
  for (const item of heuristics) {
    blocks.push(
      [
        `${pyStr(item["id"])}: ${pyStr(orElse(item["title"], ""))}`.trim(),
        `- Category: ${pyStr(orElse(item["category"], "unknown"))}`,
        `- Input sources: ${_list_text(item["input_sources"])}`,
        `- Evidence packs: ${_list_text(item["required_evidence_packs"])}`,
        `- Objective: ${pyStr(orElse(item["description"], ""))}`,
        `- Subquestions: ${_list_text(item["subquestions"])}`,
        `- Scoring: ${pyStr(orElse(item["scoring_guidance"], ""))}`,
      ].join("\n"),
    );
  }
  return blocks.join("\n\n");
}

export function render_mapping_section(value: Dict): string {
  if (!truthy(value)) {
    return "- none";
  }
  return Object.entries(value)
    .map(([key, val]) => `- ${key}: ${pyStr(val)}`)
    .join("\n");
}

export function render_conflict_sections(conflicts: Dict[]): string {
  if (!truthy(conflicts)) {
    return "- none";
  }
  return conflicts
    .map(
      (item) =>
        `- ${pyStr(orElse(item["id"], "conflict"))}: ${pyStr(orElse(item["title"], ""))} (${pyStr(
          orElse(item["severity"], "unknown"),
        )}) - ${pyStr(orElse(item["summary"], ""))}`,
    )
    .join("\n");
}

export function render_worker_sections(worker_results: Dict[]): string {
  if (!truthy(worker_results)) {
    return "- none";
  }
  const blocks: string[] = [];
  for (const result of worker_results) {
    const lines = [
      `${pyStr(result["heuristic_id"])}: ${pyStr(result["status"])} / score ${pyStr(result["local_score"])}`,
      `- Direction: ${pyStr(result["direction"])} | confidence: ${pyStr(result["confidence"])}`,
      `- Finding: ${pyStr(orElse(result["finding"], ""))}`,
    ];
    lines.push(
      ..._section_items(
        "  Evidence For",
        (orElse(result["evidence_for"], []) as any[]).map((ref) => _ref_text(ref)),
        false,
      ),
    );
    lines.push(
      ..._section_items(
        "  Evidence Against",
        (orElse(result["evidence_against"], []) as any[]).map((ref) => _ref_text(ref)),
        false,
      ),
    );
    lines.push(..._section_items("  Missing Evidence", orElse(result["missing_evidence"], []), false));
    lines.push(..._section_items("  Caveats", orElse(result["caveats"], []), false));
    blocks.push(lines.join("\n"));
  }
  return blocks.join("\n\n");
}

function _section_items(title: string, items: any, empty = true): string[] {
  const values = (orElse(items, []) as any[]).map((item) => pyStr(item)).filter((item) => item.trim() !== "");
  if (values.length === 0 && !empty) {
    return [];
  }
  const lines = ["", title];
  if (values.length > 0) {
    for (const item of values) {
      lines.push(`- ${item}`);
    }
  } else {
    lines.push("- none");
  }
  return lines;
}

function _source_count_text(source_counts: Dict): string {
  if (!truthy(source_counts)) {
    return "none";
  }
  return Object.entries(source_counts)
    .sort((a, b) => codePointCompare(a[0], b[0]))
    .map(([source, count]) => `${source}=${pyStr(count)}`)
    .join(", ");
}

function _summary_items(items: Dict[], label_key: string, summaries_key: string): string[] {
  const values: string[] = [];
  for (const item of items) {
    const label = orElse(item[label_key], "unknown");
    const summaries = orElse(item[summaries_key], []);
    values.push(
      `${pyStr(label)}: ${
        truthy(summaries) ? (summaries as any[]).map((summary) => pyStr(summary)).join("; ") : "no summary"
      }`,
    );
  }
  return values;
}

function _people_items(items: Dict[]): string[] {
  const values: string[] = [];
  for (const item of items) {
    values.push(
      `${pyStr(orElse(item["name"], "unknown"))} | relationship=${pyStr(
        orElse(item["relationship_to_owner"], "unknown"),
      )} | sources=${_list_text(item["sources"])}`,
    );
  }
  return values;
}

function _prefixed_items(prefix: string, items: any[]): string[] {
  return items.map((item) => `${prefix}: ${pyStr(item)}`);
}

function _ref_text(ref: Dict): string {
  return `${pyStr(orElse(ref["source"], "unknown"))}:${pyStr(
    orElse(orElse(ref["rowid"], ref["record_id"]), "n/a"),
  )} - ${pyStr(orElse(ref["summary"], ""))}`;
}

function _heuristic_brief(heuristic: Dict): string {
  const category = pyStr(orElse(heuristic["category"], "risk"));
  const score = pyInt(orElse(heuristic["score"], 0));
  const score_cap = pyInt(orElse(heuristic["score_cap"], 0));
  const execution_mode = pyStr(orElse(heuristic["execution_mode"], "deterministic"));
  const subquestions = orElse(heuristic["subquestions"], []) as any[];
  const scoring_guidance = pyStr(orElse(heuristic["scoring_guidance"], ""));
  const agent_guidance = pyStr(orElse(heuristic["agent_guidance"], ""));
  const context_scope = orElse(orElse(heuristic["context_scope"], heuristic["input_sources"]), []);
  const lines = [
    `Name: ${pyStr(orElse(heuristic["title"], heuristic["id"]))}`,
    `Objective: ${pyStr(orElse(heuristic["description"], "Evaluate whether this signal is present."))}`,
    `Signal category: ${_category_explanation(category)}`,
    `Context scope: ${_list_text(context_scope)}`,
    `Relevant evidence packs: ${_list_text(heuristic["required_evidence_packs"])}`,
    `Default confidence if triggered: ${pyStr(orElse(heuristic["confidence"], "medium"))}`,
    `Execution mode: ${execution_mode}`,
    "Your role: investigate this heuristic using local evidence and submit advisory findings" +
      " for the master orchestrator. The Lead Case Adjudicator owns the final case-level verdict.",
  ];
  if (truthy(subquestions)) {
    lines.push("Required subquestions: " + subquestions.map((item) => pyStr(item)).join(" | "));
  }
  if (truthy(agent_guidance)) {
    lines.push(`Agent guidance: ${agent_guidance}`);
  }
  if (truthy(scoring_guidance)) {
    lines.push(`Scoring rubric: ${scoring_guidance}`);
  }
  if (category === "agent_only" || execution_mode === "agent") {
    if (!truthy(scoring_guidance)) {
      lines.push(
        "Scoring guidance: this is a reasoning heuristic. Use score 0 unless the config says" +
          " otherwise; focus on documenting caveats and evidence interpretation" +
          " for the adjudicator.",
      );
    }
  } else if (category === "mitigation" || score < 0) {
    lines.push(
      `Scoring guidance: this is mitigating evidence. If supported, use a negative score` +
        ` down to ${score}; otherwise use 0.`,
    );
  } else if (category === "context" || category === "quality") {
    lines.push(
      `Scoring guidance: this is ${category} evidence. Use up to ${orElse(score_cap, score)} points` +
        ` only when it materially affects interpretation.`,
    );
  } else {
    lines.push(
      `Scoring guidance: this is risk evidence. If supported, use up to ${orElse(score_cap, score)}` +
        ` points; otherwise use 0.`,
    );
  }
  const amplifiers = orElse(heuristic["amplifiers"], []) as any[];
  const amplifier_score = pyInt(orElse(heuristic["amplifier_score"], 0));
  if (truthy(amplifiers) && truthy(amplifier_score)) {
    lines.push(
      `Amplifier context: if evidence also supports ${_list_text(amplifiers)}, note that` +
        ` this can strengthen the interpretation by about ${amplifier_score} point(s).` +
        ` Do not invent amplifier evidence.`,
    );
  }
  const caveats = orElse(heuristic["caveats"], []) as any[];
  if (truthy(caveats)) {
    lines.push("Known caveats: " + caveats.map((c) => pyStr(c)).join("; "));
  }
  lines.push(
    "Trigger standard: trigger only when local GraphQL evidence directly supports the" +
      " heuristic after accounting for address normalization, person/name ambiguity," +
      " stale data, and unit/property ambiguity.",
    "Non-trigger standard: use not_triggered with score 0 when evidence is absent," +
      " name-only, stale/ambiguous, or explained by same-property equivalence.",
    "Evidence standard: cite concrete source rows or GraphQL result summaries in" +
      " evidence_refs when possible; do not rely on the prompt context alone for final scoring.",
    "Interpretation standard: always address signal strength, directness," +
      " relationship-to-owner context, owner-presence context, rental-market context," +
      " absentee-owner context, staleness, ambiguity, and recommended case weight.",
  );
  return lines.map((line) => `- ${line}`).join("\n");
}

function _category_explanation(category: string): string {
  if (category === "risk") {
    return "risk signal; positive scores support occupancy-risk review";
  }
  if (category === "mitigation") {
    return "mitigation signal; negative scores reduce confidence in risk";
  }
  if (category === "context") {
    return "context signal; helps interpret other evidence and may have limited score impact";
  }
  if (category === "quality") {
    return "quality signal; affects confidence or data reliability";
  }
  if (category === "agent_only") {
    return "agent-only reasoning aid; usually score-neutral";
  }
  return `${category}; interpret using the machine-readable config`;
}

function _list_text(value: any): string {
  if (!truthy(value)) {
    return "none specified";
  }
  if (typeof value === "string") {
    return value;
  }
  return (value as any[]).map((item) => pyStr(item)).join(", ");
}
