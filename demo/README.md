# Minimal LSAR Sandbox browser demo

This directory contains a static, writable browser build of the project. It runs
SQLite through WebAssembly and stores the active database in IndexedDB. There is
no API and no shared cloud database: every browser profile receives an independent
copy of `bike_example.txt` on first use.

The browser build uses the desktop project's unmodified `schema.sql` and sample
file. It implements table editing, validation, foreign-key navigation, the LCN
tree, database upload/download, and the same fixed-width import/export rules. The
browser security model requires an explicit download when the user wants a normal
`.db` file; a web page cannot silently replace an arbitrary local file.

The grid supports drag/Shift selection of cell ranges, rows, and columns; TSV
copy/paste; insert-or-overwrite paste; a visible Add Row action that also works
for empty tables; Delete, arrow navigation, and undo/redo.
Single-clicking a cell selects its value for replacement, while double-click or
F2 enters text-editing mode. Save validation is atomic and lists every invalid
row in one persistent dialog, with the affected rows highlighted in orange.

`vendor/sql-wasm.js` and `vendor/sql-wasm.wasm` are from sql.js 1.14.1. Its MIT
license is included as `vendor/LICENSE-sql.js`.

Run the logic tests with:

```sh
node --test demo/tests/logic.test.mjs
```

Serve the repository over HTTP to run the demo; WebAssembly loading is not
supported reliably from a `file://` URL.
