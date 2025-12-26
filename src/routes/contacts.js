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
    getChatById,
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

function parsePositiveInt(value) {
    if (value === undefined || value === null || value === '') {
        return null;
    }
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return null;
    }
    return parsed;
}

function parseBoolean(value) {
    if (value === undefined || value === null || value === '') {
        return null;
    }
    const normalized = String(value).toLowerCase();
    if (['true', '1', 'yes', 'y'].includes(normalized)) return true;
    if (['false', '0', 'no', 'n'].includes(normalized)) return false;
    return null;
}

function toChatId(contactNumber) {
    const trimmed = (contactNumber || '').trim();
    if (!trimmed) {
        return null;
    }
    const sanitizedNumber = trimmed.replace(/[^\d]/g, '');
    if (!sanitizedNumber) {
        return null;
    }
    return `${sanitizedNumber}@c.us`;
}

async function loadContactForChat(db, rowId) {
    return dbGet(
        db,
        `SELECT rowid, cleanContactNumber, conversation_started
         FROM "${TABLE_NAME}"
         WHERE rowid = ?`,
        [rowId]
    );
}

function serializeMessage(message) {
    if (!message || typeof message !== 'object') {
        return null;
    }
    return {
        id: message.id && (message.id._serialized || message.id.id || message.id),
        body: message.body,
        from: message.from,
        to: message.to,
        fromMe: message.fromMe,
        timestamp: message.timestamp,
        type: message.type,
        hasMedia: message.hasMedia,
    };
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
        `SELECT rowid, contactName, agentName, cleanContactNumber, notes, conversation_started
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
            const row = await loadContactForChat(db, rowId);
            console.log(row);

            if (!row) {
                res.status(404).json({ error: 'Contact not found.' });
                return;
            }

            const chatId = toChatId(row.cleanContactNumber);
            if (!chatId) {
                res.status(400).json({ error: 'Contact missing cleanContactNumber.' });
                return;
            }
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
            await updateStatus(db, rowId, STATUS.ACTIVE);
            res.json({ status: STATUS.ACTIVE });
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

    app.patch('/api/contacts/:rowid/status', async (req, res) => {
        const rowId = parseRowId(req.params.rowid);
        if (!rowId) {
            res.status(400).json({ error: 'Invalid contact id.' });
            return;
        }

        const nextStatus = req.body?.status;
        const allowedStatuses = new Set(Object.values(STATUS));
        if (!allowedStatuses.has(nextStatus)) {
            res.status(400).json({ error: 'Invalid status.' });
            return;
        }

        const db = openDatabase();
        try {
            const row = await loadContactForChat(db, rowId);
            if (!row) {
                res.status(404).json({ error: 'Contact not found.' });
                return;
            }
            await updateStatus(db, rowId, nextStatus);
            res.json({ status: nextStatus });
        } catch (err) {
            console.error('Failed to update status:', err);
            res.status(500).json({ error: 'Failed to update status.' });
        } finally {
            try {
                await closeDatabase(db);
            } catch (err) {
                console.error('Failed to close database:', err);
            }
        }
    });

    app.post('/api/contacts/:rowid/sync-history', async (req, res) => {
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
            const row = await loadContactForChat(db, rowId);
            if (!row) {
                res.status(404).json({ error: 'Contact not found.' });
                return;
            }

            const chatId = toChatId(row.cleanContactNumber);
            if (!chatId) {
                res.status(400).json({ error: 'Contact missing cleanContactNumber.' });
                return;
            }

            const chat = await getChatById(chatId);
            if (!chat) {
                res.status(404).json({ error: 'Chat not found.' });
                return;
            }

            await chat.syncHistory();
            res.json({ synced: true });
        } catch (err) {
            console.error('Failed to sync history:', err);
            res.status(500).json({ error: 'Failed to sync history.' });
        } finally {
            try {
                await closeDatabase(db);
            } catch (err) {
                console.error('Failed to close database:', err);
            }
        }
    });

    app.get('/api/contacts/:rowid/messages', async (req, res) => {
        if (!isClientReady()) {
            res.status(503).json({ error: 'WhatsApp client not ready. Scan the QR code in the terminal.' });
            return;
        }

        const rowId = parseRowId(req.params.rowid);
        if (!rowId) {
            res.status(400).json({ error: 'Invalid contact id.' });
            return;
        }

        const limit = parsePositiveInt(req.query.limit);
        const fromMe = parseBoolean(req.query.fromMe);
        const clean = parseBoolean(req.query.clean);
        const options = {};
        if (limit) {
            options.limit = limit;
        }
        if (fromMe !== null) {
            options.fromMe = fromMe;
        }

        const db = openDatabase();
        try {
            const row = await loadContactForChat(db, rowId);
            if (!row) {
                res.status(404).json({ error: 'Contact not found.' });
                return;
            }

            const chatId = toChatId(row.cleanContactNumber);
            if (!chatId) {
                res.status(400).json({ error: 'Contact missing cleanContactNumber.' });
                return;
            }

            const chat = await getChatById(chatId);
            if (!chat) {
                res.status(404).json({ error: 'Chat not found.' });
                return;
            }

            const messages = await chat.fetchMessages(options);
            if (clean) {
                const chatlog = Array.isArray(messages)
                    ? messages
                          .map((message) => {
                              if (!message || typeof message !== 'object') return null;
                              const rawBody = typeof message.body === 'string' ? message.body : '';
                              const body = rawBody.trim();
                              if (!body) {
                                  if (message.hasMedia) {
                                      const mediaType = message.type ? String(message.type) : 'media';
                                      const label = `media:${mediaType}`;
                                      return message.fromMe ? `me: [${label}]` : `them: [${label}]`;
                                  }
                                  return null;
                              }
                              return message.fromMe ? `me: ${body}` : `them: ${body}`;
                          })
                          .filter(Boolean)
                          .join('\n')
                    : '';
                res.json({ chatlog });
                return;
            }

            const payload = Array.isArray(messages)
                ? messages.map(serializeMessage).filter(Boolean)
                : [];
            res.json({ messages: payload });
        } catch (err) {
            console.error('Failed to fetch messages:', err);
            res.status(500).json({ error: 'Failed to fetch messages.' });
        } finally {
            try {
                await closeDatabase(db);
            } catch (err) {
                console.error('Failed to close database:', err);
            }
        }
    });
}
