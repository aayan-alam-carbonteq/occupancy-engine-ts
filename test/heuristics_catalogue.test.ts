import { describe, expect, test } from "bun:test";
import { heuristic_ids, reasoning_path_ids } from "../src/heuristics/atomic_eval.ts";
import { evaluate_evidence, get_heuristic_catalog, get_packet_catalog } from "../src/heuristics/index.ts";
import { SCORE_CASES } from "./support/score_cases.ts";

describe("catalogue after the voter removal", () => {
  test("23 atomic heuristics remain; the two voter-dependent ones are gone", () => {
    expect(heuristic_ids().length).toBe(23);
    expect(heuristic_ids()).not.toContain("voter_address_subject_analysis");
    expect(heuristic_ids()).not.toContain("drive_voter_conflict_same_person");
  });

  test("their three reasoning paths are gone with them", () => {
    for (const p of ["owner_voter_at_subject", "owner_voter_elsewhere", "nonowner_voter_at_subject"]) {
      expect(reasoning_path_ids()).not.toContain(p);
    }
  });

  test("legal_address_presence keeps 5 atomics and no longer claims voter", () => {
    const packet = get_packet_catalog().find((p: any) => p.id === "legal_address_presence") as any;
    expect(packet.atomic_heuristic_ids).toEqual([
      "drive_address_subject_analysis",
      "auto_address_subject_analysis",
      "owner_legal_records_conflict",
      "auto_only_owner_elsewhere_discount",
      "auto_at_subject_but_stronger_legal_elsewhere",
    ]);
    expect(packet.input_sources).toEqual(["drive", "auto", "tax"]);
  });

  test("no packet scope, gate, guidance or field ref mentions a dead source", () => {
    const text = JSON.stringify(get_packet_catalog()) + JSON.stringify(get_heuristic_catalog());
    for (const dead of ["voter", "criminal", "linkedin"]) {
      expect(text).not.toContain(dead);
    }
  });
});

/**
 * Removing atomics from a packet is only safe if no gate counts them. Measured against the
 * benchmark case set across commits d52460e (before) and this one (after): all 84 packet-gate
 * evaluations kept their decision, and legal_address_presence's RUNNABLE atomic count was
 * identical in every case — only the denominator moved, 7 -> 5. These tests pin the two properties
 * that made that true, so a future removal cannot quietly drop a packet below a threshold.
 */
describe("removing the two atomics did not move any packet gate", () => {
  test("legal_address_presence still gates on drive/auto FIELD evidence, not on how many atomics it holds", () => {
    const decisions = new Map<string, string>();
    for (const c of SCORE_CASES) {
      const report = evaluate_evidence(c.evidence) as unknown as Record<string, any>;
      const gate = (report["packet_gate_evaluations"] as any[]).find((g) => g.packet_id === "legal_address_presence");
      decisions.set(c.id, gate.decision);
    }
    // Runs exactly for the cases carrying a usable drive or auto row, and for no others. If the
    // gate had started counting atomics, the 7 -> 5 drop would show up here as a case flipping.
    expect(decisions.get("drive_only_owner_elsewhere")).toBe("run");
    expect(decisions.get("auto_only_owner_elsewhere")).toBe("run");
    expect(decisions.get("full_stack_absentee")).toBe("run");
    expect(decisions.get("drive_at_subject_nonowner")).toBe("run");
    expect(decisions.get("no_rows")).toBe("skip");
    expect(decisions.get("tax_only_mailing_elsewhere")).toBe("skip");
    expect(decisions.get("loan_only_owner_elsewhere")).toBe("skip");
    expect(decisions.get("utility_only_nonowner")).toBe("skip");
  });

  test("its field-presence diagnostics no longer report a permanently-zero voter_rows", () => {
    const c = SCORE_CASES.find((x) => x.id === "drive_only_owner_elsewhere")!;
    const report = evaluate_evidence(c.evidence) as unknown as Record<string, any>;
    const gate = (report["packet_gate_evaluations"] as any[]).find((g) => g.packet_id === "legal_address_presence");
    expect(Object.keys(gate.field_presence).sort()).toEqual([
      "auto_rows",
      "drive_rows",
      "usable_auto_person_address_rows",
      "usable_drive_person_address_rows",
    ]);
  });
});
