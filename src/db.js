import sqlite3 from 'sqlite3';
import { DB_PATH } from './config.js';

const sqlite = sqlite3.verbose();

export function openDatabase() {
    return new sqlite.Database(DB_PATH);
}

export function closeDatabase(db) {
    return new Promise((resolve, reject) => {
        db.close((err) => {
            if (err) return reject(err);
            resolve();
        });
    });
}

export function dbAll(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => {
            if (err) return reject(err);
            resolve(rows);
        });
    });
}

export function dbGet(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => {
            if (err) return reject(err);
            resolve(row);
        });
    });
}

export function dbRun(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function (err) {
            if (err) return reject(err);
            resolve(this);
        });
    });
}
