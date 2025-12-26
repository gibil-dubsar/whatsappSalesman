import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const ROOT_DIR = path.resolve(__dirname, '..');
export const DB_PATH = path.join(ROOT_DIR, 'seller_background.db');
export const TABLE_NAME = 'seller_background';
export const PROPERTY_CONTEXT_PATH = path.join(ROOT_DIR, 'property_context.json');
export const IMAGE_DIRECTORY = path.join(ROOT_DIR, 'SelectedHouseImages');
export const PORT = Number.parseInt(process.env.PORT || '3300', 10);
export const CHROME_EXECUTABLE_PATH = process.env.CHROME_PATH || (() => {
    if (process.platform === 'darwin') {
        return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    }
    if (process.platform === 'win32') {
        return 'C:\\\\Program Files\\\\Google\\\\Chrome\\\\Application\\\\chrome.exe';
    }
    return '/usr/bin/google-chrome';
})();
export const WHATSAPP_KEEP_ALIVE_MS = Number.parseInt(
    process.env.WA_KEEP_ALIVE_MS || '60000',
    10
);
export const WHATSAPP_STATE_POLL_MS = Number.parseInt(
    process.env.WA_STATE_POLL_MS || '3000',
    10
);

export const STATUS = {
    PENDING: 'pending',
    ACTIVE: 'active',
    PAUSED: 'paused',
    UNREGISTERED: 'unregistered',
};
