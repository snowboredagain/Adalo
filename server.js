/**
 * server.js
 * Express API server for NetSuite RESTlet integration.
 *
 * NetSuite Account: XXXXXX
 *
 * Endpoints:
 *   GET /api/salesorders?customerId=###   — fetch sales orders for a customer
 *   GET /health                           — health check (no auth required)
 *
 * Authentication:
 *   All /api/* routes require an API key in the request header:
 *   X-API-Key: your_api_key
 *
 * Environment variables (set in Render dashboard):
 *   API_KEY             — your chosen API key for this server
 *   NS_ACCOUNT_ID       — your Netsuite Account ID
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

// Script IDs this server is permitted to invoke via the scriptId query param.
// Add to this set if you deploy additional RESTlets you want exposed here.
const ALLOWED_SCRIPT_IDS = new Set([
  process.env.NS_SALESORDER_SCRIPT_ID,
  process.env.NS_SALESORDER_LINES_SCRIPT_ID,
  process.env.NS_CUSTOMER_INFO_SCRIPT_ID,
  process.env.NS_VERIFY_SCRIPT_ID,
  process.env.NS_CLASSES_SCRIPT_ID,
  process.env.NS_ITEMS_SCRIPT_ID,
  process.env.NS_AVAILABILITY_SCRIPT_ID,
  process.env.NS_PRICE_SCRIPT_ID,
  process.env.NS_ORDER_SCRIPT_ID,
]);

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

const nodemailer = require('nodemailer');

// In-memory lockout store: { entityId: { attempts, lockedUntil } }
const verifyAttempts = {};
const MAX_ATTEMPTS   = 5;
const LOCKOUT_MS     = 60 * 60 * 1000; // 1 hour

const NS_VERIFY_SCRIPT_ID = process.env.NS_VERIFY_SCRIPT_ID;
const NS_VERIFY_DEPLOY_ID = process.env.NS_VERIFY_DEPLOY_ID || '1';

const mailer = nodemailer.createTransport({
  host:   'mail.iceguys.com',
  port:   465,
  secure: true,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

app.get('/api/customer/verify', requireApiKey, async (req, res) => {
  const { entityId, tranNumber, tranAmount } = req.query;
  if (!entityId || !tranNumber || !tranAmount) {
    return res.status(400).json({ error: 'entityId, tranNumber, and tranAmount are required' });
  }

  const key  = entityId.toLowerCase().trim();
  const now  = Date.now();
  const info = verifyAttempts[key] || { attempts: 0, lockedUntil: null };

  // Check lockout
  if (info.lockedUntil && now < info.lockedUntil) {
    const minutesLeft = Math.ceil((info.lockedUntil - now) / 60000);
    return res.status(429).json({
      error:       'Too many failed attempts. Account verification locked.',
      minutesLeft: minutesLeft,
    });
  }

  // Reset if lockout has expired
  if (info.lockedUntil && now >= info.lockedUntil) {
    verifyAttempts[key] = { attempts: 0, lockedUntil: null };
  }

  // Call NetSuite RESTlet
  const params = new URLSearchParams({
    script:    NS_VERIFY_SCRIPT_ID,
    deploy:    NS_VERIFY_DEPLOY_ID,
    entityId,
    tranNumber,
    tranAmount,
  });
  const endpoint = `${NS_RESTLET_URL}?${params.toString()}`;

  let data;
  try {
    data = await makeRequest('GET', endpoint);
  } catch (err) {
    console.error('NetSuite verify error:', err.message);
    return res.status(502).json({ error: 'NetSuite request failed', detail: err.message });
  }

  // Handle failed verification
  if (!data.success) {
    info.attempts += 1;

    if (info.attempts >= MAX_ATTEMPTS) {
      info.lockedUntil    = now + LOCKOUT_MS;
      verifyAttempts[key] = info;
      return res.status(429).json({
        error:       'Too many failed attempts. Account verification locked for 1 hour.',
        minutesLeft: 60,
      });
    }

    verifyAttempts[key] = info;
    return res.status(401).json({
      success:      false,
      reason:       data.reason,
      attemptsLeft: MAX_ATTEMPTS - info.attempts,
    });
  }

  // Success — reset attempts
  delete verifyAttempts[key];

  // Send notification email asynchronously — don't await
  mailer.sendMail({
    from:    process.env.SMTP_USER,
    to:      'sales@iceguys.com',
    subject: `New User Verified: ${data.companyName} (${data.entityId})`,
    text:    `A new user has successfully verified their account.\n\nCompany: ${data.companyName}\nCustomer #: ${data.entityId}\nNetSuite ID: ${data.customerId}\n\nThey have been granted access to the customer portal.`,
  }).catch(mailErr => console.error('Email notification failed:', mailErr.message));

  return res.json({
    verification: [ {
      success:     true,
      customerId:  parseFloat(data.customerId),    // define as a number
      companyName: data.companyName,
      hasTerms:    data.hasTerms,
      requiresPO:  data.requiresPO,
    } ]  
  });
});

/**
 * GET /api/salesorders?customerId=123&scriptId=123&deployId=1
 *
 * Fetches sales orders for a given NetSuite customer ID.
 *
 * Headers:
 *   X-API-Key: your_api_key
 *
 * Query params:
 *   customerId (required) — NetSuite internal customer ID
 *   scriptId   (optional) — NetSuite RESTlet script ID, defaults to NS_SCRIPT_ID.
 *                            Must be in ALLOWED_SCRIPT_IDS.
 *   deployId   (optional) — NetSuite RESTlet deployment ID, defaults to NS_DEPLOY_ID
 *   soNumber   (optional) — restrict results to a single sales order number (tranid);
 *                            only honored by RESTlets that support it (e.g. open-sales-order-line-items.js)
 *   limit      (optional) — max number of orders to consider; only honored by RESTlets that support it
 *
 * Response:
 *   200 { ...sales order data from NetSuite }
 *   400 { error: 'customerId query parameter is required' }
 *   400 { error: 'scriptId <id> is not permitted' }
 *   401 { error: 'Unauthorized' }
 *   502 { error: 'NetSuite request failed', detail: '...' }
 */
app.get('/api/salesorders', requireApiKey, async (req, res) => {
  const { customerId: rawCustomerId, scriptId, deployId, soNumber, limit } = req.query;
  const customerId = rawCustomerId 
    ? rawCustomerId.replace(/,/g, '').replace('NSID', '') 
    : rawCustomerId;
  
  if (!customerId) {
    return res.status(400).json({ error: 'customerId query parameter is required' });
  }

  const script = scriptId || NS_SCRIPT_ID;
  const deploy = deployId || NS_DEPLOY_ID;

  if (!ALLOWED_SCRIPT_IDS.has(script)) {
    return res.status(400).json({ error: `scriptId ${script} is not permitted` });
  }

  const params = new URLSearchParams({ script, deploy, customerId });
  if (soNumber) params.set('soNumber', soNumber);
  if (limit)    params.set('limit', limit);

  const endpoint = `${NS_RESTLET_URL}?${params.toString()}`;

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
app.get('/api/customer', requireApiKey, async (req, res) => {
  const { customerId: rawCustomerId, scriptId, deployId } = req.query;
  const customerId = rawCustomerId 
    ? rawCustomerId.replace(/,/g, '').replace('NSID', '') 
    : rawCustomerId;

  if (!customerId) {
    return res.status(400).json({ error: 'customerId query parameter is required' });
  }

  const script = scriptId || process.env.NS_CUSTOMER_SCRIPT_ID;
  const deploy = deployId || process.env.NS_CUSTOMER_DEPLOY_ID;

  const params = new URLSearchParams({ script, deploy, customerId });
  const endpoint = `${NS_RESTLET_URL}?${params.toString()}`;

  try {
    const data = await makeRequest('GET', endpoint);
    return res.json(data);
  } catch (err) {
    console.error('NetSuite error:', err.message);
    return res.status(502).json({ error: 'NetSuite request failed', detail: err.message });
  }
});
const NS_CLASSES_SCRIPT_ID = process.env.NS_CLASSES_SCRIPT_ID;
const NS_CLASSES_DEPLOY_ID = process.env.NS_CLASSES_DEPLOY_ID || '1';

app.get('/api/classes', requireApiKey, async (req, res) => {
  const params   = new URLSearchParams({
    script: NS_CLASSES_SCRIPT_ID,
    deploy: NS_CLASSES_DEPLOY_ID,
  });
  const endpoint = `${NS_RESTLET_URL}?${params.toString()}`;

  try {
    const data = await makeRequest('GET', endpoint);
    return res.json(data);
  } catch (err) {
    console.error('Classes error:', err.message);
    return res.status(502).json({ error: 'NetSuite request failed', detail: err.message });
  }
});

const NS_AVAILABILITY_SCRIPT_ID = process.env.NS_AVAILABILITY_SCRIPT_ID;
const NS_AVAILABILITY_DEPLOY_ID = process.env.NS_AVAILABILITY_DEPLOY_ID || '1';

app.get('/api/items/availability', requireApiKey, async (req, res) => {
  const { itemId, scriptId, deployId } = req.query;

  if (!itemId) {
    return res.status(400).json({ error: 'itemId is required' });
  }

  const script = scriptId || NS_AVAILABILITY_SCRIPT_ID;
  const deploy = deployId || NS_AVAILABILITY_DEPLOY_ID;

  const params = new URLSearchParams({ script, deploy, itemId });
  const endpoint = `${NS_RESTLET_URL}?${params.toString()}`;

  try {
    const data = await makeRequest('GET', endpoint);
    return res.json(data);
  } catch (err) {
    console.error('Availability error:', err.message);
    return res.status(502).json({ error: 'NetSuite request failed', detail: err.message });
  }
});

const NS_PRICE_SCRIPT_ID = process.env.NS_PRICE_SCRIPT_ID;
const NS_PRICE_DEPLOY_ID = process.env.NS_PRICE_DEPLOY_ID || '1';

app.get('/api/items/price', requireApiKey, async (req, res) => {
  const { customerId: rawCustomerId, itemId, scriptId, deployId } = req.query;
  const customerId = rawCustomerId ? rawCustomerId.replace(/,/g, '') : null;

  if (!customerId || !itemId) {
    return res.status(400).json({ error: 'customerId and itemId are required' });
  }

  const script = scriptId || NS_PRICE_SCRIPT_ID;
  const deploy = deployId || NS_PRICE_DEPLOY_ID;

  const params = new URLSearchParams({
    script,
    deploy,
    customerId,
    itemId,
  });

  const endpoint = `${NS_RESTLET_URL}?${params.toString()}`;

  try {
    const data = await makeRequest('GET', endpoint);
    return res.json(data);
  } catch (err) {
    console.error('Pricing error:', err.message);
    return res.status(502).json({ error: 'NetSuite request failed', detail: err.message });
  }
});

const NS_ITEMS_SCRIPT_ID = process.env.NS_ITEMS_SCRIPT_ID;
const NS_ITEMS_DEPLOY_ID = process.env.NS_ITEMS_DEPLOY_ID || '1';

app.get('/api/items', requireApiKey, async (req, res) => {
  const { classId, page, pageSize, scriptId, deployId } = req.query;

  if (!classId) {
    return res.status(400).json({ error: 'classId query parameter is required' });
  }

  const script = scriptId || NS_ITEMS_SCRIPT_ID;
  const deploy = deployId || NS_ITEMS_DEPLOY_ID;

  const params = new URLSearchParams({
    script,
    deploy,
    classId,
    page:     page     || '1',
    pageSize: pageSize || '50',
  });

  const endpoint = `${NS_RESTLET_URL}?${params.toString()}`;

  try {
    const data = await makeRequest('GET', endpoint);
    return res.json(data);
  } catch (err) {
    console.error('Items error:', err.message);
    return res.status(502).json({ error: 'NetSuite request failed', detail: err.message });
  }
});

const NS_ORDER_SCRIPT_ID = process.env.NS_ORDER_SCRIPT_ID;
const NS_ORDER_DEPLOY_ID = process.env.NS_ORDER_DEPLOY_ID || '1';

app.post('/api/order/create', requireApiKey, async (req, res) => {
  const {
    customerId,
    customerEmail,
    locationId,
    memo,
    otherrefnum,
    isWarranty,
    model,
    serial,
    items,
    scriptId,
    deployId,
  } = req.body;

  if (!customerId || !items) {
    return res.status(400).json({ error: 'customerId and items are required' });
  }

  const script = scriptId || NS_ORDER_SCRIPT_ID;
  const deploy = deployId || NS_ORDER_DEPLOY_ID;

  const params = new URLSearchParams({ script, deploy });
  const endpoint = `${NS_RESTLET_URL}?${params.toString()}`;

  try {
    const data = await makeRequest('POST', endpoint, {
      customerId,
      customerEmail,
      memo:        memo        || '',
      otherrefnum: otherrefnum || '',
      isWarranty:  isWarranty  || 'false',
      model:       model       || '',
      serial:      serial      || '',
      items:       typeof items === 'string' ? items : JSON.stringify(items),
    });
    return res.json(data);
  } catch (err) {
    console.error('Order create error:', err.message);
    return res.status(502).json({ error: 'NetSuite request failed', detail: err.message });
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
