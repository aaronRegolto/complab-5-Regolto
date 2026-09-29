const express = require('express');
const cors = require('cors');

const PORT = process.env.PORT || 8080;
const ORDER_SERVICE_URL = process.env.ORDER_SERVICE_URL || 'http://localhost:3001';
const INVENTORY_SERVICE_URL = process.env.INVENTORY_SERVICE_URL || 'http://localhost:3002';
const NOTIFICATION_SERVICE_URL = process.env.NOTIFICATION_SERVICE_URL || 'http://localhost:3003';
const CORS_ORIGIN = process.env.CORS_ORIGIN || 'http://localhost:3000';

const app = express();
app.use(cors({ origin: CORS_ORIGIN }));
app.use(express.json());

// Sends the request to a backend service and relays its status code and body back to the client.
async function forward(res, url, options = {}) {
  try {
    const response = await fetch(url, { ...options, signal: AbortSignal.timeout(5000) });
    const body = await response.text();
    res
      .status(response.status)
      .type(response.headers.get('content-type') || 'application/json')
      .send(body);
  } catch (err) {
    console.error(`Request to ${url} failed: ${err.message}`);
    res.status(502).json({ error: 'Service is unavailable, please try again shortly' });
  }
}

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.get('/api/products', (req, res) => forward(res, `${INVENTORY_SERVICE_URL}/products`));

app.get('/api/orders', (req, res) => forward(res, `${ORDER_SERVICE_URL}/orders`));

app.post('/api/orders', (req, res) =>
  forward(res, `${ORDER_SERVICE_URL}/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req.body ?? {}),
  }),
);

app.get('/api/notifications', (req, res) =>
  forward(res, `${NOTIFICATION_SERVICE_URL}/notifications`),
);

app.use((req, res) => res.status(404).json({ error: 'Route not found' }));

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));

app.listen(PORT, () => console.log(`API gateway listening on port ${PORT}`));
