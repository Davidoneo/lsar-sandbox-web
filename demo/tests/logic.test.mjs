import assert from "node:assert/strict";
import test from "node:test";

import {
  blankToNull,
  buildLcnHierarchy,
  flatFieldWidth,
  formatTableName,
  generateFlatLines,
  isNumericType,
  parseClipboardText,
  parseFlatRecord,
  rowKey,
  rowsToTsv,
  tablePrefix,
  timestampNow,
  valuesEquivalent,
} from "../logic.mjs";

test("fixed-width rules match the desktop application", () => {
  assert.equal(flatFieldWidth("VARCHAR(10)"), 10);
  assert.equal(flatFieldWidth("CHAR(1)"), 1);
  assert.equal(flatFieldWidth("NUMERIC(5, 2)"), 6);
  assert.equal(flatFieldWidth("NUMERIC(7, 0)"), 7);
  assert.equal(flatFieldWidth("numeric(6 , 3)"), 7);
  assert.equal(flatFieldWidth("TEXT"), 255);
  assert.equal(flatFieldWidth("INTEGER"), 20);
  assert.equal(flatFieldWidth(null), 20);
});

test("numeric detection and blank conversion match the desktop application", () => {
  for (const declaration of ["NUMERIC(5,2)", "INTEGER", "int", "REAL", "DECIMAL(3)", "DOUBLE", "FLOAT"]) {
    assert.equal(isNumericType(declaration), true, declaration);
  }
  for (const declaration of ["VARCHAR(8)", "CHAR(1)", "TEXT", "", null]) {
    assert.equal(isNumericType(declaration), false, String(declaration));
  }
  assert.equal(blankToNull(""), null);
  assert.equal(blankToNull("0"), "0");
  assert.equal(blankToNull(" "), " ");
});

test("numeric equivalence accepts SQLite normalization", () => {
  assert.equal(valuesEquivalent("abc", "abc", false), true);
  assert.equal(valuesEquivalent(null, "", false), true);
  assert.equal(valuesEquivalent(50, "0050.00", true), true);
  assert.equal(valuesEquivalent(50, "51", true), false);
  assert.equal(valuesEquivalent("50.0", "50", false), false);
  assert.equal(valuesEquivalent(null, "0", true), false);
});

test("clipboard parsing and TSV copy preserve spreadsheet shape", () => {
  assert.deepEqual(parseClipboardText("A\tB\r\nC\tD\r\n"), [["A", "B"], ["C", "D"]]);
  assert.deepEqual(parseClipboardText("single"), [["single"]]);
  assert.deepEqual(parseClipboardText(""), [[""]]);
  assert.equal(rowsToTsv([["A", "B", "C"], ["D", "E", "F"]], [0, 1], [0, 2]), "A\tC\nD\tF");
});

test("LCN hierarchy resolves explicit and longest-prefix parents", () => {
  const [group] = buildLcnHierarchy([
    ["E1", "A", "00", "P", "System", ""],
    ["E1", "AA", "00", "P", "Assembly", "MISSING"],
    ["E1", "AAA", "00", "P", "Part", ""],
  ]);
  assert.deepEqual(group.key, ["E1", "00", "P"]);
  assert.deepEqual(group.items, [
    { lcn: "A", name: "System", parent: null },
    { lcn: "AA", name: "Assembly", parent: "A" },
    { lcn: "AAA", name: "Part", parent: "AA" },
  ]);
});

test("flat-file parser honors the three-character prefix and field layout", () => {
  const schema = {
    table: "xb_item",
    lengths: [10, 18, 6],
    primaryKeys: ["eiac", "lcn"],
  };
  const cache = new Map([["XB", schema]]);
  const result = parseFlatRecord(`XB ${"E1".padEnd(10)}${"A".padEnd(18)}${"12.5".padEnd(6)}`, cache);
  assert.equal(result.skipped, false);
  assert.deepEqual(result.values, ["E1", "A", "12.5"]);
  assert.equal(parseFlatRecord("ZZ unknown", cache).skipped, true);
});

test("flat-file export pads nulls and truncates overlong values", () => {
  const lines = generateFlatLines([
    {
      table: "xb_item",
      layout: [
        { name: "eiac", width: 10 },
        { name: "lcn", width: 18 },
        { name: "qty", width: 6 },
        { name: "note", width: 5 },
      ],
      rows: [["E23456789012345", "A", 12.5, null]],
    },
  ]);
  assert.equal(lines[0], `XB ${"E234567890"}${"A".padEnd(18)}${"12.5".padEnd(6)}${"".padEnd(5)}`);
});

test("table labels, prefixes, keys, and timestamps are deterministic", () => {
  assert.equal(tablePrefix("xb_lcn_indenture"), "XB");
  assert.deepEqual(formatTableName("xb_lcn_indenture"), { display: "XB: lcn indenture", area: "X" });
  assert.equal(rowKey(["E1", "A"], ["eiac", "lcn"], ["eiac", "lcn"]), '["E1","A"]');
  assert.equal(timestampNow(new Date(2026, 7, 30, 12, 3, 4)), "2026-08-30 12:03:04");
});
