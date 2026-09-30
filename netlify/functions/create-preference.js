// Netlify Function: crea una preferencia de pago en Mercado Pago (Checkout Pro)
// El Access Token vive SOLO acá (variable de entorno en Netlify), nunca en el HTML/JS del sitio.

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;
  const SITE_URL = process.env.URL || 'https://storgelab.netlify.app';
  const SUCCESS_URL = process.env.MP_SUCCESS_URL || `${SITE_URL}/gracias.html?estado=success`;
  const FAILURE_URL = process.env.MP_FAILURE_URL || `${SITE_URL}/gracias.html?estado=failure`;
  const PENDING_URL = process.env.MP_PENDING_URL || `${SITE_URL}/gracias.html?estado=pending`;

  if (!ACCESS_TOKEN) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Falta configurar MP_ACCESS_TOKEN en Netlify' }) };
  }

  let cart, recargoPct;
  try {
    const body = JSON.parse(event.body);
    cart = body.cart;
    recargoPct = Number(body.recargoPct) || 0;
    if (!Array.isArray(cart) || cart.length === 0) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Carrito vacío' }) };
    }
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Body inválido' }) };
  }

  // Armamos los items para Mercado Pago a partir del carrito recibido.
  // Nota: el precio viene del carrito del cliente (localStorage), tomado de lo que
  // muestra la web en ese momento — no hay una base de datos de precios server-side todavía.
  const items = cart.map((item) => ({
    title: item.color ? `${item.nombre} (${item.color})` : String(item.nombre || 'Producto'),
    quantity: Number(item.qty) || 1,
    unit_price: Number(item.precio) || 0,
    currency_id: 'UYU',
  }));

  // El recargo de Mercado Pago se agrega como un ítem aparte (en vez de inflar
  // cada precio unitario) para que quede claro y transparente en el resumen de MP.
  const subtotal = items.reduce((sum, it) => sum + it.quantity * it.unit_price, 0);
  const recargo = Math.round(subtotal * (recargoPct / 100));
  if (recargo > 0) {
    items.push({
      title: `Recargo Mercado Pago (${recargoPct}%)`,
      quantity: 1,
      unit_price: recargo,
      currency_id: 'UYU',
    });
  }

  const preference = {
    items,
    back_urls: {
      success: SUCCESS_URL,
      failure: FAILURE_URL,
      pending: PENDING_URL,
    },
    auto_return: 'approved',
    statement_descriptor: 'STORGE LAB',
  };

  try {
    const resp = await fetch('https://api.mercadopago.com/checkout/preferences', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ACCESS_TOKEN}`,
      },
      body: JSON.stringify(preference),
    });

    const data = await resp.json();

    if (!resp.ok) {
      return { statusCode: resp.status, body: JSON.stringify({ error: data }) };
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ init_point: data.init_point, id: data.id }),
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
