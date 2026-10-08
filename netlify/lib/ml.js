// Storge Lab — lógica compartida de la integración con Mercado Libre.
//
// La usan tres funciones de Netlify:
//   netlify/functions/ml-admin.js     → botones del panel (conectar, vista previa, publicar, sincronizar)
//   netlify/functions/ml-callback.js  → vuelta de Mercado Libre después de "Autorizar"
//   netlify/functions/ml-sync-cron.js → sincronización automática cada hora
//
// Variables de entorno en Netlify (ver MERCADOLIBRE.md):
//   ML_CLIENT_ID, ML_CLIENT_SECRET   → de tu aplicación en developers.mercadolibre.com.uy (obligatorias)
//   SUPABASE_SERVICE_ROLE_KEY        → llave secreta de Supabase (obligatoria; NUNCA va en el sitio)
//   ADMIN_EMAILS                     → tu mail (o varios separados por coma): solo esos usuarios pueden usar los botones
//   ML_REDIRECT_URI                  → opcional; por defecto https://<tu sitio>/api/ml-callback
//   SUPABASE_URL, SUPABASE_ANON_KEY  → opcionales; por defecto los públicos de js/supabase-client.js

'use strict';

const crypto = require('crypto');

const DEFAULT_SUPABASE_URL = 'https://elpckhakeiezcnahxmoz.supabase.co';
const DEFAULT_SUPABASE_ANON_KEY = 'sb_publishable_7F0HV4PNBbEmr7fb3ZTYdA_n9AdfzXa';
const ML_API = 'https://api.mercadolibre.com';
const ML_AUTH_URL = 'https://auth.mercadolibre.com.uy/authorization';
const SITE_ID = 'MLU';
const CURRENCY = 'UYU';
const FETCH_TIMEOUT_MS = 6000;
const MAX_PICTURES = 10;
const MAX_UNITS = 30; // tope de avisos por producto (tamaños × colores)
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class HttpError extends Error {
  constructor(status, message, code, extra) {
    super(message);
    this.status = status;
    this.code = code || 'ERROR';
    this.extra = extra || null;
  }
}

function reply(statusCode, obj, headers) {
  return {
    statusCode,
    headers: Object.assign(
      { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
      headers || {}
    ),
    body: JSON.stringify(obj),
  };
}

function env(name, fallback) {
  const v = process.env[name];
  return v === undefined || String(v).trim() === '' ? fallback : String(v).trim();
}

function supabaseUrl() { return env('SUPABASE_URL', DEFAULT_SUPABASE_URL).replace(/\/+$/, ''); }
function anonKey() { return env('SUPABASE_ANON_KEY', DEFAULT_SUPABASE_ANON_KEY); }
function serviceKey() {
  const k = env('SUPABASE_SERVICE_ROLE_KEY', '');
  if (!k) throw new HttpError(500, 'Falta configurar SUPABASE_SERVICE_ROLE_KEY en Netlify (ver MERCADOLIBRE.md).', 'NO_SERVICE_KEY');
  return k;
}
function mlClient() {
  const id = env('ML_CLIENT_ID', '');
  const secret = env('ML_CLIENT_SECRET', '');
  if (!id || !secret) throw new HttpError(500, 'Falta configurar ML_CLIENT_ID y ML_CLIENT_SECRET en Netlify (ver MERCADOLIBRE.md).', 'NO_ML_APP');
  return { id, secret };
}
function siteUrl() {
  return env('URL', 'https://storgelab.netlify.app').replace(/\/+$/, '');
}
function redirectUri() {
  return env('ML_REDIRECT_URI', siteUrl() + '/api/ml-callback');
}

/* ------------------------------------------------------------------ */
/* fetch con timeout                                                    */
/* ------------------------------------------------------------------ */

async function fetchJson(url, opts) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), (opts && opts.timeout) || FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, Object.assign({}, opts, { signal: ctrl.signal }));
    const text = await res.text();
    let data = null;
    if (text) {
      try { data = JSON.parse(text); } catch (e) { data = { raw: text.slice(0, 500) }; }
    }
    return { ok: res.ok, status: res.status, data };
  } catch (e) {
    const timeout = e && e.name === 'AbortError';
    return { ok: false, status: 0, data: { message: timeout ? 'tardó demasiado en responder' : 'sin conexión (' + (e && e.message) + ')' } };
  } finally {
    clearTimeout(t);
  }
}

/* ------------------------------------------------------------------ */
/* Supabase (con la llave de servicio)                                  */
/* ------------------------------------------------------------------ */

function keyHeaders(key) {
  const h = { apikey: key, 'Content-Type': 'application/json' };
  // Las llaves viejas (JWT, empiezan con "eyJ") también van en Authorization.
  // Las nuevas (sb_secret_… / sb_publishable_…) van solo en "apikey".
  if (/^eyJ/.test(key)) h.Authorization = 'Bearer ' + key;
  return h;
}

async function sb(path, opts) {
  opts = opts || {};
  const headers = keyHeaders(serviceKey());
  if (opts.prefer) headers.Prefer = opts.prefer;
  const r = await fetchJson(supabaseUrl() + '/rest/v1/' + path, {
    method: opts.method || 'GET',
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  if (!r.ok) {
    if (opts.allowError) return { error: r };
    const msg = (r.data && (r.data.message || r.data.hint)) || 'error ' + r.status;
    throw new HttpError(502, 'Error de la base de datos: ' + msg, 'DB_ERROR');
  }
  return opts.allowError ? { data: r.data } : r.data;
}

/* ------------------------------------------------------------------ */
/* Solo el admin puede usar los botones                                 */
/* ------------------------------------------------------------------ */

async function requireAdmin(event) {
  const h = event.headers || {};
  const auth = h.authorization || h.Authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  if (!m) throw new HttpError(401, 'Tenés que iniciar sesión en el panel.', 'NO_SESSION');
  const r = await fetchJson(supabaseUrl() + '/auth/v1/user', {
    headers: { apikey: anonKey(), Authorization: 'Bearer ' + m[1] },
  });
  if (!r.ok || !r.data || !r.data.id) throw new HttpError(401, 'Tu sesión venció. Volvé a entrar al panel.', 'BAD_SESSION');
  const allowed = env('ADMIN_EMAILS', '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const email = String(r.data.email || '').toLowerCase();
  if (allowed.length && !allowed.includes(email)) {
    throw new HttpError(403, 'Este usuario no tiene permiso para manejar Mercado Libre.', 'NOT_ADMIN');
  }
  return r.data;
}

/* ------------------------------------------------------------------ */
/* Cuenta de Mercado Libre y tokens                                     */
/* ------------------------------------------------------------------ */

function mlErrorMessage(data) {
  if (!data) return 'sin respuesta';
  const fmt = (c) => (c.code ? '[' + c.code + '] ' : '') + String(c.message || '');
  const causes = Array.isArray(data.cause) ? data.cause.filter((c) => c && (c.message || c.code)) : [];
  let parts = causes.filter((c) => c.type !== 'warning').map(fmt);
  // Si ML solo devolvió avisos, se muestran igual: alguno es el motivo del rechazo.
  if (!parts.length && causes.length) parts = causes.map(fmt);
  const head = data.message && !/^validation error$/i.test(String(data.message)) ? String(data.message) : '';
  if (head) parts.unshift(head);
  if (!parts.length && data.message) parts.push(String(data.message));
  if (!parts.length && data.error) parts.push(String(data.error));
  if (!parts.length && data.raw) parts.push(String(data.raw));
  return parts.join(' · ').slice(0, 1200) || 'error desconocido';
}

function mlWarnings(data) {
  if (!data || !Array.isArray(data.cause)) return [];
  return data.cause.filter((c) => c && c.type === 'warning' && c.message).map((c) => String(c.message));
}

async function getAccount() {
  const rows = await sb('ml_cuenta?id=eq.1&select=*');
  return rows && rows[0] ? rows[0] : null;
}

async function saveAccount(acc) {
  await sb('ml_cuenta?on_conflict=id', {
    method: 'POST',
    prefer: 'resolution=merge-duplicates,return=minimal',
    body: Object.assign({ id: 1, updated_at: new Date().toISOString() }, acc),
  });
}

async function updateAccount(patch) {
  await sb('ml_cuenta?id=eq.1', {
    method: 'PATCH',
    prefer: 'return=minimal',
    body: Object.assign({ updated_at: new Date().toISOString() }, patch),
  });
}

async function tokenRequest(params) {
  const { id, secret } = mlClient();
  const body = new URLSearchParams(Object.assign({ client_id: id, client_secret: secret }, params));
  return fetchJson(ML_API + '/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: body.toString(),
  });
}

function expiresAt(seconds) {
  return new Date(Date.now() + (Number(seconds) || 21600) * 1000).toISOString();
}

async function readMe(token) {
  const r = await fetchJson(ML_API + '/users/me', { headers: { Authorization: 'Bearer ' + token } });
  if (!r.ok) throw new HttpError(502, 'Mercado Libre no devolvió tu usuario: ' + mlErrorMessage(r.data), 'ML_ME');
  const tags = Array.isArray(r.data.tags) ? r.data.tags : [];
  return {
    ml_user_id: r.data.id,
    nickname: r.data.nickname || null,
    site_id: r.data.site_id || null,
    user_products: tags.includes('user_product_seller'),
  };
}

async function connectWithCode(code) {
  const r = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirectUri() });
  if (!r.ok || !r.data || !r.data.access_token) {
    throw new HttpError(502, 'Mercado Libre rechazó la conexión: ' + mlErrorMessage(r.data), 'ML_TOKEN');
  }
  const me = await readMe(r.data.access_token);
  await saveAccount(
    Object.assign(me, {
      access_token: r.data.access_token,
      refresh_token: r.data.refresh_token,
      expires_at: expiresAt(r.data.expires_in),
    })
  );
  return me;
}

// Devuelve {token, account}. Renueva el token si vence en menos de 5 minutos.
async function getAccess(force) {
  let acc = await getAccount();
  if (!acc) throw new HttpError(409, 'Todavía no conectaste tu cuenta de Mercado Libre.', 'NOT_CONNECTED');
  const left = new Date(acc.expires_at).getTime() - Date.now();
  if (!force && left > 5 * 60 * 1000) return { token: acc.access_token, account: acc };

  const r = await tokenRequest({ grant_type: 'refresh_token', refresh_token: acc.refresh_token });
  if (r.ok && r.data && r.data.access_token) {
    acc = Object.assign({}, acc, {
      access_token: r.data.access_token,
      refresh_token: r.data.refresh_token || acc.refresh_token,
      expires_at: expiresAt(r.data.expires_in),
    });
    await updateAccount({
      access_token: acc.access_token,
      refresh_token: acc.refresh_token,
      expires_at: acc.expires_at,
    });
    return { token: acc.access_token, account: acc };
  }
  // El refresh token es de un solo uso: si otra ejecución (por ejemplo la
  // sincronización de cada hora) lo renovó recién, usamos el que dejó guardado.
  const again = await getAccount();
  if (again && again.refresh_token !== acc.refresh_token && new Date(again.expires_at).getTime() - Date.now() > 60 * 1000) {
    return { token: again.access_token, account: again };
  }
  throw new HttpError(409, 'Se venció la conexión con Mercado Libre. Tocá "Conectar" de nuevo en la pestaña Mercado Libre.', 'RECONNECT');
}

function makeMl(access) {
  let token = access.token;
  let retried = false;
  async function call(method, path, body) {
    const r = await fetchJson(ML_API + path, {
      method,
      headers: Object.assign(
        { Authorization: 'Bearer ' + token, Accept: 'application/json' },
        body === undefined ? {} : { 'Content-Type': 'application/json' }
      ),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (r.status === 401 && !retried) {
      retried = true;
      const fresh = await getAccess(true);
      token = fresh.token;
      return call(method, path, body);
    }
    return r;
  }
  return {
    account: access.account,
    get: (p) => call('GET', p),
    post: (p, b) => call('POST', p, b),
    put: (p, b) => call('PUT', p, b),
  };
}

/* ------------------------------------------------------------------ */
/* Precio, textos y colores                                             */
/* ------------------------------------------------------------------ */

const DEFAULT_CONFIG = {
  recargo_pct: 15,
  costo_envio: 0,
  redondear_a: 10,
  tipo_publicacion: 'gold_special',
  stock_por_variante: 10,
  dias_fabricacion: null,
  garantia: '30 días',
  sync_auto: true,
};

// ML exige "número + unidad" (días, meses o años). "30" → "30 días", "6 meses" queda igual.
function normalizeWarranty(v) {
  const t = String(v == null ? '' : v).trim().toLowerCase().replace(/\s+/g, ' ');
  if (/^sin\b|^no\b|^ninguna$|^0$/.test(t)) return 'Sin garantía';
  const m = /^(\d{1,3})\s*(d[ií]as?|mes(es)?|a[ñn]os?)?$/.exec(t);
  if (!m) return '30 días';
  const n = Number(m[1]) || 30;
  const u = m[2] || 'días';
  const unit = /^d/.test(u) ? (n === 1 ? 'día' : 'días') : /^m/.test(u) ? (n === 1 ? 'mes' : 'meses') : (n === 1 ? 'año' : 'años');
  return n + ' ' + unit;
}

function normalizeConfig(row) {
  const c = Object.assign({}, DEFAULT_CONFIG, row || {});
  const num = (v, d, min, max) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= min && n <= max ? n : d;
  };
  return {
    recargo_pct: num(c.recargo_pct, 15, 0, 100),
    costo_envio: num(c.costo_envio, 0, 0, 1e7),
    redondear_a: Math.round(num(c.redondear_a, 10, 1, 10000)),
    tipo_publicacion: ['gold_special', 'gold_pro', 'free'].includes(c.tipo_publicacion) ? c.tipo_publicacion : 'gold_special',
    stock_por_variante: Math.round(num(c.stock_por_variante, 10, 1, 999)),
    dias_fabricacion: c.dias_fabricacion == null || c.dias_fabricacion === '' ? null : Math.round(num(c.dias_fabricacion, 0, 0, 45)) || null,
    garantia: normalizeWarranty(c.garantia),
    sync_auto: c.sync_auto !== false,
  };
}

async function getConfig() {
  const rows = await sb('ml_config?id=eq.1&select=*');
  return normalizeConfig(rows && rows[0]);
}

// Precio en ML = precio web + recargo % + costo del envío gratis, redondeado hacia arriba.
function mlPrice(base, cfg) {
  const raw = Math.round(Number(base) * (1 + cfg.recargo_pct / 100) + cfg.costo_envio);
  const r = cfg.redondear_a > 1 ? cfg.redondear_a : 1;
  return Math.ceil(raw / r) * r;
}

function decodeEntities(s) {
  return s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (m, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/gi, '&');
}

// La descripción de la web es HTML (negrita/cursiva/saltos); ML solo acepta texto plano.
function htmlToPlain(html) {
  if (!html) return '';
  let s = String(html)
    .replace(/\r/g, '')
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\s*li[^>]*>/gi, '\u0001• ')
    // Bloques (los que arma el editor del admin): cada uno empieza en su propia línea.
    .replace(/<\/?\s*(p|div|li|h[1-6]|ul|ol)(\s[^>]*)?>/gi, '\u0001')
    .replace(/<[^>]*>/g, '')
    .replace(/\u0001([ \t]*\u0001)*/g, '\n');
  s = decodeEntities(s);
  return s
    .split('\n')
    .map((l) => l.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function buildDescription(p, cfg) {
  const body = (p.descripcion_ml && String(p.descripcion_ml).trim()) || htmlToPlain(p.descripcion);
  const lines = [];
  if (body) lines.push(body, '');
  if (p.material) lines.push('Material: ' + String(p.material).trim());
  lines.push('Pieza impresa en 3D a pedido por Storge Lab, en Montevideo.');
  if (cfg.dias_fabricacion) lines.push('Tiempo de fabricación: ' + cfg.dias_fabricacion + ' días hábiles antes del envío.');
  lines.push('Envío gratis a todo el país.');
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, 49000);
}

// ML no permite datos de contacto ni links en las publicaciones.
function contactWarnings(text) {
  const w = [];
  if (/https?:\/\/|www\.|\.com\b|\.uy\b|netlify/i.test(text)) w.push('La descripción tiene un link o una dirección web: Mercado Libre no lo permite y puede pausar el aviso.');
  if (/whats\s?app|instagram|facebook|@[a-z0-9_.]{3,}/i.test(text)) w.push('La descripción menciona redes, WhatsApp o un usuario (@): Mercado Libre no lo permite.');
  if (/\b0?9\d[\s.-]?\d{3}[\s.-]?\d{3}\b|\+598/.test(text)) w.push('La descripción parece tener un número de teléfono: Mercado Libre no lo permite.');
  return w;
}

function hash(s) {
  return crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 16);
}

function cleanList(arr) {
  const seen = new Set();
  return (Array.isArray(arr) ? arr : [])
    .map((x) => String(x == null ? '' : x).trim())
    .filter((x) => x && !seen.has(x.toLowerCase()) && seen.add(x.toLowerCase()));
}

function productSizes(p) {
  const sizes = (Array.isArray(p.tamanos) ? p.tamanos : [])
    .map((t) => ({ name: String((t && t.nombre) || '').trim(), price: Number(t && t.precio) }))
    .filter((t) => t.name && Number.isFinite(t.price));
  if (sizes.length) return sizes;
  const price = p.precio == null ? NaN : Number(p.precio);
  return [{ name: '', price }];
}

// Mapa color (en minúscula) → disponible, desde la tabla de Filamentos.
async function loadColorAvailability() {
  const r = await sb('filamentos?select=color,disponible', { allowError: true });
  const map = new Map();
  if (r.error || !Array.isArray(r.data)) return map; // sin la migración v7: todo disponible
  r.data.forEach((f) => {
    const k = String(f.color || '').trim().toLowerCase();
    if (!k) return;
    map.set(k, (map.get(k) || false) || f.disponible !== false);
  });
  return map;
}

function colorAvailable(map, color) {
  const k = String(color).trim().toLowerCase();
  return map.has(k) ? map.get(k) : true; // colores escritos a mano: se ofrecen
}

function truncate(s, n) {
  s = String(s).replace(/\s+/g, ' ').trim();
  if (s.length <= n) return s;
  const cut = s.slice(0, n);
  const sp = cut.lastIndexOf(' ');
  return (sp > n * 0.6 ? cut.slice(0, sp) : cut).trim();
}

/* ------------------------------------------------------------------ */
/* Categoría y atributos de Mercado Libre                               */
/* ------------------------------------------------------------------ */

async function loadCategoryContext(ml, p) {
  let categoryId = p.ml_categoria_id && String(p.ml_categoria_id).trim().toUpperCase();
  let predicted = null;
  if (!categoryId) {
    const q = encodeURIComponent(truncate(p.nombre, 80));
    const r = await ml.get('/sites/' + SITE_ID + '/domain_discovery/search?limit=1&q=' + q);
    if (r.ok && Array.isArray(r.data) && r.data[0] && r.data[0].category_id) {
      predicted = r.data[0];
      categoryId = predicted.category_id;
    } else {
      throw new HttpError(422, 'Mercado Libre no pudo sugerir una categoría para "' + p.nombre + '". Cargala a mano en Opciones (por ejemplo MLU1234).', 'NO_CATEGORY');
    }
  }
  if (!/^MLU\d+$/.test(categoryId)) {
    throw new HttpError(422, 'La categoría "' + categoryId + '" no es válida: tiene que ser algo como MLU1234.', 'BAD_CATEGORY');
  }
  const [cat, attrs] = await Promise.all([
    ml.get('/categories/' + categoryId),
    ml.get('/categories/' + categoryId + '/attributes'),
  ]);
  if (!cat.ok) throw new HttpError(422, 'No encontramos la categoría ' + categoryId + ' en Mercado Libre: ' + mlErrorMessage(cat.data), 'BAD_CATEGORY');
  const attributes = attrs.ok && Array.isArray(attrs.data) ? attrs.data : [];
  const byId = new Map(attributes.map((a) => [a.id, a]));
  const color = byId.get('COLOR');
  const settings = (cat.data && cat.data.settings) || {};
  return {
    categoryId,
    categoryName: (cat.data && cat.data.name) || (predicted && predicted.category_name) || categoryId,
    path: Array.isArray(cat.data && cat.data.path_from_root) ? cat.data.path_from_root.map((x) => x.name).join(' › ') : '',
    predicted: !!predicted,
    maxTitle: Number(settings.max_title_length) || 60,
    attributes,
    byId,
    colorAsVariation: !!(color && color.tags && color.tags.allow_variations),
  };
}

function isRequired(a) {
  const t = a.tags || {};
  if (t.read_only || t.hidden || t.fixed || t.others) return false;
  return !!(t.required || t.catalog_required);
}

function pickValue(attr, re) {
  const vals = Array.isArray(attr && attr.values) ? attr.values : [];
  const v = vals.find((x) => re.test(String(x.name || '')));
  return v ? { id: attr.id, value_id: String(v.id) } : null;
}

// Arma los atributos de un aviso. Devuelve {attributes, missing}.
function buildAttributes(ctx, p, sizeName, color) {
  const out = new Map();
  const has = (id) => ctx.byId.has(id);
  const set = (id, value_name) => {
    if (value_name && has(id) && !out.has(id)) out.set(id, { id, value_name: String(value_name).slice(0, 255) });
  };

  // 1) Lo que cargaste a mano en Opciones gana siempre.
  (Array.isArray(p.ml_atributos) ? p.ml_atributos : []).forEach((a) => {
    if (!a || !a.id) return;
    const id = String(a.id).trim().toUpperCase();
    if (a.value_id) out.set(id, { id, value_id: String(a.value_id) });
    else if (a.value_name) out.set(id, { id, value_name: String(a.value_name).slice(0, 255) });
  });

  // 2) Lo que se puede completar solo.
  set('BRAND', 'Storge Lab');
  set('MODEL', truncate(p.nombre, 60));
  if (p.material) {
    set('MATERIAL', p.material);
    set('MAIN_MATERIAL', p.material);
  }
  if (sizeName) set('SIZE', sizeName);
  if (color) set('COLOR', color);
  ['ITEM_CONDITION'].forEach((id) => {
    if (has(id) && !out.has(id)) {
      const v = pickValue(ctx.byId.get(id), /nuevo/i);
      if (v) out.set(id, v);
    }
  });
  // Producto artesanal: no tiene código de barras.
  if (has('GTIN') && !out.has('GTIN') && has('EMPTY_GTIN_REASON') && !out.has('EMPTY_GTIN_REASON')) {
    const a = ctx.byId.get('EMPTY_GTIN_REASON');
    const v = pickValue(a, /no tiene c[oó]digo|sin c[oó]digo|artesanal|otro motivo|otra raz[oó]n/i) ||
      (a.values && a.values[0] ? { id: a.id, value_id: String(a.values[0].id) } : null);
    if (v) out.set('EMPTY_GTIN_REASON', v);
  }

  const missing = ctx.attributes
    .filter((a) => isRequired(a) && !out.has(a.id))
    .filter((a) => !(a.id === 'COLOR' && ctx.colorAsVariation)) // va en cada variante
    .filter((a) => !(a.id === 'GTIN' && out.has('EMPTY_GTIN_REASON')))
    .map((a) => ({
      id: a.id,
      nombre: a.name,
      valores: (Array.isArray(a.values) ? a.values : []).slice(0, 10).map((v) => v.name),
    }));
  return { attributes: Array.from(out.values()), missing };
}

function saleTerms(cfg) {
  const t = cfg.garantia === 'Sin garantía'
    ? [{ id: 'WARRANTY_TYPE', value_name: 'Sin garantía' }]
    : [
        { id: 'WARRANTY_TYPE', value_name: 'Garantía del vendedor' },
        { id: 'WARRANTY_TIME', value_name: cfg.garantia },
      ];
  if (cfg.dias_fabricacion) t.push({ id: 'MANUFACTURING_TIME', value_name: cfg.dias_fabricacion + ' días' });
  return t;
}

function pictures(p) {
  return cleanList(p.imagenes).filter((u) => /^https:\/\//i.test(u)).slice(0, MAX_PICTURES);
}

/* ------------------------------------------------------------------ */
/* Qué avisos tiene que tener cada producto                             */
/* ------------------------------------------------------------------ */
//
// Una "unidad" = un aviso de ML. Hay dos formas de armarlos:
//   - Clásica: un aviso por tamaño, con los colores como variantes del mismo aviso.
//   - Un aviso por color (cuenta con el modelo nuevo "User Products" de ML, o
//     categoría que no deja variar el color): un aviso por tamaño y color; ML
//     los agrupa en una misma ficha por el "family_name".

function planUnits(p, cfg, availability, porColor) {
  const colors = cleanList(p.colores);
  const units = [];
  const problems = [];
  productSizes(p).forEach((s) => {
    if (!Number.isFinite(s.price) || s.price <= 0) {
      problems.push((s.name ? 'Tamaño "' + s.name + '": ' : '') + 'no tiene precio (los productos "a cotizar" no se pueden publicar).');
      return;
    }
    const price = mlPrice(s.price, cfg);
    const colorRows = colors.map((c) => ({ color: c, available: colorAvailable(availability, c) }));
    if (porColor && colorRows.length) {
      colorRows.forEach((c) =>
        units.push({ tamano: s.name, color: c.color, price, basePrice: s.price, colors: [c], active: p.activo !== false && c.available })
      );
    } else {
      units.push({
        tamano: s.name,
        color: '',
        price,
        basePrice: s.price,
        colors: colorRows,
        active: p.activo !== false && (colorRows.length === 0 || colorRows.some((c) => c.available)),
      });
    }
  });
  if (units.length > MAX_UNITS) {
    problems.push('Este producto daría ' + units.length + ' avisos (tamaños × colores); se publican los primeros ' + MAX_UNITS + '.');
    units.length = MAX_UNITS;
  }
  return { units, problems };
}

function unitTitle(ctx, p, unit, mode) {
  const parts = [p.nombre];
  if (unit.tamano) parts.push(unit.tamano);
  if (mode === 'clasico' && unit.color) parts.push(unit.color);
  return truncate(parts.join(' '), ctx.maxTitle);
}

function buildItemPayload(ctx, p, cfg, unit, mode) {
  const pics = pictures(p);
  const single = unit.colors.length === 1 ? unit.colors[0].color : null;
  const useVariations = mode === 'clasico' && !unit.color && unit.colors.length > 1 && ctx.colorAsVariation;
  const attrColor = unit.color || (!useVariations && single ? single : null);
  const { attributes, missing } = buildAttributes(ctx, p, unit.tamano, attrColor);
  const stockFor = (c) => (c.available ? cfg.stock_por_variante : 0);

  const payload = {
    category_id: ctx.categoryId,
    price: unit.price,
    currency_id: CURRENCY,
    buying_mode: 'buy_it_now',
    condition: 'new',
    listing_type_id: cfg.tipo_publicacion,
    pictures: pics.map((source) => ({ source })),
    attributes,
    sale_terms: saleTerms(cfg),
    shipping: { mode: 'me2', free_shipping: true, local_pick_up: false },
  };
  if (mode === 'user_products') payload.family_name = unitTitle(ctx, p, unit, mode);
  else payload.title = unitTitle(ctx, p, unit, mode);

  const notes = [];
  if (useVariations) {
    payload.variations = unit.colors.map((c) => ({
      attribute_combinations: [{ id: 'COLOR', value_name: c.color }],
      price: unit.price,
      available_quantity: stockFor(c),
      picture_ids: pics,
    }));
  } else {
    payload.available_quantity = unit.colors.length ? Math.max(1, stockFor(unit.colors[0])) : cfg.stock_por_variante;
    if (mode === 'clasico' && !unit.color && unit.colors.length > 1) {
      // La categoría no deja variar el color: un solo aviso, el color se elige por mensaje.
      notes.push('Esta categoría no permite variantes de color: los colores (' + unit.colors.map((c) => c.color).join(', ') + ') van en la descripción.');
    }
  }
  if (!pics.length) notes.push('El producto no tiene fotos: Mercado Libre exige al menos una.');
  return { payload, missing, notes };
}

/* ------------------------------------------------------------------ */
/* Publicaciones guardadas                                              */
/* ------------------------------------------------------------------ */

async function loadProduct(id) {
  if (!UUID_RE.test(String(id || ''))) throw new HttpError(400, 'Producto inválido.', 'BAD_ID');
  const rows = await sb('productos?id=eq.' + id + '&select=*');
  if (!rows || !rows[0]) throw new HttpError(404, 'No encontramos ese producto.', 'NOT_FOUND');
  return rows[0];
}

async function loadPubs(productId) {
  return (await sb('ml_publicaciones?producto_id=eq.' + productId + '&select=*')) || [];
}

async function savePub(row) {
  const res = await sb('ml_publicaciones?on_conflict=producto_id,tamano,color', {
    method: 'POST',
    prefer: 'resolution=merge-duplicates,return=representation',
    body: row,
  });
  return res && res[0];
}

async function updatePub(id, patch) {
  await sb('ml_publicaciones?id=eq.' + id, { method: 'PATCH', prefer: 'return=minimal', body: patch });
}

function descriptionFor(p, cfg, unit, ctxColorNote) {
  let d = buildDescription(p, cfg);
  if (ctxColorNote && unit.colors.length > 1) {
    d += '\n\nColores disponibles: ' + unit.colors.filter((c) => c.available).map((c) => c.color).join(', ') +
      '. Contanos cuál querés por mensaje después de comprar.';
  }
  if (p.colores_multiple && unit.colors.length > 1) {
    d += '\n\nSi querés combinar varios colores en la misma pieza, avisanos por mensaje después de comprar.';
  }
  return d;
}

/* ------------------------------------------------------------------ */
/* Vista previa (no publica nada)                                       */
/* ------------------------------------------------------------------ */

async function preview(productId) {
  const [p, cfg, availability, access] = await Promise.all([loadProduct(productId), getConfig(), loadColorAvailability(), getAccess()]);
  const ml = makeMl(access);
  const ctx = await loadCategoryContext(ml, p);
  const mode = access.account.user_products ? 'user_products' : 'clasico';
  const porColor = mode === 'user_products' || !ctx.colorAsVariation;
  const { units, problems } = planUnits(p, cfg, availability, porColor);

  const avisos = problems.slice();
  const items = units.map((u) => {
    const b = buildItemPayload(ctx, p, cfg, u, mode);
    return { unit: u, built: b };
  });
  const desc = items[0] ? descriptionFor(p, cfg, items[0].unit, !ctx.colorAsVariation && !porColor) : buildDescription(p, cfg);
  avisos.push(...contactWarnings(desc));
  items.forEach((it) => it.built.notes.forEach((n) => { if (!avisos.includes(n)) avisos.push(n); }));

  // Validación oficial de ML del primer aviso (no publica).
  let validacion = null;
  if (items[0]) {
    const v = await ml.post('/items/validate', items[0].built.payload);
    const causes = v.data && Array.isArray(v.data.cause) ? v.data.cause : [];
    // ML a veces responde 400 "validation_error" con SOLO avisos (ningún error real):
    // en ese caso el aviso se puede publicar igual; se muestran los avisos aparte.
    const onlyWarnings = !v.ok && causes.length > 0 && causes.every((c) => c && c.type === 'warning');
    validacion = v.ok || v.status === 204 || onlyWarnings
      ? { ok: true, con_avisos: onlyWarnings }
      : { ok: false, mensaje: mlErrorMessage(v.data), detalle: JSON.stringify(v.data || {}).slice(0, 2000) };
    if (validacion.ok) {
      mlWarnings(v.data)
        .filter((w) => !/has not mode me1/i.test(w)) // me1 es el sistema viejo de envíos: no aplica
        .forEach((w) => avisos.push('Aviso de ML: ' + (/mandatory free shipping/i.test(w) ? 'el envío gratis queda activado (obligatorio para este precio).' : w)));
    }
  }
  // Qué formas de envío tiene habilitadas la cuenta.
  let envios = null;
  const sp = await ml.get('/users/' + access.account.ml_user_id + '/shipping_preferences');
  if (sp.ok && sp.data) {
    const modos = Array.isArray(sp.data.modes) ? sp.data.modes : [];
    envios = { modos };
    if (!modos.includes('me2')) {
      avisos.push('Tu cuenta de Mercado Libre no tiene Mercado Envíos (me2) habilitado' +
        (modos.length ? ' (tiene: ' + modos.join(', ') + ')' : '') +
        '. Para el envío gratis automático hay que activarlo en Mercado Libre → Configuración → Envíos.');
    }
  }
  const missing = items[0] ? items[0].built.missing : [];
  return {
    categoria: { id: ctx.categoryId, nombre: ctx.categoryName, ruta: ctx.path, sugerida: ctx.predicted },
    modo: mode,
    por_color: porColor,
    avisos_ml: items.map((it) => ({
      titulo: it.built.payload.title || it.built.payload.family_name,
      tamano: it.unit.tamano,
      color: it.unit.color,
      precio_web: it.unit.basePrice,
      precio_ml: it.unit.price,
      activo: it.unit.active,
      variantes: (it.built.payload.variations || []).map((v) => ({
        color: v.attribute_combinations[0].value_name,
        stock: v.available_quantity,
      })),
    })),
    atributos: items[0] ? items[0].built.payload.attributes : [],
    faltan: missing,
    descripcion: desc,
    avisos,
    validacion,
    envios,
  };
}

/* ------------------------------------------------------------------ */
/* Publicar / sincronizar un producto (idempotente)                     */
/* ------------------------------------------------------------------ */
//
// Compara lo que hay en la web con lo publicado y hace solo lo necesario:
// crea los avisos que faltan, actualiza precio/stock si cambiaron, pausa lo
// que ya no está disponible y reactiva lo que volvió. Si se queda sin tiempo,
// devuelve pendiente:true y se puede volver a llamar (sigue donde quedó).

async function reconcile(productId, opts) {
  opts = opts || {};
  const deadline = opts.deadline || Date.now() + 7000;
  const result = { producto_id: productId, creados: 0, actualizados: 0, pausados: 0, sin_cambios: 0, errores: [], avisos: [], pendiente: false };

  const [p, cfg, availability, pubs, access] = await Promise.all([
    loadProduct(productId), getConfig(), loadColorAvailability(), loadPubs(productId), getAccess(),
  ]);
  const ml = makeMl(access);
  if (!opts.create && pubs.length === 0) return Object.assign(result, { sin_publicar: true });

  let ctx = null;
  const getCtx = async () => (ctx = ctx || (await loadCategoryContext(ml, p)));
  let mode = access.account.user_products ? 'user_products' : 'clasico';

  // ¿Ya está publicado "por color"? Se respeta lo que ya existe.
  let porColor;
  if (pubs.length) {
    porColor = pubs.some((x) => x.color);
    mode = pubs[0].modo || mode;
  } else {
    porColor = mode === 'user_products' || !(await getCtx()).colorAsVariation;
  }
  const { units, problems } = planUnits(p, cfg, availability, porColor);
  result.avisos.push(...problems);

  const key = (t, c) => t + '\u0000' + c;
  const byKey = new Map(pubs.map((x) => [key(x.tamano, x.color), x]));
  const wanted = new Set(units.map((u) => key(u.tamano, u.color)));

  for (const unit of units) {
    if (Date.now() > deadline) { result.pendiente = true; break; }
    const pub = byKey.get(key(unit.tamano, unit.color));
    try {
      if (!pub || !pub.ml_item_id) {
        if (!unit.active) continue; // no se crea un aviso de algo sin stock o dado de baja
        await createUnit(ml, await getCtx(), p, cfg, unit, mode, result, (m) => { mode = m; });
      } else {
        await updateUnit(ml, p, cfg, unit, pub, result, opts.force, !!(ctx ? !ctx.colorAsVariation : false));
      }
    } catch (e) {
      const msg = e && e.message ? e.message : String(e);
      result.errores.push((unit.tamano ? unit.tamano + ' ' : '') + (unit.color || '') + ': ' + msg);
      if (pub && pub.id) await updatePub(pub.id, { ultimo_error: msg.slice(0, 900), ultima_sync: new Date().toISOString() });
      if (e && (e.code === 'RECONNECT' || e.code === 'NOT_CONNECTED')) throw e;
    }
  }

  // Avisos que ya no corresponden (tamaño o color borrado en la web): se pausan.
  if (!result.pendiente) {
    for (const pub of pubs) {
      if (wanted.has(key(pub.tamano, pub.color)) || !pub.ml_item_id) continue;
      if (Date.now() > deadline) { result.pendiente = true; break; }
      if (pub.estado === 'paused' || pub.estado === 'closed') continue;
      const r = await ml.put('/items/' + pub.ml_item_id, { status: 'paused' });
      await updatePub(pub.id, {
        estado: r.ok ? 'paused' : pub.estado,
        ultimo_error: r.ok ? 'Ese tamaño/color ya no está en la web: se pausó el aviso.' : 'No se pudo pausar: ' + mlErrorMessage(r.data),
        ultima_sync: new Date().toISOString(),
      });
      if (r.ok) result.pausados++;
    }
  }
  return result;
}

async function createUnit(ml, ctx, p, cfg, unit, mode, result, setMode) {
  let built = buildItemPayload(ctx, p, cfg, unit, mode);
  let r = await ml.post('/items', built.payload);
  // Si ML pide el otro modelo de publicación, se reintenta una vez con ese.
  if (!r.ok) {
    const msg = mlErrorMessage(r.data);
    const other = mode === 'clasico' && /family_name|user.?product/i.test(msg) ? 'user_products'
      : mode === 'user_products' && /title/i.test(msg) && /required|obligatori/i.test(msg) ? 'clasico' : null;
    if (other) {
      mode = other;
      setMode(other);
      await updateAccount({ user_products: other === 'user_products' });
      built = buildItemPayload(ctx, p, cfg, unit, mode);
      r = await ml.post('/items', built.payload);
    }
  }
  if (!r.ok || !r.data || !r.data.id) {
    const faltan = built.missing.length ? ' (Faltan datos obligatorios: ' + built.missing.map((m) => m.nombre).join(', ') + '. Cargalos en Opciones.)' : '';
    throw new HttpError(422, 'Mercado Libre no aceptó el aviso: ' + mlErrorMessage(r.data) + faltan, 'ML_CREATE');
  }
  const item = r.data;
  const descText = descriptionFor(p, cfg, unit, !ctx.colorAsVariation && !unit.color);
  const d = await ml.post('/items/' + item.id + '/description', { plain_text: descText });
  if (!d.ok) result.avisos.push('Se publicó ' + item.id + ' pero la descripción no se pudo cargar: ' + mlErrorMessage(d.data));
  built.notes.forEach((n) => { if (!result.avisos.includes(n)) result.avisos.push(n); });

  const variaciones = (item.variations || []).map((v) => {
    const comb = (v.attribute_combinations || []).find((a) => a.id === 'COLOR');
    return { color: comb ? comb.value_name : '', variation_id: v.id, stock: v.available_quantity };
  });
  await savePub({
    producto_id: p.id,
    tamano: unit.tamano,
    color: unit.color,
    ml_item_id: item.id,
    permalink: item.permalink || null,
    modo: mode,
    categoria_id: ctx.categoryId,
    precio: unit.price,
    stock: item.available_quantity != null ? item.available_quantity : null,
    estado: item.status || 'active',
    variaciones,
    desc_hash: d.ok ? hash(descText) : null,
    ultima_sync: new Date().toISOString(),
    ultimo_error: null,
  });
  result.creados++;
}

async function updateUnit(ml, p, cfg, unit, pub, result, force, colorNote) {
  if (pub.estado === 'closed') {
    await updatePub(pub.id, { ultimo_error: 'El aviso está finalizado en Mercado Libre. Tocá "Desvincular" y publicalo de nuevo.', ultima_sync: new Date().toISOString() });
    result.errores.push((pub.ml_item_id) + ': finalizado en Mercado Libre.');
    return;
  }
  const stockFor = (c) => (c.available ? cfg.stock_por_variante : 0);
  const patch = {};
  let changed = false;
  const now = new Date().toISOString();

  const oldVars = Array.isArray(pub.variaciones) ? pub.variaciones : [];
  if (oldVars.length) {
    // Aviso con variantes de color: hay que mandar TODAS las variantes (las que
    // no se mandan, ML las borra). Los colores que ya no están quedan en 0.
    const lower = (s) => String(s).trim().toLowerCase();
    const desired = new Map(unit.colors.map((c) => [lower(c.color), c]));
    const vars = oldVars.map((v) => {
      const c = desired.get(lower(v.color));
      return { id: v.variation_id, price: unit.price, available_quantity: c ? stockFor(c) : 0, _color: v.color };
    });
    const newColors = unit.colors.filter((c) => !oldVars.some((v) => lower(v.color) === lower(c.color)));
    let pictureIds = null;
    if (newColors.length) {
      const it = await ml.get('/items/' + pub.ml_item_id);
      pictureIds = it.ok && Array.isArray(it.data.pictures) ? it.data.pictures.map((x) => x.id) : [];
    }
    newColors.forEach((c) =>
      vars.push({ attribute_combinations: [{ id: 'COLOR', value_name: c.color }], price: unit.price, available_quantity: stockFor(c), picture_ids: pictureIds, _color: c.color })
    );
    const same = !newColors.length && Number(pub.precio) === unit.price &&
      vars.every((v) => { const o = oldVars.find((x) => x.variation_id === v.id); return o && Number(o.stock) === v.available_quantity; });
    if (!same || force) {
      const body = { variations: vars.map((v) => { const c = Object.assign({}, v); delete c._color; return c; }) };
      const r = await ml.put('/items/' + pub.ml_item_id, body);
      if (!r.ok) throw new HttpError(502, 'No se pudo actualizar precio/stock: ' + mlErrorMessage(r.data), 'ML_UPDATE');
      patch.variaciones = (r.data && Array.isArray(r.data.variations) ? r.data.variations : []).map((v) => {
        const comb = (v.attribute_combinations || []).find((a) => a.id === 'COLOR');
        return { color: comb ? comb.value_name : '', variation_id: v.id, stock: v.available_quantity };
      });
      if (!patch.variaciones.length) patch.variaciones = vars.filter((v) => v.id).map((v) => ({ color: v._color, variation_id: v.id, stock: v.available_quantity }));
      patch.precio = unit.price;
      changed = true;
    }
  } else {
    const qty = unit.colors.length ? Math.max(1, stockFor(unit.colors[0])) : cfg.stock_por_variante;
    if (force || Number(pub.precio) !== unit.price || Number(pub.stock) !== qty) {
      const r = await ml.put('/items/' + pub.ml_item_id, { price: unit.price, available_quantity: qty });
      if (!r.ok) throw new HttpError(502, 'No se pudo actualizar precio/stock: ' + mlErrorMessage(r.data), 'ML_UPDATE');
      patch.precio = unit.price;
      patch.stock = qty;
      changed = true;
    }
  }

  // Pausar o reactivar.
  const desiredStatus = unit.active ? 'active' : 'paused';
  if ((pub.estado === 'active' || pub.estado === 'paused') && pub.estado !== desiredStatus) {
    const r = await ml.put('/items/' + pub.ml_item_id, { status: desiredStatus });
    if (!r.ok) throw new HttpError(502, 'No se pudo ' + (unit.active ? 'reactivar' : 'pausar') + ' el aviso: ' + mlErrorMessage(r.data), 'ML_STATUS');
    patch.estado = desiredStatus;
    changed = true;
    if (desiredStatus === 'paused') result.pausados++;
  }

  // Descripción, si cambió en la web.
  const descText = descriptionFor(p, cfg, unit, colorNote || (!oldVars.length && !unit.color && unit.colors.length > 1));
  const h = hash(descText);
  if (force || h !== pub.desc_hash) {
    const r = await ml.put('/items/' + pub.ml_item_id + '/description', { plain_text: descText });
    if (r.ok) { patch.desc_hash = h; changed = true; }
    else result.avisos.push(pub.ml_item_id + ': no se pudo actualizar la descripción (' + mlErrorMessage(r.data) + ').');
  }

  patch.ultima_sync = now;
  patch.ultimo_error = null;
  await updatePub(pub.id, patch);
  if (changed) result.actualizados++;
  else result.sin_cambios++;
}

// Trae el estado real de cada aviso desde ML (por si lo pausaste o te lo
// moderaron desde Mercado Libre) y lo guarda.
async function refreshStatuses(productId) {
  const pubs = (await loadPubs(productId)).filter((x) => x.ml_item_id);
  if (!pubs.length) return 0;
  const ml = makeMl(await getAccess());
  const ids = pubs.map((x) => x.ml_item_id).slice(0, 20).join(',');
  const r = await ml.get('/items?ids=' + ids + '&attributes=id,status,permalink,price');
  if (!r.ok || !Array.isArray(r.data)) return 0;
  let n = 0;
  for (const row of r.data) {
    const body = row && row.body;
    if (!body || !body.id) continue;
    const pub = pubs.find((x) => x.ml_item_id === body.id);
    if (pub && (pub.estado !== body.status || (body.permalink && pub.permalink !== body.permalink))) {
      await updatePub(pub.id, { estado: body.status, permalink: body.permalink || pub.permalink });
      n++;
    }
  }
  return n;
}

module.exports = {
  HttpError,
  reply,
  env,
  sb,
  requireAdmin,
  getAccount,
  saveAccount,
  updateAccount,
  connectWithCode,
  getAccess,
  readMe,
  makeMl,
  mlClient,
  redirectUri,
  siteUrl,
  ML_AUTH_URL,
  getConfig,
  normalizeConfig,
  mlPrice,
  htmlToPlain,
  buildDescription,
  contactWarnings,
  planUnits,
  buildItemPayload,
  buildAttributes,
  preview,
  reconcile,
  refreshStatuses,
  mlErrorMessage,
  UUID_RE,
};
