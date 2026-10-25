import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

assert.equal(process.argv.length, 3, 'Usage: node check-parsers.mjs /absolute/disposable-directory');
const root = path.resolve(process.argv[2]);
const bytes = await readFile(path.join(root, 'sample.gpkg'));
const { default: initSqlJs } = await import(pathToFileURL(path.join(root, 'node_modules/sql.js/dist/sql-wasm.js')));
const { default: initSQLite } = await import(pathToFileURL(path.join(root, 'node_modules/@sqlite.org/sqlite-wasm/dist/node.mjs')));
const sqljs = await initSqlJs(), first = new sqljs.Database(bytes);
const results = {};
try {
    results.sqljs = { rows: first.exec('SELECT count(*) FROM mobile')[0].values[0][0],
        rtreeEnabled: first.exec('PRAGMA compile_options')[0].values.some(row => row[0] === 'ENABLE_RTREE') };
    try { first.exec('SELECT count(*) FROM sample_bounds'); results.sqljs.indexWorks = true; }
    catch (error) { results.sqljs.indexWorks = false; results.sqljs.error = error.message; }
    assert.equal(results.sqljs.indexWorks, false);
} finally { first.close(); }
const sqlite = await initSQLite(), second = new sqlite.oo1.DB();
const pointer = sqlite.wasm.allocFromTypedArray(new Uint8Array(bytes));
try {
    assert.equal(sqlite.capi.sqlite3_deserialize(second.pointer, 'main', pointer, bytes.length, bytes.length,
        sqlite.capi.SQLITE_DESERIALIZE_READONLY), sqlite.capi.SQLITE_OK);
    results.sqliteWasm = { rows: second.exec({ sql: 'SELECT count(*) FROM mobile', returnValue: 'resultRows' })[0][0],
        indexRows: second.exec({ sql: 'SELECT count(*) FROM sample_bounds', returnValue: 'resultRows' })[0][0],
        rtreeEnabled: second.exec({ sql: 'PRAGMA compile_options', returnValue: 'resultRows' }).some(row => row[0] === 'ENABLE_RTREE') };
    assert.equal(results.sqliteWasm.indexRows, results.sqliteWasm.rows);
    assert.equal(results.sqliteWasm.rtreeEnabled, true);
} finally { second.close(); sqlite.wasm.dealloc(pointer); }
await writeFile(path.join(root, 'parser-results.json'), JSON.stringify(results, null, 2) + '\n');
console.log(JSON.stringify(results));
