const express = require('express');
const amqp = require('amqplib');

const PORT = process.env.PORT || 3000;
const BROKER_URL = process.env.BROKER_URL || 'amqp://guest:guest@localhost:5672';
const EXCHANGE = 'shop.events';
const QUEUE = 'inventory_queue';

// In-memory catalog; stock resets when the container restarts. Prices are in PHP.
const products = new Map(
  [
    { id: 'P-001', name: 'Wireless Mouse', price: 850, stock: 25 },
    { id: 'P-002', name: 'Mechanical Keyboard', price: 3200, stock: 15 },
    { id: 'P-003', name: 'USB-C Hub', price: 1450, stock: 20 },
    { id: 'P-004', name: 'Noise-Cancelling Headphones', price: 4999, stock: 10 },
    { id: 'P-005', name: '24" IPS Monitor', price: 8500, stock: 8 },
    { id: 'P-006', name: 'Gaming Laptop', price: 65000, stock: 3 },
  ].map((product) => [product.id, product]),
);

const app = express();

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.get('/products', (req, res) => res.json([...products.values()]));

app.get('/products/:id', (req, res) => {
  const product = products.get(req.params.id);
  if (!product) return res.status(404).json({ error: 'Product not found' });
  res.json(product);
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
  const channel = await connection.createChannel();

  await channel.assertExchange(EXCHANGE, 'topic', { durable: true });
  await channel.assertQueue(QUEUE, { durable: true });
  await channel.bindQueue(QUEUE, EXCHANGE, 'payment.success');

  const publish = (routingKey, payload) =>
    channel.publish(EXCHANGE, routingKey, Buffer.from(JSON.stringify(payload)), {
      persistent: true,
      contentType: 'application/json',
    });

  // Stock is only reserved once the order has been paid for.
  await channel.consume(QUEUE, (msg) => {
    let order;
    try {
      order = JSON.parse(msg.content.toString());
    } catch {
      console.error('Discarding malformed message');
      return channel.nack(msg, false, false);
    }

    const product = products.get(order.productId);
    if (product && product.stock >= order.quantity) {
      product.stock -= order.quantity;
      publish('inventory.reserved', { ...order, remainingStock: product.stock });
      console.log(`Reserved ${order.quantity} x ${product.name} for order ${order.id} (${product.stock} left)`);
    } else {
      publish('inventory.failed', {
        ...order,
        reason: `Not enough ${order.productName} in stock, payment will be refunded`,
      });
      console.log(`Not enough stock for order ${order.id}, published inventory.failed`);
    }
    channel.ack(msg);
  });

  app.listen(PORT, () => console.log(`Inventory service listening on port ${PORT}`));
}

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));

start().catch((err) => {
  console.error(err);
  process.exit(1);
});
