const express = require('express');
const amqp = require('amqplib');

const PORT = process.env.PORT || 3000;
const BROKER_URL = process.env.BROKER_URL || 'amqp://guest:guest@localhost:5672';
const EXCHANGE = 'shop.events';
const QUEUE = 'notification_queue';
const MAX_NOTIFICATIONS = 50;

const peso = new Intl.NumberFormat('en-PH', { style: 'currency', currency: 'PHP' });
const shortId = (id) => id.slice(0, 8).toUpperCase();

// The message sent to the customer for each event this service subscribes to.
const MESSAGES = {
  'order.placed': (o) =>
    `Hi ${o.customerName}, we received order #${shortId(o.id)} for ${o.quantity} x ${o.productName}.`,
  'payment.success': (o) =>
    `Payment of ${peso.format(o.total)} for order #${shortId(o.id)} was successful.`,
  'payment.failed': (o) => `Payment for order #${shortId(o.id)} was declined. ${o.reason}.`,
  'inventory.reserved': (o) =>
    `Order #${shortId(o.id)} is confirmed and is being prepared for shipping.`,
  'inventory.failed': (o) =>
    `Sorry, order #${shortId(o.id)} could not be completed. ${o.reason}.`,
};

// Most recent notifications first, kept in memory.
const notifications = [];

const app = express();

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.get('/notifications', (req, res) => res.json(notifications));

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
  for (const routingKey of Object.keys(MESSAGES)) {
    await channel.bindQueue(QUEUE, EXCHANGE, routingKey);
  }

  await channel.consume(QUEUE, (msg) => {
    let order;
    try {
      order = JSON.parse(msg.content.toString());
    } catch {
      console.error('Discarding malformed message');
      return channel.nack(msg, false, false);
    }

    const event = msg.fields.routingKey;
    const notification = {
      event,
      orderId: order.id,
      to: order.email,
      message: MESSAGES[event](order),
      sentAt: new Date().toISOString(),
    };

    notifications.unshift(notification);
    notifications.length = Math.min(notifications.length, MAX_NOTIFICATIONS);
    console.log(`[EMAIL to ${notification.to}] ${notification.message}`);
    channel.ack(msg);
  });

  app.listen(PORT, () => console.log(`Notification service listening on port ${PORT}`));
}

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));

start().catch((err) => {
  console.error(err);
  process.exit(1);
});
