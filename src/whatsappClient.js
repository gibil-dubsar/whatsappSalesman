import whatsappWeb from 'whatsapp-web.js';
import qrcode from 'qrcode-terminal';
import { CHROME_EXECUTABLE_PATH, WHATSAPP_KEEP_ALIVE_MS, WHATSAPP_STATE_POLL_MS } from './config.js';

const { Client, LocalAuth } = whatsappWeb;

let client = null;
let ready = false;
let latestQr = null;
let status = 'starting';
let statusDetail = '';
let statusUpdatedAt = Date.now();
let connectionState = 'unknown';
let keepAliveTimer = null;
let pollTimer = null;
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function updateStatus(nextStatus, detail = '') {
    status = nextStatus;
    statusDetail = detail || '';
    statusUpdatedAt = Date.now();
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
    });

    client.on('message', (msg) => {
        const body = typeof msg.body === 'string' ? msg.body : '';
        const snippet = body.length > 120 ? `${body.slice(0, 120)}...` : body;
        console.log('MESSAGE RECEIVED', msg.from, snippet);
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
    return client.sendMessage(chatId, message);
}
