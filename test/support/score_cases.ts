// A fixed, deterministic case set for the source-weight benchmark. Each case is an evidence dict
// accepted by evaluate_evidence() — no LLM, no network, no clock. The set spans exactly the space
// the drive re-weighting moves: drive alone, drive co-occurring with the loan row it IS, and the
// neighbours whose relative ranking must not silently change with it.
//
// EVERY case that is supposed to MOVE carries a drive row, and every case that is supposed to HOLD
// carries none — that split is what makes the golden table a measurement rather than a snapshot.
export interface ScoreCase {
  id: string;
  why: string;
  evidence: Record<string, unknown>;
}

const SUBJECT = "1104 SPRING RUN RD";
const ELSEWHERE = "3360 RAVINIA CIR";

/**
 * The owner's person id — and the id EVERY owner-linked row must carry, whatever its shape.
 *
 * `build_evidence` (atomic_eval.ts:627-640) sets `owner_ids` to the tax rows' `id`s and then
 * backfills the other sources with `_id_rows(connection, source, owner_ids, …)`, so an owner's
 * drive/loan/auto/base row arrives carrying the OWNER's id, not one of its own. Every
 * owner-elsewhere path then links through `_owner_related_rows_by_id`, which is a pure
 * `owner_ids.has(row.id)` test — name matching is not consulted at all on that route.
 *
 * Giving an owner's drive row a distinct id (`"d1"`) therefore does not make a weaker case; it
 * makes an INERT one. Every owner_* path silently fails to fire and the case collapses onto the
 * tax-only baseline, scoring the same before and after any source re-weighting.
 */
const OWNER_ID = "t1";

function taxRow(owner = "CORRELL, JOSIAH", mailing = ELSEWHERE, extra: Record<string, unknown> = {}) {
  return {
    id: OWNER_ID,
    ownername: owner,
    address: SUBJECT,
    zip: "40514",
    owneraddressline1: mailing,
    ownercity: "AURORA",
    ownerstate: "IL",
    ownerzipcode: "60504",
    residential: "True",
    ownerrescount: 1,
    ...extra,
  };
}

function personRow(id: string, first: string, last: string, address: string, extra: Record<string, unknown> = {}) {
  return { id, firstname: first, lastname: last, address, zip: "40514", ...extra };
}

// `utility` is the one live shape that names people in snake_case (SOURCE_DATA_FIELDS.utility), so
// its rows are built through their own helper rather than personRow — writing them with `firstname`
// would make the case set disagree with the wire and quietly test a row the service never sends.
function utilityRow(first: string, last: string, address: string, extra: Record<string, unknown> = {}) {
  return { first_name: first, last_name: last, address, city: "LEXINGTON", state: "KY", zip: "40514", ...extra };
}

type Row = Record<string, unknown>;
/** The seven live shapes. Annotated, not inferred: a bare `[]` literal infers `never[]`. */
type RowsByShape = { tax: Row[]; base: Row[]; loan: Row[]; drive: Row[]; auto: Row[]; trace: Row[]; utility: Row[] };

const EMPTY: RowsByShape = { tax: [], base: [], loan: [], drive: [], auto: [], trace: [], utility: [] };

function make(id: string, why: string, rows: Partial<RowsByShape>): ScoreCase {
  const merged: Record<string, Row[]> = { ...EMPTY, ...rows };
  const source_counts: Record<string, number> = {};
  for (const [k, v] of Object.entries(merged)) {
    source_counts[k] = v.length;
  }
  const tax_rows = merged["tax"]!;
  return {
    id,
    why,
    evidence: {
      address: SUBJECT,
      normalized_address: SUBJECT,
      zip: "40514",
      rows: merged,
      owner_ids: tax_rows.map((r) => String(r["id"])),
      owner_name_keys: tax_rows.length ? [["josiah", "correll"]] : [],
      source_counts,
      owner_summaries: tax_rows.map((r) => ({
        owner_name: r["ownername"],
        mailing_address: r["owneraddressline1"],
        mailing_matches_subject: false,
      })),
      people_at_address: [],
      owner_presence_hints: [],
      owner_elsewhere_hints: tax_rows.length
        ? [`Owner mailing differs from selected address: ${String(tax_rows[0]!["ownername"])} -> ${ELSEWHERE}.`]
        : [],
      nonowner_occupancy_hints: [],
      freshness_hints: [],
      data_gaps: [],
      property_types: [],
      evidence_refs: [],
    },
  };
}

export const SCORE_CASES: readonly ScoreCase[] = [
  make("no_rows", "empty corpus — must land on insufficient_ownership_data", {}),
  make("tax_only_mailing_elsewhere", "absentee mailing with no occupancy evidence at all", { tax: [taxRow()] }),
  make("drive_only_owner_elsewhere", "the pure-drive case: the ONLY thing the weight change moves in isolation", {
    tax: [taxRow()],
    drive: [personRow(OWNER_ID, "JOSIAH", "CORRELL", ELSEWHERE, { dl_num: "K1234", dl_state: "IL" })],
  }),
  make("drive_and_loan_same_row", "THE double-count: one physical payday row read as both drive and loan", {
    tax: [taxRow()],
    drive: [personRow(OWNER_ID, "JOSIAH", "CORRELL", ELSEWHERE, { dl_num: "K1234", dl_state: "IL" })],
    loan: [personRow(OWNER_ID, "JOSIAH", "CORRELL", ELSEWHERE, { own_rent: "OWN", loan_amount: 500, employer: "ACME" })],
  }),
  make("nonowner_loan_renter_at_subject", "loan-only renter claim — the reference the drive tier must sit below", {
    tax: [taxRow()],
    loan: [personRow("l1", "JENNIFER", "HOWARD", SUBJECT, { own_rent: "RENT", loan_amount: 500 })],
  }),
  make("auto_only_owner_elsewhere", "auto-only, which the auto_only discount is supposed to mute", {
    tax: [taxRow()],
    auto: [personRow(OWNER_ID, "JOSIAH", "CORRELL", ELSEWHERE, { vin: "1X", year: 2015, make: "FORD", model: "F150" })],
  }),
  make("utility_only_nonowner", "utility-only non-owner: the lower-tier cap case", {
    tax: [taxRow()],
    utility: [utilityRow("JENNIFER", "HOWARD", SUBJECT)],
  }),
  make("trace_only_presence", "trace-only, the unranked corroboration case", {
    tax: [taxRow()],
    trace: [personRow("tr1", "AMY", "WILSON", SUBJECT, { phone: "8034786758" })],
  }),
  make("full_stack_absentee", "every live shape populated — the maximum-score case", {
    tax: [taxRow()],
    base: [{ id: OWNER_ID, firstname: "JOSIAH", lastname: "CORRELL", primaryaddress: ELSEWHERE, zip: "60504", homeownerprobabilitymodel: 9 }],
    drive: [personRow(OWNER_ID, "JOSIAH", "CORRELL", ELSEWHERE, { dl_num: "K1234", dl_state: "IL" })],
    loan: [personRow("l1", "JENNIFER", "HOWARD", SUBJECT, { own_rent: "RENT", loan_amount: 500 })],
    auto: [personRow("a1", "JENNIFER", "HOWARD", SUBJECT, { vin: "1X", year: 2015, make: "FORD", model: "F150" })],
    trace: [personRow("tr1", "JENNIFER", "HOWARD", SUBJECT, {})],
    utility: [utilityRow("JENNIFER", "HOWARD", SUBJECT)],
  }),
  // ── Added to the plan's nine. The plan's set puts drive ONLY on an owner elsewhere, so it can
  // only ever measure the re-weighting through the owner_*_elsewhere paths. These two exercise the
  // other two ways a drive row reaches a path, which is where a re-rank (not just a re-weight) shows
  // up: `drive` moving BELOW `loan` changes which source a path carrying both APPLIES, and that is
  // invisible unless a path has both to choose between on the non-owner side too.
  make("drive_at_subject_nonowner", "a non-owner drive row AT the subject: the drive path on the occupancy side", {
    tax: [taxRow()],
    drive: [personRow("d1", "JENNIFER", "HOWARD", SUBJECT, { dl_num: "K9999", dl_state: "KY" })],
  }),
  make("drive_and_loan_nonowner_at_subject", "non-owner drive+loan on one row: the re-RANK case, not just the re-weight", {
    tax: [taxRow()],
    drive: [personRow("d1", "JENNIFER", "HOWARD", SUBJECT, { dl_num: "K9999", dl_state: "KY" })],
    loan: [personRow("l1", "JENNIFER", "HOWARD", SUBJECT, { own_rent: "RENT", loan_amount: 500 })],
  }),
  // The control: identical to drive_and_loan_same_row with the drive row removed, i.e. the same
  // physical payday row read ONLY as the loan it is. The gap between the two is the whole cost of
  // the double-count, and comparing them before and after is what says how much of that cost the
  // re-weighting actually removes — as opposed to how much it was claimed to remove.
  make("loan_only_owner_elsewhere", "the control for the double-count: the same payday row read ONLY as loan", {
    tax: [taxRow()],
    loan: [personRow(OWNER_ID, "JOSIAH", "CORRELL", ELSEWHERE, { own_rent: "OWN", loan_amount: 500, employer: "ACME" })],
  }),
];
