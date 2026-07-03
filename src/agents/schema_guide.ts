// Port of occupancy_engine/agents/schema_guide.py.
type Dict = Record<string, any>;

export const SCHEMA_GUIDE_QUERY = `
query AgentSchemaGuide {
  __schema {
    queryType {
      fields {
        name
        args { name type { kind name ofType { kind name ofType { kind name ofType { kind name } } } } }
        type { kind name ofType { kind name ofType { kind name ofType { kind name } } } }
      }
    }
    types {
      kind
      name
      fields {
        name
        args { name type { kind name ofType { kind name ofType { kind name ofType { kind name } } } } }
        type { kind name ofType { kind name ofType { kind name ofType { kind name } } } }
      }
      inputFields {
        name
        type { kind name ofType { kind name ofType { kind name ofType { kind name } } } }
      }
    }
  }
}
`;

const IMPORTANT_TYPES: ReadonlySet<string> = new Set([
  "Address",
  "Person",
  "SourceRecord",
  "Property",
  "Organization",
  "PersonAddressAssociation",
  "PropertyAddressAssociation",
  "PropertyPersonAssociation",
  "PersonOrganizationAssociation",
  "AddressConnection",
  "PersonConnection",
  "SourceRecordConnection",
  "PersonAddressAssociationConnection",
  "PropertyAddressAssociationConnection",
  "PropertyPersonAssociationConnection",
  "TaxRecord",
  "BaseRecord",
  "DriveRecord",
  "VoterRecord",
  "AutoRecord",
  "LoanRecord",
  "TraceRecord",
  "UtilityRecord",
]);

export function summarizeSchemaGuide(data: Dict): string {
  const schema: Dict = (data?.["__schema"] ?? {}) as Dict;
  if (!schema || Object.keys(schema).length === 0) {
    return fallbackSchemaGuide("introspection response did not include __schema");
  }
  const queryType: Dict = (schema["queryType"] ?? {}) as Dict;
  const queryFields: Dict[] = [...((queryType["fields"] ?? []) as Dict[])].sort((a, b) =>
    String(a?.["name"] ?? "").localeCompare(String(b?.["name"] ?? "")),
  );
  if (queryFields.length === 0) {
    return fallbackSchemaGuide("introspection response did not include query fields");
  }
  const typesByName = new Map<string, Dict>();
  for (const item of (schema["types"] ?? []) as Dict[]) {
    const name = item?.["name"];
    if (name) {
      typesByName.set(String(name), item);
    }
  }

  const lines: string[] = [
    "Use this schema guide for every GraphQL query. Do not invent root fields, arguments, or record fields.",
    "Important: address ids are Int values. Person/source ids are usually String values. Do not use GraphQL ID unless this guide shows it.",
    "Prefer neutral entity traversal first: resolveAddress, Address.personAssociations, Address.propertyAssociations, Person.addressAssociations, and sourceRecord for provenance.",
    "Use Address.sourceRecords(source: UTILITY, role: SERVICE_ADDRESS) for utility rows; utility is address-linked and often has no person association.",
    "Raw SourceRecord data is available for exact field inspection, but associations should be the default exploration path.",
    "Useful root Query fields:",
  ];
  for (const field of queryFields) {
    const name = String(field?.["name"] ?? "");
    if (name.startsWith("__")) {
      continue;
    }
    const args = ((field["args"] ?? []) as Dict[]).map((arg) => `${arg["name"]}: ${typeName(arg["type"])}`).join(", ");
    lines.push(`- ${name}(${args}) -> ${typeName(field["type"])}`);
  }

  for (const typeName_ of [...IMPORTANT_TYPES].sort()) {
    const typeInfo = typesByName.get(typeName_);
    if (!typeInfo) {
      continue;
    }
    const fields = (typeInfo["fields"] ?? []) as Dict[];
    if (fields.length === 0) {
      continue;
    }
    const rendered: string[] = [];
    for (const field of fields.slice(0, 60)) {
      const args = (field["args"] ?? []) as Dict[];
      let argText = "";
      if (args.length > 0) {
        argText = "(" + args.map((arg) => `${arg["name"]}: ${typeName(arg["type"])}`).join(", ") + ")";
      }
      rendered.push(`${field["name"]}${argText}: ${typeName(field["type"])}`);
    }
    lines.push(`${typeName_} fields: ` + rendered.join("; "));
  }

  const whereInputs = [...typesByName.values()].filter(
    (item) => String(item?.["name"] ?? "").endsWith("WhereInput") && item["inputFields"],
  );
  if (whereInputs.length > 0) {
    lines.push("Where input examples:");
    const sorted = whereInputs
      .sort((a, b) => String(a?.["name"] ?? "").localeCompare(String(b?.["name"] ?? "")))
      .slice(0, 20);
    for (const item of sorted) {
      const fields = ((item["inputFields"] ?? []) as Dict[]).slice(0, 30).map((f) => f["name"]).join(", ");
      lines.push(`- ${item["name"]}: ${fields}`);
    }
  }
  return lines.join("\n");
}

export function fallbackSchemaGuide(message = ""): string {
  const suffix = message ? ` Introspection failed: ${message}` : "";
  return (
    "Schema guide unavailable." +
    `${suffix} Use known safe entrypoints only: resolveAddress(query, zip), address(id: Int), ` +
    "person(id: String), searchAddresses(query, zip, limit), searchPeople(query, limit), and " +
    "sourceRecord(source, rowid). Prefer Address.personAssociations, Address.propertyAssociations, " +
    "and Person.addressAssociations. Use Address.sourceRecords(source: UTILITY, role: SERVICE_ADDRESS) " +
    "for utility rows. Fetch SourceRecord.data only when summaries/provenance are insufficient."
  );
}

function typeName(typeRef: Dict | null | undefined): string {
  if (!typeRef) {
    return "Unknown";
  }
  const kind = typeRef["kind"];
  const name = typeRef["name"];
  const ofType = typeRef["ofType"];
  if (kind === "NON_NULL") {
    return `${typeName(ofType)}!`;
  }
  if (kind === "LIST") {
    return `[${typeName(ofType)}]`;
  }
  return String(name ?? kind ?? "Unknown");
}
