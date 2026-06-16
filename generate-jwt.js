/**
 * netsuite-auth.js
 * NetSuite Token Based Authentication (TBA) — OAuth 1.0a
 *
 * NetSuite Account: 4130572
 *
 * This module generates a properly signed OAuth 1.0a Authorization header
 * for use with NetSuite RESTlets and REST Web Services.
 *
 * Prerequisites:
 *   npm install crypto (built-in to Node.js — no install needed)
 *
 * Setup (one-time in NetSuite):
 *   1. Enable TBA: Setup → Company → Enable Features → SuiteCloud
 *      → Check "Token-based Authentication" → Save
 *
 *   2. Enable TBA on your Integration record:
 *      Setup → Integration → Manage Integrations → [your integration]
 *      → Check "TBA: Authorization Flow" and "TBA: Issuing Token Endpoint" → Save
 *      → Note the Consumer Key and Consumer Secret
 *
 *   3. Create an Access Token:
 *      Setup → Users/Roles → Access Tokens → New
 *      → Select your Integration, User, and Role → Save
 *      → Note the Token ID and Token Secret (shown only once)
 *
 *   4. Populate the CONFIG block below or set environment variables.
 *
 * Usage:
 *   node netsuite-auth.js
 *
 * Or import in another script:
 *   const { makeRequest } = require('./netsuite-auth');
 *   const result = await makeRequest('GET', 'https://4130572.restlets.api.netsuite.com/app/site/hosting/restlet.nl?script=123&deploy=1');
 */

'use strict';

const crypto      = require('crypto');
const https       = require('https');
const url         = require('url');

// ---------------------------------------------------------------------------
// CONFIG — populate these values or set equivalent environment variables
// ---------------------------------------------------------------------------
const CONFIG = {
  // NetSuite Account ID
  accountId: process.env.NS_ACCOUNT_ID || '4130572',

  // From the Integration record (Setup → Integration → Manage Integrations)
  consumerKey:    process.env.NS_CONSUMER_KEY    || 'YOUR_CONSUMER_KEY_HERE',
  consumerSecret: process.env.NS_CONSUMER_SECRET || 'YOUR_CONSUMER_SECRET_HERE',

  // From the Access Token record (Setup → Users/Roles → Access Tokens)
  tokenId:     process.env.NS_TOKEN_ID     || 'YOUR_TOKEN_ID_HERE',
  tokenSecret: process.env.NS_TOKEN_SECRET || 'YOUR_TOKEN_SECRET_HERE',
};
// ---------------------------------------------------------------------------

/**
 * Generates a random nonce string for OAuth 1.0a.
 * @returns {string}
 */
function generateNonce() {
  return crypto.randomBytes(16).toString('hex');
}

/**
 * Percent-encodes a string per RFC 3986 (required by OAuth 1.0a).
 * @param {string} str
 * @returns {string}
 */
function percentEncode(str) {
  return encodeURIComponent(str)
    .replace(/!/g,  '%21')
    .replace(/'/g,  '%27')
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29')
    .replace(/\*/g, '%2A');
}

/**
 * Builds the OAuth 1.0a Authorization header for a NetSuite TBA request.
 *
 * @param {string} method   HTTP method e.g. 'GET', 'POST'
 * @param {string} endpoint Full URL of the RESTlet or REST Web Service
 * @param {object} [extraParams={}] Additional query params to include in signature base
 * @returns {string} The full Authorization header value
 */
function generateAuthHeader(method, endpoint, extraParams = {}) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce     = generateNonce();

  // Base OAuth params
  const oauthParams = {
    oauth_consumer_key:     CONFIG.consumerKey,
    oauth_nonce:            nonce,
    oauth_signature_method: 'HMAC-SHA256',
    oauth_timestamp:        timestamp,
    oauth_token:            CONFIG.tokenId,
    oauth_version:          '1.0',
  };

  // Parse URL to separate base URL from query string params
  const parsedUrl  = new url.URL(endpoint);
  const baseUrl    = `${parsedUrl.protocol}//${parsedUrl.host}${parsedUrl.pathname}`;

  // Collect all params: oauth + query string + any extra
  const allParams = { ...oauthParams, ...extraParams };
  parsedUrl.searchParams.forEach((value, key) => {
    allParams[key] = value;
  });

  // Sort params alphabetically and build normalized param string
  const normalizedParams = Object.keys(allParams)
    .sort()
    .map(key => `${percentEncode(key)}=${percentEncode(allParams[key])}`)
    .join('&');

  // Build the signature base string
  const signatureBaseString = [
    method.toUpperCase(),
    percentEncode(baseUrl),
    percentEncode(normalizedParams),
  ].join('&');

  // Build the signing key
  const signingKey = `${percentEncode(CONFIG.consumerSecret)}&${percentEncode(CONFIG.tokenSecret)}`;

  // Generate HMAC-SHA256 signature
  const signature = crypto
    .createHmac('sha256', signingKey)
    .update(signatureBaseString)
    .digest('base64');

  // Build Authorization header
  const authHeader = 'OAuth ' + [
    `realm="${CONFIG.accountId}"`,
    `oauth_consumer_key="${oauthParams.oauth_consumer_key}"`,
    `oauth_token="${oauthParams.oauth_token}"`,
    `oauth_signature_method="${oauthParams.oauth_signature_method}"`,
    `oauth_timestamp="${oauthParams.oauth_timestamp}"`,
    `oauth_nonce="${oauthParams.oauth_nonce}"`,
    `oauth_version="${oauthParams.oauth_version}"`,
    `oauth_signature="${percentEncode(signature)}"`,
  ].join(', ');

  return authHeader;
}

/**
 * Makes an authenticated request to a NetSuite RESTlet or REST endpoint.
 *
 * @param {string} method       HTTP method: 'GET', 'POST', 'PUT', 'DELETE'
 * @param {string} endpoint     Full RESTlet URL
 * @param {object} [body=null]  Request body for POST/PUT (will be JSON stringified)
 * @returns {Promise<object>}   Parsed JSON response
 */
function makeRequest(method, endpoint, body = null) {
  return new Promise((resolve, reject) => {
    const authHeader = generateAuthHeader(method, endpoint);
    const parsedUrl  = new url.URL(endpoint);

    const payload = body ? JSON.stringify(body) : null;

    const options = {
      hostname: parsedUrl.hostname,
      path:     parsedUrl.pathname + parsedUrl.search,
      method:   method.toUpperCase(),
      headers:  {
        'Authorization': authHeader,
        'Content-Type':  'application/json',
        'Accept':        'application/json',
        ...(payload && { 'Content-Length': Buffer.byteLength(payload) }),
      },
    };

    console.log('\n--- Request ---');
    console.log(`${method.toUpperCase()} ${endpoint}`);
    console.log('Authorization:', authHeader);

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        console.log(`\n--- Response [${res.statusCode}] ---`);
        console.log(data);
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(parsed);
          } else {
            reject(new Error(`Request failed [${res.statusCode}]: ${JSON.stringify(parsed)}`));
          }
        } catch (e) {
          reject(new Error(`Failed to parse response: ${data}`));
        }
      });
    });

    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Main — run directly to test: node netsuite-auth.js
// Replace the test URL below with your actual RESTlet URL
// ---------------------------------------------------------------------------
if (require.main === module) {
  // Example RESTlet URL — update script and deploy numbers to match yours
  const testUrl = `https://${CONFIG.accountId}.restlets.api.netsuite.com/app/site/hosting/restlet.nl?script=YOUR_SCRIPT_ID&deploy=1`;

  console.log('Testing NetSuite TBA authentication...');
  console.log('Account ID:    ', CONFIG.accountId);
  console.log('Consumer Key:  ', CONFIG.consumerKey.substring(0, 8) + '...');
  console.log('Token ID:      ', CONFIG.tokenId.substring(0, 8) + '...');

  // Generate and display a sample auth header without making a live request
  console.log('\n--- Sample Authorization Header ---');
  const sampleHeader = generateAuthHeader('GET', testUrl);
  console.log(sampleHeader);

  // Uncomment below to make a live test request once credentials are configured:
  // makeRequest('GET', testUrl)
  //   .then(result => console.log('\nSuccess:', JSON.stringify(result, null, 2)))
  //   .catch(err   => console.error('\nError:', err.message));
}

// ---------------------------------------------------------------------------
// Module exports — import in your RESTlet client or other scripts
// ---------------------------------------------------------------------------
module.exports = { generateAuthHeader, makeRequest };