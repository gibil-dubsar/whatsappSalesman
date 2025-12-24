import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import sqlite3 from 'sqlite3';
import { parse } from 'csv-parse/sync';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CSV_PATH = process.argv[2] || path.join(__dirname, 'seller_background_data.csv');
const DB_PATH = process.argv[3] || path.join(__dirname, 'seller_background.db');
const TABLE_NAME = 'seller_background';

const sqlite = sqlite3.verbose();

function normalizeHeader(header, index) {
  const trimmed = (header || '').trim();
  return trimmed ? trimmed : `csv_index_${index}`;
}

function toSqlName(name, usedNames) {
  let sqlName = name.replace(/[^A-Za-z0-9_]/g, '_');
  if (!sqlName) {
    sqlName = 'column';
  }
  if (/^\d/.test(sqlName)) {
    sqlName = `col_${sqlName}`;
  }
  let candidate = sqlName;
  let suffix = 1;
  while (usedNames.has(candidate)) {
    candidate = `${sqlName}_${suffix}`;
    suffix += 1;
  }
  usedNames.add(candidate);
  return candidate;
}

function readCsv(csvPath) {
  const raw = fs.readFileSync(csvPath, 'utf8').replace(/^\uFEFF/, '');
  let headerColumns = [];
  const records = parse(raw, {
    columns: (header) => {
      headerColumns = header.map((h, idx) => normalizeHeader(h, idx));
      return headerColumns;
    },
    relax_column_count: true,
    skip_empty_lines: true,
    trim: true,
  });
  return { records, headerColumns };
}

function ensureTable(db, columnMap) {
  const columnDefs = columnMap.map(({ sqlName }) => `"${sqlName}" TEXT`);
  columnDefs.push('"conversation_started" TEXT DEFAULT \'pending\'');
  db.run(`DROP TABLE IF EXISTS "${TABLE_NAME}"`);
  db.run(`CREATE TABLE "${TABLE_NAME}" (${columnDefs.join(', ')})`);
}

function insertRows(db, records, columnMap) {
  const sqlColumns = columnMap.map(({ sqlName }) => `"${sqlName}"`);
  const placeholders = columnMap.map(() => '?').join(', ');
  const stmt = db.prepare(
    `INSERT INTO "${TABLE_NAME}" (${sqlColumns.join(', ')}) VALUES (${placeholders})`
  );

  for (const record of records) {
    const values = columnMap.map(({ originalName }) => {
      const value = record[originalName];
      return value === '' ? null : value;
    });
    stmt.run(values);
  }
  stmt.finalize();
}

function main() {
  if (!fs.existsSync(CSV_PATH)) {
    console.error(`CSV file not found: ${CSV_PATH}`);
    process.exit(1);
  }

  const { records, headerColumns } = readCsv(CSV_PATH);
  if (records.length === 0) {
    console.error('No records found in CSV.');
    process.exit(1);
  }

  const usedNames = new Set();
  const columnMap = headerColumns.map((name) => ({
    originalName: name,
    sqlName: toSqlName(name, usedNames),
  }));

  const db = new sqlite.Database(DB_PATH);
  db.serialize(() => {
    ensureTable(db, columnMap);
    insertRows(db, records, columnMap);
  });
  db.close();

  console.log(`Imported ${records.length} rows into ${DB_PATH} (table: ${TABLE_NAME}).`);
}

main();
