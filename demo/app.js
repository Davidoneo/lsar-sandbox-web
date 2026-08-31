import {
  AUDIT_CREATE,
  AUDIT_UPDATE,
  AUDIT_USER_CREATE,
  AUDIT_USER_UPDATE,
  MAX_GRID_ROWS,
  blankToNull,
  buildLcnHierarchy,
  flatFieldWidth,
  formatTableName,
  generateFlatLines,
  isAuditColumn,
  isNumericType,
  parseClipboardText,
  parseFlatRecord,
  quoteIdentifier,
  rowKey,
  rowsToTsv,
  rowsEqual,
  tablePrefix,
  timestampNow,
  valuesEquivalent,
} from "./logic.mjs?v=20260831-2";

const STORAGE_DB = "minimal-lsar-browser-demo";
const STORAGE_STORE = "databases";
const STORAGE_KEY = "active";
const DEMO_USER = "browser-demo";

const elements = Object.fromEntries([
  "loading-screen", "loading-message", "app", "table-tree", "active-db-name",
  "table-title", "table-search", "relaxed-mode", "relaxed-info", "show-audit",
  "save-changes", "relation-banner", "relation-description", "clear-relation",
  "grid-wrap", "row-status", "column-status", "grid-zoom", "zoom-label",
  "context-menu", "modal-backdrop", "modal", "modal-title", "modal-body",
  "modal-actions", "modal-close", "toast", "database-file", "flat-file",
  "mobile-tables", "sidebar",
].map((id) => [id, document.getElementById(id)]));

let SQL;
let db;
let dbName = "bike_example.db";
let tables = [];
let metadata = new Map();
let rowCounts = new Map();
let inboundRelations = new Map();
let currentTable = null;
let columns = [];
let rows = [];
let originalRows = [];
let selectedRow = -1;
let selectedColumn = -1;
let gridSelection = null;
let gridSelectionActive = false;
let draggingSelection = false;
let editingCell = false;
let undoStack = [];
let redoStack = [];
let invalidRows = new Set();
let invalidMessages = new Map();
let dirty = false;
let relationFilter = null;
let sortState = null;
let toastTimer;

function query(sql, parameters = []) {
  const statement = db.prepare(sql);
  const result = [];
  try {
    statement.bind(parameters);
    while (statement.step()) result.push(statement.getAsObject());
  } finally {
    statement.free();
  }
  return result;
}

function scalar(sql, parameters = [], fallback = 0) {
  const record = query(sql, parameters)[0];
  return record ? Object.values(record)[0] : fallback;
}

function cloneRows(source) {
  return source.map((row) => row.map((value) => value == null ? "" : String(value)));
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function setLoading(message) {
  elements["loading-message"].textContent = message;
}

function toast(message, error = false) {
  clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.classList.toggle("error", error);
  elements.toast.hidden = false;
  toastTimer = setTimeout(() => { elements.toast.hidden = true; }, error ? 6500 : 3500);
}

function setDirty(value = true) {
  dirty = value;
  elements["save-changes"].disabled = !currentTable || !dirty;
  updateStatus();
}

function updateStatus(filteredCount = null) {
  if (!currentTable) {
    elements["row-status"].textContent = "Select a table";
    elements["column-status"].textContent = "";
    return;
  }
  const shown = filteredCount == null ? rows.length : filteredCount;
  const total = relationFilter || dirty ? rows.length : (rowCounts.get(currentTable) ?? rows.length);
  let text = `Rows: ${shown.toLocaleString()}${shown !== total ? ` of ${total.toLocaleString()}` : ""}`;
  if (total > MAX_GRID_ROWS) text += ` · first ${MAX_GRID_ROWS.toLocaleString()} loaded`;
  if (dirty) text += " · unsaved changes";
  elements["row-status"].textContent = text;
  elements["row-status"].classList.toggle("dirty", dirty);
  const visible = columns.filter((column) => elements["show-audit"].checked || !isAuditColumn(column.name));
  const selected = selectedGridCoordinates();
  const selectedCount = selected.rowIndices.length * selected.columnIndices.length;
  const selectionText = selectedCount > 1
    ? ` · ${selectedCount.toLocaleString()} cells selected`
    : selectedCount === 1 ? ` · ${columns[selected.columnIndices[0]]?.name || "cell"} selected` : "";
  elements["column-status"].textContent = `${visible.length} columns${selectionText}${relationFilter ? " · relationship filter active" : ""}`;
}

function openStorage() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(STORAGE_DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORAGE_STORE);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
}

async function storageGet() {
  const storage = await openStorage();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = storage.transaction(STORAGE_STORE, "readonly");
      const request = transaction.objectStore(STORAGE_STORE).get(STORAGE_KEY);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  } finally {
    storage.close();
  }
}

async function storagePut(value) {
  const storage = await openStorage();
  try {
    await new Promise((resolve, reject) => {
      const transaction = storage.transaction(STORAGE_STORE, "readwrite");
      transaction.objectStore(STORAGE_STORE).put(value, STORAGE_KEY);
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
    });
  } finally {
    storage.close();
  }
}

function exportDatabaseBytes() {
  const bytes = db.export();
  // sql.js closes and reopens the connection while exporting, which resets
  // connection-local PRAGMAs. The desktop app enables this on every connection.
  db.run("PRAGMA foreign_keys = ON");
  return bytes;
}

async function persistDatabase() {
  const bytes = exportDatabaseBytes();
  await storagePut({ name: dbName, bytes, savedAt: new Date().toISOString(), version: 1 });
}

async function fetchText(path) {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`Could not load ${path} (${response.status})`);
  return response.text();
}

function schemaForTable(table) {
  const info = query(`PRAGMA table_info(${quoteIdentifier(table)})`)
    .sort((left, right) => Number(left.cid) - Number(right.cid))
    .map((column) => ({
      name: String(column.name),
      type: String(column.type || ""),
      required: Boolean(column.notnull) || Number(column.pk) > 0,
      primaryOrder: Number(column.pk) || 0,
      defaultValue: column.dflt_value,
    }));
  const primaryKeys = info.filter((column) => column.primaryOrder > 0)
    .sort((left, right) => left.primaryOrder - right.primaryOrder)
    .map((column) => column.name);
  const foreignKeyRows = query(`PRAGMA foreign_key_list(${quoteIdentifier(table)})`);
  const relationGroups = new Map();
  for (const foreignKey of foreignKeyRows) {
    const id = Number(foreignKey.id);
    if (!relationGroups.has(id)) relationGroups.set(id, { table: String(foreignKey.table), from: [], to: [] });
    const group = relationGroups.get(id);
    group.from[Number(foreignKey.seq)] = String(foreignKey.from);
    group.to[Number(foreignKey.seq)] = String(foreignKey.to);
  }
  return { columns: info, primaryKeys, outbound: [...relationGroups.values()] };
}

async function introspectDatabase() {
  setLoading("Reading LSAR tables and relationships…");
  tables = query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .map((record) => String(record.name));
  if (!tables.length) throw new Error("The database does not contain any application tables.");

  metadata = new Map();
  rowCounts = new Map();
  inboundRelations = new Map(tables.map((table) => [table, []]));
  for (const table of tables) {
    const meta = schemaForTable(table);
    metadata.set(table, meta);
    rowCounts.set(table, Number(scalar(`SELECT COUNT(*) FROM ${quoteIdentifier(table)}`)));
    for (const relation of meta.outbound) {
      if (!inboundRelations.has(relation.table)) inboundRelations.set(relation.table, []);
      inboundRelations.get(relation.table).push({ table, from: relation.from, to: relation.to });
    }
  }
}

function schemaByPrefix() {
  const cache = new Map();
  for (const table of tables) {
    const meta = metadata.get(table);
    const layoutColumns = meta.columns.filter((column) => !isAuditColumn(column.name));
    cache.set(tablePrefix(table).slice(0, 2), {
      table,
      columns: layoutColumns,
      lengths: layoutColumns.map((column) => flatFieldWidth(column.type)),
      primaryKeys: meta.primaryKeys,
      auditColumns: meta.columns.filter((column) => isAuditColumn(column.name)),
    });
  }
  return cache;
}

async function buildExampleDatabase() {
  setLoading("Creating the example database…");
  const [schema, example] = await Promise.all([fetchText("schema.sql"), fetchText("bike_example.txt")]);
  db = new SQL.Database();
  db.run("PRAGMA foreign_keys = ON");
  db.exec(schema);
  await introspectDatabase();
  importFlatText(example, false);
  dbName = "bike_example.db";
  await persistDatabase();
}

function renderTableTree() {
  const groups = new Map();
  for (const table of tables) {
    const formatted = formatTableName(table);
    if (!groups.has(formatted.area)) groups.set(formatted.area, []);
    groups.get(formatted.area).push({ table, label: formatted.display, count: rowCounts.get(table) || 0 });
  }
  elements["table-tree"].replaceChildren();
  for (const [area, items] of [...groups.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const details = document.createElement("details");
    details.className = "area-group";
    details.open = items.some(({ table }) => table === currentTable) || area === "X";
    const summary = document.createElement("summary");
    summary.textContent = `Area ${area}`;
    const list = document.createElement("div");
    list.className = "area-tables";
    for (const item of items) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `table-link${item.count ? "" : " empty"}${item.table === currentTable ? " active" : ""}`;
      button.dataset.table = item.table;
      button.title = `${item.label} — ${item.count.toLocaleString()} rows`;
      button.textContent = `${item.label} (${item.count.toLocaleString()})`;
      button.addEventListener("click", async () => {
        if (!confirmDiscard()) return;
        await selectTable(item.table);
        setMobileSidebar(false);
      });
      list.append(button);
    }
    details.append(summary, list);
    elements["table-tree"].append(details);
  }
}

function confirmDiscard() {
  return !dirty || window.confirm("Discard the unsaved changes in the current table?");
}

function relationSql(filter) {
  if (!filter) return { clause: "", parameters: [] };
  const pairs = filter.columns.map((column, index) => `${quoteIdentifier(column)} IS ?`);
  return { clause: ` WHERE ${pairs.join(" AND ")}`, parameters: filter.values.map(blankToNull) };
}

async function selectTable(table, filter = null) {
  if (!metadata.has(table)) throw new Error(`Table ${table} is not available in this database.`);
  currentTable = table;
  relationFilter = filter;
  columns = metadata.get(table).columns;
  const { clause, parameters } = relationSql(filter);
  const order = metadata.get(table).primaryKeys.map(quoteIdentifier).join(", ");
  const records = query(`SELECT * FROM ${quoteIdentifier(table)}${clause}${order ? ` ORDER BY ${order}` : ""} LIMIT ${MAX_GRID_ROWS}`, parameters);
  rows = records.map((record) => columns.map((column) => record[column.name] == null ? "" : String(record[column.name])));
  originalRows = cloneRows(rows);
  invalidRows.clear();
  invalidMessages.clear();
  selectedRow = -1;
  selectedColumn = -1;
  gridSelection = null;
  gridSelectionActive = false;
  undoStack = [];
  redoStack = [];
  sortState = null;
  elements["table-search"].value = "";
  elements["table-search"].disabled = false;
  elements["table-title"].textContent = formatTableName(table).display;
  elements["active-db-name"].textContent = dbName;
  elements["relation-banner"].hidden = !filter;
  elements["relation-description"].textContent = filter ? filter.description : "";
  setDirty(false);
  renderTableTree();
  renderGrid();
}

function visibleColumnEntries() {
  return columns.map((column, index) => ({ column, index }))
    .filter(({ column }) => elements["show-audit"].checked || !isAuditColumn(column.name));
}

function filteredRowEntries() {
  const search = elements["table-search"].value.trim().toLocaleLowerCase();
  return rows.map((row, index) => ({ row, index })).filter(({ row }) =>
    !search || row.some((value) => String(value ?? "").toLocaleLowerCase().includes(search)),
  );
}

function orderedSpan(order, start, end) {
  if (!order.length) return [];
  const startIndex = order.indexOf(start);
  const endIndex = order.indexOf(end);
  if (startIndex < 0 || endIndex < 0) return [];
  const low = Math.min(startIndex, endIndex);
  const high = Math.max(startIndex, endIndex);
  return order.slice(low, high + 1);
}

function selectedGridCoordinates() {
  if (!gridSelection) return { rowIndices: [], columnIndices: [] };
  const visibleRows = filteredRowEntries().map(({ index }) => index);
  const visibleColumns = visibleColumnEntries().map(({ index }) => index);
  if (gridSelection.mode === "rows") {
    return {
      rowIndices: orderedSpan(visibleRows, gridSelection.anchorRow, gridSelection.focusRow),
      columnIndices: visibleColumns,
    };
  }
  if (gridSelection.mode === "columns") {
    return {
      rowIndices: visibleRows,
      columnIndices: orderedSpan(visibleColumns, gridSelection.anchorColumn, gridSelection.focusColumn),
    };
  }
  return {
    rowIndices: orderedSpan(visibleRows, gridSelection.anchorRow, gridSelection.focusRow),
    columnIndices: orderedSpan(visibleColumns, gridSelection.anchorColumn, gridSelection.focusColumn),
  };
}

function selectionContains(rowIndex, columnIndex) {
  const { rowIndices, columnIndices } = selectedGridCoordinates();
  if (rowIndex >= 0 && !rowIndices.includes(rowIndex)) return false;
  if (columnIndex >= 0 && !columnIndices.includes(columnIndex)) return false;
  return rowIndex >= 0 || columnIndex >= 0;
}

function applySelectionClasses() {
  const table = elements["grid-wrap"].querySelector(".data-grid");
  if (!table) return;
  table.querySelectorAll(".grid-selected, .grid-active, .grid-heading-selected").forEach((element) => {
    element.classList.remove("grid-selected", "grid-active", "grid-heading-selected");
  });
  const { rowIndices, columnIndices } = selectedGridCoordinates();
  const rowSet = new Set(rowIndices);
  const columnSet = new Set(columnIndices);
  table.querySelectorAll("tbody td[data-row-index][data-column-index]").forEach((cell) => {
    const rowIndex = Number(cell.dataset.rowIndex);
    const columnIndex = Number(cell.dataset.columnIndex);
    cell.classList.toggle("grid-selected", rowSet.has(rowIndex) && columnSet.has(columnIndex));
    cell.classList.toggle("grid-active", rowIndex === selectedRow && columnIndex === selectedColumn);
  });
  if (gridSelection?.mode === "rows") {
    table.querySelectorAll("tbody tr").forEach((record) => {
      record.querySelector(".row-index")?.classList.toggle("grid-heading-selected", rowSet.has(Number(record.dataset.rowIndex)));
    });
  }
  if (gridSelection?.mode === "columns") {
    table.querySelectorAll("thead th[data-column-index]").forEach((heading) => {
      heading.classList.toggle("grid-heading-selected", columnSet.has(Number(heading.dataset.columnIndex)));
    });
  }
}

function setGridSelection(rowIndex, columnIndex, mode = "cells", extend = false) {
  const canExtend = extend && gridSelection?.mode === mode;
  if (canExtend) {
    if (rowIndex >= 0) gridSelection.focusRow = rowIndex;
    if (columnIndex >= 0) gridSelection.focusColumn = columnIndex;
  } else {
    gridSelection = {
      mode,
      anchorRow: rowIndex,
      focusRow: rowIndex,
      anchorColumn: columnIndex,
      focusColumn: columnIndex,
    };
  }
  if (rowIndex >= 0) selectedRow = rowIndex;
  if (columnIndex >= 0) selectedColumn = columnIndex;
  gridSelectionActive = true;
  applySelectionClasses();
  updateStatus(filteredRowEntries().length);
}

function selectAllGrid() {
  const visibleRows = filteredRowEntries().map(({ index }) => index);
  const visibleColumns = visibleColumnEntries().map(({ index }) => index);
  if (!visibleRows.length || !visibleColumns.length) return;
  gridSelection = {
    mode: "cells",
    anchorRow: visibleRows[0],
    focusRow: visibleRows.at(-1),
    anchorColumn: visibleColumns[0],
    focusColumn: visibleColumns.at(-1),
  };
  selectedRow = visibleRows[0];
  selectedColumn = visibleColumns[0];
  gridSelectionActive = true;
  applySelectionClasses();
  updateStatus(visibleRows.length);
}

function focusGridCell(rowIndex, columnIndex) {
  const input = elements["grid-wrap"].querySelector(`.cell-input[data-row-index="${rowIndex}"][data-column-index="${columnIndex}"]`);
  if (!input) return;
  input.focus({ preventScroll: true });
  input.scrollIntoView({ block: "nearest", inline: "nearest" });
  const length = input.value.length;
  input.setSelectionRange(length, length);
}

function moveGridSelection(rowDelta, columnDelta, extend = false) {
  const visibleRows = filteredRowEntries().map(({ index }) => index);
  const visibleColumns = visibleColumnEntries().map(({ index }) => index);
  if (!visibleRows.length || !visibleColumns.length) return;
  const currentRow = gridSelection?.focusRow >= 0 ? gridSelection.focusRow : visibleRows[0];
  const currentColumn = gridSelection?.focusColumn >= 0 ? gridSelection.focusColumn : visibleColumns[0];
  const rowPosition = Math.max(0, Math.min(visibleRows.length - 1, visibleRows.indexOf(currentRow) + rowDelta));
  const columnPosition = Math.max(0, Math.min(visibleColumns.length - 1, visibleColumns.indexOf(currentColumn) + columnDelta));
  const rowIndex = visibleRows[rowPosition];
  const columnIndex = visibleColumns[columnPosition];
  setGridSelection(rowIndex, columnIndex, "cells", extend);
  focusGridCell(rowIndex, columnIndex);
}

function gridRowsEqual(left, right) {
  return left.length === right.length && left.every((row, index) => rowsEqual(row, right[index]));
}

function recordUndo() {
  undoStack.push(cloneRows(rows));
  if (undoStack.length > 50) undoStack.shift();
  redoStack = [];
}

function restoreGridSnapshot(snapshot, targetStack) {
  if (!snapshot) return;
  targetStack.push(cloneRows(rows));
  rows = cloneRows(snapshot);
  invalidRows.clear();
  invalidMessages.clear();
  selectedRow = Math.min(Math.max(selectedRow, 0), rows.length - 1);
  setDirty(!gridRowsEqual(rows, originalRows));
  renderGrid();
}

function undoGrid() {
  restoreGridSnapshot(undoStack.pop(), redoStack);
}

function redoGrid() {
  restoreGridSnapshot(redoStack.pop(), undoStack);
}

function originalGridKeys() {
  const primaryKeys = metadata.get(currentTable)?.primaryKeys || [];
  if (!primaryKeys.length) return null;
  const headers = columns.map((column) => column.name);
  return {
    headers,
    primaryKeys,
    keys: new Set(originalRows.map((original) => rowKey(original, headers, primaryKeys))),
  };
}

function rowIsNew(row, originals) {
  if (!originals) return false;
  return !originals.keys.has(rowKey(row, originals.headers, originals.primaryKeys));
}

function renderGrid() {
  if (!currentTable) return;
  const shownColumns = visibleColumnEntries();
  const shownRows = filteredRowEntries();
  const originalKeys = originalGridKeys();
  const table = document.createElement("table");
  table.className = "data-grid";
  const head = document.createElement("thead");
  const headingRow = document.createElement("tr");
  const corner = document.createElement("th");
  corner.className = "row-index";
  corner.textContent = "#";
  corner.title = "Select all visible cells";
  corner.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    selectAllGrid();
  });
  headingRow.append(corner);
  for (const { column, index } of shownColumns) {
    const heading = document.createElement("th");
    heading.dataset.columnIndex = String(index);
    heading.classList.toggle("required-column", column.required);
    heading.textContent = column.name;
    heading.title = `${column.name} — ${column.type || "untyped"}${column.primaryOrder ? " — primary key" : ""}`;
    heading.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      const firstRow = shownRows[0]?.index ?? -1;
      setGridSelection(firstRow, index, "columns", event.shiftKey);
    });
    heading.addEventListener("dblclick", () => sortRows(index, sortState?.column === index && sortState.direction === "asc" ? "desc" : "asc"));
    heading.addEventListener("contextmenu", (event) => showContextMenu(event, -1, index));
    headingRow.append(heading);
  }
  head.append(headingRow);
  table.append(head);

  const body = document.createElement("tbody");
  for (const { row, index: rowIndex } of shownRows) {
    const tr = document.createElement("tr");
    tr.dataset.rowIndex = String(rowIndex);
    tr.classList.toggle("new-row", rowIsNew(row, originalKeys));
    tr.classList.toggle("invalid-row", invalidRows.has(rowIndex));
    const rowHeading = document.createElement("td");
    rowHeading.className = "row-index";
    rowHeading.textContent = String(rowIndex + 1);
    rowHeading.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      setGridSelection(rowIndex, shownColumns[0]?.index ?? -1, "rows", event.shiftKey);
      draggingSelection = true;
    });
    rowHeading.addEventListener("pointerenter", (event) => {
      if (draggingSelection && (event.buttons & 1)) setGridSelection(rowIndex, shownColumns[0]?.index ?? -1, "rows", true);
    });
    rowHeading.addEventListener("contextmenu", (event) => showContextMenu(event, rowIndex, -1));
    tr.append(rowHeading);
    for (const { column, index: columnIndex } of shownColumns) {
      const td = document.createElement("td");
      td.dataset.rowIndex = String(rowIndex);
      td.dataset.columnIndex = String(columnIndex);
      td.classList.toggle("required-column", column.required);
      const input = document.createElement("input");
      input.className = "cell-input";
      input.autocomplete = "off";
      input.value = row[columnIndex] ?? "";
      input.dataset.rowIndex = String(rowIndex);
      input.dataset.columnIndex = String(columnIndex);
      input.setAttribute("aria-label", `${column.name}, row ${rowIndex + 1}`);
      td.addEventListener("pointerdown", (event) => {
        if (event.button !== 0) return;
        editingCell = event.detail > 1;
        setGridSelection(rowIndex, columnIndex, "cells", event.shiftKey);
        draggingSelection = true;
      });
      td.addEventListener("pointerenter", (event) => {
        if (draggingSelection && (event.buttons & 1)) setGridSelection(rowIndex, columnIndex, "cells", true);
      });
      input.addEventListener("focus", () => {
        if (!selectionContains(rowIndex, columnIndex)) setGridSelection(rowIndex, columnIndex);
      });
      input.addEventListener("pointerup", (event) => {
        if (!editingCell) {
          event.preventDefault();
          input.select();
        }
      });
      input.addEventListener("dblclick", () => { editingCell = true; });
      input.addEventListener("beforeinput", () => {
        if (input.dataset.undoRecorded !== "true") {
          recordUndo();
          input.dataset.undoRecorded = "true";
        }
        editingCell = true;
      });
      input.addEventListener("input", () => {
        rows[rowIndex][columnIndex] = input.value;
        setDirty(true);
      });
      input.addEventListener("blur", () => {
        delete input.dataset.undoRecorded;
        editingCell = false;
      });
      input.addEventListener("contextmenu", (event) => showContextMenu(event, rowIndex, columnIndex));
      td.append(input);
      tr.append(td);
    }
    body.append(tr);
  }
  table.append(body);
  elements["grid-wrap"].replaceChildren(table);
  applySelectionClasses();
  updateStatus(shownRows.length);
}

function sortRows(columnIndex, direction) {
  rows.sort((left, right) => {
    const a = String(left[columnIndex] ?? "");
    const b = String(right[columnIndex] ?? "");
    const numeric = isNumericType(columns[columnIndex].type);
    const comparison = numeric && a !== "" && b !== "" ? Number(a) - Number(b) : a.localeCompare(b, undefined, { numeric: true });
    return direction === "desc" ? -comparison : comparison;
  });
  sortState = { column: columnIndex, direction };
  selectedRow = -1;
  selectedColumn = columnIndex;
  gridSelection = null;
  invalidRows.clear();
  invalidMessages.clear();
  renderGrid();
}

function insertRow(offset) {
  recordUndo();
  const blank = columns.map(() => "");
  const position = selectedRow < 0 ? rows.length : Math.max(0, selectedRow + offset);
  rows.splice(position, 0, blank);
  invalidRows.clear();
  invalidMessages.clear();
  setDirty(true);
  renderGrid();
  setGridSelection(position, Math.max(0, selectedColumn), "rows");
}

function deleteSelectedRows() {
  if (selectedRow < 0 || selectedRow >= rows.length) return toast("Select a row first.", true);
  const selected = gridSelection?.mode === "rows" ? selectedGridCoordinates().rowIndices : [selectedRow];
  recordUndo();
  [...selected].sort((left, right) => right - left).forEach((rowIndex) => rows.splice(rowIndex, 1));
  invalidRows.clear();
  invalidMessages.clear();
  selectedRow = Math.min(Math.min(...selected), rows.length - 1);
  setDirty(true);
  renderGrid();
  if (selectedRow >= 0) setGridSelection(selectedRow, Math.max(0, selectedColumn), "rows");
}

function clearSelectedCells() {
  const { rowIndices, columnIndices } = selectedGridCoordinates();
  if (!rowIndices.length || !columnIndices.length) return toast("Select one or more cells first.", true);
  recordUndo();
  rowIndices.forEach((rowIndex) => columnIndices.forEach((columnIndex) => { rows[rowIndex][columnIndex] = ""; }));
  setDirty(true);
  renderGrid();
}

function selectedGridText() {
  const { rowIndices, columnIndices } = selectedGridCoordinates();
  return rowsToTsv(rows, rowIndices, columnIndices);
}

async function copyGridSelection() {
  const text = selectedGridText();
  if (!text && !selectedGridCoordinates().rowIndices.length) return toast("Select one or more cells first.", true);
  try {
    await navigator.clipboard.writeText(text);
    const { rowIndices, columnIndices } = selectedGridCoordinates();
    toast(`Copied ${rowIndices.length * columnIndices.length} cell${rowIndices.length * columnIndices.length === 1 ? "" : "s"}.`);
  } catch {
    toast("Clipboard access was blocked by the browser. Use Ctrl+C instead.", true);
  }
}

function applyPasteMatrix(matrix, mode) {
  if (!matrix.length || !matrix.some((record) => record.length)) return;
  const visibleColumns = visibleColumnEntries().map(({ index }) => index);
  const startColumnPosition = Math.max(0, visibleColumns.indexOf(selectedColumn));
  const targetColumns = visibleColumns.slice(startColumnPosition, startColumnPosition + Math.max(...matrix.map((record) => record.length)));
  if (!targetColumns.length) return toast("No visible destination column is available.", true);
  recordUndo();
  const targetRows = [];
  if (mode === "insert") {
    const insertion = selectedRow >= 0 ? selectedRow : rows.length;
    const blanks = matrix.map(() => columns.map(() => ""));
    rows.splice(insertion, 0, ...blanks);
    matrix.forEach((record, rowOffset) => {
      const rowIndex = insertion + rowOffset;
      targetRows.push(rowIndex);
      record.forEach((value, columnOffset) => {
        const columnIndex = targetColumns[columnOffset];
        if (columnIndex != null) rows[rowIndex][columnIndex] = value;
      });
    });
  } else {
    const startRow = selectedRow >= 0 ? selectedRow : 0;
    matrix.forEach((record, rowOffset) => {
      let rowIndex = startRow + rowOffset;
      if (rowIndex >= rows.length) {
        rowIndex = rows.length;
        rows.push(columns.map(() => ""));
      }
      targetRows.push(rowIndex);
      record.forEach((value, columnOffset) => {
        const columnIndex = targetColumns[columnOffset];
        if (columnIndex != null) rows[rowIndex][columnIndex] = value;
      });
    });
  }
  invalidRows.clear();
  invalidMessages.clear();
  setDirty(true);
  renderGrid();
  gridSelection = {
    mode: "cells",
    anchorRow: targetRows[0],
    focusRow: targetRows.at(-1),
    anchorColumn: targetColumns[0],
    focusColumn: targetColumns.at(-1),
  };
  selectedRow = targetRows[0];
  selectedColumn = targetColumns[0];
  applySelectionClasses();
  updateStatus(filteredRowEntries().length);
}

function showPasteChoice(matrix) {
  const description = document.createElement("p");
  description.textContent = `${matrix.length} clipboard rows detected. Choose how to place them in the grid.`;
  openModal("Paste Options", description, [
    modalButton("Cancel", "secondary-button", closeModal),
    modalButton("Overwrite Existing Cells", "secondary-button", () => { closeModal(); applyPasteMatrix(matrix, "overwrite"); }),
    modalButton("Insert as New Rows", "primary-button", () => { closeModal(); applyPasteMatrix(matrix, "insert"); }),
  ]);
}

function handleGridPaste(text, forcedMode = null) {
  const matrix = parseClipboardText(text);
  if (!forcedMode && matrix.length > 1) showPasteChoice(matrix);
  else applyPasteMatrix(matrix, forcedMode || "overwrite");
}

async function pasteFromClipboard(mode) {
  try {
    handleGridPaste(await navigator.clipboard.readText(), mode);
  } catch {
    toast("Clipboard access was blocked by the browser. Focus a cell and use Ctrl+V instead.", true);
  }
}

function addInvalidMessage(messages, rowIndex, message) {
  if (!messages.has(rowIndex)) messages.set(rowIndex, new Set());
  messages.get(rowIndex).add(message);
}

function friendlyDatabaseError(error) {
  const message = String(error?.message || error || "Database validation failed.");
  if (message.includes("FOREIGN KEY constraint failed")) return "broken foreign-key reference";
  if (message.includes("UNIQUE constraint failed")) return "duplicate value violates a unique key";
  if (message.includes("NOT NULL constraint failed")) return "a required value is missing";
  if (message.includes("CHECK constraint failed")) return "a database format rule was not satisfied";
  return message;
}

function showSaveErrors(messages) {
  invalidMessages = new Map(messages);
  invalidRows = new Set(messages.keys());
  if (elements["table-search"].value) elements["table-search"].value = "";
  renderGrid();
  const wrapper = document.createElement("div");
  wrapper.className = "save-error-details";
  const intro = document.createElement("p");
  intro.innerHTML = `<strong>${messages.size} ${messages.size === 1 ? "row contains" : "rows contain"} fatal errors.</strong> Nothing was saved. The affected rows are highlighted in orange.`;
  const list = document.createElement("ol");
  for (const [rowIndex, rowMessages] of [...messages].sort(([left], [right]) => left - right).slice(0, 30)) {
    const item = document.createElement("li");
    item.value = rowIndex + 1;
    item.textContent = [...rowMessages].join("; ");
    list.append(item);
  }
  if (messages.size > 30) {
    const remainder = document.createElement("p");
    remainder.textContent = `The first 30 rows are listed; all ${messages.size} affected rows are highlighted in the grid.`;
    wrapper.append(intro, list, remainder);
  } else {
    wrapper.append(intro, list);
  }
  openModal("Save Aborted", wrapper, [modalButton("Return to Grid", "primary-button", closeModal)]);
}

function showSaveEngineError(message) {
  showErrorDialog("Save Aborted", message, "Nothing was saved.", "Return to Grid");
}

function showErrorDialog(title, message, intro = "The operation was not completed.", buttonText = "Close") {
  openModal(title, `<p><strong>${escapeHtml(intro)}</strong></p><p>${escapeHtml(message)}</p>`, [modalButton(buttonText, "primary-button", closeModal)]);
}

function prepareRowsForSave() {
  const meta = metadata.get(currentTable);
  if (!meta.primaryKeys.length) throw new Error("This table has no primary key and cannot be edited safely.");
  const headers = columns.map((column) => column.name);
  const keys = new Set();
  const prepared = [];
  const errors = new Map();
  rows.forEach((row, rowIndex) => {
    const normalized = row.map((value) => String(value ?? "").trim());
    if (!normalized.some(Boolean)) return;
    for (const key of meta.primaryKeys) {
      const index = columns.findIndex((column) => column.name === key);
      if (normalized[index] === "") addInvalidMessage(errors, rowIndex, `primary key ${key} is required`);
    }
    for (const [columnIndex, column] of columns.entries()) {
      const value = normalized[columnIndex];
      if (column.required && !column.primaryOrder && !isAuditColumn(column.name) && value === "") {
        addInvalidMessage(errors, rowIndex, `${column.name} is required`);
      }
      if (!elements["relaxed-mode"].checked) {
        const match = column.type.match(/\(\s*(\d+)/);
        const width = match ? flatFieldWidth(column.type) : null;
        if (width != null && value.length > width) {
          addInvalidMessage(errors, rowIndex, `${column.name} exceeds ${width} characters`);
        }
      }
    }
    const key = rowKey(normalized, headers, meta.primaryKeys);
    if (keys.has(key)) {
      addInvalidMessage(errors, rowIndex, "duplicate primary key");
    }
    keys.add(key);
    if (!errors.has(rowIndex)) prepared.push({ rowIndex, row: normalized, key });
  });
  return { prepared, headers, meta, errors };
}

function applyAuditValues(row, original, changed) {
  if (!changed) return;
  const now = timestampNow();
  const isNew = !original;
  const userEditedAudit = new Set();
  if (original) {
    columns.forEach((column, index) => {
      if (isAuditColumn(column.name) && row[index] !== original[index]) userEditedAudit.add(column.name.toUpperCase());
    });
  }
  columns.forEach((column, index) => {
    const upper = column.name.toUpperCase();
    if (!isAuditColumn(column.name) || userEditedAudit.has(upper)) return;
    if (AUDIT_USER_CREATE.includes(upper)) row[index] = isNew || !row[index] ? DEMO_USER : original[index];
    else if (AUDIT_USER_UPDATE.includes(upper)) row[index] = changed || isNew || !row[index] ? DEMO_USER : original[index];
    else if (AUDIT_CREATE.includes(upper)) row[index] = isNew || !row[index] ? now : original[index];
    else if (AUDIT_UPDATE.includes(upper)) row[index] = changed || isNew || !row[index] ? now : original[index];
  });
}

async function saveChanges() {
  if (!currentTable || !dirty) return;
  let saveData;
  try {
    saveData = prepareRowsForSave();
  } catch (error) {
    return showSaveEngineError(error.message);
  }
  const { prepared, headers, meta, errors } = saveData;
  invalidRows.clear();
  invalidMessages = new Map(errors);
  const normalizedOriginal = originalRows.map((row) => row.map((value) => String(value ?? "").trim()));
  const originalMap = new Map(normalizedOriginal.map((row) => [rowKey(row, headers, meta.primaryKeys), row]));
  const seenKeys = new Set(prepared.map(({ key }) => key));
  const keyWhere = meta.primaryKeys.map((key) => `${quoteIdentifier(key)} IS ?`).join(" AND ");
  let inserted = 0;
  let updated = 0;
  let deleted = 0;
  db.run("PRAGMA foreign_keys = ON");
  db.run("BEGIN");
  try {
    // Match the desktop order: inserts/updates first, removals afterwards.
    for (const { key, row, rowIndex } of prepared) {
      const original = originalMap.get(key);
      const changed = !original || !rowsEqual(row, original);
      if (!changed) continue;
      applyAuditValues(row, original, true);
      const values = row.map(blankToNull);
      try {
        if (!original) {
          db.run(
            `INSERT INTO ${quoteIdentifier(currentTable)} (${headers.map(quoteIdentifier).join(", ")}) VALUES (${headers.map(() => "?").join(", ")})`,
            values,
          );
          inserted += 1;
        } else {
          const setColumns = headers.filter((name) => !meta.primaryKeys.includes(name));
          const setValues = setColumns.map((name) => values[headers.indexOf(name)]);
          const keyValues = meta.primaryKeys.map((name) => blankToNull(original[headers.indexOf(name)]));
          db.run(
            `UPDATE ${quoteIdentifier(currentTable)} SET ${setColumns.map((name) => `${quoteIdentifier(name)} = ?`).join(", ")} WHERE ${keyWhere}`,
            [...setValues, ...keyValues],
          );
          updated += 1;
        }
      } catch (error) {
        addInvalidMessage(invalidMessages, rowIndex, friendlyDatabaseError(error));
      }
    }
    if (invalidMessages.size) {
      db.run("ROLLBACK");
      db.run("PRAGMA foreign_keys = ON");
      showSaveErrors(invalidMessages);
      return;
    }
    for (const [key, original] of originalMap) {
      if (seenKeys.has(key)) continue;
      const keyValues = meta.primaryKeys.map((name) => blankToNull(original[headers.indexOf(name)]));
      try {
        db.run(`DELETE FROM ${quoteIdentifier(currentTable)} WHERE ${keyWhere}`, keyValues);
        deleted += 1;
      } catch {
        throw new Error("Cannot delete rows. They are referenced as parent keys in another table (relational integrity violated).");
      }
    }
    const violations = query("PRAGMA foreign_key_check");
    if (violations.length) throw new Error(`Foreign-key validation failed (${violations.length} violation${violations.length === 1 ? "" : "s"}).`);
    db.run("COMMIT");
    await persistDatabase();
    rowCounts.set(currentTable, Number(scalar(`SELECT COUNT(*) FROM ${quoteIdentifier(currentTable)}`)));
    const table = currentTable;
    const filter = relationFilter;
    await selectTable(table, filter);
    if (inserted || updated || deleted) toast(`Saved locally: ${inserted} inserted, ${updated} updated, ${deleted} deleted.`);
    else toast("No changes detected.");
  } catch (error) {
    try { db.run("ROLLBACK"); } catch { /* transaction already closed */ }
    db.run("PRAGMA foreign_keys = ON");
    renderGrid();
    showSaveEngineError(error.message);
  }
}

function existingRecord(spec, values) {
  const indexes = spec.primaryKeys.map((key) => spec.columns.findIndex((column) => column.name === key));
  const keyValues = indexes.map((index) => blankToNull(values[index]));
  const clause = spec.primaryKeys.map((key) => `${quoteIdentifier(key)} IS ?`).join(" AND ");
  return query(`SELECT * FROM ${quoteIdentifier(spec.table)} WHERE ${clause} LIMIT 1`, keyValues)[0] || null;
}

function importFlatText(text, showResult = true) {
  const cache = schemaByPrefix();
  const counts = { inserted: 0, updated: 0, unchanged: 0, skipped: 0 };
  db.run("PRAGMA foreign_keys = OFF");
  db.run("BEGIN");
  try {
    for (const [lineIndex, line] of String(text).split(/\r?\n/).entries()) {
      if (!line.trim()) continue;
      const parsed = parseFlatRecord(line, cache);
      if (parsed.skipped) {
        counts.skipped += 1;
        continue;
      }
      try {
        const spec = parsed.schema;
        const current = existingRecord(spec, parsed.values);
        const changed = current && spec.columns.some((column, index) =>
          !valuesEquivalent(current[column.name], parsed.values[index], isNumericType(column.type)),
        );
        const now = timestampNow();
        if (!current) {
          const names = spec.columns.map((column) => column.name);
          const values = parsed.values.map(blankToNull);
          for (const audit of spec.auditColumns) {
            names.push(audit.name);
            const upper = audit.name.toUpperCase();
            values.push(AUDIT_CREATE.includes(upper) || AUDIT_UPDATE.includes(upper) ? now : DEMO_USER);
          }
          db.run(
            `INSERT INTO ${quoteIdentifier(spec.table)} (${names.map(quoteIdentifier).join(", ")}) VALUES (${names.map(() => "?").join(", ")})`,
            values,
          );
          counts.inserted += 1;
        } else if (changed) {
          const dataColumns = spec.columns.filter((column) => !spec.primaryKeys.includes(column.name));
          const names = dataColumns.map((column) => column.name);
          const values = dataColumns.map((column) => blankToNull(parsed.values[spec.columns.indexOf(column)]));
          for (const audit of spec.auditColumns) {
            const upper = audit.name.toUpperCase();
            if (AUDIT_UPDATE.includes(upper) || AUDIT_USER_UPDATE.includes(upper)) {
              names.push(audit.name);
              values.push(AUDIT_UPDATE.includes(upper) ? now : DEMO_USER);
            }
          }
          const where = spec.primaryKeys.map((key) => `${quoteIdentifier(key)} IS ?`).join(" AND ");
          const keyValues = spec.primaryKeys.map((key) => parsed.values[spec.columns.findIndex((column) => column.name === key)]);
          if (names.length) {
            db.run(
              `UPDATE ${quoteIdentifier(spec.table)} SET ${names.map((name) => `${quoteIdentifier(name)} = ?`).join(", ")} WHERE ${where}`,
              [...values, ...keyValues],
            );
          }
          counts.updated += 1;
        } else {
          counts.unchanged += 1;
        }
      } catch (error) {
        throw new Error(`Line ${lineIndex + 1} (${parsed.prefix} record): ${error.message}`);
      }
    }
    const violations = query("PRAGMA foreign_key_check");
    if (violations.length) throw new Error(`Import would create ${violations.length} foreign-key violation${violations.length === 1 ? "" : "s"}.`);
    db.run("COMMIT");
    if (showResult) toast(`Import complete: ${counts.inserted} inserted, ${counts.updated} updated, ${counts.unchanged} unchanged, ${counts.skipped} skipped.`);
    return counts;
  } catch (error) {
    try { db.run("ROLLBACK"); } catch { /* transaction already closed */ }
    throw error;
  } finally {
    db.run("PRAGMA foreign_keys = ON");
  }
}

function downloadBytes(bytes, filename, type) {
  const blob = new Blob([bytes], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function downloadDatabase() {
  const filename = dbName.replace(/\.(db|sqlite|sqlite3)$/i, "") + "-browser.db";
  downloadBytes(exportDatabaseBytes(), filename, "application/vnd.sqlite3");
  toast("Database downloaded. It can be opened by the desktop application.");
}

function exportTables(selectedTables) {
  const specifications = selectedTables.map((table) => {
    const layout = metadata.get(table).columns.filter((column) => !isAuditColumn(column.name))
      .map((column) => ({ name: column.name, width: flatFieldWidth(column.type) }));
    const records = query(`SELECT ${layout.map(({ name }) => quoteIdentifier(name)).join(", ")} FROM ${quoteIdentifier(table)}`);
    return { table, layout, rows: records };
  });
  const output = generateFlatLines(specifications);
  downloadBytes(`${output.join("\n")}${output.length ? "\n" : ""}`, "lsar_export.txt", "text/plain;charset=utf-8");
  toast(`Exported ${output.length.toLocaleString()} records from ${selectedTables.length} tables.`);
}

function modalButton(label, className, handler) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.textContent = label;
  button.addEventListener("click", handler);
  return button;
}

function openModal(title, content, actions = [], wide = false) {
  elements["modal-title"].textContent = title;
  elements["modal-body"].replaceChildren();
  if (typeof content === "string") elements["modal-body"].innerHTML = content;
  else elements["modal-body"].append(content);
  elements["modal-actions"].replaceChildren(...actions);
  elements.modal.classList.toggle("wide", wide);
  elements["modal-backdrop"].hidden = false;
}

function closeModal() {
  elements["modal-backdrop"].hidden = true;
  elements.modal.classList.remove("wide");
}

function showExportDialog() {
  const wrapper = document.createElement("div");
  wrapper.className = "export-list";
  const intro = document.createElement("p");
  intro.textContent = "Select the LSAR tables to export in the same fixed-width format used by the desktop application.";
  wrapper.append(intro);
  const byArea = new Map();
  for (const table of tables) {
    const area = formatTableName(table).area;
    if (!byArea.has(area)) byArea.set(area, []);
    byArea.get(area).push(table);
  }
  for (const [area, areaTables] of byArea) {
    const block = document.createElement("div");
    block.className = "export-area";
    const strong = document.createElement("strong");
    strong.textContent = `Area ${area}`;
    block.append(strong);
    for (const table of areaTables) {
      const label = document.createElement("label");
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.value = table;
      checkbox.checked = (rowCounts.get(table) || 0) > 0;
      label.append(checkbox, ` ${formatTableName(table).display} (${(rowCounts.get(table) || 0).toLocaleString()})`);
      block.append(label);
    }
    wrapper.append(block);
  }
  const cancel = modalButton("Cancel", "secondary-button", closeModal);
  const save = modalButton("Export .txt", "primary-button", () => {
    const selected = [...wrapper.querySelectorAll("input:checked")].map((input) => input.value);
    if (!selected.length) return toast("Select at least one table.", true);
    closeModal();
    exportTables(selected);
  });
  openModal("Export Fixed-Width LSAR File", wrapper, [cancel, save]);
}

function showInfo() {
  openModal("Browser Demo Information", `
    <p>This is the real Minimal LSAR data model running locally in your browser through SQLite. It uses the same <strong>103-table schema</strong>, example dataset, validation rules, relationships, LCN hierarchy, and fixed-width import/export logic as the desktop project.</p>
    <p><strong>Grid controls:</strong> click and drag, or Shift-click, to select a range. Ctrl+C/Cmd+C copies tab-separated cells; Ctrl+V/Cmd+V pastes them and asks whether multiple rows should be inserted or overwritten. Use arrows to move, Delete to clear, Ctrl+Z/Cmd+Z to undo, and double-click or F2 to edit within a cell.</p>
    <p>Your copy is private to this browser profile. Nothing is uploaded to lsarstudio.com, and another visitor receives a separate database. <strong>Save Changes</strong> writes to browser storage; <strong>Download Database</strong> creates a normal SQLite file that you can retain or open with the desktop application.</p>
    <p>A web page cannot silently overwrite an arbitrary file on your computer. This is why replacing the local <code>.db</code> file is an explicit download. Clearing site data or using a private window removes that browser's saved copy.</p>
  `, [modalButton("Close", "primary-button", closeModal)]);
}

function showRelaxedInfo() {
  openModal("Relaxed Mode", `
    <p>Normal mode checks declared MIL-STD field lengths before saving. Relaxed Mode allows longer text values for experimentation.</p>
    <p>Primary keys, required values, unique constraints, SQL types, and foreign-key relationships are still enforced. Imported and exported fixed-width files always use the official field widths.</p>
  `, [modalButton("Close", "primary-button", closeModal)]);
}

function renderLcnItems(items, key) {
  const byParent = new Map();
  for (const item of items) {
    const parent = item.parent || "";
    if (!byParent.has(parent)) byParent.set(parent, []);
    byParent.get(parent).push(item);
  }
  const walk = (parent, seen = new Set()) => {
    const list = document.createElement("ul");
    list.className = "lcn-tree";
    for (const item of byParent.get(parent) || []) {
      if (seen.has(item.lcn)) continue;
      const li = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = `${item.lcn}${item.name ? ` — ${item.name}` : ""}`;
      button.addEventListener("click", async () => {
        closeModal();
        await selectTable("xb_lcn_indentured_item", {
          columns: ["eiacodxa", "lsaconxb", "altlcnxb", "lcntypxb"],
          values: [key[0], item.lcn, key[1], key[2]],
          description: `LCN ${item.lcn} · EIAC ${key[0]} · ALC ${key[1]} · type ${key[2]}`,
        });
      });
      li.append(button);
      const nextSeen = new Set(seen).add(item.lcn);
      const children = walk(item.lcn, nextSeen);
      if (children.childElementCount) li.append(children);
      list.append(li);
    }
    return list;
  };
  const roots = items.filter((item) => !item.parent).map((item) => item.lcn);
  const container = document.createElement("div");
  for (const root of roots) {
    const item = items.find((candidate) => candidate.lcn === root);
    const rootList = document.createElement("ul");
    rootList.className = "lcn-tree";
    const li = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = `${item.lcn}${item.name ? ` — ${item.name}` : ""}`;
    button.addEventListener("click", async () => {
      closeModal();
      await selectTable("xb_lcn_indentured_item", {
        columns: ["eiacodxa", "lsaconxb", "altlcnxb", "lcntypxb"], values: [key[0], item.lcn, key[1], key[2]],
        description: `LCN ${item.lcn} · EIAC ${key[0]} · ALC ${key[1]} · type ${key[2]}`,
      });
    });
    li.append(button, walk(item.lcn, new Set([item.lcn])));
    rootList.append(li);
    container.append(rootList);
  }
  return container;
}

function showLcnTree() {
  if (!metadata.has("xb_lcn_indentured_item")) return toast("The LCN table is not present in this database.", true);
  const source = query(`SELECT eiacodxa, lsaconxb, altlcnxb, lcntypxb, lcnamexb, parent_lsacon FROM ${quoteIdentifier("xb_lcn_indentured_item")}`)
    .map((record) => [record.eiacodxa, record.lsaconxb, record.altlcnxb, record.lcntypxb, record.lcnamexb, record.parent_lsacon]);
  if (!source.length) return toast("The LCN table is empty.", true);
  const wrapper = document.createElement("div");
  wrapper.className = "lcn-groups";
  for (const group of buildLcnHierarchy(source)) {
    const section = document.createElement("section");
    section.className = "lcn-group";
    const title = document.createElement("strong");
    title.textContent = `EIAC ${group.key[0]} · ALC ${group.key[1]} · type ${group.key[2]}`;
    section.append(title, renderLcnItems(group.items, group.key));
    wrapper.append(section);
  }
  openModal("LCN Indenture Tree", wrapper, [modalButton("Close", "secondary-button", closeModal)], true);
}

function relationChoices(kind) {
  if (selectedRow < 0 || selectedRow >= rows.length) return toast("Select a record first.", true);
  const sourceRow = rows[selectedRow];
  const sourceHeaders = columns.map((column) => column.name);
  const relations = kind === "parent" ? metadata.get(currentTable).outbound : (inboundRelations.get(currentTable) || []);
  const usable = relations.map((relation) => {
    const sourceColumns = kind === "parent" ? relation.from : relation.to;
    const targetColumns = kind === "parent" ? relation.to : relation.from;
    const targetTable = relation.table;
    const values = sourceColumns.map((name) => sourceRow[sourceHeaders.indexOf(name)]);
    return { targetTable, targetColumns, values, sourceColumns };
  }).filter(({ values }) => values.every((value) => String(value ?? "") !== ""));
  if (!usable.length) return toast(`No ${kind === "parent" ? "parent" : "child"} relationship is available for this record.`, true);
  const navigate = async (choice) => {
    closeModal();
    await selectTable(choice.targetTable, {
      columns: choice.targetColumns,
      values: choice.values,
      description: `${kind === "parent" ? "Parent" : "Children"} via ${choice.sourceColumns.join(", ")}`,
    });
  };
  if (usable.length === 1) return navigate(usable[0]);
  const list = document.createElement("div");
  list.className = "choice-list";
  for (const choice of usable) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = `${formatTableName(choice.targetTable).display} — ${choice.sourceColumns.join(", ")}`;
    button.addEventListener("click", () => navigate(choice));
    list.append(button);
  }
  openModal(kind === "parent" ? "Choose Parent Table" : "Choose Child Table", list, [modalButton("Cancel", "secondary-button", closeModal)]);
}

function showContextMenu(event, rowIndex, columnIndex) {
  event.preventDefault();
  const matchingSelection = rowIndex < 0
    ? gridSelection?.mode === "columns" && selectionContains(rowIndex, columnIndex)
    : columnIndex < 0
      ? gridSelection?.mode === "rows" && selectionContains(rowIndex, columnIndex)
      : selectionContains(rowIndex, columnIndex);
  if (!matchingSelection) {
    const mode = rowIndex < 0 ? "columns" : columnIndex < 0 ? "rows" : "cells";
    setGridSelection(rowIndex, columnIndex, mode);
  } else {
    if (rowIndex >= 0) selectedRow = rowIndex;
    if (columnIndex >= 0) selectedColumn = columnIndex;
  }
  elements["context-menu"].querySelector('[data-context="undo"]').disabled = !undoStack.length;
  elements["context-menu"].querySelector('[data-context="redo"]').disabled = !redoStack.length;
  elements["context-menu"].hidden = false;
  const bounds = elements["context-menu"].getBoundingClientRect();
  elements["context-menu"].style.left = `${Math.max(4, Math.min(event.clientX, innerWidth - bounds.width - 4))}px`;
  elements["context-menu"].style.top = `${Math.max(4, Math.min(event.clientY, innerHeight - bounds.height - 4))}px`;
}

function closeMenus() {
  document.querySelectorAll(".menu-panel").forEach((panel) => { panel.hidden = true; });
  document.querySelectorAll(".menu-trigger").forEach((button) => button.setAttribute("aria-expanded", "false"));
  elements["context-menu"].hidden = true;
}

function setMobileSidebar(open) {
  elements.sidebar.classList.toggle("mobile-open", open);
  elements["mobile-tables"].setAttribute("aria-expanded", String(open));
}

async function replaceWithExample() {
  if (!confirmDiscard() || !window.confirm("Replace this browser's database with a fresh copy of the included bicycle example?")) return;
  db.close();
  await buildExampleDatabase();
  await introspectDatabase();
  await selectTable(metadata.has("xb_lcn_indentured_item") ? "xb_lcn_indentured_item" : tables[0]);
  toast("Example database reloaded in this browser.");
}

async function newBlankDatabase() {
  if (!confirmDiscard() || !window.confirm("Create a new empty LSAR database in this browser? Download the current database first if you need it.")) return;
  const schema = await fetchText("schema.sql");
  db.close();
  db = new SQL.Database();
  db.exec(schema);
  db.run("PRAGMA foreign_keys = ON");
  dbName = "new_lsar.db";
  await introspectDatabase();
  await persistDatabase();
  await selectTable(metadata.has("xb_lcn_indentured_item") ? "xb_lcn_indentured_item" : tables[0]);
  toast("New empty database created locally.");
}

async function wipeDatabase() {
  if (!confirmDiscard() || !window.confirm("Delete every record from every table in this browser's current database? This cannot be undone unless you downloaded a copy.")) return;
  db.run("PRAGMA foreign_keys = OFF");
  db.run("BEGIN");
  try {
    for (const table of tables) db.run(`DELETE FROM ${quoteIdentifier(table)}`);
    db.run("COMMIT");
  } catch (error) {
    try { db.run("ROLLBACK"); } catch { /* no-op */ }
    throw error;
  } finally {
    db.run("PRAGMA foreign_keys = ON");
  }
  await introspectDatabase();
  await persistDatabase();
  await selectTable(currentTable || tables[0]);
  toast("All records were removed from this browser's database.");
}

async function loadDatabaseFile(file) {
  if (!file || !confirmDiscard()) return;
  const candidate = new SQL.Database(new Uint8Array(await file.arrayBuffer()));
  const candidateTables = candidate.exec("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'");
  if (!candidateTables.length || !candidateTables[0].values.length) {
    candidate.close();
    throw new Error("The selected file is not a SQLite database with application tables.");
  }
  db.close();
  db = candidate;
  db.run("PRAGMA foreign_keys = ON");
  dbName = file.name;
  await introspectDatabase();
  await persistDatabase();
  await selectTable(metadata.has("xb_lcn_indentured_item") ? "xb_lcn_indentured_item" : tables[0]);
  toast(`${file.name} loaded and stored in this browser.`);
}

async function handleAction(action) {
  closeMenus();
  switch (action) {
    case "new-blank": await newBlankDatabase(); break;
    case "load-db": elements["database-file"].click(); break;
    case "download-db": downloadDatabase(); break;
    case "import-flat": elements["flat-file"].click(); break;
    case "export-flat": showExportDialog(); break;
    case "reset-example": await replaceWithExample(); break;
    case "wipe-db": await wipeDatabase(); break;
    case "lcn-tree": showLcnTree(); break;
    case "browser-demo-info": showInfo(); break;
  }
}

function bindEvents() {
  document.querySelectorAll(".menu-trigger").forEach((trigger) => {
    trigger.addEventListener("click", (event) => {
      event.stopPropagation();
      const panel = trigger.nextElementSibling;
      const willOpen = panel.hidden;
      closeMenus();
      panel.hidden = !willOpen;
      trigger.setAttribute("aria-expanded", String(willOpen));
    });
  });
  document.querySelectorAll("[data-action]").forEach((button) => button.addEventListener("click", () => {
    handleAction(button.dataset.action).catch((error) => showErrorDialog("Operation Failed", error.message));
  }));
  document.addEventListener("click", (event) => {
    if (!event.target.closest(".menu-root") && !event.target.closest("#context-menu")) closeMenus();
    if (!event.target.closest("#sidebar") && !event.target.closest("#mobile-tables")) setMobileSidebar(false);
    if (!event.target.closest("#grid-wrap") && !event.target.closest("#context-menu") && !event.target.closest("#modal")) gridSelectionActive = false;
  });
  document.addEventListener("pointerup", () => { draggingSelection = false; });
  elements["mobile-tables"].addEventListener("click", (event) => {
    event.stopPropagation();
    setMobileSidebar(!elements.sidebar.classList.contains("mobile-open"));
  });
  document.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      saveChanges();
      return;
    }
    if (!gridSelectionActive || !currentTable) {
      if (event.key === "Escape") { closeMenus(); closeModal(); setMobileSidebar(false); }
      return;
    }
    const modifier = event.ctrlKey || event.metaKey;
    if (modifier && event.key.toLowerCase() === "a" && editingCell && document.activeElement?.classList.contains("cell-input")) {
      return;
    } else if (modifier && event.key.toLowerCase() === "a") {
      event.preventDefault();
      selectAllGrid();
    } else if (modifier && event.key.toLowerCase() === "z") {
      event.preventDefault();
      if (event.shiftKey) redoGrid(); else undoGrid();
    } else if (modifier && event.key.toLowerCase() === "y") {
      event.preventDefault();
      redoGrid();
    } else if (event.key === "F2") {
      event.preventDefault();
      editingCell = true;
      const active = document.activeElement;
      if (active?.classList.contains("cell-input")) active.select();
    } else if (!editingCell && ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) {
      event.preventDefault();
      const moves = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
      moveGridSelection(...moves[event.key], event.shiftKey);
    } else if (event.key === "Enter") {
      event.preventDefault();
      editingCell = false;
      moveGridSelection(event.shiftKey ? -1 : 1, 0, false);
    } else if (!editingCell && (event.key === "Delete" || event.key === "Backspace")) {
      event.preventDefault();
      clearSelectedCells();
    } else if (event.key === "Escape") {
      editingCell = false;
      closeMenus();
      closeModal();
      setMobileSidebar(false);
    }
  });
  document.addEventListener("copy", (event) => {
    if (!gridSelectionActive || !gridSelection) return;
    const active = document.activeElement;
    if (editingCell && active?.classList.contains("cell-input") && active.selectionStart !== active.selectionEnd) return;
    event.preventDefault();
    event.clipboardData.setData("text/plain", selectedGridText());
  });
  document.addEventListener("paste", (event) => {
    if (!gridSelectionActive || !gridSelection) return;
    event.preventDefault();
    handleGridPaste(event.clipboardData.getData("text/plain"));
  });
  window.addEventListener("beforeunload", (event) => {
    if (dirty) { event.preventDefault(); event.returnValue = ""; }
  });
  elements["table-search"].addEventListener("input", renderGrid);
  elements["show-audit"].addEventListener("change", renderGrid);
  elements["save-changes"].addEventListener("click", saveChanges);
  elements["relaxed-info"].addEventListener("click", showRelaxedInfo);
  elements["clear-relation"].addEventListener("click", () => selectTable(currentTable));
  elements["grid-zoom"].addEventListener("input", () => {
    const value = Number(elements["grid-zoom"].value);
    document.documentElement.style.setProperty("--grid-scale", String(value / 100));
    elements["zoom-label"].textContent = `Zoom ${value}%`;
  });
  elements["modal-close"].addEventListener("click", closeModal);
  elements["modal-backdrop"].addEventListener("click", (event) => { if (event.target === elements["modal-backdrop"]) closeModal(); });
  elements["context-menu"].addEventListener("click", (event) => {
    const action = event.target.dataset.context;
    if (!action) return;
    closeMenus();
    if (action === "sort-asc" && selectedColumn >= 0) sortRows(selectedColumn, "asc");
    if (action === "sort-desc" && selectedColumn >= 0) sortRows(selectedColumn, "desc");
    if (action === "copy") copyGridSelection();
    if (action === "paste-overwrite") pasteFromClipboard("overwrite");
    if (action === "paste-insert") pasteFromClipboard("insert");
    if (action === "undo") undoGrid();
    if (action === "redo") redoGrid();
    if (action === "insert-above") insertRow(0);
    if (action === "insert-below") insertRow(1);
    if (action === "clear-cell") clearSelectedCells();
    if (action === "delete-row") deleteSelectedRows();
    if (action === "go-parent") relationChoices("parent");
    if (action === "show-children") relationChoices("children");
  });
  elements["database-file"].addEventListener("change", async () => {
    try { await loadDatabaseFile(elements["database-file"].files[0]); }
    catch (error) { showErrorDialog("Database Error", error.message); }
    elements["database-file"].value = "";
  });
  elements["flat-file"].addEventListener("change", async () => {
    const file = elements["flat-file"].files[0];
    if (!file || !confirmDiscard()) return;
    try {
      const counts = importFlatText(await file.text());
      await introspectDatabase();
      await persistDatabase();
      await selectTable(currentTable || tables[0]);
      toast(`Imported ${file.name}: ${counts.inserted} inserted, ${counts.updated} updated, ${counts.unchanged} unchanged, ${counts.skipped} skipped.`);
    } catch (error) {
      showErrorDialog("Import Error", error.message, "Nothing was imported.");
    } finally {
      elements["flat-file"].value = "";
    }
  });
}

async function start() {
  try {
    bindEvents();
    setLoading("Loading SQLite in the browser…");
    SQL = await window.initSqlJs({ locateFile: (file) => `vendor/${file}` });
    const saved = await storageGet();
    if (saved?.bytes) {
      setLoading("Opening your saved browser database…");
      try {
        db = new SQL.Database(new Uint8Array(saved.bytes));
        dbName = saved.name || "browser_lsar.db";
        db.run("PRAGMA foreign_keys = ON");
        await introspectDatabase();
      } catch (error) {
        if (db) db.close();
        console.warn("Stored database could not be opened; rebuilding the example.", error);
        await buildExampleDatabase();
      }
    } else {
      await buildExampleDatabase();
    }
    await introspectDatabase();
    elements["active-db-name"].textContent = dbName;
    elements.app.hidden = false;
    elements["loading-screen"].hidden = true;
    const initial = metadata.has("xb_lcn_indentured_item") ? "xb_lcn_indentured_item" : tables[0];
    await selectTable(initial);
    window.__LSAR_DEMO__ = {
      summary: () => ({ tables: tables.length, dbName, currentTable, rows: rows.length, totalRows: [...rowCounts.values()].reduce((sum, count) => sum + count, 0), dirty }),
      cellValue: (rowIndex, columnIndex) => rows[rowIndex]?.[columnIndex],
      selection: () => ({ ...gridSelection, ...selectedGridCoordinates() }),
      invalidRows: () => [...invalidMessages].map(([rowIndex, messages]) => ({ rowIndex, messages: [...messages] })),
      foreignKeyViolations: () => query("PRAGMA foreign_key_check"),
      foreignKeysEnabled: () => Number(scalar("PRAGMA foreign_keys")) === 1,
      selectTable,
      exportTableLines: (names) => generateFlatLines(names.map((table) => {
        const layout = metadata.get(table).columns.filter((column) => !isAuditColumn(column.name)).map((column) => ({ name: column.name, width: flatFieldWidth(column.type) }));
        return { table, layout, rows: query(`SELECT ${layout.map(({ name }) => quoteIdentifier(name)).join(", ")} FROM ${quoteIdentifier(table)}`) };
      })),
    };
  } catch (error) {
    console.error(error);
    setLoading(`The demo could not start: ${error.message}`);
    document.querySelector(".loading-bar").hidden = true;
  }
}

start();
