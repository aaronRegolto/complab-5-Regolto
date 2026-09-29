const express = require('express');
const amqp = require('amqplib');
const { randomUUID } = require('node:crypto');

const PORT = process.env.PORT || 3000;
const BROKER_URL = process.env.BROKER_URL || 'amqp://guest:guest@localhost:5672';
const INVENTORY_SERVICE_URL = process.env.INVENTORY_SERVICE_URL || 'http://localhost:3002';
const EXCHANGE = 'shop.events';
const QUEUE = 'order_status_queue';

// Events from the other services and the order status each one moves the order to.
const STATUS_BY_EVENT = {
  'payment.success': 'PAID',
  'payment.failed': 'PAYMENT_FAILED',
  'inventory.reserved': 'CONFIRMED',
  'inventory.failed': 'OUT_OF_STOCK',
};

// In-memory store; orders are cleared when the container restarts.
const orders = new Map();
let channel;

function publish(routingKey, payload) {
  channel.publish(EXCHANGE, routingKey, Buffer.from(JSON.stringify(payload)), {
    persistent: true,
    contentType: 'application/json',
  });
}

const isNonEmptyString = (value) => typeof value === 'string' && value.trim() !== '';

const app = express();
app.use(express.json());

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.get('/orders', (req, res) => {
  const newestFirst = [...orders.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  res.json(newestFirst);
});

app.post('/orders', async (req, res) => {
  const { customerName, email, productId } = req.body ?? {};
  const quantity = Number(req.body?.quantity);

  if (!isNonEmptyString(customerName) || !isNonEmptyString(email) || !isNonEmptyString(productId)) {
    return res.status(400).json({ error: 'Name, email and product are required' });
  }
  if (!Number.isInteger(quantity) || quantity < 1) {
    return res.status(400).json({ error: 'Quantity must be a whole number of at least 1' });
  }

  // Price and stock come from the inventory service, so the client can't set its own total.
  let product;
  try {
    const response = await fetch(`${INVENTORY_SERVICE_URL}/products/${encodeURIComponent(productId)}`, {
      signal: AbortSignal.timeout(5000),
    });
    if (response.status === 404) return res.status(404).json({ error: 'Product not found' });
    if (!response.ok) throw new Error(`inventory service responded with ${response.status}`);
    product = await response.json();
  } catch (err) {
    console.error(`Product lookup failed: ${err.message}`);
    return res.status(502).json({ error: 'Inventory service is unavailable' });
  }

  if (product.stock < quantity) {
    return res.status(409).json({ error: `Only ${product.stock} ${product.name} left in stock` });
  }

  const now = new Date().toISOString();
  const order = {
    id: randomUUID(),
    customerName: customerName.trim(),
    email: email.trim(),
    productId: product.id,
    productName: product.name,
    quantity,
    unitPrice: product.price,
    total: product.price * quantity,
    status: 'PENDING',
    createdAt: now,
    updatedAt: now,
  };

  orders.set(order.id, order);
  publish('order.placed', order);
  console.log(`Order ${order.id} placed, published order.placed`);

  res.status(201).json(order);
});

async function connectToBroker() {
  for (let attempt = 1; ; attempt++) {
    try {
      const connection = await amqp.connect(BROKER_URL);
      connection.on('error', (err) => console.error(`RabbitMQ connection error: ${err.message}`));
      connection.on('close', () => {
        console.error('Lost connection to RabbitMQ, exiting so Docker restarts the service');
        process.exit(1);
      });
      return connection;
    } catch (err) {
      console.log(`Waiting for RabbitMQ (attempt ${attempt}): ${err.message}`);
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }
}

async function start() {
  const connection = await connectToBroker();
  channel = await connection.createChannel();

  await channel.assertExchange(EXCHANGE, 'topic', { durable: true });
  await channel.assertQueue(QUEUE, { durable: true });
  for (const routingKey of Object.keys(STATUS_BY_EVENT)) {
    await channel.bindQueue(QUEUE, EXCHANGE, routingKey);
  }

  await channel.consume(QUEUE, (msg) => {
    let event;
    try {
      event = JSON.parse(msg.content.toString());
    } catch {
      console.error('Discarding malformed message');
      return channel.nack(msg, false, false);
    }

    const order = orders.get(event.id);
    if (order) {
      order.status = STATUS_BY_EVENT[msg.fields.routingKey];
      order.updatedAt = new Date().toISOString();
      if (event.reason) order.reason = event.reason;
      console.log(`Order ${order.id} is now ${order.status} (${msg.fields.routingKey})`);
    }
    channel.ack(msg);
  });

  app.listen(PORT, () => console.log(`Order service listening on port ${PORT}`));
}

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));

start().catch((err) => {
  console.error(err);
  process.exit(1);
});
