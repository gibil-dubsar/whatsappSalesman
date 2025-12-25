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

const KEEP_COLUMNS = ['contactName', 'agentName', 'cleanContactNumber'];
const NOTES_COLUMN = 'notes';

const sqlite = sqlite3.verbose();

function readCsv(csvPath) {
  const raw = fs.readFileSync(csvPath, 'utf8').replace(/^\uFEFF/, '');
  let headerColumns = [];
  const records = parse(raw, {
    columns: (header) => {
      headerColumns = header.map((h) => (h || '').trim());
      return headerColumns;
    },
    relax_column_count: true,
    skip_empty_lines: true,
    trim: true,
  });
  return { records, headerColumns };
}

function ensureTable(db) {
  db.run(`DROP TABLE IF EXISTS "${TABLE_NAME}"`);
  db.run(
    `CREATE TABLE "${TABLE_NAME}" (
      "contactName" TEXT,
      "agentName" TEXT,
      "cleanContactNumber" TEXT,
      "notes" TEXT,
      "conversation_started" TEXT DEFAULT 'pending'
    )`
  );
}

function normalizeValue(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function buildNotes(record, noteColumns) {
  const notes = {};
  for (const key of noteColumns) {
    if (!key) continue;
    const value = normalizeValue(record[key]);
    if (value !== null) {
      notes[key] = value;
    }
  }
  return Object.keys(notes).length > 0 ? JSON.stringify(notes) : null;
}

function insertRows(db, records, noteColumns) {
  const stmt = db.prepare(
    `INSERT INTO "${TABLE_NAME}" (
      "contactName",
      "agentName",
      "cleanContactNumber",
      "notes"
    ) VALUES (?, ?, ?, ?)`
  );

  for (const record of records) {
    const contactName = normalizeValue(record.contactName);
    const agentName = normalizeValue(record.agentName);
    const cleanContactNumber = normalizeValue(record.cleanContactNumber);
    const notes = buildNotes(record, noteColumns);
    stmt.run([contactName, agentName, cleanContactNumber, notes]);
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

  const noteColumns = headerColumns.filter((name) => name && !KEEP_COLUMNS.includes(name));

  const db = new sqlite.Database(DB_PATH);
  db.serialize(() => {
    ensureTable(db);
    insertRows(db, records, noteColumns);
  });
  db.close();

  console.log(`Imported ${records.length} rows into ${DB_PATH} (table: ${TABLE_NAME}).`);
}

main();
