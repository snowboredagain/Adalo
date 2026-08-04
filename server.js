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
const ALLOWED_SCRIPT_IDS = new Set([NS_SCRIPT_ID, '914','916']);

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
 * GET /api/salesorders?customerId=123&scriptId=813&deployId=1
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
  const customerId = rawCustomerId ? rawCustomerId.replace(/,/g, '') : rawCustomerId;  // strip comma formatting
  
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
const NS_SUITEQL_URL = `https://${process.env.NS_ACCOUNT_ID || '4130572'}.suitetalk.api.netsuite.com/services/rest/query/v1/suiteql`;

app.get('/api/customer', requireApiKey, async (req, res) => {
  const { customerId: rawCustomerId } = req.query;
  const customerId = rawCustomerId ? rawCustomerId.replace(/,/g, '') : null;

  if (!customerId) {
    return res.status(400).json({ error: 'customerId query parameter is required' });
  }

  const query = `
    SELECT
      BUILTIN.DF( Transaction.Entity ) AS customerName,
      SUM(
        CASE WHEN ( TRUNC( SYSDATE ) - Transaction.DueDate ) < 1
        THEN COALESCE( TransactionAccountingLine.AmountUnpaid, 0 ) - COALESCE( TransactionAccountingLine.PaymentAmountUnused, 0 )
        ELSE 0 END
      ) AS agingCurrent,
      SUM(
        CASE WHEN ( TRUNC( SYSDATE ) - Transaction.DueDate ) BETWEEN 1 AND 30
        THEN COALESCE( TransactionAccountingLine.AmountUnpaid, 0 ) - COALESCE( TransactionAccountingLine.PaymentAmountUnused, 0 )
        ELSE 0 END
      ) AS aging1,
      SUM(
        CASE WHEN ( TRUNC( SYSDATE ) - Transaction.DueDate ) BETWEEN 31 AND 60
        THEN COALESCE( TransactionAccountingLine.AmountUnpaid, 0 ) - COALESCE( TransactionAccountingLine.PaymentAmountUnused, 0 )
        ELSE 0 END
      ) AS aging2,
      SUM(
        CASE WHEN ( TRUNC( SYSDATE ) - Transaction.DueDate ) BETWEEN 61 AND 90
        THEN COALESCE( TransactionAccountingLine.AmountUnpaid, 0 ) - COALESCE( TransactionAccountingLine.PaymentAmountUnused, 0 )
        ELSE 0 END
      ) AS aging3,
      SUM(
        CASE WHEN ( TRUNC( SYSDATE ) - Transaction.DueDate ) > 90
        THEN COALESCE( TransactionAccountingLine.AmountUnpaid, 0 ) - COALESCE( TransactionAccountingLine.PaymentAmountUnused, 0 )
        ELSE 0 END
      ) AS aging4,
      SUM(
        COALESCE( TransactionAccountingLine.AmountUnpaid, 0 ) - COALESCE( TransactionAccountingLine.PaymentAmountUnused, 0 )
      ) AS total
    FROM
      Transaction
      INNER JOIN TransactionAccountingLine ON
        ( TransactionAccountingLine.Transaction = Transaction.ID )
      INNER JOIN Customer ON
        ( Customer.ID = Transaction.Entity )
    WHERE
      ( Transaction.Entity = ${customerId} )
      AND ( Transaction.Posting = 'T' )
      AND ( Transaction.Voided = 'F' )
      AND (
        ( TransactionAccountingLine.AmountUnpaid <> 0 )
        OR ( TransactionAccountingLine.PaymentAmountUnused <> 0 )
      )
    GROUP BY
      BUILTIN.DF( Transaction.Entity )
  `;

  try {
    const data = await makeRequest('POST', NS_SUITEQL_URL, { q: query });

    const row = data.items && data.items[0];
    if (!row) {
      return res.json({
        customer: [ {
          customerId,
          companyName:  '',
          agingCurrent: 0,
          aging1:       0,
          aging2:       0,
          aging3:       0,
          aging4:       0,
          total:        0,
        } ]
      });
    }

    return res.json({
      customer: [ {
        customerId,
        companyName:  row.customername  || '',
        agingCurrent: parseFloat(row.agingcurrent) || 0,
        aging1:       parseFloat(row.aging1)       || 0,
        aging2:       parseFloat(row.aging2)       || 0,
        aging3:       parseFloat(row.aging3)       || 0,
        aging4:       parseFloat(row.aging4)       || 0,
        total:        parseFloat(row.total)        || 0,
      } ]
    });

  } catch (err) {
    console.error('SuiteQL error:', err.message);
    return res.status(502).json({ error: 'SuiteQL request failed', detail: err.message });
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
