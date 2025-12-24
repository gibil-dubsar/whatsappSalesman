import express from 'express';
import { PORT } from './src/config.js';
import { loadPropertyContext } from './src/propertyContext.js';
import { registerContactRoutes } from './src/routes/contacts.js';
import { initWhatsAppClient } from './src/whatsappClient.js';

const app = express();
app.use(express.json());

app.get('/', (_req, res) => {
    res.type('text').send('API server running. Start the UI with "npm run dev --prefix ui".');
});

let initialMessage = '';
try {
    const context = loadPropertyContext();
    initialMessage = context.messages?.initial || '';
    console.log(`Property context loaded: ${context.title || 'untitled'}`);
} catch (err) {
    console.error(err.message);
    process.exit(1);
}

registerContactRoutes(app, { initialMessage });

app.listen(PORT, () => {
    console.log(`UI server running at http://localhost:${PORT}`);
});
initWhatsAppClient();
