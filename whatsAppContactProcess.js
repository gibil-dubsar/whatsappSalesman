import express from 'express';
import { PORT } from './src/config.js';
import { loadPropertyContext } from './src/propertyContext.js';
import { registerContactRoutes } from './src/routes/contacts.js';
import { createAutoResponder } from './src/autoResponder.js';
import { initWhatsAppClient, setMessageHandler } from './src/whatsappClient.js';

const app = express();
app.use(express.json());

app.get('/', (_req, res) => {
    res.type('text').send('API server running. Start the UI with "npm run dev --prefix ui".');
});

let initialMessage = '';
let followupMessage = '';
let propertyContext = null;
try {
    propertyContext = loadPropertyContext();
    initialMessage = propertyContext.messages.initial;
    followupMessage =propertyContext.messages.followup;
    console.log(`Property context loaded: ${propertyContext.title || 'untitled'}`);
    console.log(`Initial message: ${initialMessage}`);
    console.log(`Follow-up message: ${followupMessage}`);
} catch (err) {
    console.error(err.message);
    process.exit(1);
}

registerContactRoutes(app, { initialMessage, followupMessage, propertyContext });

app.listen(PORT, () => {
    console.log(`UI server running at http://localhost:${PORT}`);
});
initWhatsAppClient();
setMessageHandler(createAutoResponder({ propertyContext }));
