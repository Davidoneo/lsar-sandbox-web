export const MAX_GRID_ROWS = 50_000;

export const AUDIT_CREATE = ["CREATED_AT", "INSERTED_AT", "CREATION_DATE"];
export const AUDIT_UPDATE = ["UPDATED_AT", "MODIFIED_AT", "CHANGE_DATE", "LAST_UPDATE"];
export const AUDIT_USER_CREATE = ["CREATED_BY", "AUTHOR_ID"];
export const AUDIT_USER_UPDATE = ["UPDATED_BY", "LAST_MODIFIED_BY", "USER_ID"];
export const ALL_AUDIT_KWS = [
  ...AUDIT_CREATE,
  ...AUDIT_UPDATE,
  ...AUDIT_USER_CREATE,
  ...AUDIT_USER_UPDATE,
];

const AUDIT_SET = new Set(ALL_AUDIT_KWS);

export function isAuditColumn(name) {
  return AUDIT_SET.has(String(name || "").toUpperCase());
}

export function flatFieldWidth(declaredType) {
  const declaration = String(declaredType || "").toUpperCase();
  const match = declaration.match(/\((\d+)(?:\s*,\s*(\d+))?\)/);
  if (match) {
    const precision = Number(match[1]);
    const scale = Number(match[2] || 0);
    return scale > 0 ? precision + 1 : precision;
  }
  return declaration.includes("TEXT") ? 255 : 20;
}

export function isNumericType(declaredType) {
  const declaration = String(declaredType || "").toUpperCase();
  return ["NUMERIC", "INT", "REAL", "DECIMAL", "DOUBLE", "FLOAT"].some((part) =>
    declaration.includes(part),
  );
}

export function valuesEquivalent(databaseValue, fileValue, numeric) {
  const current = databaseValue == null ? "" : String(databaseValue);
  const incoming = fileValue == null ? "" : String(fileValue);
  if (current === incoming) return true;
  if (numeric && current && incoming) {
    const left = Number(current);
    const right = Number(incoming);
    return Number.isFinite(left) && Number.isFinite(right) && left === right;
  }
  return false;
}

export function blankToNull(value) {
  return value === "" ? null : value;
}

export function parseClipboardText(text) {
  const normalized = String(text ?? "").replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  const withoutFinalNewline = normalized.endsWith("\n") ? normalized.slice(0, -1) : normalized;
  if (withoutFinalNewline === "") return [[""]];
  return withoutFinalNewline.split("\n").map((line) => line.split("\t"));
}

export function rowsToTsv(sourceRows, rowIndices, columnIndices) {
  return rowIndices.map((rowIndex) => columnIndices
    .map((columnIndex) => String(sourceRows[rowIndex]?.[columnIndex] ?? ""))
    .join("\t"))
    .join("\n");
}

export function quoteIdentifier(identifier) {
  return `"${String(identifier).replaceAll('"', '""')}"`;
}

export function tablePrefix(tableName) {
  return String(tableName).split("_", 1)[0].toUpperCase();
}

export function formatTableName(tableName) {
  const separator = tableName.indexOf("_");
  if (separator === -1) {
    const display = tableName.toUpperCase();
    return { display, area: display[0] || "?" };
  }
  const prefix = tableName.slice(0, separator).toUpperCase();
  const label = tableName.slice(separator + 1).replaceAll("_", " ");
  return { display: `${prefix}: ${label}`, area: prefix[0] || "?" };
}

export function parseFlatRecord(line, schemaByPrefix) {
  const normalized = String(line).replace(/\r?\n$/, "");
  const prefix = normalized.slice(0, 2).trim().toUpperCase();
  const schema = schemaByPrefix.get(prefix);
  if (!schema || !schema.primaryKeys.length) return { prefix, skipped: true };

  const body = normalized.slice(3);
  let cursor = 0;
  const values = schema.lengths.map((width) => {
    const value = body.slice(cursor, cursor + width).trim();
    cursor += width;
    return value;
  });
  return { prefix, schema, values, skipped: false };
}

export function generateFlatLines(tableSpecs) {
  const lines = [];
  for (const spec of tableSpecs) {
    const prefix = tablePrefix(spec.table).padEnd(3, " ").slice(0, 3);
    for (const row of spec.rows) {
      let line = prefix;
      spec.layout.forEach(({ name, width }, index) => {
        const raw = Array.isArray(row) ? row[index] : row[name];
        const text = raw == null ? "" : String(raw);
        line += text.trim().padEnd(width, " ").slice(0, width);
      });
      lines.push(line);
    }
  }
  return lines;
}

export function buildLcnHierarchy(rows) {
  const grouped = new Map();
  for (const rawRow of rows) {
    const [rawEiac, rawLcn, rawAlc, rawType, rawName, rawParent] = rawRow;
    const key = [rawEiac, rawAlc, rawType].map((value) => String(value ?? ""));
    const serialized = JSON.stringify(key);
    if (!grouped.has(serialized)) grouped.set(serialized, { key, source: [] });
    grouped.get(serialized).source.push({
      lcn: String(rawLcn ?? ""),
      name: String(rawName ?? ""),
      parent: String(rawParent ?? ""),
    });
  }

  return [...grouped.values()].map(({ key, source }) => {
    const known = new Set(source.map(({ lcn }) => lcn));
    const items = source
      .sort((left, right) => left.lcn.localeCompare(right.lcn))
      .map((item) => {
        let parent = item.parent;
        if (!known.has(parent) || parent === item.lcn) {
          parent = [...known]
            .filter((candidate) => candidate !== item.lcn && item.lcn.startsWith(candidate))
            .sort((left, right) => right.length - left.length)[0] || "";
        }
        return { ...item, parent: parent || null };
      });
    return { key, items };
  });
}

export function timestampNow(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return [date.getFullYear(), pad(date.getMonth() + 1), pad(date.getDate())].join("-")
    + ` ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function rowKey(row, headers, primaryKeys) {
  return JSON.stringify(primaryKeys.map((key) => String(row[headers.indexOf(key)] ?? "").trim()));
}

export function rowsEqual(left, right) {
  if (!left || !right || left.length !== right.length) return false;
  return left.every((value, index) => String(value ?? "") === String(right[index] ?? ""));
}
