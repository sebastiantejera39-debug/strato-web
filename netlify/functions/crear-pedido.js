// Netlify Function: crea un pedido en Supabase DESDE EL SERVIDOR.
//
// Antes el navegador del cliente insertaba el pedido directo en la tabla `pedidos` con la clave
// pública, así que cualquiera podía cargar pedidos falsos (con el subtotal, el estado o el contenido
// que quisiera). Ahora el navegador manda SOLO "qué producto, tamaño, color, cantidad y nota" más los
// datos de contacto; acá se recalcula todo con la MISMA lógica que create-preference.js (y que
// js/cart.js) leyendo los precios reales de Supabase, y se guarda con la llave de servicio.
// El estado siempre es "nuevo" y el canal siempre es "web". Lo demás que mande el cliente se ignora.
//
// Además copia a cada ítem el COSTO de fabricación de ese producto y tamaño (tabla privada
// `producto_costos`, que solo se puede leer con la llave de servicio): queda como una "foto" del costo
// al momento de la venta, así el Dashboard calcula la ganancia aunque después cambies el costo.
// Si esa tabla todavía no existe o no se puede leer, el pedido se guarda igual, sin costo.
//
// Una vez probado, se corre supabase/cerrar_pedidos_publicos.sql, que le quita al público la
// posibilidad de insertar en `pedidos`: desde ahí esta función es la única puerta de entrada.
//
// Variables de entorno:
//   SUPABASE_SERVICE_ROLE_KEY  -> la misma que ya usa Mercado Libre (obligatoria; NUNCA va en el sitio)
//   SUPABASE_URL, SUPABASE_ANON_KEY -> opcionales; por defecto los públicos de js/supabase-client.js

'use strict';

const pref = require('./create-preference.js')._internals;

const { parseCart, priceOrder, basePrice, findSize, loadCatalogData, fetchWithTimeout, parseBody, reply, HttpError } = pref;

const MAX_NAME = 80;
const MAX_PHONE = 40;
const MAX_EMAIL = 120;
const MAX_ENTREGA = 120;
const MAX_DIRECCION = 200;
const MAX_NOTAS = 1000;
const MAX_NOTA_LINEA = 300;
const PAGOS = { 'mercado pago': 'Mercado Pago', 'transferencia bancaria': 'Transferencia bancaria' };

/* ---------- Entrada ---------- */

// Texto de una línea: sin caracteres de control, recortado, null si queda vacío.
function clean(v, max) {
  if (typeof v !== 'string') return null;
  const s = v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
  return s || null;
}

// Texto con saltos de línea (notas): conserva \n, quita el resto de los controles.
function cleanMultiline(v, max) {
  if (typeof v !== 'string') return null;
  const s = v
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ')
    .trim()
    .slice(0, max);
  return s || null;
}

function parseDatos(body) {
  const nombre = clean(body.cliente_nombre, MAX_NAME);
  const telefono = clean(body.cliente_telefono, MAX_PHONE);
  const entrega = clean(body.entrega, MAX_ENTREGA);
  if (!nombre) throw new HttpError(400, 'Falta el nombre.', 'MISSING_NAME');
  if (!telefono) throw new HttpError(400, 'Falta el contacto.', 'MISSING_PHONE');
  if (!entrega) throw new HttpError(400, 'Falta la forma de entrega.', 'MISSING_DELIVERY');
  let email = clean(body.cliente_email, MAX_EMAIL);
  if (email && !/^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/.test(email)) email = null; // email opcional: si es raro, se descarta
  const pagoKey = typeof body.pago === 'string' ? body.pago.trim().toLowerCase() : '';
  return {
    cliente_nombre: nombre,
    cliente_telefono: telefono,
    cliente_email: email,
    entrega,
    direccion: clean(body.direccion, MAX_DIRECCION),
    pago: PAGOS[pagoKey] || null, // solo los dos medios de pago que existen en el checkout
    notas: cleanMultiline(body.notas, MAX_NOTAS),
  };
}

/* ---------- Items con precios reales ---------- */

function buildItems(requested, productsById, globalTiers) {
  // Los productos "a cotizar" (sin precio) se guardan sin precio y no suman al subtotal:
  // el checkout por transferencia los deja pasar (se coordinan por WhatsApp).
  const priceable = [];
  const isQuote = requested.map((l) => {
    const product = productsById[l.id];
    const quote = !!product && basePrice(product, l.size) == null;
    if (!quote) priceable.push(l);
    return quote;
  });

  const priced = priceOrder(priceable, productsById, globalTiers); // lanza 422 si falta un producto
  let k = 0;
  const items = requested.map((l, i) => {
    if (isQuote[i]) {
      const product = productsById[l.id];
      const size = findSize(product, l.size);
      return {
        producto_id: l.id,
        nombre: product.name,
        tamano: size ? size.name : null,
        qty: l.qty,
        color: l.color,
        nota: l.nota,
        precio: null,
        precio_lista: null,
        descuento_cantidad_pct: 0,
        a_cotizar: true,
      };
    }
    const pl = priced.lines[k++];
    return {
      producto_id: pl.id,
      nombre: pl.name,
      tamano: pl.size,
      qty: pl.qty,
      color: pl.color,
      nota: l.nota,
      precio: pl.unit,
      precio_lista: pl.unitBase,
      descuento_cantidad_pct: pl.pct,
    };
  });
  return { items, subtotal: priced.subtotal };
}

/* ---------- Supabase (con la llave de servicio) ---------- */

function serviceKey() {
  const k = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  if (!k) {
    console.error('crear-pedido: falta SUPABASE_SERVICE_ROLE_KEY');
    throw new HttpError(500, 'El guardado de pedidos no está configurado todavía.', 'NOT_CONFIGURED');
  }
  return k;
}

function supabaseUrl() {
  return (process.env.SUPABASE_URL || pref.DEFAULT_SUPABASE_URL).replace(/\/+$/, '');
}

function keyHeaders(key) {
  const h = { apikey: key, 'Content-Type': 'application/json', Prefer: 'return=representation' };
  // Las llaves viejas (JWT, empiezan con "eyJ") también van en Authorization; las nuevas (sb_secret_…) no.
  if (/^eyJ/.test(key)) h.Authorization = 'Bearer ' + key;
  return h;
}

// Pista corta para quien administra el sitio (solo el estado HTTP y el código de error de Postgres,
// nunca el mensaje ni los datos): el checkout la agrega al WhatsApp cuando un pedido no se pudo guardar.
function dbDetail(out) {
  const code = out.data && typeof out.data.code === 'string' && /^[A-Za-z0-9_]{3,12}$/.test(out.data.code) ? ' ' + out.data.code : '';
  return 'supabase ' + out.resp.status + code;
}

async function insertPedido(row, key) {
  const url = supabaseUrl() + '/rest/v1/pedidos';
  const post = async (payload) => {
    const resp = await fetchWithTimeout(
      url,
      { method: 'POST', headers: keyHeaders(key), body: JSON.stringify(payload) },
      pref.FETCH_TIMEOUT_MS
    );
    let data = null;
    try { data = await resp.json(); } catch (e) { /* respuesta vacía */ }
    return { resp, data };
  };

  let out;
  try {
    out = await post(row);
    // Si todavía no se corrió supabase/migracion_dashboard.sql no existe la columna `canal`:
    // se guarda igual, sin ella (queda como pedido web por defecto).
    if (!out.resp.ok && /canal/i.test(JSON.stringify(out.data || {}))) {
      const sinCanal = Object.assign({}, row);
      delete sinCanal.canal;
      out = await post(sinCanal);
    }
  } catch (e) {
    console.error('crear-pedido: error de red con Supabase:', e && e.message);
    const err = new HttpError(502, 'No pudimos guardar el pedido en este momento.', 'DB_UNREACHABLE');
    err.detail = 'sin red con la base';
    throw err;
  }
  if (!out.resp.ok) {
    console.error('crear-pedido: Supabase rechazó el pedido:', out.resp.status, JSON.stringify(out.data).slice(0, 500));
    const err = new HttpError(502, 'No pudimos guardar el pedido en este momento.', 'DB_ERROR');
    err.detail = dbDetail(out);
    throw err;
  }
  const created = Array.isArray(out.data) ? out.data[0] : out.data;
  return created && created.id ? created.id : null;
}

/* ---------- Costos de fabricación (foto al momento de la venta) ---------- */

function readHeaders(key) {
  const h = { apikey: key, Accept: 'application/json' };
  if (/^eyJ/.test(key)) h.Authorization = 'Bearer ' + key;
  return h;
}

// Devuelve { 'producto_id|tamaño': costo }. NUNCA lanza: si algo falla devuelve {} (el pedido sigue igual).
async function loadCostos(ids, key) {
  const map = {};
  if (!ids.length) return map;
  try {
    const url = supabaseUrl() + '/rest/v1/producto_costos?select=producto_id,tamano,costo&producto_id=in.(' + ids.join(',') + ')';
    const resp = await fetchWithTimeout(url, { method: 'GET', headers: readHeaders(key) }, pref.FETCH_TIMEOUT_MS);
    if (!resp.ok) {
      console.warn('crear-pedido: no se pudieron leer los costos (' + resp.status + '); el pedido se guarda sin costo.');
      return map;
    }
    const rows = await resp.json();
    (Array.isArray(rows) ? rows : []).forEach((r) => {
      // Un costo vacío (null) no es un costo 0: se ignora. PostgREST manda los numeric como número.
      const crudo = r && r.costo;
      const c = typeof crudo === 'number' || (typeof crudo === 'string' && crudo.trim() !== '') ? Number(crudo) : NaN;
      if (r && r.producto_id && Number.isFinite(c) && c >= 0) map[r.producto_id + '|' + String(r.tamano || '')] = c;
    });
  } catch (e) {
    console.warn('crear-pedido: error leyendo los costos; el pedido se guarda sin costo:', e && e.message);
  }
  return map;
}

// Costo unitario de un producto y tamaño: el del tamaño exacto, o el del producto sin tamaños; null si no hay.
function costoDe(map, productoId, tamano) {
  const exacto = productoId + '|' + String(tamano || '');
  if (Object.prototype.hasOwnProperty.call(map, exacto)) return map[exacto];
  const base = productoId + '|';
  if (Object.prototype.hasOwnProperty.call(map, base)) return map[base];
  return null;
}

function attachCostos(items, map) {
  items.forEach((it) => {
    it.costo = it.a_cotizar ? null : costoDe(map, it.producto_id, it.tamano);
  });
  return items;
}

/* ---------- Handler ---------- */

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return reply(405, { error: 'Método no permitido.', code: 'METHOD_NOT_ALLOWED' });
  }
  try {
    const key = serviceKey();
    const body = parseBody(event);

    // Validación sin tocar la red: carrito (id/tamaño/color/cantidad) + notas por línea + datos de contacto.
    const requested = parseCart(body.cart);
    requested.forEach((l, i) => { l.nota = clean(body.cart[i].nota, MAX_NOTA_LINEA); });
    const datos = parseDatos(body);

    const ids = Array.from(new Set(requested.map((l) => l.id)));
    const { productsById, globalTiers } = await loadCatalogData(ids);
    const { items, subtotal } = buildItems(requested, productsById, globalTiers);
    attachCostos(items, await loadCostos(ids, key));

    const row = Object.assign({}, datos, {
      items,
      subtotal, // lo calculó el servidor; el "subtotal" que mande el cliente se ignora
      estado: 'nuevo',
      canal: 'web',
    });
    const id = await insertPedido(row, key);
    return reply(200, { ok: true, id, subtotal });
  } catch (err) {
    if (err instanceof HttpError) {
      return reply(err.status, Object.assign({ error: err.message, code: err.code }, err.detail ? { detail: err.detail } : {}));
    }
    console.error('crear-pedido: error inesperado:', err && err.stack ? err.stack : err);
    return reply(500, { error: 'Ocurrió un error inesperado. Probá de nuevo en unos segundos.', code: 'INTERNAL' });
  }
};

// Solo para los tests (Netlify ignora todo lo que no sea `handler`).
exports._internals = { clean, cleanMultiline, parseDatos, buildItems, loadCostos, costoDe, attachCostos };
