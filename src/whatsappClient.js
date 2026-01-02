import fs from 'node:fs';
import path from 'node:path';
import whatsappWeb from 'whatsapp-web.js';
import qrcode from 'qrcode-terminal';
import {
    CHROME_EXECUTABLE_PATH,
    WHATSAPP_KEEP_ALIVE_MS,
    WHATSAPP_STATE_POLL_MS,
    WHATSAPP_TYPING_DELAY_MS,
    WHATSAPP_REINIT_DELAY_MS
} from './config.js';

const { Client, LocalAuth, MessageMedia } = whatsappWeb;

let client = null;
let ready = false;
let latestQr = null;
let status = 'starting';
let statusDetail = '';
let statusUpdatedAt = Date.now();
let connectionState = 'unknown';
let keepAliveTimer = null;
let pollTimer = null;
let messageHandler = null;
let reinitScheduled = false;
let reinitInProgress = false;
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function updateStatus(nextStatus, detail = '') {
    status = nextStatus;
    statusDetail = detail || '';
    statusUpdatedAt = Date.now();
}

function clearTimers() {
    if (keepAliveTimer) {
        clearInterval(keepAliveTimer);
        keepAliveTimer = null;
    }
    if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
    }
}

async function destroyClient() {
    if (!client) return;
    try {
        client.removeAllListeners();
    } catch (err) {
        console.warn('Failed to remove WhatsApp listeners:', err);
    }
    try {
        await client.destroy();
    } catch (err) {
        console.warn('Failed to destroy WhatsApp client:', err);
    }
    client = null;
}

function scheduleReinit(reason) {
    if (reinitScheduled || reinitInProgress) {
        return;
    }
    reinitScheduled = true;
    updateStatus('restarting', reason || '');
    setTimeout(async () => {
        reinitScheduled = false;
        if (reinitInProgress) return;
        reinitInProgress = true;
        clearTimers();
        ready = false;
        latestQr = null;
        connectionState = 'unknown';
        await destroyClient();
        try {
            initWhatsAppClient();
        } finally {
            reinitInProgress = false;
        }
    }, WHATSAPP_REINIT_DELAY_MS);
}

function isStoreReady() {
    return Boolean(client && client.info);
}

function formatEventArg(arg) {
    if (arg === null || arg === undefined) {
        return String(arg);
    }
    const type = typeof arg;
    if (type === 'string') {
        return arg.length > 120 ? `${arg.slice(0, 120)}...` : arg;
    }
    if (type === 'number' || type === 'boolean' || type === 'bigint') {
        return String(arg);
    }
    if (Array.isArray(arg)) {
        return `Array(${arg.length})`;
    }
    if (type === 'object') {
        if (arg.constructor && arg.constructor.name) {
            return `[${arg.constructor.name}]`;
        }
        return '[Object]';
    }
    return `[${type}]`;
}

function logEvent(event, args) {
    const summary = args.map(formatEventArg).join(' | ');
    const suffix = summary ? ` ${summary}` : '';
    console.log(`[WA_EVENT] ${event}${suffix}`);
}

function getMessageContent(message) {
    if (!message || typeof message !== 'object') {
        return '';
    }
    const rawBody = typeof message.body === 'string' ? message.body : '';
    const body = rawBody.trim();
    if (body) {
        return body;
    }
    const type = message.type ? String(message.type) : '';
    if (message.hasMedia || ['image', 'video', 'audio', 'ptt', 'document', 'sticker', 'album', 'location', 'vcard', 'multi_vcard'].includes(type)) {
        const mediaType = type || 'media';
        return `User sent [media:${mediaType}]`;
    }
    if (type === 'call_log') {
        return 'User sent [call:log]';
    }
    return '';
}

function formatMessageLine(message) {
    if (!message || typeof message !== 'object') return null;
    const rawBody = typeof message.body === 'string' ? message.body : '';
    const body = rawBody.trim();
    if (!body) {
        const type = message.type ? String(message.type) : '';
        if (message.hasMedia || ['image', 'video', 'audio', 'ptt', 'document', 'sticker', 'album', 'location', 'vcard', 'multi_vcard'].includes(type)) {
            const mediaType = type || 'media';
            const label = `media:${mediaType}`;
            return message.fromMe ? `me: [${label}]` : `them: [${label}]`;
        }
        if (type === 'call_log') {
            return message.fromMe ? 'me: [call:log]' : 'them: [call:log]';
        }
        return null;
    }
    return message.fromMe ? `me: ${body}` : `them: ${body}`;
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

function buildCleanChatlog(messages) {
    if (!Array.isArray(messages)) {
        return '';
    }
    return messages
        .map(formatMessageLine)
        .filter(Boolean)
        .join('\n');
}

export function initWhatsAppClient() {
    if (client) {
        return client;
    }

    client = new Client({
        authStrategy: new LocalAuth(),
        puppeteer: {
            executablePath: CHROME_EXECUTABLE_PATH,
            headless: false,
        }
    });

    const originalEmit = client.emit.bind(client);
    client.emit = (event, ...args) => {
        logEvent(event, args);
        return originalEmit(event, ...args);
    };

    client.on('qr', (qr) => {
        latestQr = qr;
        ready = false;
        updateStatus('qr');
        console.log('QR RECEIVED');
        qrcode.generate(qr, { small: true });
    });

    client.on('code', (code) => {
        console.log('Pairing code:', code);
    });

    client.on('authenticated', () => {
        ready = false;
        latestQr = null;
        updateStatus('authenticated');
        console.log('AUTHENTICATED');
        console.log('WhatsApp authenticated, waiting for ready.');
    });

    client.on('loading_screen', (percent, message) => {
        updateStatus('loading', `${percent}% ${message}`.trim());
        console.log('LOADING SCREEN', percent, message);
    });

    client.on('change_state', (state) => {
        connectionState = state;
        console.log('CHANGE STATE', state);
        if (state === 'CONNECTED') {
            ready = true;
            latestQr = null;
            const storeState = isStoreReady() ? 'store=ready' : 'store=loading';
            updateStatus('ready', storeState);
        } else {
            ready = false;
            updateStatus('state', state);
        }
    });

    client.on('ready', () => {
        ready = true;
        latestQr = null;
        updateStatus('ready');
        console.log('READY');
        console.log('WhatsApp client is ready.');
        client.getWWebVersion().then((version) => {
            console.log(`WWebVersion = ${version}`);
        }).catch(() => {});
        if (client.pupPage) {
            client.pupPage.on('pageerror', (err) => {
                console.log('Page error:', err.toString());
            });
            client.pupPage.on('error', (err) => {
                console.log('Page error:', err.toString());
            });
        }
    });

    client.on('auth_failure', (msg) => {
        ready = false;
        latestQr = null;
        updateStatus('auth_failure', msg);
        console.error('AUTHENTICATION FAILURE', msg);
    });

    client.on('disconnected', (reason) => {
        ready = false;
        latestQr = null;
        connectionState = 'DISCONNECTED';
        updateStatus('disconnected', reason);
        console.warn('WhatsApp client disconnected:', reason);
        scheduleReinit(reason || 'disconnected');
    });

    client.on('message', (msg) => {
        const body = typeof msg.body === 'string' ? msg.body : '';
        const snippet = body.length > 120 ? `${body.slice(0, 120)}...` : body;
        console.log('MESSAGE RECEIVED', msg.from, snippet);
        if (messageHandler) {
            Promise.resolve(messageHandler(msg)).catch((err) => {
                console.error('Message handler failed:', err);
            });
        }
    });

    if (WHATSAPP_KEEP_ALIVE_MS > 0) {
        keepAliveTimer = setInterval(async () => {
            if (!ready || !client) return;
            try {
                await client.sendPresenceAvailable();
            } catch (err) {
                updateStatus('state', 'keep-alive failed');
            }
        }, WHATSAPP_KEEP_ALIVE_MS);
    }

    if (WHATSAPP_STATE_POLL_MS > 0) {
        pollTimer = setInterval(async () => {
            if (!client) return;
            try {
                const state = await client.getState();
                if (state) {
                    connectionState = state;
                    if (state === 'CONNECTED') {
                        ready = true;
                        latestQr = null;
                        const storeState = isStoreReady() ? 'store=ready' : 'store=loading';
                        updateStatus('ready', storeState);
                    } else if (!latestQr) {
                        ready = false;
                        const storeState = isStoreReady() ? 'store=ready' : 'store=loading';
                        updateStatus('state', `${state} ${storeState}`.trim());
                    }
                }
            } catch (err) {
                updateStatus('state', 'state poll failed');
            }
        }, WHATSAPP_STATE_POLL_MS);
    }

    client.initialize();
    return client;
}

export function isClientReady() {
    return connectionState === 'CONNECTED';
}

export function getLatestQr() {
    return latestQr;
}

export function setMessageHandler(handler) {
    messageHandler = handler;
}

export function getStatus() {
    return status;
}

export function getStatusDetail() {
    return statusDetail;
}

export function getStatusUpdatedAt() {
    return statusUpdatedAt;
}

export function getConnectionState() {
    return connectionState;
}

export function getStoreReady() {
    return isStoreReady();
}

export async function isRegisteredUser(chatId) {
    if (!client) {
        throw new Error('WhatsApp client not initialized.');
    }
    return client.isRegisteredUser(chatId);
}

export async function sendMessage(chatId, message) {
    if (!client) {
        throw new Error('WhatsApp client not initialized.');
    }
    await sleep(500);
    const chat = await getChatById(chatId);
    if (!chat) {
        throw new Error('Chat not found.');
    }
    await chat.sendStateTyping();
    const text = typeof message === 'string' ? message : String(message || '');
    const perCharMs = 55;
    const minDelayMs = 2000;
    const maxDelayMs = 25000;
    const scaledDelay = Math.round(text.length * perCharMs);
    const delayMs = Math.min(maxDelayMs, Math.max(minDelayMs, scaledDelay));
    if (delayMs > 0) {
        await sleep(delayMs);
    }
    return chat.sendMessage(message);
}

export async function sendSeen(chatId) {
    if (!client) {
        throw new Error('WhatsApp client not initialized.');
    }
    const chat = await getChatById(chatId);
    if (!chat) {
        throw new Error('Chat not found.');
    }
    return chat.sendSeen();
}

export async function reactToMessage(messageId, reaction) {
    if (!client) {
        throw new Error('WhatsApp client not initialized.');
    }
    if (!messageId) {
        return false;
    }
    await client.pupPage.evaluate(async (id, emoji) => {
        if (!id) return null;
        const msg =
            window.Store.Msg.get(id) || (await window.Store.Msg.getMessagesById([id]))?.messages?.[0];
        if (!msg) return null;
        await window.Store.sendReactionToMsg(msg, emoji);
    }, messageId, reaction);
    return true;
}
export async function sendMedia(chatId, mediaDirectory) {
    if (!client) {
        throw new Error('WhatsApp client not initialized.');
    }

    if (!fs.existsSync(mediaDirectory)) {
        throw new Error(`Media directory not found: ${mediaDirectory}`);
    }

    const entries = fs.readdirSync(mediaDirectory, { withFileTypes: true });
    const files = entries
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name)
        .filter((name) => !name.startsWith('.'))
        .sort((a, b) => a.localeCompare(b));
    if (files.length === 0) {
        return false;
    }

    for (const filename of files) {
        const mediaPath = path.join(mediaDirectory, filename);
        const media = MessageMedia.fromFilePath(mediaPath);
        await client.sendMessage(chatId, media, { sendMediaAsHd: true });
        await sleep(200);
    }
    return true;
}

export async function fetchChatMessages(chatId, options = {}, { clean = false } = {}) {
    if (!client) {
        throw new Error('WhatsApp client not initialized.');
    }
    const chat = await client.getChatById(chatId);
    if (!chat) {
        return null;
    }
    const messages = await chat.fetchMessages(options);
    if (clean) {
        return { chatlog: buildCleanChatlog(messages) };
    }
    const payload = Array.isArray(messages)
        ? messages.map(serializeMessage).filter(Boolean)
        : [];
    return { messages: payload };
}

export async function isChatTyping(chatId) {
    if (!client) {
        throw new Error('WhatsApp client not initialized.');
    }
    return client.pupPage.evaluate(async (id) => {
        const getChat = window.WWebJS?.getChat;
        if (!getChat) return false;
        const chat = await getChat(id, { getAsModel: false });
        if (!chat) return false;

        const presence = chat.presence || chat.presenceData || chat.__x_presence || null;
        if (!presence) return false;

        const data = typeof presence.serialize === 'function' ? presence.serialize() : presence;
        const state = data?.chatstate || data?.state || data?.type || '';
        if (typeof state === 'string') {
            const normalized = state.toLowerCase();
            if (['composing', 'typing', 'recording'].includes(normalized)) {
                return true;
            }
        }

        const isComposing = data?.isComposing;
        const isTyping = data?.isTyping;
        const isRecording = data?.isRecording;
        return Boolean(isComposing || isTyping || isRecording);
    }, chatId);
}

export async function getUnrepliedMessagesSnapshot(chatId, { limit = 250 } = {}) {
    if (!client) {
        throw new Error('WhatsApp client not initialized.');
    }
    const chat = await client.getChatById(chatId);
    if (!chat) {
        return null;
    }
    const messages = await chat.fetchMessages({ limit });
    if (!Array.isArray(messages)) {
        return { history: '', pending: [] };
    }
    const normalized = messages
        .filter((message) => message && typeof message === 'object')
        .map((message) => ({
            id: message.id && (message.id._serialized || message.id.id || message.id),
            fromMe: Boolean(message.fromMe),
            body: message.body,
            hasMedia: Boolean(message.hasMedia),
            type: message.type,
            timestamp: Number(message.timestamp) || 0,
        }))
        .sort((a, b) => a.timestamp - b.timestamp);

    let lastOutgoingIndex = -1;
    for (let i = 0; i < normalized.length; i += 1) {
        if (normalized[i].fromMe) {
            lastOutgoingIndex = i;
        }
    }

    const historyMessages = lastOutgoingIndex >= 0
        ? normalized.slice(0, lastOutgoingIndex + 1)
        : [];
    const pending = normalized
        .slice(lastOutgoingIndex + 1)
        .filter((message) => !message.fromMe)
        .map((message) => ({
            content: getMessageContent(message),
            messageId: message.id || null,
            hasMedia: message.hasMedia,
            type: message.type,
        }))
        .filter((message) => message.content);

    return {
        history: buildCleanChatlog(historyMessages),
        pending,
    };
}

export async function getChatById(chatId) {
    if (!client) {
        throw new Error('WhatsApp client not initialized.');
    }
    return client.getChatById(chatId);
}
