# Complab 5 – Multi-Container Shop with Docker Compose and RabbitMQ

A small online shop split into microservices. Services talk to each other through events on a RabbitMQ topic exchange. The whole stack is defined in one `docker-compose.yml`.

## Tech stack

| Part | Language / framework |
| --- | --- |
| Frontend | HTML, CSS and JavaScript served by Nginx |
| API Gateway | Node.js + Express |
| Order, Payment, Inventory and Notification services | Node.js + Express + amqplib |
| Message broker | RabbitMQ 3 (with the management plugin) |

## Services

| Container | Port | What it does |
| --- | --- | --- |
| `frontend` | 3000 | Shop page: place orders, view live stock, order status and notifications |
| `api-gateway` | 8080 | Single entry point for the frontend; routes `/api/*` to the services |
| `order-service` | internal | Creates orders, publishes `order.placed`, tracks each order's status |
| `payment-service` | internal | Charges new orders, publishes `payment.success` or `payment.failed` |
| `inventory-service` | internal | Owns products and stock, reserves stock after payment |
| `notification-service` | internal | Sends a (simulated) email for every event |
| `message-broker` | 5672, 15672 | RabbitMQ broker and management console |

## Event flow

All events go through the `shop.events` topic exchange.

```
frontend → api-gateway → order-service ──order.placed──▶ payment-service
                                                             │
                                                      payment.success
                                                             ▼
                                                     inventory-service ──inventory.reserved──▶ order confirmed
```

| Routing key | Published by | Consumed by (queue) |
| --- | --- | --- |
| `order.placed` | order-service | payment-service (`payment_queue`), notification-service (`notification_queue`) |
| `payment.success` | payment-service | inventory-service (`inventory_queue`), order-service (`order_status_queue`), notification-service |
| `payment.failed` | payment-service | order-service, notification-service |
| `inventory.reserved` | inventory-service | order-service, notification-service |
| `inventory.failed` | inventory-service | order-service, notification-service |

## Running the project

Requires Docker Desktop.

```bash
# Build the images and start every container
docker compose up --build -d

# Follow the logs of the event-driven services
docker compose logs -f order-service payment-service inventory-service notification-service

# Stop and remove the containers and network
docker compose down
```

Orders, stock and notifications are kept in memory, so they reset whenever the containers restart.

## Testing

### Frontend

1. Open http://localhost:3000. The badge in the top right should say **Connected to API gateway**.
2. Fill in the form and place an order. Its status changes from **Pending payment** to **Paid** to **Confirmed** within a few seconds. The product's stock goes down, and a notification appears for each step.
3. Try the failure paths:
   - **Payment failed:** order 2 Gaming Laptops (₱130,000). The payment service declines orders over ₱100,000.
   - **Out of stock:** quickly place two orders for 8 × 24" IPS Monitor (only 8 in stock). The first is confirmed and the second is marked **Out of stock, refunded**.

### RabbitMQ management console

1. Open http://localhost:15672 and log in with `guest` / `guest`.
2. Under **Exchanges**, open `shop.events`. The bindings list includes `order.placed` (to `payment_queue`) and `payment.success` (to `inventory_queue`).
3. Under **Queues**, you'll see `payment_queue`, `inventory_queue`, `order_status_queue` and `notification_queue`.

## Project structure

```
complab-5-Regolto/
├── api-gateway/            Dockerfile, package.json, server.js
├── frontend/               Dockerfile, nginx.conf, public/ (index.html, styles.css, app.js)
├── inventory-service/      Dockerfile, index.js, package.json
├── notification-service/   Dockerfile, index.js, package.json
├── order-service/          Dockerfile, index.js, package.json
├── payment-service/        Dockerfile, index.js, package.json
└── docker-compose.yml
```
