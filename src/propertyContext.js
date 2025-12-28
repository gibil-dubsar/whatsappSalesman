import fs from 'fs';
import { PROPERTY_CONTEXT_PATH } from './config.js';

export function validatePropertyContext(context) {
    if (!context || typeof context !== 'object') {
        throw new Error('Property context must be an object.');
    }

    const requiredTopLevel = ['description', 'specs', 'location', 'viewing_contact', 'messages'];
    for (const key of requiredTopLevel) {
        if (!context[key]) {
            throw new Error(`Property context missing required field: ${key}`);
        }
    }

    const requiredSpecs = ['price_lkr', 'bedrooms', 'bathrooms', 'house_size_sqft', 'land_size_perches'];
    for (const key of requiredSpecs) {
        if (context.specs[key] === undefined || context.specs[key] === null) {
            throw new Error(`Property context specs missing required field: ${key}`);
        }
    }

    const requiredLocation = ['address', 'city', 'maps_url', 'flood_risk'];
    for (const key of requiredLocation) {
        if (!context.location[key]) {
            throw new Error(`Property context location missing required field: ${key}`);
        }
    }

    const requiredContact = ['name', 'phone'];
    for (const key of requiredContact) {
        if (!context.viewing_contact[key]) {
            throw new Error(`Property context viewing_contact missing required field: ${key}`);
        }
    }

    if (!context.messages || !context.messages.initial) {
        throw new Error('Property context messages missing required field: initial');
    }
}

export function loadPropertyContext() {
    if (!fs.existsSync(PROPERTY_CONTEXT_PATH)) {
        throw new Error(`Property context file not found: ${PROPERTY_CONTEXT_PATH}`);
    }
    const raw = fs.readFileSync(PROPERTY_CONTEXT_PATH, 'utf8');
    const context = JSON.parse(raw);
    validatePropertyContext(context);
    return context;
}
