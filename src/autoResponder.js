import { dbAll, dbRun, openDatabase, closeDatabase } from './db.js';
import { STATUS, TABLE_NAME, IMAGE_DIRECTORY } from './config.js';
import { generateGeminiResponse } from './geminiClient.js';
import { sendMessage, sendMedia, fetchChatMessages, isChatTyping } from './whatsappClient.js';







function normalizeNumber(value) {
    if (!value) return '';
    return String(value).replace(/[^\d]/g, '');
}

function serializeContactForPrompt(contact) {
    if (!contact || typeof contact !== 'object') {
        return null;
    }
    return {
        number: contact.number || null,
        name: contact.name || null,
        pushname: contact.pushname || null,
        shortName: contact.shortName || null,
        isMyContact: Boolean(contact.isMyContact),
        isBusiness: Boolean(contact.isBusiness),
        isWAContact: Boolean(contact.isWAContact),
    };
}

async function resolveSenderNumber(message) {
    if (!message || typeof message !== 'object') return '';
    const from = typeof message.from === 'string' ? message.from : '';
    if (from && !from.endsWith('@lid')) {
        return normalizeNumber(from);
    }
    try {
        const contact = await message.getContact();
        const number = contact?.number || contact?.id?.user || '';
        return normalizeNumber(number);
    } catch (err) {
        console.error('Failed to resolve sender number:', err);
    }
    return '';
}

async function resolveContactInfo(message) {
    try {
        const contact = await message.getContact();
        return serializeContactForPrompt(contact);
    } catch (err) {
        console.warn('[autoResponder] Failed to load contact info:', err);
        return null;
    }
}

async function findContactByNumber(db, number) {
    const rows = await dbAll(
        db,
        `SELECT rowid, cleanContactNumber, conversation_started FROM "${TABLE_NAME}"`
    );
    const match = rows.find((row) => normalizeNumber(row.cleanContactNumber) === number);
    if (match) return match;
    if (number.length >= 9) {
        const suffix = number.slice(-9);
        return rows.find((row) => normalizeNumber(row.cleanContactNumber).slice(-9) === suffix) || null;
    }
    return null;
}

async function setContactStatus(db, rowId, status) {
    await dbRun(
        db,
        `UPDATE "${TABLE_NAME}" SET conversation_started = ? WHERE rowid = ?`,
        [status, rowId]
    );
}

const inFlight = new Map();
const QUIET_WINDOW_MS = 25000;
const TYPING_WAIT_MS = 4 * 60 * 1000;
const TYPING_POLL_MS = 15000;

function isActiveStatus(status) {
    return status === STATUS.ACTIVE || status === 'started';
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pauseContact(rowId) {
    const db = openDatabase();
    try {
        await setContactStatus(db, rowId, STATUS.PAUSED);
    } finally {
        try {
            await closeDatabase(db);
        } catch (err) {
            console.error('Failed to close database:', err);
        }
    }
}

async function processChatQueue(entry, contactRowId, chatId, propertyContext) {
    if (entry.processing) {
        return;
    }
    entry.processing = true;
    entry.timer = null;
    try {
        while (entry.buffer.length > 0) {
            try {
                const start = Date.now();
                let typing = await isChatTyping(chatId);
                while (typing && Date.now() - start < TYPING_WAIT_MS) {
                    console.log('[autoResponder] User is typing; waiting 15s before checking again.');
                    await sleep(TYPING_POLL_MS);
                    typing = await isChatTyping(chatId);
                }
                if (typing) {
                    console.log('[autoResponder] Typing wait exceeded 4 minutes; proceeding.');
                }
            } catch (err) {
                console.warn('[autoResponder] Failed to check typing state:', err);
            }

            const batch = entry.buffer.splice(0, entry.buffer.length);
            const content = batch.filter(Boolean).join('\n');
            if (!content) {
                continue;
            }

            const historyResult = await fetchChatMessages(
                chatId,
                { limit: 250 },
                { clean: true }
            );
            const conversationHistory = historyResult?.chatlog || '';
            console.log('[autoResponder] History length', conversationHistory.length);
            console.log('[autoResponder] Sending content to LLM:', content.slice(0, 160));

            const result = await generateGeminiResponse({
                propertyContext,
                message: content,
                conversationHistory,
                contactInfo: entry.contactInfo || null,
            });
            console.log('[autoResponder] LLM result', {
                action: result.action,
                hasReply: Boolean(result.reply),
                media: result.media
            });

            if (result.action === 'reply' && (result.reply || result.media === 'include')) {
                if (result.reply) {
                    await sendMessage(chatId, String(result.reply));
                }
                if (result.media === 'include') {
                    await sendMedia(chatId, IMAGE_DIRECTORY);
                }
                console.log('[autoResponder] Reply sent', {
                    replySent: Boolean(result.reply),
                    mediaSent: result.media === 'include'
                });
                continue;
            }

            console.warn('[autoResponder] Pausing conversation (LLM did not reply).');
            await pauseContact(contactRowId);
            break;
        }
    } catch (err) {
        console.error('Auto responder failed:', err);
        await pauseContact(contactRowId);
    } finally {
        entry.processing = false;
        if (entry.buffer.length > 0) {
            entry.timer = setTimeout(() => {
                void processChatQueue(entry, contactRowId, chatId, propertyContext);
            }, QUIET_WINDOW_MS);
        } else {
            inFlight.delete(chatId);
        }
    }
}

export function createAutoResponder({ propertyContext }) {
    return async function handleIncomingMessage(message) {
        if (!message || message.fromMe) return;
        message = await message.reload();
        if (typeof message.from === 'string' && message.from.includes('@g.us')) return;
        console.log('[autoResponder] Received message from', message.from);
        const fromNumber = await resolveSenderNumber(message);
        if (!fromNumber) {
            console.warn('[autoResponder] Unable to resolve sender number; skipping.');
            return;
        }

        const db = openDatabase();
        let contact = null;
        try {
            console.log('[autoResponder] Looking for contact in database:', fromNumber);
            contact = await findContactByNumber(db, fromNumber);
            if (!contact) {
                console.warn('[autoResponder] Contact not found; skipping.');
                return;
            }
            console.log('[autoResponder] Found contact', {
                rowid: contact.rowid,
                status: contact.conversation_started
            });
            if (!isActiveStatus(contact.conversation_started)) {
                console.log('[autoResponder] Contact not active; skipping.');
                return;
            }

            const rawBody = typeof message.body === 'string' ? message.body : '';
            const body = rawBody.trim();
            const content = body || (message.hasMedia ? `User sent media: ${message.type || 'media'}` : '');
            if (!content) {
                console.warn('[autoResponder] Empty message content; skipping.');
                return;
            }

            const chatId = typeof message.from === 'string' ? message.from : '';
            if (!chatId) {
                console.warn('[autoResponder] Missing chat id; skipping.');
                return;
            }

            const contactInfo = await resolveContactInfo(message);

            const existing = inFlight.get(chatId);
            if (existing) {
                existing.buffer.push(content);
                if (!existing.contactInfo && contactInfo) {
                    existing.contactInfo = contactInfo;
                }
                if (existing.timer) {
                    clearTimeout(existing.timer);
                }
                if (!existing.processing) {
                    existing.timer = setTimeout(() => {
                        void processChatQueue(existing, contact.rowid, chatId, propertyContext);
                    }, QUIET_WINDOW_MS);
                }
                console.log('[autoResponder] Message buffered for in-flight chat.');
                return;
            }

            const entry = {
                buffer: [content],
                timer: null,
                processing: false,
                contactInfo,
            };
            inFlight.set(chatId, entry);
            entry.timer = setTimeout(() => {
                void processChatQueue(entry, contact.rowid, chatId, propertyContext);
            }, QUIET_WINDOW_MS);
        } catch (err) {
            console.error('Auto responder failed:', err);
            if (contact) {
                await pauseContact(contact.rowid);
            }
        } finally {
            try {
                await closeDatabase(db);
            } catch (err) {
                console.error('Failed to close database:', err);
            }
        }
    };
}
