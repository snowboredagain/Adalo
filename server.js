/**
 * server.js
 * Express API server for NetSuite RESTlet integration.
 *
 * NetSuite Account: 4130572
 *
 * Endpoints:
 *   GET /api/salesorders?customerId=123   — fetch sales orders for a customer
 *   GET /health                           — health check (no auth required)
 *
 * Authentication:
 *   All /api/* routes require an API key in the request header:
 *   X-API-Key: your_api_key
 *
 * Environment variables (set in Render dashboard):
 *   API_KEY             — your chosen API key for this server
 *   NS_ACCOUNT_ID       — 4130572
 *   NS_CONSUMER_KEY     — from NetSuite Integration record
 *   NS_CONSUMER_SECRET  — from NetSuite Integration record
 *   NS_TOKEN_ID         — from NetSuite Access Token record
 *   NS_TOKEN_SECRET     — from NetSuite Access Token record
 *   PORT                — (optional) defaults to 3000
 *
 * Run locally:
 *   npm install express
 *   node server.js
 */

'use strict';

const express      = require('express');
const { makeRequest } = require('./generate-jwt');

const app  = express();
const PORT = process.env.PORT || 3000;

// NetSuite RESTlet config
const NS_ACCOUNT_ID  = process.env.NS_ACCOUNT_ID || '4130572';
const NS_SCRIPT_ID   = process.env.NS_SCRIPT_ID  || '813';
const NS_DEPLOY_ID   = process.env.NS_DEPLOY_ID  || '1';
const NS_RESTLET_URL = `https://${NS_ACCOUNT_ID}.restlets.api.netsuite.com/app/site/hosting/restlet.nl`;

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------
app.use(express.json());

// Request logger
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// API key authentication — applied to all /api/* routes
function requireApiKey(req, res, next) {
  const apiKey       = process.env.API_KEY;
  const providedKey  = req.headers['x-api-key'];

  if (!apiKey) {
    console.error('API_KEY environment variable is not set');
    return res.status(500).json({ error: 'Server misconfiguration: API_KEY not set' });
  }

  if (!providedKey || providedKey !== apiKey) {
    return res.status(401).json({ error: 'Unauthorized: invalid or missing X-API-Key header' });
  }

  next();
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// Health check — no auth required, used by Render to verify the service is up
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

/**
 * GET /api/salesorders?customerId=123
 *
 * Fetches sales orders for a given NetSuite customer ID.
 *
 * Headers:
 *   X-API-Key: your_api_key
 *
 * Query params:
 *   customerId (required) — NetSuite internal customer ID
 *
 * Response:
 *   200 { ...sales order data from NetSuite }
 *   400 { error: 'customerId query parameter is required' }
 *   401 { error: 'Unauthorized' }
 *   502 { error: 'NetSuite request failed', detail: '...' }
 */
app.get('/api/salesorders', requireApiKey, async (req, res) => {
  const { customerId } = req.query;

  if (!customerId) {
    return res.status(400).json({ error: 'customerId query parameter is required' });
  }

  const endpoint = `${NS_RESTLET_URL}?script=${NS_SCRIPT_ID}&deploy=${NS_DEPLOY_ID}&customerId=${encodeURIComponent(customerId)}`;

  try {
    const data = await makeRequest('GET', endpoint);
    return res.json(data);
  } catch (err) {
    console.error('NetSuite error:', err.message);
    return res.status(502).json({
      error:  'NetSuite request failed',
      detail: err.message,
    });
  }
});

// Catch-all for undefined routes
app.use((req, res) => {
  res.status(404).json({ error: `Route not found: ${req.method} ${req.path}` });
});

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
  console.log(`Sales orders: http://localhost:${PORT}/api/salesorders?customerId=123`);
});

module.exports = app;
