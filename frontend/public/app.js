// The browser talks to the API gateway, which is published on port 8080 of the same host.
const API_URL = `http://${location.hostname}:8080/api`;
const REFRESH_MS = 2000;

const peso = new Intl.NumberFormat('en-PH', { style: 'currency', currency: 'PHP' });

const STATUS = {
  PENDING: { label: 'Pending payment', tone: 'pending' },
  PAID: { label: 'Paid, reserving stock', tone: 'info' },
  CONFIRMED: { label: 'Confirmed', tone: 'success' },
  PAYMENT_FAILED: { label: 'Payment failed', tone: 'danger' },
  OUT_OF_STOCK: { label: 'Out of stock, refunded', tone: 'danger' },
};

const form = document.getElementById('order-form');
const productSelect = document.getElementById('product-select');
const submitButton = document.getElementById('submit-button');
const formMessage = document.getElementById('form-message');

const shortId = (id) => `#${id.slice(0, 8).toUpperCase()}`;
const formatTime = (iso) => new Date(iso).toLocaleTimeString();

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

async function api(path, options) {
  const response = await fetch(API_URL + path, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Request failed with status ${response.status}`);
  return body;
}

function showMessage(text, tone) {
  formMessage.textContent = text;
  formMessage.className = `form-message ${tone}`;
  formMessage.hidden = false;
}

function setConnection(online) {
  const badge = document.getElementById('connection');
  badge.textContent = online ? 'Connected to API gateway' : 'Cannot reach API gateway on port 8080';
  badge.className = `connection ${online ? 'online' : 'offline'}`;
}

let productIds = '';

function renderProducts(products) {
  // Only rebuild the dropdown when the catalog changes, so it doesn't reset while someone is using it.
  const ids = products.map((p) => p.id).join(',');
  if (ids !== productIds) {
    productIds = ids;
    const selected = productSelect.value;
    productSelect.replaceChildren(
      ...products.map((p) => {
        const option = el('option', '', `${p.name} (${peso.format(p.price)})`);
        option.value = p.id;
        return option;
      }),
    );
    if (products.some((p) => p.id === selected)) productSelect.value = selected;
  }

  const list = document.getElementById('products');
  list.replaceChildren(
    ...products.map((p) => {
      const button = el('button', 'product');
      button.type = 'button';
      button.addEventListener('click', () => {
        productSelect.value = p.id;
        form.elements.quantity.focus();
      });

      const stockTone = p.stock === 0 ? 'danger' : p.stock <= 3 ? 'pending' : 'muted';
      const stockText = p.stock === 0 ? 'Out of stock' : `${p.stock} in stock`;
      button.append(
        el('span', 'product-name', p.name),
        el('span', 'product-price', peso.format(p.price)),
        el('span', `product-stock ${stockTone}`, stockText),
      );

      const item = el('li');
      item.append(button);
      return item;
    }),
  );
}

function renderOrders(orders) {
  document.getElementById('orders-empty').hidden = orders.length > 0;
  document.getElementById('orders').replaceChildren(
    ...orders.map((order) => {
      const status = STATUS[order.status] ?? { label: order.status, tone: 'muted' };
      const row = el('tr');

      const idCell = el('td');
      idCell.append(el('span', 'mono', shortId(order.id)), el('span', 'small', formatTime(order.createdAt)));

      const customerCell = el('td');
      customerCell.append(el('span', '', order.customerName), el('span', 'small', order.email));

      const statusCell = el('td');
      statusCell.append(el('span', `badge ${status.tone}`, status.label));
      if (order.reason) statusCell.append(el('span', 'small', order.reason));

      row.append(
        idCell,
        customerCell,
        el('td', '', `${order.quantity} × ${order.productName}`),
        el('td', 'num', peso.format(order.total)),
        statusCell,
      );
      return row;
    }),
  );
}

function renderNotifications(notifications) {
  document.getElementById('notifications-empty').hidden = notifications.length > 0;
  document.getElementById('notifications').replaceChildren(
    ...notifications.map((n) => {
      const item = el('li');
      const meta = el('div', 'notification-meta');
      meta.append(el('code', '', n.event), el('span', 'small', `${formatTime(n.sentAt)} · to ${n.to}`));
      item.append(meta, el('p', '', n.message));
      return item;
    }),
  );
}

async function refresh() {
  try {
    const [products, orders, notifications] = await Promise.all([
      api('/products'),
      api('/orders'),
      api('/notifications'),
    ]);
    renderProducts(products);
    renderOrders(orders);
    renderNotifications(notifications);
    setConnection(true);
  } catch (err) {
    console.error(err);
    setConnection(false);
  }
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const data = new FormData(form);
  submitButton.disabled = true;

  try {
    const order = await api('/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        customerName: data.get('customerName'),
        email: data.get('email'),
        productId: data.get('productId'),
        quantity: Number(data.get('quantity')),
      }),
    });
    showMessage(`Order ${shortId(order.id)} placed. Watch its status update in the Orders list.`, 'success');
    form.elements.quantity.value = 1;
    refresh();
  } catch (err) {
    showMessage(err.message, 'danger');
  } finally {
    submitButton.disabled = false;
  }
});

refresh();
setInterval(refresh, REFRESH_MS);
