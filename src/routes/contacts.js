import { dbAll, dbGet, dbRun, openDatabase, closeDatabase } from '../db.js';
import { STATUS, TABLE_NAME } from '../config.js';
import {
    getLatestQr,
    getConnectionState,
    getStatus,
    getStatusDetail,
    getStatusUpdatedAt,
    getStoreReady,
    isClientReady,
    isRegisteredUser,
    sendMessage
} from '../whatsappClient.js';

function parseRowId(value) {
    const rowId = Number.parseInt(value, 10);
    if (!Number.isFinite(rowId)) {
        return null;
    }
    return rowId;
}

async function updateStatus(db, rowId, status) {
    await dbRun(
        db,
        `UPDATE "${TABLE_NAME}" SET conversation_started = ? WHERE rowid = ?`,
        [status, rowId]
    );
}

async function loadContacts(db) {
    return dbAll(
        db,
        `SELECT rowid, adId, agentName, contactName, cleanContactNumber, city, propertyType, conversation_started
         FROM "${TABLE_NAME}"
         ORDER BY rowid DESC`
    );
}

async function loadTableInfo(db) {
    return dbAll(db, `PRAGMA table_info("${TABLE_NAME}")`);
}

function normalizeDefaultValue(value) {
    if (value === null || value === undefined) {
        return '';
    }
    const text = String(value);
    if (text.startsWith("'") && text.endsWith("'")) {
        return text.slice(1, -1);
    }
    return text;
}

export function registerContactRoutes(app, { initialMessage }) {
    app.get('/api/status', (_req, res) => {
        res.json({
            whatsappReady: isClientReady(),
            qr: getLatestQr(),
            status: getStatus(),
            detail: getStatusDetail(),
            updatedAt: getStatusUpdatedAt(),
            connectionState: getConnectionState(),
            storeReady: getStoreReady()
        });
    });

    app.get('/api/contacts', async (_req, res) => {
        const db = openDatabase();
        try {
            const contacts = await loadContacts(db);
            res.json({ contacts });
        } catch (err) {
            console.error('Failed to load contacts:', err);
            res.status(500).json({ error: 'Failed to load contacts.' });
        } finally {
            try {
                await closeDatabase(db);
            } catch (err) {
                console.error('Failed to close database:', err);
            }
        }
    });

    app.get('/api/contacts/schema', async (_req, res) => {
        const db = openDatabase();
        try {
            const columns = await loadTableInfo(db);
            const schema = columns.map((column) => ({
                name: column.name,
                type: column.type,
                defaultValue: normalizeDefaultValue(column.dflt_value),
                notNull: column.notnull === 1,
            }));
            res.json({ columns: schema });
        } catch (err) {
            console.error('Failed to load schema:', err);
            res.status(500).json({ error: 'Failed to load schema.' });
        } finally {
            try {
                await closeDatabase(db);
            } catch (err) {
                console.error('Failed to close database:', err);
            }
        }
    });

    app.post('/api/contacts', async (req, res) => {
        const payload = req.body;
        if (!payload || typeof payload !== 'object') {
            res.status(400).json({ error: 'Invalid payload.' });
            return;
        }

        const db = openDatabase();
        try {
            const columns = await loadTableInfo(db);
            const insertColumns = [];
            const values = [];
            let hasNonStatusValue = false;

            for (const column of columns) {
                const name = column.name;
                if (!(name in payload)) {
                    continue;
                }
                const rawValue = payload[name];
                const value = typeof rawValue === 'string' ? rawValue.trim() : rawValue;
                if (value === '' || value === undefined || value === null) {
                    continue;
                }
                if (name !== 'conversation_started') {
                    hasNonStatusValue = true;
                }
                insertColumns.push(name);
                values.push(value);
            }

            if (!hasNonStatusValue) {
                res.status(400).json({ error: 'Provide at least one contact field.' });
                return;
            }

            const quotedColumns = insertColumns.map((name) => `"${name}"`);
            const placeholders = insertColumns.map(() => '?').join(', ');
            const sql = `INSERT INTO "${TABLE_NAME}" (${quotedColumns.join(', ')}) VALUES (${placeholders})`;

            const result = await dbRun(db, sql, values);
            res.status(201).json({ rowid: result.lastID });
        } catch (err) {
            console.error('Failed to create contact:', err);
            res.status(500).json({ error: 'Failed to create contact.' });
        } finally {
            try {
                await closeDatabase(db);
            } catch (err) {
                console.error('Failed to close database:', err);
            }
        }
    });

    app.delete('/api/contacts/:rowid', async (req, res) => {
        const rowId = parseRowId(req.params.rowid);
        if (!rowId) {
            res.status(400).json({ error: 'Invalid contact id.' });
            return;
        }

        const db = openDatabase();
        try {
            const result = await dbRun(
                db,
                `DELETE FROM "${TABLE_NAME}" WHERE rowid = ?`,
                [rowId]
            );
            if (!result || result.changes === 0) {
                res.status(404).json({ error: 'Contact not found.' });
                return;
            }
            res.json({ deleted: true });
        } catch (err) {
            console.error('Failed to delete contact:', err);
            res.status(500).json({ error: 'Failed to delete contact.' });
        } finally {
            try {
                await closeDatabase(db);
            } catch (err) {
                console.error('Failed to close database:', err);
            }
        }
    });

    app.post('/api/contacts/:rowid/initiate', async (req, res) => {
        if (!isClientReady()) {
            res.status(503).json({ error: 'WhatsApp client not ready. Scan the QR code in the terminal.' });
            return;
        }

        const rowId = parseRowId(req.params.rowid);
        if (!rowId) {
            res.status(400).json({ error: 'Invalid contact id.' });
            return;
        }

        const db = openDatabase();
        try {
            const row = await dbGet(
                db,
                `SELECT rowid, cleanContactNumber, conversation_started
                 FROM "${TABLE_NAME}"
                 WHERE rowid = ?`,
                [rowId]
            );
            console.log(row);

            if (!row) {
                res.status(404).json({ error: 'Contact not found.' });
                return;
            }

            const contactNumber = (row.cleanContactNumber || '').trim();
            if (!contactNumber) {
                res.status(400).json({ error: 'Contact missing cleanContactNumber.' });
                return;
            }

            const sanitizedNumber = contactNumber.replace(/[^\d]/g, '');
            if (!sanitizedNumber) {
                res.status(400).json({ error: 'Contact number is invalid.' });
                return;
            }

            const chatId = `${sanitizedNumber}@c.us`;
            const isRegistered = await isRegisteredUser(chatId);
            console.log(`isRegisteredUser(${chatId}) = ${isRegistered}`);
            if (!isRegistered) {
                await updateStatus(db, rowId, STATUS.UNREGISTERED);
                res.json({ status: STATUS.UNREGISTERED });
                return;
            }

            if (!initialMessage) {
                res.status(500).json({ error: 'Initial message is not configured.' });
                return;
            }
            await sendMessage(chatId, initialMessage);
            await updateStatus(db, rowId, STATUS.STARTED);
            res.json({ status: STATUS.STARTED });
        } catch (err) {
            console.error('Failed to initiate conversation:', err);
            res.status(500).json({ error: 'Failed to initiate conversation.' });
        } finally {
            try {
                await closeDatabase(db);
            } catch (err) {
                console.error('Failed to close database:', err);
            }
        }
    });
}
