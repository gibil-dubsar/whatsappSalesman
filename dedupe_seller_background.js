import sqlite3 from 'sqlite3';
import { DB_PATH, TABLE_NAME, STATUS } from './src/config.js';

const sqlite = sqlite3.verbose();

function normalizeNumber(value) {
  if (!value) return '';
  return String(value).replace(/[^\d]/g, '');
}

function normalizeText(value) {
  if (value === null || value === undefined) return '';
  const text = String(value).trim();
  return text;
}

function fieldScore(row) {
  let score = 0;
  if (normalizeText(row.contactName)) score += 1;
  if (normalizeText(row.agentName)) score += 1;
  if (normalizeText(row.group)) score += 1;
  if (normalizeText(row.notes)) score += 1;
  if (normalizeText(row.cleanContactNumber)) score += 1;
  return score;
}

function pickCanonical(rows) {
  return rows
    .slice()
    .sort((a, b) => {
      const scoreDiff = fieldScore(b) - fieldScore(a);
      if (scoreDiff !== 0) return scoreDiff;
      return b.rowid - a.rowid;
    })[0];
}

function mergeField(rows, key, fallback) {
  for (const row of rows) {
    const value = normalizeText(row[key]);
    if (value) return value;
  }
  return fallback;
}

function mergeRow(rows, canonical) {
  const merged = { ...canonical };
  merged.contactName = mergeField(rows, 'contactName', canonical.contactName || null) || null;
  merged.agentName = mergeField(rows, 'agentName', canonical.agentName || null) || null;
  merged.group = mergeField(rows, 'group', canonical.group || null) || null;
  merged.notes = mergeField(rows, 'notes', canonical.notes || null) || null;
  merged.cleanContactNumber =
    mergeField(rows, 'cleanContactNumber', canonical.cleanContactNumber || null) || null;

  const hasActive = rows.some((row) => row.conversation_started === STATUS.ACTIVE);
  merged.conversation_started = hasActive
    ? STATUS.ACTIVE
    : (canonical.conversation_started || STATUS.PENDING);
  return merged;
}

function dbAll(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows);
    });
  });
}

function dbRun(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve(this);
    });
  });
}

async function main() {
  const db = new sqlite.Database(DB_PATH);
  try {
    const rows = await dbAll(
      db,
      `SELECT rowid, contactName, agentName, cleanContactNumber, "group", notes, conversation_started
       FROM "${TABLE_NAME}"`
    );

    const map = new Map();
    const skipped = [];
    for (const row of rows) {
      const normalized = normalizeNumber(row.cleanContactNumber);
      if (!normalized) {
        skipped.push(row.rowid);
        continue;
      }
      if (!map.has(normalized)) {
        map.set(normalized, []);
      }
      map.get(normalized).push(row);
    }

    let dedupeGroups = 0;
    let removedRows = 0;

    await dbRun(db, 'BEGIN TRANSACTION');
    try {
      for (const [, groupRows] of map) {
        if (groupRows.length < 2) continue;
        dedupeGroups += 1;
        const canonical = pickCanonical(groupRows);
        const merged = mergeRow(groupRows, canonical);

        await dbRun(
          db,
          `UPDATE "${TABLE_NAME}"
           SET contactName = ?,
               agentName = ?,
               cleanContactNumber = ?,
               "group" = ?,
               notes = ?,
               conversation_started = ?
           WHERE rowid = ?`,
          [
            merged.contactName,
            merged.agentName,
            merged.cleanContactNumber,
            merged.group,
            merged.notes,
            merged.conversation_started,
            canonical.rowid,
          ]
        );

        for (const row of groupRows) {
          if (row.rowid === canonical.rowid) continue;
          await dbRun(db, `DELETE FROM "${TABLE_NAME}" WHERE rowid = ?`, [row.rowid]);
          removedRows += 1;
        }
      }

      await dbRun(db, 'COMMIT');
    } catch (err) {
      await dbRun(db, 'ROLLBACK');
      throw err;
    }

    console.log(`Deduped groups: ${dedupeGroups}`);
    console.log(`Removed rows: ${removedRows}`);
    if (skipped.length) {
      console.log(`Skipped rows without numbers: ${skipped.join(', ')}`);
    }
  } finally {
    db.close();
  }
}

main().catch((err) => {
  console.error('Deduplication failed:', err);
  process.exit(1);
});
