const amqp = require('amqplib');
const { randomUUID } = require('node:crypto');

const BROKER_URL = process.env.BROKER_URL || 'amqp://guest:guest@localhost:5672';
const EXCHANGE = 'shop.events';
const QUEUE = 'payment_queue';

// Simulated card limit: orders above this amount are declined so payment.failed can be demonstrated.
const PAYMENT_LIMIT = 100000;
const PROCESSING_DELAY_MS = 1500;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
      await sleep(3000);
    }
  }
}

async function start() {
  const connection = await connectToBroker();
  const channel = await connection.createChannel();

  await channel.assertExchange(EXCHANGE, 'topic', { durable: true });
  await channel.assertQueue(QUEUE, { durable: true });
  await channel.bindQueue(QUEUE, EXCHANGE, 'order.placed');
  await channel.prefetch(5);

  const publish = (routingKey, payload) =>
    channel.publish(EXCHANGE, routingKey, Buffer.from(JSON.stringify(payload)), {
      persistent: true,
      contentType: 'application/json',
    });

  await channel.consume(QUEUE, async (msg) => {
    let order;
    try {
      order = JSON.parse(msg.content.toString());
    } catch {
      console.error('Discarding malformed message');
      return channel.nack(msg, false, false);
    }

    console.log(`Processing payment for order ${order.id} (PHP ${order.total})`);
    await sleep(PROCESSING_DELAY_MS);

    if (order.total > PAYMENT_LIMIT) {
      publish('payment.failed', {
        ...order,
        reason: `Amount is over the PHP ${PAYMENT_LIMIT.toLocaleString('en-PH')} limit`,
      });
      console.log(`Payment declined for order ${order.id}, published payment.failed`);
    } else {
      publish('payment.success', { ...order, paymentId: randomUUID(), paidAt: new Date().toISOString() });
      console.log(`Payment approved for order ${order.id}, published payment.success`);
    }
    channel.ack(msg);
  });

  console.log(`Payment service is listening for order.placed on ${QUEUE}`);
}

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));

start().catch((err) => {
  console.error(err);
  process.exit(1);
});
