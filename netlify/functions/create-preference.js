// Netlify Function: crea una preferencia de pago en Mercado Pago (Checkout Pro).
//
// El navegador manda SOLO "qué producto, qué tamaño, qué color y cuántas unidades".
// Los precios NO se aceptan del cliente: acá se leen de Supabase (con la clave pública,
// que solo puede ver productos activos) y se recalcula todo con la misma lógica que
// js/cart.js (tamaño elegido + descuento por cantidad según el TOTAL de unidades de cada
// producto). El recargo de Mercado Pago también se decide acá.
//
// El Access Token de Mercado Pago vive SOLO acá (variable de entorno MP_ACCESS_TOKEN en
// Netlify), nunca en el HTML/JS del sitio.
//
// Variables de entorno (todas opcionales salvo MP_ACCESS_TOKEN):
//   SUPABASE_URL, SUPABASE_ANON_KEY  -> si no están, se usan los valores públicos de js/supabase-client.js
//   MP_RECARGO_PCT                   -> recargo de Mercado Pago en % (por defecto 8; debe coincidir con el checkout)
//   MP_SUCCESS_URL / MP_FAILURE_URL / MP_PENDING_URL, URL

'use strict';

const DEFAULT_SUPABASE_URL = 'https://elpckhakeiezcnahxmoz.supabase.co';
const DEFAULT_SUPABASE_ANON_KEY = 'sb_publishable_7F0HV4PNBbEmr7fb3ZTYdA_n9AdfzXa';
const DEFAULT_RECARGO_PCT = 8;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BODY_CHARS = 20000; // un carrito normal pesa unos pocos cientos de bytes
const MAX_LINES = 30;
const MAX_QTY_PER_LINE = 500;
const MAX_TEXT = 80;
const FETCH_TIMEOUT_MS = 8000;

class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code || 'ERROR';
  }
}

function reply(statusCode, obj) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
    body: JSON.stringify(obj),
  };
}

/* ---------- Entrada: validación estricta ---------- */

function cleanText(v) {
  if (typeof v !== 'string') return null;
  const s = v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, MAX_TEXT);
  return s || null;
}

function parseBody(event) {
  let raw = event.body || '';
  if (event.isBase64Encoded) raw = Buffer.from(raw, 'base64').toString('utf8');
  if (raw.length > MAX_BODY_CHARS) throw new HttpError(413, 'El pedido es demasiado grande.', 'TOO_BIG');
  try {
    const body = JSON.parse(raw);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('no object');
    return body;
  } catch (e) {
    throw new HttpError(400, 'No pudimos leer el pedido.', 'BAD_JSON');
  }
}

// Devuelve [{id, qty, size, color}]. Cualquier precio que venga en el body se ignora.
function parseCart(cart) {
  if (!Array.isArray(cart) || cart.length === 0) {
    throw new HttpError(400, 'El carrito está vacío.', 'EMPTY_CART');
  }
  if (cart.length > MAX_LINES) {
    throw new HttpError(400, 'El carrito tiene demasiados productos distintos. Hacé el pedido en dos partes.', 'TOO_MANY_LINES');
  }
  return cart.map((l) => {
    if (!l || typeof l !== 'object' || Array.isArray(l)) {
      throw new HttpError(400, 'Carrito inválido.', 'INVALID_LINE');
    }
    if (typeof l.id !== 'string' || !UUID_RE.test(l.id)) {
      // Formato viejo del checkout (mandaba nombre y precio, sin id): hay que recargar la página.
      const legacy = l.id === undefined && (l.precio !== undefined || l.nombre !== undefined);
      throw new HttpError(
        400,
        legacy
          ? 'Tu página quedó desactualizada. Recargala (Ctrl+Shift+R) e intentá de nuevo.'
          : 'Uno de los productos del carrito no es válido. Actualizá el carrito e intentá de nuevo.',
        legacy ? 'LEGACY_CART' : 'INVALID_ID'
      );
    }
    if (typeof l.qty !== 'number' || !Number.isInteger(l.qty) || l.qty < 1 || l.qty > MAX_QTY_PER_LINE) {
      throw new HttpError(400, 'Cantidad inválida. Cada producto admite de 1 a ' + MAX_QTY_PER_LINE + ' unidades por pedido.', 'INVALID_QTY');
    }
    return { id: l.id.toLowerCase(), qty: l.qty, size: cleanText(l.size), color: cleanText(l.color) };
  });
}

function recargoPct() {
  const raw = process.env.MP_RECARGO_PCT;
  if (raw === undefined || String(raw).trim() === '') return DEFAULT_RECARGO_PCT;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 && n <= 30 ? n : DEFAULT_RECARGO_PCT;
}

/* ---------- Precios: espejo de js/cart.js + js/supabase-client.js ---------- */

// Igual a stratoNormalizeTiers: [{from, pct}] ordenado, descartando escalones inválidos.
function normalizeTiers(rows) {
  return (Array.isArray(rows) ? rows : [])
    .map((r) => ({ from: Number(r && r.desde), pct: Number(r && r.descuento_pct) }))
    .filter((t) => t.from >= 2 && t.pct > 0 && t.pct < 100)
    .sort((a, b) => a.from - b.from);
}

// Igual al mapeo de supabase-client.js (fila de la base -> producto del sitio).
function mapProduct(p) {
  const price = p.precio == null ? null : Number(p.precio);
  return {
    id: String(p.id).toLowerCase(),
    name: String(p.nombre || 'Producto'),
    price: price == null || Number.isNaN(price) ? null : price,
    sizes: (Array.isArray(p.tamanos) ? p.tamanos : [])
      .map((t) => ({ name: String((t && t.nombre) || '').trim(), price: Number(t && t.precio) }))
      .filter((t) => t.name && !isNaN(t.price)),
    byQuantity: !!p.venta_por_cantidad,
    ownTiers: Array.isArray(p.escalones_propios) ? normalizeTiers(p.escalones_propios) : null,
  };
}

// stratoProductTiers
function productTiers(product, globalTiers) {
  if (!product.byQuantity) return [];
  const own = product.ownTiers && product.ownTiers.length ? product.ownTiers : null;
  return (own || globalTiers).slice().sort((a, b) => a.from - b.from);
}

// stratoTierFor: último escalón alcanzado por la cantidad TOTAL del producto.
function tierFor(product, globalTiers, totalQty) {
  let hit = null;
  productTiers(product, globalTiers).forEach((t) => {
    if (totalQty >= t.from) hit = t;
  });
  return hit;
}

// stratoFindSize: si el nombre ya no existe cae al primer tamaño; null si no tiene tamaños.
function findSize(product, sizeName) {
  if (!product.sizes.length) return null;
  return product.sizes.find((s) => s.name === sizeName) || product.sizes[0];
}

// stratoBasePrice: precio de lista de UNA unidad. null = a cotizar.
function basePrice(product, sizeName) {
  const size = findSize(product, sizeName);
  if (size) return size.price;
  return product.price;
}

// Calcula el pedido completo con los datos reales. `productsById` viene de Supabase.
function priceOrder(lines, productsById, globalTiers) {
  const totalByProduct = {};
  lines.forEach((l) => {
    totalByProduct[l.id] = (totalByProduct[l.id] || 0) + l.qty;
  });

  const priced = lines.map((l) => {
    const product = productsById[l.id];
    if (!product) {
      throw new HttpError(422, 'Uno de los productos del carrito ya no está disponible. Actualizá el carrito e intentá de nuevo.', 'PRODUCT_UNAVAILABLE');
    }
    const size = findSize(product, l.size);
    const tier = tierFor(product, globalTiers, totalByProduct[l.id]);
    const unitBase = basePrice(product, l.size);
    if (unitBase == null) {
      throw new HttpError(422, '"' + product.name + '" se cotiza a medida, no se puede pagar online. Consultalo por WhatsApp.', 'PRICE_ON_REQUEST');
    }
    const unit = tier ? Math.round(unitBase * (1 - tier.pct / 100)) : unitBase;
    if (!Number.isFinite(unit) || unit <= 0) {
      throw new HttpError(422, 'No pudimos calcular el precio de "' + product.name + '". Consultalo por WhatsApp.', 'PRICE_INVALID');
    }
    return {
      id: l.id,
      name: product.name,
      size: size ? size.name : null,
      color: l.color,
      qty: l.qty,
      unitBase,
      pct: tier ? tier.pct : 0,
      unit,
      lineTotal: unit * l.qty,
    };
  });

  const subtotal = priced.reduce((sum, l) => sum + l.lineTotal, 0);
  return { lines: priced, subtotal };
}

/* ---------- Supabase (lectura pública) ---------- */

async function fetchWithTimeout(url, options, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, Object.assign({}, options, { signal: ctrl.signal }));
  } finally {
    clearTimeout(timer);
  }
}

function sbHeaders(key) {
  const h = { apikey: key, Accept: 'application/json' };
  // Las claves nuevas ("sb_publishable_...") van solo en apikey; las JWT viejas también como Bearer.
  if (!key.startsWith('sb_')) h.Authorization = 'Bearer ' + key;
  return h;
}

async function sbSelect(base, key, path) {
  const resp = await fetchWithTimeout(base + '/rest/v1/' + path, { headers: sbHeaders(key) }, FETCH_TIMEOUT_MS);
  if (!resp.ok) {
    const err = new Error('Supabase respondió ' + resp.status);
    err.status = resp.status;
    throw err;
  }
  return resp.json();
}

async function loadCatalogData(ids) {
  const base = (process.env.SUPABASE_URL || DEFAULT_SUPABASE_URL).replace(/\/+$/, '');
  const key = process.env.SUPABASE_ANON_KEY || DEFAULT_SUPABASE_ANON_KEY;
  try {
    const [rows, tierRows] = await Promise.all([
      // select=* a propósito: si todavía no se corrió la migración v7 faltan columnas y no queremos fallar.
      // Solo productos activos (la política RLS pública también lo exige).
      sbSelect(base, key, 'productos?select=*&activo=eq.true&id=in.(' + ids.join(',') + ')'),
      // Los escalones globales son opcionales: si la tabla no existe (migración v7 sin correr) se ignoran,
      // igual que hace el sitio. Cualquier otro error corta el pago (mejor que cobrar sin el descuento).
      sbSelect(base, key, 'escalones_cantidad?select=desde,descuento_pct&order=desde.asc').catch((e) => {
        if (e && (e.status === 404 || e.status === 400)) return [];
        throw e;
      }),
    ]);
    const productsById = {};
    (Array.isArray(rows) ? rows : []).forEach((r) => {
      if (r && r.id) productsById[String(r.id).toLowerCase()] = mapProduct(r);
    });
    return { productsById, globalTiers: normalizeTiers(tierRows) };
  } catch (e) {
    console.error('create-preference: no se pudo leer Supabase:', e && e.message);
    throw new HttpError(502, 'No pudimos verificar los precios en este momento. Probá de nuevo en unos segundos.', 'CATALOG_UNAVAILABLE');
  }
}

/* ---------- Mercado Pago ---------- */

function itemTitle(l) {
  let t = l.size ? l.name + ' — ' + l.size : l.name;
  if (l.color) t += ' (' + l.color + ')';
  return t.slice(0, 200);
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return reply(405, { error: 'Método no permitido.', code: 'METHOD_NOT_ALLOWED' });
  }

  const ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;
  const SITE_URL = process.env.URL || 'https://storgelab.netlify.app';
  const SUCCESS_URL = process.env.MP_SUCCESS_URL || `${SITE_URL}/gracias.html?estado=success`;
  const FAILURE_URL = process.env.MP_FAILURE_URL || `${SITE_URL}/gracias.html?estado=failure`;
  const PENDING_URL = process.env.MP_PENDING_URL || `${SITE_URL}/gracias.html?estado=pending`;

  if (!ACCESS_TOKEN) {
    console.error('create-preference: falta MP_ACCESS_TOKEN');
    return reply(500, { error: 'El pago online no está configurado todavía.', code: 'NOT_CONFIGURED' });
  }

  try {
    const body = parseBody(event);
    const requested = parseCart(body.cart); // el body.recargoPct y cualquier "precio" del cliente se ignoran

    const ids = Array.from(new Set(requested.map((l) => l.id)));
    const { productsById, globalTiers } = await loadCatalogData(ids);
    const order = priceOrder(requested, productsById, globalTiers);

    // El recargo de Mercado Pago va como un ítem aparte (en vez de inflar cada precio
    // unitario) para que quede claro y transparente en el resumen de MP.
    const pct = recargoPct();
    const recargo = Math.round(order.subtotal * (pct / 100)); // misma fórmula que checkout.html
    const total = order.subtotal + recargo;

    const items = order.lines.map((l) => ({
      title: itemTitle(l),
      quantity: l.qty,
      unit_price: l.unit,
      currency_id: 'UYU',
    }));
    if (recargo > 0) {
      items.push({
        title: `Recargo Mercado Pago (${pct}%)`,
        quantity: 1,
        unit_price: recargo,
        currency_id: 'UYU',
      });
    }

    const preference = {
      items,
      back_urls: { success: SUCCESS_URL, failure: FAILURE_URL, pending: PENDING_URL },
      auto_return: 'approved',
      statement_descriptor: 'STORGE LAB',
    };

    let resp, data;
    try {
      resp = await fetchWithTimeout(
        'https://api.mercadopago.com/checkout/preferences',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ACCESS_TOKEN}` },
          body: JSON.stringify(preference),
        },
        10000
      );
      data = await resp.json();
    } catch (e) {
      console.error('create-preference: error de red con Mercado Pago:', e && e.message);
      throw new HttpError(502, 'No pudimos conectar con Mercado Pago. Probá de nuevo en unos segundos.', 'MP_UNREACHABLE');
    }

    if (!resp.ok || !data || !data.init_point) {
      console.error('create-preference: Mercado Pago rechazó la preferencia:', resp.status, JSON.stringify(data).slice(0, 500));
      throw new HttpError(502, 'Mercado Pago no pudo generar el link de pago. Probá de nuevo o elegí Transferencia bancaria.', 'MP_ERROR');
    }

    return reply(200, {
      init_point: data.init_point,
      id: data.id,
      // Lo que realmente se va a cobrar: el checkout lo compara con lo que mostró en pantalla.
      subtotal: order.subtotal,
      recargo,
      recargoPct: pct,
      total,
    });
  } catch (err) {
    if (err instanceof HttpError) {
      return reply(err.status, { error: err.message, code: err.code });
    }
    console.error('create-preference: error inesperado:', err && err.stack ? err.stack : err);
    return reply(500, { error: 'Ocurrió un error inesperado. Probá de nuevo en unos segundos.', code: 'INTERNAL' });
  }
};

// Solo para los tests (Netlify ignora todo lo que no sea `handler`).
exports._internals = { parseCart, priceOrder, mapProduct, normalizeTiers, tierFor, findSize, basePrice, recargoPct };
