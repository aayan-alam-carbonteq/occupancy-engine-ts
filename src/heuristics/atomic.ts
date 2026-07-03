// Port of occupancy_engine/heuristics/atomic.py.
// Atomic heuristic *definitions* (no gates, no executors): the reasoning-path
// catalog keyed by the tax owner and cross-source evidence surfaces.
// @dataclass(frozen=True) -> readonly interface fields + builder functions.

export type SignalRole =
  | "risk"
  | "support"
  | "mitigation"
  | "quality"
  | "synthesis"
  | "context";
export type Confidence = "high" | "medium" | "low" | "variable";
export type VerdictDirection = "increase" | "decrease" | "qualify" | "decide";

export interface SourceFieldRef {
  readonly source: string;
  readonly field: string;
  readonly role: string;
  readonly required: boolean;
  readonly notes: string;
}

export interface VerdictContribution {
  readonly archetypes: readonly string[];
  readonly direction: VerdictDirection;
  readonly rationale: string;
}

export interface ReasoningPath {
  readonly id: string;
  readonly title: string;
  readonly role: SignalRole;
  readonly predicate: string;
  readonly positive_indicators: readonly string[];
  readonly negative_indicators: readonly string[];
  readonly caveats: readonly string[];
  readonly verdict_contributions: readonly VerdictContribution[];
  readonly confidence: Confidence;
  readonly output_fields: readonly string[];
}

export interface AtomicHeuristicDefinition {
  readonly id: string;
  readonly title: string;
  readonly role: SignalRole;
  readonly description: string;
  readonly input_fields: readonly SourceFieldRef[];
  readonly reasoning: string;
  readonly positive_indicators: readonly string[];
  readonly negative_indicators: readonly string[];
  readonly caveats: readonly string[];
  readonly verdict_contributions: readonly VerdictContribution[];
  readonly confidence: Confidence;
  readonly output_fields: readonly string[];
  readonly group: string;
  readonly reasoning_paths: readonly ReasoningPath[];
}

export const FINAL_CASE_ARCHETYPES: readonly string[] = [
  "clear_absentee_rental",
  "family_household_rental",
  "owner_present_with_rental_indicators",
  "ambiguous_nonowner_occupancy",
  "mixed_evidence",
  "insufficient_ownership_data",
  "low_evidence_owner_occupied",
];

export const WITHHELD_EXTERNAL_EVIDENCE_NOTE =
  "Realtor, VRBO, rental listing, platform, and market-status fields are intentionally " +
  "excluded from canonical heuristics. They may be used as evaluation labels, " +
  "but not as agent-visible input evidence for internal-only occupancy benchmarking.";

export const DEFAULT_OUTPUT_FIELDS: readonly string[] = [
  "status",
  "matched_refs",
  "reasoning",
  "verdict_effect",
];

// PORT NOTE: dataclasses.asdict -> a recursive deep-clone into plain objects/arrays
// (class instances lose their prototype, tuples become arrays), matching how the
// Python catalog builders serialize frozen dataclasses.
export function asdict(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => asdict(item));
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>)) {
      out[key] = asdict((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

export function field(
  source: string,
  name: string,
  role: string,
  opts: { required?: boolean; notes?: string } = {},
): SourceFieldRef {
  return { source, field: name, role, required: opts.required ?? true, notes: opts.notes ?? "" };
}

export function contribution(
  direction: VerdictDirection,
  rationale: string,
  ...archetypes: string[]
): VerdictContribution {
  return { archetypes, direction, rationale };
}

export function path(init: {
  id: string;
  title: string;
  role: SignalRole;
  predicate: string;
  positive_indicators: readonly string[];
  negative_indicators?: readonly string[];
  caveats?: readonly string[];
  verdict_contributions?: readonly VerdictContribution[];
  confidence?: Confidence;
  output_fields?: readonly string[];
}): ReasoningPath {
  const output_fields = init.output_fields ?? [];
  return {
    id: init.id,
    title: init.title,
    role: init.role,
    predicate: init.predicate,
    positive_indicators: init.positive_indicators,
    negative_indicators: init.negative_indicators ?? [],
    caveats: init.caveats ?? [],
    verdict_contributions: init.verdict_contributions ?? [],
    confidence: init.confidence ?? "variable",
    output_fields: output_fields.length > 0 ? output_fields : DEFAULT_OUTPUT_FIELDS,
  };
}

export function heuristic(init: {
  id: string;
  title: string;
  role: SignalRole;
  group: string;
  description: string;
  input_fields: readonly SourceFieldRef[];
  reasoning: string;
  positive_indicators: readonly string[];
  negative_indicators?: readonly string[];
  caveats?: readonly string[];
  verdict_contributions?: readonly VerdictContribution[];
  confidence?: Confidence;
  output_fields?: readonly string[];
  reasoning_paths?: readonly ReasoningPath[];
}): AtomicHeuristicDefinition {
  const output_fields = init.output_fields ?? [];
  return {
    id: init.id,
    title: init.title,
    role: init.role,
    group: init.group,
    description: init.description,
    input_fields: init.input_fields,
    reasoning: init.reasoning,
    positive_indicators: init.positive_indicators,
    negative_indicators: init.negative_indicators ?? [],
    caveats: init.caveats ?? [],
    verdict_contributions: init.verdict_contributions ?? [],
    confidence: init.confidence ?? "variable",
    output_fields: output_fields.length > 0 ? output_fields : DEFAULT_OUTPUT_FIELDS,
    reasoning_paths: init.reasoning_paths ?? [],
  };
}

export function family(init: {
  id: string;
  title: string;
  role: SignalRole;
  group: string;
  description: string;
  input_fields: readonly SourceFieldRef[];
  reasoning_paths: readonly ReasoningPath[];
  confidence?: Confidence;
}): AtomicHeuristicDefinition {
  return heuristic({
    id: init.id,
    title: init.title,
    role: init.role,
    group: init.group,
    description: init.description,
    input_fields: init.input_fields,
    reasoning:
      "Evaluate each reasoning path independently against the shared input surface; multiple paths may apply.",
    positive_indicators: init.reasoning_paths.map((p) => p.title),
    verdict_contributions: [
      contribution(
        "qualify",
        "Predicate-family wrapper preserves path-level verdict effects.",
        "mixed_evidence",
      ),
    ],
    confidence: init.confidence ?? "variable",
    reasoning_paths: init.reasoning_paths,
  });
}

export const ATOMIC_HEURISTICS: readonly AtomicHeuristicDefinition[] = [
  heuristic({
    id: "residential_tax_subject",
    title: "Residential tax subject",
    role: "context",
    group: "ownership_exposure",
    description:
      "Tax data supports that the subject is a residential property rather than a non-residential parcel.",
    input_fields: [
      field("tax", "residential", "residential flag"),
      field("tax", "condo", "condo flag", { required: false }),
      field("tax", "address", "situs address"),
      field("tax", "addressformal", "formal situs address", { required: false }),
    ],
    reasoning:
      "Use tax property classification and situs fields as the property-level gate before weighing occupancy contradictions.",
    positive_indicators: [
      "tax.residential is true",
      "tax address normalizes to the subject address",
    ],
    negative_indicators: [
      "tax row is non-residential",
      "tax address does not resolve to the subject",
    ],
    caveats: [
      "Residential classification does not itself prove mortgage exposure or rental use.",
    ],
    verdict_contributions: [
      contribution(
        "qualify",
        "Establishes the property context needed for occupancy review.",
        "mixed_evidence",
      ),
    ],
    confidence: "high",
  }),
  heuristic({
    id: "liened_residential_subject",
    title: "Liened residential subject",
    role: "context",
    group: "ownership_exposure",
    description: "Tax data shows lien or lender evidence on a residential subject property.",
    input_fields: [
      field("tax", "totalliencount", "lien count"),
      field("tax", "totallienbalance", "lien balance", { required: false }),
      field("tax", "lendername", "lender name", { required: false }),
      field("tax", "recordingdate", "recording date", { required: false }),
    ],
    reasoning:
      "Treat lien/lender fields as mortgage-exposure context when paired with absentee or third-party occupancy signals.",
    positive_indicators: [
      "tax.totalliencount is positive",
      "tax.totallienbalance or tax.lendername is populated",
    ],
    caveats: [
      "Lien evidence is not equivalent to a confirmed primary-residence occupancy obligation.",
    ],
    verdict_contributions: [
      contribution(
        "increase",
        "Mortgage exposure makes absentee and non-owner occupancy signals more consequential.",
        "clear_absentee_rental",
        "ambiguous_nonowner_occupancy",
      ),
    ],
    confidence: "medium",
  }),
  heuristic({
    id: "base_mortgage_or_refi_at_subject",
    title: "Base mortgage or refi at subject",
    role: "context",
    group: "ownership_exposure",
    description:
      "Base person/home fields align a person to the subject and include mortgage or refinance evidence.",
    input_fields: [
      field("base", "primaryaddress", "person primary address"),
      field("base", "zip", "person address zip", { required: false }),
      field("base", "mortgageamountinthousands", "mortgage amount", { required: false }),
      field("base", "mortgagelendername", "mortgage lender", { required: false }),
      field("base", "refinanceamountinthousands", "refinance amount", { required: false }),
      field("base", "refinancelendername", "refinance lender", { required: false }),
    ],
    reasoning:
      "Use base mortgage/refi fields as a borrower-home proxy only when the person and address match subject context.",
    positive_indicators: [
      "base.primaryaddress matches subject",
      "mortgage or refinance fields are populated",
    ],
    caveats: ["Base data can be self-reported, stale, or not title-linked."],
    verdict_contributions: [
      contribution(
        "increase",
        "A home/mortgage proxy makes owner-elsewhere evidence more suspicious.",
        "clear_absentee_rental",
        "mixed_evidence",
      ),
    ],
    confidence: "medium",
  }),
  heuristic({
    id: "foreclosure_or_distress_marker",
    title: "Foreclosure or distress marker",
    role: "risk",
    group: "ownership_exposure",
    description: "Tax data carries foreclosure or distress markers for the subject.",
    input_fields: [
      field("tax", "foreclosecode", "foreclosure code"),
      field("tax", "forecloserecorddate", "foreclosure record date", { required: false }),
    ],
    reasoning:
      "Use distress only as an amplifier when absentee or non-owner occupancy evidence is also present.",
    positive_indicators: [
      "tax.foreclosecode is populated",
      "tax.forecloserecorddate is populated",
    ],
    caveats: ["Distress is not rental evidence by itself."],
    verdict_contributions: [
      contribution(
        "increase",
        "Distress can strengthen review priority when occupancy mismatch is otherwise supported.",
        "clear_absentee_rental",
        "mixed_evidence",
      ),
    ],
    confidence: "medium",
  }),
  heuristic({
    id: "company_or_trust_owner",
    title: "Company or trust owner",
    role: "risk",
    group: "owner_identity_title",
    description: "Tax owner fields indicate a company, trust, or non-natural owner.",
    input_fields: [
      field("tax", "ownercompany", "owner company"),
      field("tax", "ownername", "owner display name"),
    ],
    reasoning:
      "Treat entity ownership as absentee/investor context unless resident-owner evidence bridges the entity to a natural person.",
    positive_indicators: [
      "tax.ownercompany is populated",
      "tax.ownername contains LLC, INC, TRUST, ESTATE, or similar entity text",
    ],
    caveats: [
      "Family trusts and estate records can be owner-occupied; require occupant identity context.",
    ],
    verdict_contributions: [
      contribution(
        "increase",
        "Entity ownership increases investor or absentee-owner plausibility when non-owner occupancy exists.",
        "clear_absentee_rental",
        "ambiguous_nonowner_occupancy",
      ),
    ],
    confidence: "medium",
  }),
  family({
    id: "evidence_quality_and_synthesis",
    title: "Evidence quality and synthesis",
    role: "quality",
    group: "quality_synthesis",
    description:
      "Quality gates and final internal-only synthesis paths that depend on optional cross-source evidence.",
    input_fields: [
      field("tax", "recordingdate", "tax recording date", { required: false }),
      field("tax", "totalliencount", "lien count", { required: false }),
      field("base", "deeddateofrefinanceyear", "refinance year", { required: false }),
      field("trace", "homePurchaseDate", "trace home purchase date", { required: false }),
      field("utility", "address", "utility address", { required: false }),
      field("loan", "address", "loan address", { required: false }),
      field("base", "firstname", "base first name", { required: false }),
      field("base", "lastname", "base last name", { required: false }),
      field("trace", "firstname", "trace first name", { required: false }),
      field("trace", "lastname", "trace last name", { required: false }),
      field("tax", "condo", "condo flag", { required: false }),
      field("tax", "addressformal", "formal address", { required: false }),
      field("tax", "ownername", "tax owner name", { required: false }),
      field("drive", "address", "driver address evidence", { required: false }),
      field("voter", "address", "voter address evidence", { required: false }),
      field("auto", "address", "auto address evidence", { required: false }),
      field("loan", "ownRent", "loan tenure evidence", { required: false }),
      field("trace", "address", "trace address evidence", { required: false }),
    ],
    reasoning_paths: [
      path({
        id: "stale_or_missing_mortgage_exposure",
        title: "Stale or missing mortgage exposure",
        role: "quality",
        predicate:
          "Mortgage or lien exposure is missing, stale, or too ambiguous to anchor a primary-residence concern.",
        positive_indicators: [
          "no active-looking lien fields",
          "only old or undated mortgage/refi evidence is present",
        ],
        verdict_contributions: [
          contribution(
            "qualify",
            "Lower confidence in mortgage-fraud framing while preserving occupancy signal review.",
            "mixed_evidence",
            "ambiguous_nonowner_occupancy",
          ),
        ],
        confidence: "variable",
      }),
      path({
        id: "missing_dates_confidence_discount",
        title: "Missing dates confidence discount",
        role: "quality",
        predicate: "Important evidence lacks dates needed to compare occupancy timing.",
        positive_indicators: [
          "material evidence has no date fields",
          "available dates do not establish overlap",
        ],
        verdict_contributions: [
          contribution(
            "qualify",
            "Missing dates move borderline cases toward review/monitor rather than high confidence.",
            "mixed_evidence",
            "ambiguous_nonowner_occupancy",
          ),
        ],
        confidence: "high",
      }),
      path({
        id: "same_person_name_variant_ambiguity",
        title: "Same-person name variant ambiguity",
        role: "quality",
        predicate:
          "Source rows may represent the same person under variants rather than distinct occupants.",
        positive_indicators: [
          "same DOB, phone, email, or id appears under multiple names",
          "names are close variants",
        ],
        verdict_contributions: [
          contribution(
            "qualify",
            "Identity ambiguity should reduce distinct-occupant counts.",
            "mixed_evidence",
          ),
        ],
        confidence: "medium",
      }),
      path({
        id: "malformed_address_equivalence",
        title: "Malformed address equivalence",
        role: "quality",
        predicate:
          "Address normalization may have matched malformed, partial, or non-equivalent addresses.",
        positive_indicators: [
          "missing house number",
          "nearby street match only",
          "directional/unit/suffix mismatch changes meaning",
        ],
        verdict_contributions: [
          contribution(
            "qualify",
            "Address-match risk should prevent high-confidence classification.",
            "insufficient_ownership_data",
            "mixed_evidence",
          ),
        ],
        confidence: "high",
      }),
      path({
        id: "unit_collapsed_address_ambiguity",
        title: "Unit-collapsed address ambiguity",
        role: "quality",
        predicate:
          "Unit, condo, apartment, or multifamily context may collapse distinct households into one address.",
        positive_indicators: [
          "condo is true",
          "unit/apartment markers differ",
          "many unrelated households share same normalized address",
        ],
        verdict_contributions: [
          contribution(
            "qualify",
            "Unit ambiguity should move cases toward manual review unless single-dwelling context is clear.",
            "mixed_evidence",
            "insufficient_ownership_data",
          ),
        ],
        confidence: "high",
      }),
      path({
        id: "integrated_internal_occupancy_verdict",
        title: "Integrated internal occupancy verdict",
        role: "synthesis",
        predicate:
          "Synthesize atomic internal-only findings into a final case archetype and confidence explanation.",
        positive_indicators: [
          "multiple atomic signals converge",
          "mitigations and quality flags are explicitly weighed",
        ],
        caveats: [
          "This synthesis must not use withheld external market evidence as input.",
        ],
        verdict_contributions: [
          contribution(
            "decide",
            "Final internal-only case archetype selection.",
            ...FINAL_CASE_ARCHETYPES,
          ),
        ],
        confidence: "variable",
        output_fields: [
          "case_archetype",
          "confidence",
          "primary_risk_signals",
          "mitigations",
          "data_quality_flags",
        ],
      }),
    ],
  }),
  family({
    id: "owner_identity_and_cross_source_context",
    title: "Owner identity and cross-source context",
    role: "risk",
    group: "owner_identity_title",
    description:
      "Identity, relationship, and cross-source corroboration paths keyed from the tax owner name.",
    input_fields: [
      field("tax", "ownername", "owner display name"),
      field("tax", "firstname", "owner first name", { required: false }),
      field("tax", "lastname", "owner last name", { required: false }),
      field("tax", "ownercompany", "owner company", { required: false }),
      field("drive", "lastname", "driver last name", { required: false }),
      field("voter", "lastname", "voter last name", { required: false }),
      field("auto", "lastname", "auto last name", { required: false }),
      field("base", "lastname", "base last name", { required: false }),
      field("loan", "lastname", "loan last name", { required: false }),
      field("trace", "lastname", "trace last name", { required: false }),
      field("utility", "lastName", "utility last name", { required: false }),
      field("tax", "ownerrescount", "owner residential count", { required: false }),
    ],
    reasoning_paths: [
      path({
        id: "tax_owner_identity_present",
        title: "Tax owner identity present",
        role: "context",
        predicate: "Tax owner fields identify the subject owner or owner entity.",
        positive_indicators: [
          "tax.ownername is populated",
          "tax firstname/lastname or ownercompany resolves an owner identity",
        ],
        verdict_contributions: [
          contribution(
            "qualify",
            "Owner identity is required to distinguish owner-present from non-owner occupancy.",
            "mixed_evidence",
          ),
        ],
        confidence: "high",
      }),
      path({
        id: "repeated_nonowner_cross_source_corroboration",
        title: "Repeated non-owner cross-source corroboration",
        role: "risk",
        predicate: "The same non-owner appears at the subject across multiple source classes.",
        positive_indicators: [
          "same non-owner name/person appears in two or more source classes at subject",
        ],
        verdict_contributions: [
          contribution(
            "increase",
            "Corroborated non-owner presence materially strengthens rental/occupancy inference.",
            "clear_absentee_rental",
            "family_household_rental",
            "ambiguous_nonowner_occupancy",
          ),
        ],
        confidence: "high",
      }),
      path({
        id: "unrelated_nonowner_legal_presence",
        title: "Unrelated non-owner legal presence",
        role: "risk",
        predicate:
          "A non-owner with no apparent family/name bridge has legal presence at the subject.",
        positive_indicators: [
          "non-owner legal-source surname differs from owner surname",
          "no shared phone, DOB, or household bridge is apparent",
        ],
        caveats: [
          "Surname differences can reflect marriage, divorce, blended households, or name changes.",
        ],
        verdict_contributions: [
          contribution(
            "increase",
            "Unrelated legal occupant evidence pushes toward clear absentee rental when owner is absent.",
            "clear_absentee_rental",
          ),
        ],
        confidence: "medium",
      }),
      path({
        id: "same_surname_family_household_context",
        title: "Same-surname family household context",
        role: "mitigation",
        predicate: "Non-owner occupants share surname or likely family context with owner.",
        positive_indicators: [
          "non-owner surname matches owner",
          "DOB gaps or household evidence suggest adult child, spouse, or relative",
        ],
        caveats: [
          "Family rentals can still be useful; do not clear solely because the occupant appears related.",
        ],
        verdict_contributions: [
          contribution(
            "decide",
            "Family context should route supported rental evidence to family_household_rental.",
            "family_household_rental",
          ),
        ],
        confidence: "medium",
      }),
      path({
        id: "owner_present_plus_nonowner_renter_context",
        title: "Owner present plus non-owner renter context",
        role: "mitigation",
        predicate:
          "Owner-present evidence coexists with non-owner renter or occupant evidence.",
        positive_indicators: [
          "owner has subject evidence",
          "non-owner has RENT or occupant evidence at subject",
        ],
        verdict_contributions: [
          contribution(
            "qualify",
            "Coexisting owner/non-owner evidence often indicates owner-present rental indicators or ambiguous occupancy.",
            "owner_present_with_rental_indicators",
            "ambiguous_nonowner_occupancy",
          ),
        ],
        confidence: "variable",
      }),
      path({
        id: "portfolio_owner_with_nonowner_occupancy",
        title: "Portfolio owner with non-owner occupancy",
        role: "risk",
        predicate:
          "Portfolio-like ownership coexists with non-owner subject occupancy evidence.",
        positive_indicators: [
          "owner has multiple properties or portfolio marker",
          "non-owner occupancy evidence exists at subject",
        ],
        verdict_contributions: [
          contribution(
            "increase",
            "Portfolio plus occupant evidence supports rental-property inference.",
            "clear_absentee_rental",
            "ambiguous_nonowner_occupancy",
          ),
        ],
        confidence: "medium",
      }),
    ],
  }),
  family({
    id: "tax_mailing_situs_analysis",
    title: "Tax mailing situs analysis",
    role: "risk",
    group: "owner_identity_title",
    description:
      "Compare tax owner mailing address with subject situs and legal-address contradictions.",
    input_fields: [
      field("tax", "owneraddressline1", "owner mailing street"),
      field("tax", "address", "situs street"),
      field("tax", "ownercity", "owner mailing city", { required: false }),
      field("tax", "ownerstate", "owner mailing state", { required: false }),
      field("tax", "ownerzipcode", "owner mailing zip", { required: false }),
      field("tax", "city", "situs city", { required: false }),
      field("tax", "state", "situs state", { required: false }),
      field("tax", "zip", "situs zip", { required: false }),
      field("drive", "address", "driver address", { required: false }),
      field("voter", "address", "voter address", { required: false }),
      field("auto", "address", "auto address", { required: false }),
    ],
    reasoning_paths: [
      path({
        id: "tax_owner_mailing_matches_situs",
        title: "Tax owner mailing matches situs",
        role: "support",
        predicate: "The tax owner mailing address matches the subject situs address.",
        positive_indicators: [
          "owner mailing street and zip normalize to the subject situs",
        ],
        caveats: [
          "Mailing address can be administrative, stale, or intentionally retained after moving.",
        ],
        verdict_contributions: [
          contribution(
            "decrease",
            "Owner mailing at subject mitigates absentee-owner conclusions unless contradicted.",
            "clear_absentee_rental",
          ),
        ],
        confidence: "medium",
      }),
      path({
        id: "tax_owner_mailing_differs_from_situs",
        title: "Tax owner mailing differs from situs",
        role: "risk",
        predicate: "The tax owner mailing address differs from the subject situs address.",
        positive_indicators: [
          "mailing street or zip differs from subject",
          "mailing address is out of city or out of state",
        ],
        verdict_contributions: [
          contribution(
            "increase",
            "Absentee tax mailing supports clear absentee rental when occupant evidence exists.",
            "clear_absentee_rental",
            "family_household_rental",
          ),
        ],
        confidence: "medium",
      }),
      path({
        id: "tax_mailing_subject_but_owner_legal_elsewhere",
        title: "Tax mailing subject but owner legal elsewhere",
        role: "risk",
        predicate: "Tax mailing matches subject, but owner legal records point elsewhere.",
        positive_indicators: [
          "tax mailing matches subject",
          "owner drive/voter/auto address differs from subject",
        ],
        verdict_contributions: [
          contribution(
            "increase",
            "Contradictory owner address evidence raises absentee concern despite mailing-at-subject mitigation.",
            "clear_absentee_rental",
            "mixed_evidence",
          ),
        ],
        confidence: "medium",
      }),
    ],
  }),
  family({
    id: "base_subject_owner_alignment",
    title: "Base subject owner alignment",
    role: "quality",
    group: "owner_identity_title",
    description:
      "Assess whether base primary-address evidence aligns with tax ownership at the subject.",
    input_fields: [
      field("base", "firstname", "base first name"),
      field("base", "lastname", "base last name"),
      field("base", "primaryaddress", "base primary address"),
      field("tax", "ownername", "tax owner name"),
    ],
    reasoning_paths: [
      path({
        id: "base_person_not_tax_owner_at_subject",
        title: "Base person not tax owner at subject",
        role: "quality",
        predicate:
          "A base person has home/mortgage evidence at the subject but is not resolved as a tax owner.",
        positive_indicators: [
          "base address matches subject",
          "base person name is not a tax owner",
        ],
        caveats: [
          "May reflect co-borrowers, stale tax, transfers, spouses, or name changes.",
        ],
        verdict_contributions: [
          contribution(
            "qualify",
            "Ownership-chain uncertainty should temper hard conclusions.",
            "mixed_evidence",
            "insufficient_ownership_data",
          ),
        ],
        confidence: "medium",
      }),
      path({
        id: "owner_base_primary_at_subject",
        title: "Owner base primary at subject",
        role: "support",
        predicate: "A tax owner has base primary-address evidence at the subject.",
        positive_indicators: [
          "owner identity resolves to base person",
          "base.primaryaddress matches subject",
        ],
        verdict_contributions: [
          contribution(
            "decrease",
            "Owner primary evidence reduces clear absentee confidence.",
            "clear_absentee_rental",
          ),
        ],
        confidence: "medium",
      }),
    ],
  }),
  family({
    id: "loan_tenure_subject_analysis",
    title: "Loan tenure subject analysis",
    role: "risk",
    group: "loan_tenure",
    description:
      "Analyze loan tenure claims against tax ownership and subject-address alignment.",
    input_fields: [
      field("loan", "firstname", "loan first name"),
      field("loan", "lastname", "loan last name"),
      field("loan", "address", "loan address"),
      field("loan", "ownRent", "loan tenure"),
      field("tax", "ownername", "tax owner name"),
      field("loan", "zip", "loan zip", { required: false }),
    ],
    reasoning_paths: [
      path({
        id: "loan_owner_claim_not_supported_by_tax",
        title: "Loan owner claim not supported by tax",
        role: "risk",
        predicate: "A loan row claims OWN at the subject for a person not shown as tax owner.",
        positive_indicators: [
          "loan.ownRent is OWN",
          "loan address matches subject",
          "loan person is not a tax owner",
        ],
        verdict_contributions: [
          contribution(
            "increase",
            "Non-owner ownership claims add inconsistency but are not direct rental proof.",
            "mixed_evidence",
            "ambiguous_nonowner_occupancy",
          ),
        ],
        confidence: "medium",
      }),
      path({
        id: "owner_loan_rent_conflict",
        title: "Owner loan rent conflict",
        role: "quality",
        predicate: "A tax owner has a loan row at the owned subject but reports RENT.",
        positive_indicators: [
          "tax owner matches loan person",
          "loan address matches subject",
          "loan.ownRent is RENT",
        ],
        verdict_contributions: [
          contribution(
            "qualify",
            "Owner rent claims usually push toward mixed evidence unless supported by stronger absentee facts.",
            "mixed_evidence",
          ),
        ],
        confidence: "medium",
      }),
      path({
        id: "owner_loan_own_at_subject",
        title: "Owner loan OWN at subject",
        role: "support",
        predicate: "A tax owner has a loan row at the subject reporting OWN.",
        positive_indicators: [
          "owner identity resolves to loan row",
          "loan address matches subject",
          "loan.ownRent is OWN",
        ],
        verdict_contributions: [
          contribution(
            "decrease",
            "Owner OWN tenure supports owner-occupied or owner-controlled interpretation.",
            "clear_absentee_rental",
          ),
        ],
        confidence: "medium",
      }),
      path({
        id: "nonowner_loan_renter_at_subject",
        title: "Non-owner loan renter at subject",
        role: "risk",
        predicate: "A non-owner loan row at the subject reports RENT.",
        positive_indicators: [
          "loan address matches subject",
          "loan.ownRent is RENT",
          "loan person is not a tax owner",
        ],
        caveats: [
          "Same-surname family renters remain useful but should usually map to family_household_rental.",
        ],
        verdict_contributions: [
          contribution(
            "increase",
            "Direct renter self-report strongly supports rental-use inference.",
            "clear_absentee_rental",
            "family_household_rental",
            "ambiguous_nonowner_occupancy",
          ),
        ],
        confidence: "high",
      }),
      path({
        id: "nonowner_loan_owner_claim_at_subject",
        title: "Non-owner loan owner claim at subject",
        role: "risk",
        predicate: "A non-owner loan row at the subject reports OWN.",
        positive_indicators: [
          "loan address matches subject",
          "loan.ownRent is OWN",
          "loan person is not a tax owner",
        ],
        verdict_contributions: [
          contribution(
            "qualify",
            "Tenure/title inconsistency often supports mixed evidence rather than clear rental.",
            "mixed_evidence",
            "ambiguous_nonowner_occupancy",
          ),
        ],
        confidence: "medium",
      }),
    ],
  }),
  heuristic({
    id: "owner_loan_elsewhere",
    title: "Owner loan address elsewhere",
    role: "risk",
    group: "owner_elsewhere",
    description: "A tax owner has loan-address evidence at a non-subject address.",
    input_fields: [
      field("tax", "ownername", "tax owner name"),
      field("loan", "firstname", "loan first name"),
      field("loan", "lastname", "loan last name"),
      field("loan", "address", "loan address"),
      field("loan", "ownRent", "loan tenure", { required: false }),
    ],
    reasoning:
      "Owner loan address elsewhere supports an alternate residence or credit address, with weight depending on tenure and corroboration.",
    positive_indicators: [
      "owner identity resolves to loan row",
      "loan address differs from subject",
    ],
    caveats: ["Loan address can be mailing, employment, or stale credit-report context."],
    verdict_contributions: [
      contribution(
        "increase",
        "Owner loan elsewhere adds alternate-address support but needs corroboration.",
        "mixed_evidence",
        "clear_absentee_rental",
      ),
    ],
    confidence: "medium",
  }),
  family({
    id: "drive_address_subject_analysis",
    title: "Driver license subject analysis",
    role: "risk",
    group: "legal_address",
    description:
      "Classify driver license records as owner-at-subject, owner-elsewhere, or non-owner-at-subject evidence.",
    input_fields: [
      field("drive", "firstname", "driver first name"),
      field("drive", "lastname", "driver last name"),
      field("drive", "address", "driver address"),
      field("tax", "ownername", "tax owner name"),
      field("drive", "zip", "driver zip", { required: false }),
    ],
    reasoning_paths: [
      path({
        id: "owner_drive_at_subject",
        title: "Owner driver license at subject",
        role: "support",
        predicate: "A tax owner has driver license evidence at the subject.",
        positive_indicators: [
          "owner identity resolves to drive row",
          "drive address matches subject",
        ],
        verdict_contributions: [
          contribution(
            "decrease",
            "Strong owner legal presence counters absentee interpretation.",
            "clear_absentee_rental",
          ),
        ],
        confidence: "high",
      }),
      path({
        id: "owner_drive_elsewhere",
        title: "Owner driver license elsewhere",
        role: "risk",
        predicate: "A tax owner has driver license evidence at a non-subject address.",
        positive_indicators: [
          "owner identity resolves to drive row",
          "drive address differs from subject",
        ],
        verdict_contributions: [
          contribution(
            "increase",
            "Strong owner-elsewhere legal evidence supports absentee interpretation.",
            "clear_absentee_rental",
          ),
        ],
        confidence: "high",
      }),
      path({
        id: "nonowner_drive_at_subject",
        title: "Non-owner driver license at subject",
        role: "risk",
        predicate: "A non-owner has driver license evidence at the subject.",
        positive_indicators: [
          "drive address matches subject",
          "driver person is not resolved as tax owner",
        ],
        verdict_contributions: [
          contribution(
            "increase",
            "Strong third-party legal presence supports rental or non-owner occupancy.",
            "clear_absentee_rental",
            "family_household_rental",
            "ambiguous_nonowner_occupancy",
          ),
        ],
        confidence: "high",
      }),
    ],
  }),
  family({
    id: "voter_address_subject_analysis",
    title: "Voter registration subject analysis",
    role: "risk",
    group: "legal_address",
    description:
      "Classify voter records as owner-at-subject, owner-elsewhere, or non-owner-at-subject evidence.",
    input_fields: [
      field("voter", "firstname", "voter first name"),
      field("voter", "lastname", "voter last name"),
      field("voter", "address", "voter address"),
      field("tax", "ownername", "tax owner name"),
      field("voter", "zip", "voter zip", { required: false }),
    ],
    reasoning_paths: [
      path({
        id: "owner_voter_at_subject",
        title: "Owner voter registration at subject",
        role: "support",
        predicate: "A tax owner has voter registration evidence at the subject.",
        positive_indicators: [
          "owner identity resolves to voter row",
          "voter address matches subject",
        ],
        verdict_contributions: [
          contribution(
            "decrease",
            "Owner government-record presence counters absentee interpretation.",
            "clear_absentee_rental",
          ),
        ],
        confidence: "high",
      }),
      path({
        id: "owner_voter_elsewhere",
        title: "Owner voter registration elsewhere",
        role: "risk",
        predicate: "A tax owner has voter registration evidence at a non-subject address.",
        positive_indicators: [
          "owner identity resolves to voter row",
          "voter address differs from subject",
        ],
        verdict_contributions: [
          contribution(
            "increase",
            "Strong owner-elsewhere government record supports absentee interpretation.",
            "clear_absentee_rental",
          ),
        ],
        confidence: "high",
      }),
      path({
        id: "nonowner_voter_at_subject",
        title: "Non-owner voter registration at subject",
        role: "risk",
        predicate: "A non-owner has voter registration evidence at the subject.",
        positive_indicators: [
          "voter address matches subject",
          "voter person is not resolved as tax owner",
        ],
        verdict_contributions: [
          contribution(
            "increase",
            "Strong third-party government record supports rental or non-owner occupancy.",
            "clear_absentee_rental",
            "family_household_rental",
            "ambiguous_nonowner_occupancy",
          ),
        ],
        confidence: "high",
      }),
    ],
  }),
  family({
    id: "auto_address_subject_analysis",
    title: "Auto registration subject analysis",
    role: "risk",
    group: "legal_address",
    description:
      "Classify auto records as owner-at-subject, owner-elsewhere, or non-owner-at-subject evidence.",
    input_fields: [
      field("auto", "firstname", "auto first name"),
      field("auto", "lastname", "auto last name"),
      field("auto", "address", "auto address"),
      field("tax", "ownername", "tax owner name"),
      field("auto", "zip", "auto zip", { required: false }),
    ],
    reasoning_paths: [
      path({
        id: "owner_auto_at_subject",
        title: "Owner auto registration at subject",
        role: "support",
        predicate: "A tax owner has vehicle registration evidence at the subject.",
        positive_indicators: [
          "owner identity resolves to auto row",
          "auto address matches subject",
        ],
        verdict_contributions: [
          contribution(
            "decrease",
            "Owner auto at subject partially mitigates absentee conclusions.",
            "clear_absentee_rental",
          ),
        ],
        confidence: "medium",
      }),
      path({
        id: "owner_auto_elsewhere",
        title: "Owner auto registration elsewhere",
        role: "risk",
        predicate: "A tax owner has auto registration evidence at a non-subject address.",
        positive_indicators: [
          "owner identity resolves to auto row",
          "auto address differs from subject",
        ],
        caveats: [
          "Auto registration may indicate vehicle garaging or old records rather than current residence.",
        ],
        verdict_contributions: [
          contribution(
            "increase",
            "Owner auto elsewhere supports absentee interpretation when corroborated.",
            "clear_absentee_rental",
            "mixed_evidence",
          ),
        ],
        confidence: "medium",
      }),
      path({
        id: "nonowner_auto_at_subject",
        title: "Non-owner auto registration at subject",
        role: "risk",
        predicate: "A non-owner has auto registration evidence at the subject.",
        positive_indicators: [
          "auto address matches subject",
          "auto person is not resolved as tax owner",
        ],
        verdict_contributions: [
          contribution(
            "increase",
            "Non-owner vehicle evidence supports occupancy when paired with stronger signals.",
            "ambiguous_nonowner_occupancy",
            "clear_absentee_rental",
          ),
        ],
        confidence: "medium",
      }),
    ],
  }),
  heuristic({
    id: "owner_legal_records_conflict",
    title: "Owner legal records conflict",
    role: "quality",
    group: "owner_elsewhere",
    description: "Owner legal records point to multiple distinct addresses.",
    input_fields: [
      field("drive", "address", "driver address"),
      field("voter", "address", "voter address", { required: false }),
      field("auto", "address", "auto address", { required: false }),
      field("tax", "ownername", "tax owner name"),
    ],
    reasoning:
      "If owner legal sources disagree, preserve the conflict instead of treating any one address as definitive.",
    positive_indicators: [
      "two or more distinct non-subject legal addresses",
      "subject and non-subject legal addresses coexist",
    ],
    caveats: ["Conflicting legal records may indicate moves over time or stale records."],
    verdict_contributions: [
      contribution(
        "qualify",
        "Legal-source conflict should lower confidence and explain mixed evidence.",
        "mixed_evidence",
      ),
    ],
    confidence: "variable",
  }),
  heuristic({
    id: "auto_only_owner_elsewhere_discount",
    title: "Auto-only owner elsewhere discount",
    role: "mitigation",
    group: "owner_elsewhere",
    description: "Owner elsewhere evidence comes only from auto registration.",
    input_fields: [
      field("auto", "address", "auto address"),
      field("drive", "address", "driver address", { required: false }),
      field("voter", "address", "voter address", { required: false }),
      field("tax", "ownername", "tax owner name"),
    ],
    reasoning:
      "Discount owner-elsewhere conclusions when only vehicle registration points away and stronger legal sources are absent.",
    positive_indicators: [
      "owner auto address differs from subject",
      "no owner drive/voter elsewhere corroboration",
    ],
    verdict_contributions: [
      contribution(
        "decrease",
        "Auto-only owner-away evidence should not drive a clear absentee conclusion.",
        "clear_absentee_rental",
      ),
    ],
    confidence: "medium",
  }),
  family({
    id: "trace_address_subject_analysis",
    title: "Trace address subject analysis",
    role: "risk",
    group: "trace_address",
    description:
      "Classify trace records as owner-at-subject, owner-elsewhere, or non-owner-at-subject evidence.",
    input_fields: [
      field("trace", "firstname", "trace first name"),
      field("trace", "lastname", "trace last name"),
      field("trace", "address", "trace address"),
      field("tax", "ownername", "tax owner name"),
      field("trace", "zip", "trace zip", { required: false }),
      field("trace", "homePurchaseDate", "trace home purchase date", { required: false }),
    ],
    reasoning_paths: [
      path({
        id: "owner_trace_at_subject",
        title: "Owner trace at subject",
        role: "support",
        predicate: "A tax owner has trace evidence at the subject.",
        positive_indicators: [
          "owner identity resolves to trace row",
          "trace address matches subject",
        ],
        verdict_contributions: [
          contribution(
            "decrease",
            "Owner trace at subject softens absentee interpretation.",
            "clear_absentee_rental",
          ),
        ],
        confidence: "low",
      }),
      path({
        id: "owner_trace_elsewhere",
        title: "Owner trace elsewhere",
        role: "risk",
        predicate: "A tax owner has trace evidence at a non-subject address.",
        positive_indicators: [
          "owner identity resolves to trace row",
          "trace address differs from subject",
        ],
        verdict_contributions: [
          contribution(
            "increase",
            "Owner trace elsewhere supports absentee narrative when paired with stronger subject occupant evidence.",
            "clear_absentee_rental",
            "mixed_evidence",
          ),
        ],
        confidence: "low",
      }),
      path({
        id: "nonowner_trace_at_subject",
        title: "Non-owner trace at subject",
        role: "risk",
        predicate: "A non-owner has trace evidence at the subject.",
        positive_indicators: [
          "trace address matches subject",
          "trace person is not resolved as tax owner",
        ],
        verdict_contributions: [
          contribution(
            "increase",
            "Trace non-owner presence supports but should not dominate occupancy conclusions.",
            "ambiguous_nonowner_occupancy",
            "mixed_evidence",
          ),
        ],
        confidence: "low",
      }),
    ],
  }),
  family({
    id: "utility_subject_occupancy_analysis",
    title: "Utility subject occupancy analysis",
    role: "risk",
    group: "utility_occupancy",
    description:
      "Analyze utility account holders at the subject against tax owner identity.",
    input_fields: [
      field("utility", "firstName", "utility first name"),
      field("utility", "lastName", "utility last name"),
      field("utility", "address", "utility service address"),
      field("tax", "ownername", "tax owner name"),
      field("utility", "zip", "utility zip", { required: false }),
    ],
    reasoning_paths: [
      path({
        id: "owner_utility_at_subject",
        title: "Owner utility at subject",
        role: "support",
        predicate: "A tax owner appears as a utility account holder at the subject.",
        positive_indicators: [
          "owner identity resolves to utility row",
          "utility address matches subject",
        ],
        verdict_contributions: [
          contribution(
            "decrease",
            "Owner utility evidence reduces confidence in owner-absent cases.",
            "clear_absentee_rental",
          ),
        ],
        confidence: "medium",
      }),
      path({
        id: "nonowner_utility_at_subject",
        title: "Non-owner utility at subject",
        role: "risk",
        predicate: "A non-owner utility account holder appears at the subject.",
        positive_indicators: [
          "utility address matches subject",
          "utility person is not resolved as tax owner",
        ],
        verdict_contributions: [
          contribution(
            "increase",
            "Non-owner utility supports renter/occupant inference when corroborated.",
            "ambiguous_nonowner_occupancy",
            "clear_absentee_rental",
          ),
        ],
        confidence: "medium",
      }),
      path({
        id: "multiple_nonowner_utility_names",
        title: "Multiple non-owner utility names",
        role: "risk",
        predicate: "Multiple distinct non-owner utility names appear at the subject.",
        positive_indicators: [
          "two or more distinct non-owner utility names at subject",
        ],
        verdict_contributions: [
          contribution(
            "increase",
            "Utility turnover supports rental-churn inference but needs corroboration.",
            "ambiguous_nonowner_occupancy",
            "family_household_rental",
          ),
        ],
        confidence: "medium",
      }),
      path({
        id: "owner_utility_plus_nonowner_utility_context",
        title: "Owner utility plus non-owner utility context",
        role: "mitigation",
        predicate: "Utility records include both owner and non-owner names at the subject.",
        positive_indicators: [
          "at least one owner utility name",
          "at least one non-owner utility name",
        ],
        verdict_contributions: [
          contribution(
            "qualify",
            "Mixed utilities should temper hard absentee conclusions.",
            "owner_present_with_rental_indicators",
            "mixed_evidence",
          ),
        ],
        confidence: "medium",
      }),
    ],
  }),
  heuristic({
    id: "utility_only_no_dates_discount",
    title: "Utility-only no-dates discount",
    role: "quality",
    group: "mitigation_ambiguity",
    description: "Utility evidence is material but lacks service dates and corroborating records.",
    input_fields: [
      field("utility", "firstName", "utility first name"),
      field("utility", "lastName", "utility last name"),
      field("utility", "address", "utility service address"),
    ],
    reasoning:
      "Discount utility-only conclusions because current extracts do not show service start/end dates.",
    positive_indicators: [
      "only utility rows support occupancy",
      "no legal, loan, or trace corroboration",
    ],
    verdict_contributions: [
      contribution(
        "decrease",
        "Utility-only evidence should not produce clear absentee rental alone.",
        "clear_absentee_rental",
      ),
    ],
    confidence: "high",
  }),
  heuristic({
    id: "trace_only_presence_discount",
    title: "Trace-only presence discount",
    role: "quality",
    group: "mitigation_ambiguity",
    description: "Trace evidence is the only source placing a person at or away from the subject.",
    input_fields: [
      field("trace", "firstname", "trace first name"),
      field("trace", "lastname", "trace last name"),
      field("trace", "address", "trace address"),
      field("trace", "homePurchaseDate", "trace home purchase date", { required: false }),
    ],
    reasoning:
      "Trace-only address evidence is useful for search but weak for final occupancy conclusions.",
    positive_indicators: [
      "trace is the only matching source for the person/address claim",
    ],
    verdict_contributions: [
      contribution(
        "decrease",
        "Trace-only evidence should lower confidence and avoid overclassification.",
        "clear_absentee_rental",
        "family_household_rental",
      ),
    ],
    confidence: "high",
  }),
  heuristic({
    id: "drive_voter_conflict_same_person",
    title: "Driver voter conflict same person",
    role: "quality",
    group: "mitigation_ambiguity",
    description: "Driver license and voter registration disagree for the same person.",
    input_fields: [
      field("drive", "address", "driver address"),
      field("voter", "address", "voter address"),
      field("drive", "firstname", "driver first name"),
      field("drive", "lastname", "driver last name"),
      field("voter", "firstname", "voter first name"),
      field("voter", "lastname", "voter last name"),
    ],
    reasoning: "Conflicting government address records indicate timing or identity uncertainty.",
    positive_indicators: [
      "same person is resolved across drive and voter",
      "drive and voter addresses differ",
    ],
    verdict_contributions: [
      contribution(
        "qualify",
        "Legal-source disagreement should be surfaced as mixed evidence.",
        "mixed_evidence",
      ),
    ],
    confidence: "medium",
  }),
  heuristic({
    id: "auto_at_subject_but_stronger_legal_elsewhere",
    title: "Auto at subject but stronger legal elsewhere",
    role: "quality",
    group: "mitigation_ambiguity",
    description:
      "A person's auto registration is at subject while driver or voter records point elsewhere.",
    input_fields: [
      field("auto", "address", "auto address"),
      field("drive", "address", "driver address", { required: false }),
      field("voter", "address", "voter address", { required: false }),
    ],
    reasoning:
      "Vehicle garaging at a property is weaker than driver/voter evidence for primary residence.",
    positive_indicators: [
      "auto address matches subject",
      "drive or voter address differs from subject",
    ],
    verdict_contributions: [
      contribution(
        "decrease",
        "Auto-only subject presence should not override stronger legal elsewhere evidence.",
        "low_evidence_owner_occupied",
        "mixed_evidence",
      ),
    ],
    confidence: "medium",
  }),
  heuristic({
    id: "single_family_clean_address_context",
    title: "Single-family clean address context",
    role: "support",
    group: "mitigation_ambiguity",
    description: "Tax and address fields support a clean single-dwelling interpretation.",
    input_fields: [
      field("tax", "residential", "residential flag"),
      field("tax", "condo", "condo flag", { required: false }),
      field("tax", "buildingarea", "building area", { required: false }),
      field("tax", "addressformal", "formal address", { required: false }),
    ],
    reasoning:
      "A clean single-dwelling property reduces unit-collapse excuses for third-party occupancy evidence.",
    positive_indicators: [
      "residential is true",
      "condo is false",
      "no unit markers conflict",
      "address fields are stable",
    ],
    verdict_contributions: [
      contribution(
        "increase",
        "Clean single-dwelling context strengthens non-owner occupancy interpretation.",
        "clear_absentee_rental",
        "family_household_rental",
      ),
    ],
    confidence: "medium",
  }),
  family({
    id: "portfolio_primary_comparison_analysis",
    title: "Portfolio primary comparison analysis",
    role: "risk",
    group: "portfolio_pattern",
    description:
      "Analyze multi-property owner context and stronger alternate primary-address evidence.",
    input_fields: [
      field("tax", "ownername", "owner display name"),
      field("tax", "address", "situs address"),
      field("tax", "ownerrescount", "owner residential count", { required: false }),
      field("tax", "totalliencount", "lien count", { required: false }),
      field("base", "primaryaddress", "base primary address", { required: false }),
      field("drive", "address", "driver address", { required: false }),
      field("voter", "address", "voter address", { required: false }),
      field("auto", "address", "auto address", { required: false }),
    ],
    reasoning_paths: [
      path({
        id: "owner_multiple_liened_residential_properties",
        title: "Owner multiple liened residential properties",
        role: "risk",
        predicate: "The same owner appears linked to two or more liened residential properties.",
        positive_indicators: [
          "same owner has multiple residential properties with lien evidence",
        ],
        verdict_contributions: [
          contribution(
            "increase",
            "Multiple liened homes create occupancy-review context when subject has non-owner occupants.",
            "clear_absentee_rental",
            "mixed_evidence",
          ),
        ],
        confidence: "medium",
      }),
      path({
        id: "owner_primary_comparison_elsewhere",
        title: "Owner primary comparison elsewhere",
        role: "risk",
        predicate:
          "Another owner-linked property has stronger owner-presence evidence than the subject.",
        positive_indicators: [
          "owner has stronger legal/base presence at another address than at subject",
        ],
        caveats: ["Requires enough cross-property context to compare fairly."],
        verdict_contributions: [
          contribution(
            "increase",
            "A stronger alternate primary address supports absentee interpretation at subject.",
            "clear_absentee_rental",
            "mixed_evidence",
          ),
        ],
        confidence: "variable",
      }),
    ],
  }),
  heuristic({
    id: "tax_ownerrescount_portfolio_pattern",
    title: "Tax ownerrescount portfolio pattern",
    role: "risk",
    group: "portfolio_pattern",
    description: "Tax owner residential count suggests portfolio-like ownership.",
    input_fields: [
      field("tax", "ownerrescount", "owner residential count"),
      field("tax", "ownername", "owner display name"),
      field("tax", "address", "situs address"),
    ],
    reasoning: "Use ownerrescount as a portfolio context signal, not a standalone rental conclusion.",
    positive_indicators: ["tax.ownerrescount is 2 or greater"],
    caveats: ["ownerrescount may be stale, missing, or unreliable in some rows."],
    verdict_contributions: [
      contribution(
        "increase",
        "Portfolio context strengthens absentee/rental inference when occupant evidence exists.",
        "clear_absentee_rental",
        "ambiguous_nonowner_occupancy",
      ),
    ],
    confidence: "medium",
  }),
];

export function get_heuristic_catalog(): Array<Record<string, unknown>> {
  return ATOMIC_HEURISTICS.map((config) => asdict(config) as Record<string, unknown>);
}

export function get_heuristic_by_id(heuristic_id: string): AtomicHeuristicDefinition {
  for (const config of ATOMIC_HEURISTICS) {
    if (config.id === heuristic_id) {
      return config;
    }
  }
  throw new Error(`Unknown heuristic: ${heuristic_id}`);
}

export function heuristic_ids(): readonly string[] {
  return ATOMIC_HEURISTICS.map((config) => config.id);
}

export function reasoning_path_ids(): readonly string[] {
  const out: string[] = [];
  for (const config of ATOMIC_HEURISTICS) {
    for (const p of config.reasoning_paths) {
      out.push(p.id);
    }
  }
  return out;
}
