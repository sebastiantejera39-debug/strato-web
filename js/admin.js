/* ==========================================================================
   STORGE LAB — panel privado (/admin.html)
   Usa el mismo cliente de Supabase que el sitio público (definido en
   js/supabase-client.js), pero acá el login es obligatorio: todas las
   escrituras dependen de las políticas RLS "... admin" del schema.sql, que
   solo dejan pasar a un usuario autenticado.
   ========================================================================== */

(function () {
  const ESTADOS = ["nuevo", "confirmado", "en_produccion", "listo", "entregado", "cancelado"];
  const ESTADO_LABEL = {
    nuevo: "Nuevo",
    confirmado: "Confirmado",
    en_produccion: "En producción",
    listo: "Listo",
    entregado: "Entregado",
    cancelado: "Cancelado",
  };

  let categoriasCache = [];
  let productosCache = [];
  let pedidosCache = [];
  let gastosAll = []; // todos los gastos: el dashboard y la pestaña Gastos (que los filtra por fecha en pantalla)
  let gastoEditId = null; // id del gasto que se está editando (null = gasto nuevo)
  let ventaEditId = null; // id del pedido que se está editando en el formulario de venta (null = venta nueva)
  let ventaEditOrig = null; // el pedido tal como estaba guardado cuando se abrió la edición
  let pedidosSucio = false; // hay datos nuevos que la lista de Pedidos todavía no dibujó
  let maquinasCache = [];
  let cotizacionesCache = [];
  let filamentosCache = [];
  let escalonesCache = [];
  let editingMaquinaId = null;
  let editingCotizacionId = null;
  let editingFilamentoId = null;
  let editingEscalonId = null;
  let v7TablasOk = true; // false si no se pudieron leer las tablas de la migración v7 (probablemente no se corrió)
  // Costo de fabricación de cada producto/tamaño (tabla PRIVADA producto_costos): clave "producto_id|tamaño" → costo unitario.
  let costosMap = new Map();
  let costosEstado = { ok: false, intento: false, falta: false, error: "" };
  let prodCostoBase = ""; // costo del producto en edición cuando no tiene tamaños (texto tal cual se tipea)
  let ventaOrigen = null; // si la venta que se está cargando viene de una cotización: { id, nombre, sugerido, costo }

  let editingProductId = null;
  let editingCategoriaId = null;
  let prodImagenes = []; // strings (url) o {uploading:true, tempId, name}
  let prodColores = [];
  let prodTamanos = []; // [{nombre, precio}] tal como se van tipeando en el formulario
  let prodEscalones = []; // [{desde, descuento_pct}] escalones propios del producto en edición
  let calcFilRows = []; // filamentos de la cotización en curso: [{filamento_id, gramos, precio_kg}]
  let prodCategoriaIds = []; // ids de categorías elegidas para el producto en edición (muchos-a-muchos)
  let catImagenPortada = null; // url de la foto de portada de la categoría en edición, o null

  /* ---------- Helpers ---------- */
  /* Fechas en horario de Uruguay. Uruguay es UTC-3 todo el año (sin horario de verano): los días del
     negocio ("hoy", "este mes", a qué día pertenece un pedido) se calculan SIEMPRE en ese huso, sin
     importar la zona horaria de la compu o el celular desde donde se abra el panel. */
  const TZ_UY = "America/Montevideo";
  let dtfUY = null;
  try {
    dtfUY = new Intl.DateTimeFormat("en-CA", { timeZone: TZ_UY, year: "numeric", month: "2-digit", day: "2-digit" });
  } catch (e) {
    dtfUY = null;
  }
  function diaUY(input) {
    const d = input instanceof Date ? input : new Date(input);
    if (isNaN(d.getTime())) return "";
    if (dtfUY) {
      const o = {};
      dtfUY.formatToParts(d).forEach((x) => { o[x.type] = x.value; });
      return o.year + "-" + o.month + "-" + o.day;
    }
    return new Date(d.getTime() - 3 * 3600e3).toISOString().slice(0, 10); // respaldo: UTC-3 fijo
  }
  function todayStr() {
    return diaUY(new Date());
  }
  function monthStartStr(day) {
    return (day || todayStr()).slice(0, 8) + "01";
  }
  function monthEndStr(day) {
    const y = Number(day.slice(0, 4)), m = Number(day.slice(5, 7));
    return day.slice(0, 8) + String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, "0");
  }
  function prevMonthStart(day) {
    const y = Number(day.slice(0, 4)), m = Number(day.slice(5, 7));
    return new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 10);
  }
  function addDays(str, n) {
    const d = new Date(str + "T12:00:00Z");
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }
  function diffDays(a, b) {
    return Math.round((new Date(b + "T12:00:00Z") - new Date(a + "T12:00:00Z")) / 864e5);
  }
  function fmtDM(str) {
    return str.slice(8, 10) + "/" + str.slice(5, 7);
  }
  function fmtDMY(str) {
    return str.slice(8, 10) + "/" + str.slice(5, 7) + "/" + str.slice(0, 4);
  }
  function fmtFecha(iso) {
    const d = iso ? diaUY(iso) : "";
    return d ? fmtDMY(d) : "—";
  }
  function fmtMoney(n) {
    if (n === null || n === undefined || isNaN(n)) return "—";
    const sign = n < 0 ? "-" : "";
    return sign + "$U " + Math.round(Math.abs(n)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  }
  /* Monedas: el panel trabaja siempre en pesos uruguayos ($U); un gasto en dólares o reales guarda además lo que se pagó
     y el tipo de cambio que se usó. */
  const MONEDAS = {
    UYU: { sim: "$U", nombre: "Pesos" },
    USD: { sim: "US$", nombre: "Dólares" },
    BRL: { sim: "R$", nombre: "Reales" },
  };
  const monedaDe = (m) => (MONEDAS[m] ? m : "UYU");
  const redondear2 = (n) => Math.round(Number(n) * 100) / 100;
  // Número en formato uruguayo: punto de miles y coma de decimales (solo si hacen falta, hasta 2).
  function fmtNum(n, maxDec) {
    if (n === null || n === undefined || isNaN(n)) return "—";
    const d = maxDec === undefined ? 2 : maxDec;
    const f = Math.pow(10, d);
    const v = Math.round(Math.abs(n) * f) / f;
    const partes = v.toFixed(d).split(".");
    let ent = partes[0].replace(/\B(?=(\d{3})+(?!\d))/g, ".");
    let dec = (partes[1] || "").replace(/0+$/, "");
    return (n < 0 && v !== 0 ? "-" : "") + ent + (dec ? "," + dec : "");
  }
  function fmtMon(moneda, n) {
    const m = monedaDe(moneda);
    if (m === "UYU") return fmtMoney(n);
    return MONEDAS[m].sim + " " + fmtNum(n, 2);
  }
  function escHtml(s) {
    const d = document.createElement("div");
    d.textContent = s ?? "";
    return d.innerHTML;
  }
  // Para valores dentro de atributos HTML (escHtml no escapa las comillas).
  function escAttr(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }
  // Número seguro: lo que no sea un número finito cuenta como 0 (nunca se imprime tal cual en el HTML).
  function num(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  function numVal(id) {
    const v = Number(document.getElementById(id).value);
    return isNaN(v) ? 0 : v;
  }

  function requireSb() {
    if (!window.stratoSb) {
      alert("Supabase todavía no está configurado. Completá STRATO_SUPABASE_URL y STRATO_SUPABASE_ANON_KEY en js/supabase-client.js.");
      return false;
    }
    return true;
  }

  /* ============ AUTH ============ */
  async function checkSession() {
    if (!window.stratoSb) {
      showNotConfigured();
      return;
    }
    const { data } = await stratoSb.auth.getSession();
    if (data.session) {
      showApp(data.session.user);
    } else {
      showLogin();
    }
  }

  function showNotConfigured() {
    document.getElementById("login-screen").style.display = "flex";
    document.getElementById("app").style.display = "none";
    const err = document.getElementById("login-error");
    err.textContent = "Supabase todavía no está configurado (ver js/supabase-client.js).";
    document.getElementById("login-btn").disabled = true;
  }

  function showLogin() {
    document.getElementById("login-screen").style.display = "flex";
    document.getElementById("app").style.display = "none";
  }

  let appIniciada = false;

  async function showApp(user) {
    document.getElementById("login-screen").style.display = "none";
    document.getElementById("app").style.display = "block";
    document.getElementById("user-email").textContent = user.email;
    if (appIniciada) return;
    appIniciada = true;

    // Primero se preparan las fechas y el dashboard (período por defecto: este mes), recién después se
    // cargan los datos y se dibuja todo: así nunca se pinta un número calculado con fechas todavía vacías.
    const hoy = todayStr();
    document.getElementById("gasto-fecha").value = hoy;
    document.getElementById("venta-fecha").value = hoy;
    iniciarDashboard();
    dash.loading = true;
    renderDashboard(); // muestra "Cargando datos…" y guiones, no ceros

    // Si una carga falla, las demás siguen: el panel no se queda a medias.
    const seguro = (fn) => fn().catch((e) => { console.error(e); return false; });
    await Promise.all([
      seguro(loadCategorias), seguro(loadProductos), seguro(loadPedidos), seguro(loadGastosTodos),
      seguro(loadMaquinas), seguro(loadCotizaciones), seguro(loadFilamentos), seguro(loadEscalones),
      seguro(loadCostos), seguro(loadTc),
    ]);
    dash.loading = false;
    if (pedidosEstado.ok && gastosEstado.ok) dash.lastOkAt = Date.now();
    fillCategoriaSelects();
    renderTcCards();
    renderDashboard();
    renderPedidos();
    actualizarAvisosPedidos();
    renderProductos();
    renderCategorias();
    renderCatImgManager(false);
    renderFilamentos();
    renderEscalones();
    renderProdTamanos();
    renderProdEscalones();
    renderColorTags();
    renderMaquinas();
    fillMaquinaSelect();
    renderCotizaciones();
    renderCalcFilRows();
    renderResultados();

    formMonedaGasto(true);
    renderGastos();
    iniciarAutoRefresh();
  }

  document.getElementById("login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!requireSb()) return;
    const email = document.getElementById("login-email").value.trim();
    const password = document.getElementById("login-password").value;
    const errEl = document.getElementById("login-error");
    const btn = document.getElementById("login-btn");
    errEl.textContent = "";
    btn.disabled = true;
    btn.textContent = "Entrando...";
    const { data, error } = await stratoSb.auth.signInWithPassword({ email, password });
    btn.disabled = false;
    btn.textContent = "Entrar";
    if (error) {
      errEl.textContent = "Email o contraseña incorrectos.";
      return;
    }
    showApp(data.user);
  });

  document.getElementById("logout-btn").addEventListener("click", async () => {
    if (window.stratoSb) await stratoSb.auth.signOut();
    location.reload();
  });

  /* ============ TABS ============ */
  const tabBtns = Array.from(document.querySelectorAll('nav.tabs [role="tab"]'));

  function activarPanel(btn, enfocar) {
    tabBtns.forEach((b) => {
      const on = b === btn;
      b.classList.toggle("active", on);
      b.setAttribute("aria-selected", on ? "true" : "false");
      b.tabIndex = on ? 0 : -1;
    });
    document.querySelectorAll(".panel").forEach((p) => p.classList.toggle("active", p.id === btn.dataset.panel));
    if (enfocar) btn.focus();
    if (btn.dataset.panel === "panel-pedidos" && pedidosSucio) {
      pedidosSucio = false;
      renderPedidos();
    }
    // El historial marca las cotizaciones ya cargadas como pedido: se refresca al entrar (un pedido pudo cancelarse o llegar uno nuevo).
    if (btn.dataset.panel === "panel-calculadora") renderCotizaciones();
  }

  tabBtns.forEach((btn, i) => {
    btn.addEventListener("click", () => activarPanel(btn, false));
    // Teclado: flechas, inicio y fin se mueven entre pestañas (patrón estándar de tablist)
    btn.addEventListener("keydown", (e) => {
      let j = null;
      if (e.key === "ArrowRight") j = (i + 1) % tabBtns.length;
      else if (e.key === "ArrowLeft") j = (i - 1 + tabBtns.length) % tabBtns.length;
      else if (e.key === "Home") j = 0;
      else if (e.key === "End") j = tabBtns.length - 1;
      if (j === null) return;
      e.preventDefault();
      activarPanel(tabBtns[j], true);
    });
  });

  /* ============ CARGA DE DATOS ============ */
  async function loadCategorias() {
    const { data, error } = await stratoSb.from("categorias").select("*").order("orden", { ascending: true });
    if (!error) categoriasCache = data || [];
  }

  async function loadProductos() {
    // producto_categorias es la tabla puente: un producto puede tener
    // varias categorías (muchos-a-muchos), por eso ya no se usa el viejo
    // categoria_id directo.
    const { data, error } = await stratoSb
      .from("productos")
      .select("*, producto_categorias(categoria_id, categorias(id, nombre, slug))")
      .order("orden", { ascending: true });
    if (!error) productosCache = data || [];
  }

  function productoCategoriaIds(p) {
    return (p.producto_categorias || []).map((pc) => pc.categoria_id);
  }
  function productoCategoriaNombres(p) {
    return (p.producto_categorias || [])
      .map((pc) => pc.categorias && escHtml(pc.categorias.nombre))
      .filter(Boolean)
      .join(" · ");
  }

  /* Supabase devuelve como máximo 1000 filas por consulta: se pide de a páginas hasta traer todo. */
  const PAGINA = 1000;
  const MAX_FILAS = 20000;
  async function traerTodo(armarConsulta) {
    const filas = [];
    for (let desde = 0; desde < MAX_FILAS; desde += PAGINA) {
      let res;
      try {
        res = await armarConsulta().range(desde, desde + PAGINA - 1);
      } catch (e) {
        return { data: null, error: { message: e && e.message ? e.message : "error de conexión" }, truncado: false };
      }
      const { data, error } = res;
      if (error) return { data: null, error: error, truncado: false };
      const tanda = data || [];
      for (let k = 0; k < tanda.length; k++) filas.push(tanda[k]);
      if (tanda.length < PAGINA) return { data: filas, error: null, truncado: false };
    }
    return { data: filas, error: null, truncado: true };
  }

  const CANALES = ["web", "instagram", "whatsapp", "mercadolibre", "local", "otro"];
  const CANAL_LABEL = { web: "Web", instagram: "Instagram", whatsapp: "WhatsApp", mercadolibre: "Mercado Libre", local: "En persona", otro: "Otro" };

  // Datos derivados que se calculan una sola vez al cargar: el día en Uruguay y un canal siempre válido.
  function prepPedido(p) {
    p._dia = diaUY(p.created_at);
    p._plazo = /^\d{4}-\d{2}-\d{2}/.test(String(p.plazo_entrega || "")) ? String(p.plazo_entrega).slice(0, 10) : ""; // plazo de entrega prometido (día)
    p.canal = CANALES.includes(p.canal) ? p.canal : p.canal ? "otro" : "web";
    if (!Array.isArray(p.items)) p.items = [];
    return p;
  }

  /* Pago y plazo de entrega de cada pedido (columnas `pagado` y `plazo_entrega`: supabase/migracion_pago_plazo_valorhora.sql).
     Un pedido cuenta como cobrado salvo que diga expresamente lo contrario: si la columna todavía no existe en la base,
     todo cuenta como pagado (igual que antes de esta mejora). */
  const esPagado = (p) => !p || p.pagado !== false;
  // null = todavía no se sabe (no hay pedidos para mirar); true / false = las columnas nuevas existen / no existen en la base
  let colsPedidoNuevas = null;
  const SQL_PAGO = "supabase/migracion_pago_plazo_valorhora.sql";
  const VALOR_HORA_DEFECTO = 90; // $U por hora de máquina en uso, si la máquina todavía no tiene uno propio
  const PLAZO_PRONTO = 3; // "vence pronto": hoy y los 3 días siguientes
  const PLAZO_FILTROS = ["todos", "pronto", "vencidos", "con", "sin"];
  // Estado del plazo de un pedido respecto de hoy: vencido / hoy / pronto / ok, o cerrado si ya se entregó o se canceló.
  function plazoEstado(p, hoy) {
    if (!p || !p._plazo) return null;
    const d = diffDays(hoy, p._plazo);
    const fecha = p._plazo.slice(0, 4) === hoy.slice(0, 4) ? fmtDM(p._plazo) : fmtDMY(p._plazo);
    const dias = (n) => n + (n === 1 ? " día" : " días");
    let tipo, texto, largo;
    if (p.estado === "entregado" || p.estado === "cancelado") { tipo = "cerrado"; texto = "Plazo " + fecha; largo = fmtDMY(p._plazo); }
    else if (d < 0) { tipo = "vencido"; texto = "Plazo " + fecha + " · atrasado " + dias(-d); largo = fmtDMY(p._plazo) + " (atrasado " + dias(-d) + ")"; }
    else if (d === 0) { tipo = "hoy"; texto = "Plazo hoy"; largo = fmtDMY(p._plazo) + " (vence hoy)"; }
    else if (d === 1) { tipo = "pronto"; texto = "Plazo mañana"; largo = fmtDMY(p._plazo) + " (vence mañana)"; }
    else if (d <= PLAZO_PRONTO) { tipo = "pronto"; texto = "Plazo " + fecha + " · en " + d + " días"; largo = fmtDMY(p._plazo) + " (vence en " + d + " días)"; }
    else { tipo = "ok"; texto = "Plazo " + fecha; largo = fmtDMY(p._plazo) + " (en " + d + " días)"; }
    return { tipo: tipo, dias: d, texto: texto, largo: largo };
  }

  let pedidosEstado = { ok: false, error: "", truncado: false, intento: false };
  let gastosEstado = { ok: false, error: "", truncado: false, intento: false };

  // Si falla, se conservan los datos anteriores (con un aviso) en vez de vaciar la pantalla.
  async function loadPedidos() {
    const r = await traerTodo(() =>
      stratoSb.from("pedidos").select("*").order("created_at", { ascending: false }).order("id", { ascending: false })
    );
    if (r.error) {
      pedidosEstado = { ok: false, error: r.error.message || "error de conexión", truncado: false, intento: true, hayDatos: pedidosEstado.ok || pedidosEstado.hayDatos };
      return false;
    }
    pedidosCache = (r.data || []).map(prepPedido);
    if (pedidosCache.length) colsPedidoNuevas = "pagado" in pedidosCache[0] && "plazo_entrega" in pedidosCache[0];
    pedidosEstado = { ok: true, error: "", truncado: r.truncado, intento: true, hayDatos: true };
    return true;
  }

  // Los gastos del dashboard: TODOS, sin depender del filtro de fechas de la pestaña Gastos.
  async function loadGastosTodos() {
    const r = await traerTodo(() =>
      stratoSb.from("gastos").select("*").order("fecha", { ascending: false }).order("id", { ascending: false })
    );
    if (r.error) {
      gastosEstado = { ok: false, error: r.error.message || "error de conexión", truncado: false, intento: true, hayDatos: gastosEstado.ok || gastosEstado.hayDatos };
      return false;
    }
    gastosAll = (r.data || []).map((g) => { g._f = String(g.fecha || "").slice(0, 10); return g; });
    gastosEstado = { ok: true, error: "", truncado: r.truncado, intento: true, hayDatos: true };
    return true;
  }

  /* ============ COSTOS DE FABRICACIÓN (privados) ============
     Cada producto (y cada tamaño) puede tener un costo por unidad. Vive en la tabla privada `producto_costos`
     (nunca en `productos`, que lee cualquiera que abra la tienda). Cuando se vende, el costo vigente queda
     copiado en el ítem del pedido (`items[].costo`); los pedidos viejos, que no lo tienen, usan el costo actual. */
  const CAT_EN_COSTO = ["filamento", "electricidad"]; // ya están dentro del costo de las piezas: no se restan dos veces
  // "Inversión inicial" (máquinas, herramientas, primer stock…): se anota pero NO entra en la caja ni en la ganancia; se ve aparte.
  const CAT_INVERSION = "inversion inicial";
  const esInversion = (g) => normCat(g && g.categoria) === CAT_INVERSION;
  const claveCosto = (productoId, tamano) => String(productoId) + "|" + String(tamano || "");
  const COSTO_MAX = 10000000;

  async function loadCostos() {
    const r = await traerTodo(() =>
      stratoSb.from("producto_costos").select("*").order("producto_id", { ascending: true }).order("tamano", { ascending: true })
    );
    if (r.error) {
      const msg = String(r.error.message || "") + " " + String(r.error.code || "");
      costosEstado = {
        ok: false, intento: true, error: r.error.message || "error de conexión",
        falta: /producto_costos|schema cache|42P01|PGRST205|does not exist/i.test(msg),
      };
      return false;
    }
    costosMap = new Map();
    (r.data || []).forEach((c) => {
      const v = Number(c.costo);
      if (Number.isFinite(v) && v >= 0) costosMap.set(claveCosto(c.producto_id, c.tamano), v);
    });
    costosEstado = { ok: true, intento: true, falta: false, error: "" };
    return true;
  }

  // Costo real de fabricar la pieza de una cotización: costo base + accesorio. El accesorio se cobra a costo
  // (sin margen), pero igual es plata que sale, así que cuenta para la ganancia neta.
  function costoDeCotizacion(c) {
    const r = c && c.resultados;
    if (!r || r.costo_base === null || r.costo_base === undefined || r.costo_base === "" || !Number.isFinite(Number(r.costo_base))) return null;
    const acc = Number(c.inputs && c.inputs.costo_accesorio);
    return redondear2(Number(r.costo_base) + (Number.isFinite(acc) && acc > 0 ? acc : 0));
  }
  function accesorioDeCotizacion(c) {
    const acc = Number(c && c.inputs && c.inputs.costo_accesorio);
    return Number.isFinite(acc) && acc > 0 ? redondear2(acc) : 0;
  }

  // Costo unitario de un ítem de pedido: el que quedó guardado al vender, si no el costo actual del producto, si no desconocido.
  function costoItem(it) {
    if (it && it.costo !== null && it.costo !== undefined && it.costo !== "") {
      const v = Number(it.costo);
      if (Number.isFinite(v) && v >= 0) return { v: v, src: "guardado" };
    }
    if (it && it.producto_id) {
      const k = claveCosto(it.producto_id, it.tamano);
      if (costosMap.has(k)) return { v: costosMap.get(k), src: "estimado" };
      const k0 = claveCosto(it.producto_id, "");
      if (costosMap.has(k0)) return { v: costosMap.get(k0), src: "estimado" };
    }
    return { v: null, src: null };
  }

  // Costo de un pedido entero. Los ítems "a cotizar" (sin precio) no suman ni al subtotal ni al costo.
  function costoPedido(p) {
    let costo = 0, faltan = 0, conPrecio = 0, estimado = false;
    (p.items || []).forEach((it) => {
      if (!it || it.precio === null || it.precio === undefined) return;
      conPrecio++;
      const c = costoItem(it);
      if (c.v === null) { faltan++; return; }
      costo += c.v * num(it.qty);
      if (c.src === "estimado") estimado = true;
    });
    if (!conPrecio && num(p.subtotal) > 0) faltan = 1; // hay plata pero ningún producto identificable: costo desconocido
    return { costo: costo, faltan: faltan, completo: faltan === 0 && conPrecio > 0, estimado: estimado };
  }

  function fillCategoriaSelects() {
    const filtro = document.getElementById("productos-filtro-categoria");
    filtro.innerHTML =
      '<option value="todas">Todas las categorías</option>' +
      categoriasCache.map((c) => '<option value="' + c.id + '">' + escHtml(c.nombre) + "</option>").join("");
    renderProdCategoriasCheck();
  }

  /* ---- Categorías del producto (checkboxes, muchos-a-muchos) ---- */
  function renderProdCategoriasCheck() {
    const wrap = document.getElementById("prod-categorias-check");
    if (!categoriasCache.length) {
      wrap.innerHTML = '<p class="muted" style="font-size:12px;">Creá una categoría primero (pestaña Categorías).</p>';
      return;
    }
    wrap.innerHTML = categoriasCache
      .map(
        (c) =>
          '<label class="cat-check"><input type="checkbox" value="' +
          c.id +
          '"' +
          (prodCategoriaIds.includes(c.id) ? " checked" : "") +
          ' onchange="stratoAdminToggleProdCategoria(\'' +
          c.id +
          "', this.checked)\"> " +
          escHtml(c.nombre) +
          "</label>"
      )
      .join("");
  }
  window.stratoAdminToggleProdCategoria = function (id, checked) {
    if (checked) {
      if (!prodCategoriaIds.includes(id)) prodCategoriaIds.push(id);
    } else {
      prodCategoriaIds = prodCategoriaIds.filter((x) => x !== id);
    }
  };

  /* ============ FILTRO DE FECHAS (compartido por Pedidos, Gastos e Historial de cotizaciones) ============
     Los mismos períodos que el Resumen: Hoy, 7 días, Este mes, Mes anterior, Todo y Elegir fechas. Cada panel
     tiene su propio filtro (por defecto "Todo") y filtra por el día de Uruguay, igual que el dashboard. */
  const FF_OPCIONES = [["hoy", "Hoy"], ["7d", "7 días"], ["mes", "Este mes"], ["mesant", "Mes anterior"], ["todo", "Todo"], ["custom", "Elegir fechas…"]];
  const FF_RE = /^\d{4}-\d{2}-\d{2}$/;

  // Rango de días del filtro ("" = sin límite de ese lado).
  function ffRango(f) {
    const hoy = todayStr();
    switch (f.per) {
      case "hoy": return { desde: hoy, hasta: hoy, nota: "" };
      case "7d": return { desde: addDays(hoy, -6), hasta: hoy, nota: "" };
      case "mes": return { desde: monthStartStr(hoy), hasta: hoy, nota: "" };
      case "mesant": { const ps = prevMonthStart(hoy); return { desde: ps, hasta: monthEndStr(ps), nota: "" }; }
      case "custom": {
        let d = FF_RE.test(f.desde) ? f.desde : "", h = FF_RE.test(f.hasta) ? f.hasta : "", nota = "";
        if (d && h && d > h) {
          const t = d; d = h; h = t;
          nota = "Las fechas estaban al revés; mostramos del " + fmtDMY(d) + " al " + fmtDMY(h) + ".";
        }
        return { desde: d, hasta: h, nota: nota };
      }
      default: return { desde: "", hasta: "", nota: "" };
    }
  }
  const ffEnRango = (r, dia) => !!dia && (!r.desde || dia >= r.desde) && (!r.hasta || dia <= r.hasta);
  function ffTexto(r) {
    if (r.desde && r.hasta) return r.desde === r.hasta ? "Día " + fmtDMY(r.desde) : "Del " + fmtDMY(r.desde) + " al " + fmtDMY(r.hasta);
    if (r.desde) return "Desde el " + fmtDMY(r.desde);
    if (r.hasta) return "Hasta el " + fmtDMY(r.hasta);
    return "Sin límite de fechas";
  }

  function crearFiltroFecha(el, clave, alCambiar) {
    const f = { per: "todo", desde: "", hasta: "", clave: clave };
    el.innerHTML =
      '<div class="seg seg-card" role="group" aria-label="Período">' +
      FF_OPCIONES.map((o) => '<button type="button" data-per="' + o[0] + '" aria-pressed="' + (o[0] === "todo" ? "true" : "false") + '">' + o[1] + "</button>").join("") +
      "</div>" +
      '<div class="dash-custom" hidden>' +
      '<div><label for="ff-' + clave + '-desde">Desde</label><input type="date" id="ff-' + clave + '-desde"></div>' +
      '<div><label for="ff-' + clave + '-hasta">Hasta</label><input type="date" id="ff-' + clave + '-hasta"></div>' +
      '<div><button type="button" class="btn-secondary" data-ff="aplicar">Aplicar</button></div></div>' +
      '<p class="ff-resumen" aria-live="polite"></p>';
    const inD = el.querySelector("#ff-" + clave + "-desde");
    const inH = el.querySelector("#ff-" + clave + "-hasta");
    const caja = el.querySelector(".dash-custom");
    const res = el.querySelector(".ff-resumen");
    function pintar() {
      el.querySelectorAll(".seg button").forEach((b) => b.setAttribute("aria-pressed", b.dataset.per === f.per ? "true" : "false"));
      caja.hidden = f.per !== "custom";
      const r = ffRango(f);
      res.textContent = f.per === "todo" ? "" : r.nota || ffTexto(r);
    }
    function aplicarFechas() {
      f.desde = inD.value;
      f.hasta = inH.value;
      pintar();
      alCambiar();
    }
    f.poner = function (per) {
      f.per = per;
      if (per === "custom") {
        const hoy = todayStr();
        if (!f.desde) f.desde = monthStartStr(hoy);
        if (!f.hasta) f.hasta = hoy;
        inD.value = f.desde;
        inH.value = f.hasta;
      }
      pintar();
    };
    f.reiniciar = function () { f.per = "todo"; f.desde = ""; f.hasta = ""; inD.value = ""; inH.value = ""; pintar(); };
    f.rango = () => ffRango(f);
    f.dentro = (dia) => ffEnRango(ffRango(f), dia);
    f.activo = () => f.per !== "todo";
    el.querySelector(".seg").addEventListener("click", (e) => {
      const b = e.target.closest("button[data-per]");
      if (!b) return;
      f.poner(b.dataset.per);
      alCambiar();
      if (b.dataset.per === "custom") inD.focus({ preventScroll: true });
    });
    inD.addEventListener("change", aplicarFechas);
    inH.addEventListener("change", aplicarFechas);
    caja.querySelector("[data-ff='aplicar']").addEventListener("click", aplicarFechas);
    pintar();
    return f;
  }

  /* ============ TIPO DE CAMBIO ============
     Cuántos pesos uruguayos vale 1 dólar y 1 real. Se guarda en la tabla `ajustes` (una fila "tipos_cambio").
     Si esa tabla todavía no existe (falta correr migracion_monedas_inversion.sql) se guarda solo en este navegador. */
  const TC_CLAVE = "tipos_cambio";
  const TC_LS = "strato-tipos-cambio";
  let tc = { USD: 0, BRL: 0, actualizado: "", origen: "ninguno" }; // origen: base | navegador | ninguno
  const tcValido = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 && n <= 100000 ? n : 0; };
  const TC_FALTA_TABLA = /ajustes|schema cache|42P01|PGRST205|does not exist/i;

  async function loadTc() {
    let leido = null, origen = "base";
    try {
      const r = await stratoSb.from("ajustes").select("*").eq("clave", TC_CLAVE);
      if (!r.error && r.data && r.data[0]) leido = r.data[0].valor;
    } catch (e) { /* sin conexión: se intenta con lo guardado en este navegador */ }
    if (!leido || typeof leido !== "object") {
      leido = null;
      try {
        const l = localStorage.getItem(TC_LS);
        if (l) { leido = JSON.parse(l); origen = "navegador"; }
      } catch (e) { leido = null; }
    }
    if (leido && typeof leido === "object") {
      tc = { USD: tcValido(leido.USD), BRL: tcValido(leido.BRL), actualizado: FF_RE.test(String(leido.actualizado || "")) ? leido.actualizado : "", origen: origen };
    }
    return true;
  }

  async function guardarTc(usd, brl) {
    const valor = { USD: usd, BRL: brl, actualizado: todayStr() };
    let error = null;
    try {
      const r = await stratoSb.from("ajustes").upsert([{ clave: TC_CLAVE, valor: valor, updated_at: new Date().toISOString() }], { onConflict: "clave" }).select();
      error = r.error;
    } catch (e) {
      error = { message: e && e.message ? e.message : "error de conexión" };
    }
    if (error) {
      if (!TC_FALTA_TABLA.test(String(error.message || "") + " " + String(error.code || ""))) return { ok: false, error: error.message || "error de conexión" };
      try { localStorage.setItem(TC_LS, JSON.stringify(valor)); } catch (e) { return { ok: false, error: "No se pudo guardar (ni en la base ni en este navegador)." }; }
      tc = { USD: usd, BRL: brl, actualizado: valor.actualizado, origen: "navegador" };
      return { ok: true, soloNavegador: true };
    }
    try { localStorage.removeItem(TC_LS); } catch (e) { /* da igual */ }
    tc = { USD: usd, BRL: brl, actualizado: valor.actualizado, origen: "base" };
    return { ok: true };
  }

  function tcInfoTexto() {
    if (!tc.USD && !tc.BRL) return "Todavía no cargaste el tipo de cambio.";
    return (tc.actualizado ? "Actualizado el " + fmtDMY(tc.actualizado) + "." : "") +
      (tc.origen === "navegador" ? " Guardado solo en este navegador: para que quede en la base, corré supabase/migracion_monedas_inversion.sql en Supabase." : "");
  }

  function renderTcCards() {
    ["gastos", "filamentos"].forEach((k) => {
      const el = document.getElementById("tc-card-" + k);
      if (!el) return;
      el.innerHTML =
        "<h2>Tipo de cambio</h2>" +
        '<p class="muted" style="font-size:12px;margin-bottom:14px;">Cuántos pesos uruguayos vale cada moneda. Se usa para pasar a pesos los gastos nuevos en dólares o reales, y para los filamentos con precio en dólares (esos se recalculan solos cuando cambiás el dólar). Cada gasto ya cargado conserva el cambio con el que se cargó.</p>' +
        '<div class="tc-row">' +
        '<div><label for="tc-usd-' + k + '">1 dólar (US$) vale, en $U</label><input type="number" id="tc-usd-' + k + '" min="0" step="any" inputmode="decimal" value="' + (tc.USD ? tc.USD : "") + '"></div>' +
        '<div><label for="tc-brl-' + k + '">1 real (R$) vale, en $U</label><input type="number" id="tc-brl-' + k + '" min="0" step="any" inputmode="decimal" value="' + (tc.BRL ? tc.BRL : "") + '"></div>' +
        '<div><button type="button" class="btn-secondary" data-tc="guardar">Guardar</button></div></div>' +
        '<p class="tc-info" id="tc-info-' + k + '" role="status">' + escHtml(tcInfoTexto()) + "</p>" +
        '<div class="error-msg" id="tc-err-' + k + '" role="alert"></div>';
    });
  }

  async function guardarTcDesde(k) {
    const errEl = document.getElementById("tc-err-" + k);
    errEl.textContent = "";
    const rawU = document.getElementById("tc-usd-" + k).value.trim();
    const rawB = document.getElementById("tc-brl-" + k).value.trim();
    const usd = rawU === "" ? tc.USD : tcValido(rawU);
    const brl = rawB === "" ? tc.BRL : tcValido(rawB);
    if (rawU !== "" && !usd) { errEl.textContent = "El valor del dólar tiene que ser un número mayor a 0."; return; }
    if (rawB !== "" && !brl) { errEl.textContent = "El valor del real tiene que ser un número mayor a 0."; return; }
    if (!usd && !brl) { errEl.textContent = "Cargá al menos el valor del dólar o del real."; return; }
    const btn = document.querySelector("#tc-card-" + k + " [data-tc='guardar']");
    if (btn) { btn.disabled = true; btn.textContent = "Guardando…"; }
    const r = await guardarTc(usd, brl);
    if (!r.ok) {
      if (btn) { btn.disabled = false; btn.textContent = "Guardar"; }
      errEl.textContent = "No se pudo guardar el tipo de cambio (" + r.error + ").";
      return;
    }
    renderTcCards();
    tcCambio();
    const nb = document.querySelector("#tc-card-" + k + " [data-tc='guardar']");
    if (nb) nb.focus({ preventScroll: true });
  }
  ["gastos", "filamentos"].forEach((k) => {
    document.getElementById("tc-card-" + k).addEventListener("click", (e) => {
      if (e.target.closest("[data-tc='guardar']")) guardarTcDesde(k);
    });
    document.getElementById("tc-card-" + k).addEventListener("keydown", (e) => {
      if (e.key === "Enter" && e.target.matches("input")) { e.preventDefault(); guardarTcDesde(k); }
    });
  });

  /* ============ EXCEL (.xlsx armado acá mismo, sin librerías ni internet) ============
     Un .xlsx es un zip de archivos XML. Se arma con un zip "sin compresión" (alcanza para planillas de texto
     y números) para no depender de nada externo. */
  const CRC_TABLA = (function () {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(u8) {
    let c = 0xffffffff;
    for (let i = 0; i < u8.length; i++) c = CRC_TABLA[(c ^ u8[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }
  function zipSinComprimir(archivos) {
    const enc = new TextEncoder();
    const ahora = new Date();
    const dosHora = (ahora.getUTCHours() << 11) | (ahora.getUTCMinutes() << 5) | (ahora.getUTCSeconds() >> 1);
    const dosFecha = (Math.max(0, ahora.getUTCFullYear() - 1980) << 9) | ((ahora.getUTCMonth() + 1) << 5) | ahora.getUTCDate();
    const partes = [], central = [];
    let offset = 0;
    archivos.forEach((a) => {
      const nombre = enc.encode(a.nombre);
      const datos = typeof a.datos === "string" ? enc.encode(a.datos) : a.datos;
      const crc = crc32(datos);
      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, 0, true);
      lh.setUint16(10, dosHora, true); lh.setUint16(12, dosFecha, true); lh.setUint32(14, crc, true);
      lh.setUint32(18, datos.length, true); lh.setUint32(22, datos.length, true); lh.setUint16(26, nombre.length, true); lh.setUint16(28, 0, true);
      partes.push(new Uint8Array(lh.buffer), nombre, datos);
      const ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true); ch.setUint16(10, 0, true);
      ch.setUint16(12, dosHora, true); ch.setUint16(14, dosFecha, true); ch.setUint32(16, crc, true);
      ch.setUint32(20, datos.length, true); ch.setUint32(24, datos.length, true); ch.setUint16(28, nombre.length, true);
      ch.setUint16(30, 0, true); ch.setUint16(32, 0, true); ch.setUint16(34, 0, true); ch.setUint16(36, 0, true); ch.setUint32(38, 0, true); ch.setUint32(42, offset, true);
      central.push(new Uint8Array(ch.buffer), nombre);
      offset += 30 + nombre.length + datos.length;
    });
    let tamCentral = 0;
    central.forEach((c) => { tamCentral += c.length; });
    const fin = new DataView(new ArrayBuffer(22));
    fin.setUint32(0, 0x06054b50, true); fin.setUint16(4, 0, true); fin.setUint16(6, 0, true);
    fin.setUint16(8, archivos.length, true); fin.setUint16(10, archivos.length, true);
    fin.setUint32(12, tamCentral, true); fin.setUint32(16, offset, true); fin.setUint16(20, 0, true);
    return new Blob(partes.concat(central, [new Uint8Array(fin.buffer)]), { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  }

  const xmlEsc = (s) =>
    String(s)
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, " ")
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  function colLetra(i) {
    let s = "", n = i + 1;
    while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
    return s;
  }
  // "2026-10-13" -> número de serie de Excel (días desde 1899-12-30)
  function serieExcel(dia) {
    if (!FF_RE.test(dia || "")) return null;
    return Math.round((Date.UTC(Number(dia.slice(0, 4)), Number(dia.slice(5, 7)) - 1, Number(dia.slice(8, 10))) - Date.UTC(1899, 11, 30)) / 864e5);
  }
  // Estilos: 0 normal · 1 encabezado · 2 fecha · 3 dinero entero · 4 dinero con centavos · 5 texto que se ajusta al ancho
  const XLSX_ESTILO = { texto: 0, encabezado: 1, fecha: 2, dinero: 3, dinero2: 4, ajustado: 5 };
  function hojaXml(h) {
    const ult = colLetra(h.cols.length - 1) + (h.filas.length + 1);
    let x = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' +
      '<sheetFormatPr defaultRowHeight="15"/><cols>' +
      h.cols.map((c, i) => '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + (c.w || 14) + '" customWidth="1"/>').join("") +
      "</cols><sheetData>";
    x += '<row r="1">' + h.cols.map((c, i) => '<c r="' + colLetra(i) + '1" s="1" t="inlineStr"><is><t>' + xmlEsc(c.t) + "</t></is></c>").join("") + "</row>";
    h.filas.forEach((fila, r) => {
      const n = r + 2;
      x += '<row r="' + n + '">';
      h.cols.forEach((c, i) => {
        const v = fila[i];
        if (v === null || v === undefined || v === "") return;
        const ref = colLetra(i) + n;
        if (c.tipo === "fecha") {
          const s = serieExcel(v);
          if (s !== null) x += '<c r="' + ref + '" s="2"><v>' + s + "</v></c>";
        } else if (c.tipo === "dinero" || c.tipo === "dinero2" || c.tipo === "numero") {
          const nv = Number(v);
          if (Number.isFinite(nv)) x += '<c r="' + ref + '"' + (c.tipo === "numero" ? "" : ' s="' + XLSX_ESTILO[c.tipo] + '"') + "><v>" + nv + "</v></c>";
        } else {
          x += '<c r="' + ref + '" s="' + (c.ajustar ? 5 : 0) + '" t="inlineStr"><is><t xml:space="preserve">' + xmlEsc(v) + "</t></is></c>";
        }
      });
      x += "</row>";
    });
    x += '</sheetData><autoFilter ref="A1:' + ult + '"/><pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/></worksheet>';
    return x;
  }
  function xlsxBlob(hojas) {
    const ns = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
    const archivos = [
      { nombre: "[Content_Types].xml", datos: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
          hojas.map((h, i) => '<Override PartName="/xl/worksheets/sheet' + (i + 1) + '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>').join("") + "</Types>" },
      { nombre: "_rels/.rels", datos: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>' },
      { nombre: "xl/workbook.xml", datos: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook ' + ns + ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' +
          hojas.map((h, i) => '<sheet name="' + xmlEsc(h.nombre) + '" sheetId="' + (i + 1) + '" r:id="rId' + (i + 1) + '"/>').join("") + "</sheets></workbook>" },
      { nombre: "xl/_rels/workbook.xml.rels", datos: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          hojas.map((h, i) => '<Relationship Id="rId' + (i + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet' + (i + 1) + '.xml"/>').join("") +
          '<Relationship Id="rId' + (hojas.length + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>' },
      { nombre: "xl/styles.xml", datos: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet ' + ns + '><numFmts count="1"><numFmt numFmtId="164" formatCode="dd/mm/yyyy"/></numFmts>' +
          '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
          '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFEFE6E4"/><bgColor indexed="64"/></patternFill></fill></fills>' +
          '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
          '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
          '<cellXfs count="6"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
          '<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>' +
          '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
          '<xf numFmtId="3" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
          '<xf numFmtId="4" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
          '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf></cellXfs>' +
          '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>' },
    ];
    hojas.forEach((h, i) => archivos.push({ nombre: "xl/worksheets/sheet" + (i + 1) + ".xml", datos: hojaXml(h) }));
    return zipSinComprimir(archivos);
  }
  function descargarBlob(blob, nombre) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = nombre;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  /* ============ DASHBOARD ============ */
  const TITLE_BASE = document.title;
  const PER_KEY = "strato-dash-periodo";
  const PERIODOS = ["hoy", "7d", "mes", "mesant", "todo", "custom"];
  const CAT_LABEL = { filamento: "Filamento", electricidad: "Electricidad", envios: "Envíos", herramientas: "Herramientas", marketing: "Marketing", otro: "Otro", "inversion inicial": "Inversión inicial" };
  const MESES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
  const MAX_NUEVOS = 15;
  const dash = { per: "mes", desde: "", hasta: "", loading: false, visibleLoading: false, lastOkAt: 0, chart: null };

  const elDesde = document.getElementById("dash-desde");
  const elHasta = document.getElementById("dash-hasta");

  function iniciarDashboard() {
    try {
      const g = localStorage.getItem(PER_KEY);
      if (g && PERIODOS.includes(g) && g !== "custom") dash.per = g;
    } catch (e) { /* sin almacenamiento: queda "Este mes" */ }
    aplicarBotonesPeriodo();
    const box = document.getElementById("dash-chart");
    if (window.ResizeObserver) {
      let ultimo = 0;
      new ResizeObserver(() => {
        const w = Math.round(box.clientWidth);
        if (Math.abs(w - ultimo) > 8) { ultimo = w; drawChart(); }
      }).observe(box);
    } else {
      window.addEventListener("resize", drawChart);
    }
  }

  function aplicarBotonesPeriodo() {
    document.querySelectorAll("#dash-seg button").forEach((b) => b.setAttribute("aria-pressed", b.dataset.per === dash.per ? "true" : "false"));
    document.getElementById("dash-custom").hidden = dash.per !== "custom";
  }

  function elegirPeriodo(per) {
    dash.per = per;
    if (per === "custom") {
      const hoy = todayStr();
      if (!dash.desde) dash.desde = monthStartStr(hoy);
      if (!dash.hasta) dash.hasta = hoy;
      elDesde.value = dash.desde;
      elHasta.value = dash.hasta;
    } else {
      try { localStorage.setItem(PER_KEY, per); } catch (e) { /* no pasa nada */ }
    }
    aplicarBotonesPeriodo();
    renderDashboard();
  }

  function aplicarFechasPropias() {
    dash.desde = elDesde.value;
    dash.hasta = elHasta.value;
    renderDashboard();
  }

  document.getElementById("dash-seg").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-per]");
    if (b) elegirPeriodo(b.dataset.per);
  });
  elDesde.addEventListener("change", aplicarFechasPropias);
  elHasta.addEventListener("change", aplicarFechasPropias);
  document.getElementById("dash-aplicar").addEventListener("click", aplicarFechasPropias);
  document.getElementById("dash-refresh").addEventListener("click", () => refreshDatos({ manual: true }));
  document.getElementById("dash-venta-btn").addEventListener("click", () => abrirVenta());
  document.getElementById("dash-status").addEventListener("click", (e) => {
    if (e.target.closest("[data-act='reintentar']")) refreshDatos({ manual: true });
  });
  document.getElementById("dash-atencion").addEventListener("click", (e) => {
    const b = e.target.closest("[data-estado]");
    if (b) irAPedidos(b.dataset.estado);
  });
  document.getElementById("dash-gn").addEventListener("click", (e) => {
    if (e.target.closest("[data-act='ir-costos']")) irACostos();
  });
  document.getElementById("dash-nuevos-tbody").addEventListener("click", (e) => {
    const b = e.target.closest("[data-ir-pedido]");
    if (b) irAPedidos("nuevo", b.dataset.irPedido);
  });

  function minDia() {
    let m = "";
    pedidosCache.forEach((p) => { if (p._dia && (!m || p._dia < m)) m = p._dia; });
    gastosAll.forEach((g) => { if (g._f && (!m || g._f < m)) m = g._f; });
    return m;
  }

  // Rango elegido + rango "comparable" anterior (para los porcentajes de cambio).
  function dashRango(hoy) {
    let desde, hasta, prev = null, nota = "";
    const per = dash.per;
    if (per === "hoy") {
      desde = hasta = hoy;
      prev = [addDays(hoy, -1), addDays(hoy, -1)];
    } else if (per === "7d") {
      desde = addDays(hoy, -6);
      hasta = hoy;
      prev = [addDays(hoy, -13), addDays(hoy, -7)];
    } else if (per === "mes") {
      desde = monthStartStr(hoy);
      hasta = hoy;
      const ps = prevMonthStart(hoy);
      const fin = addDays(ps, diffDays(desde, hoy)); // mismo tramo del mes anterior (los primeros N días)
      const ult = monthEndStr(ps);
      prev = [ps, fin > ult ? ult : fin];
    } else if (per === "mesant") {
      const ps = prevMonthStart(hoy);
      desde = ps;
      hasta = monthEndStr(ps);
      const pps = prevMonthStart(ps);
      prev = [pps, monthEndStr(pps)];
    } else if (per === "todo") {
      desde = minDia() || hoy;
      hasta = hoy;
    } else {
      const ok = /^\d{4}-\d{2}-\d{2}$/;
      let d = ok.test(dash.desde) ? dash.desde : minDia() || hoy;
      let h = ok.test(dash.hasta) ? dash.hasta : hoy;
      if (d > h) {
        const t = d; d = h; h = t;
        nota = "Las fechas estaban al revés; mostramos del " + fmtDMY(d) + " al " + fmtDMY(h) + ".";
      }
      desde = d;
      hasta = h;
      const n = diffDays(d, h) + 1;
      prev = [addDays(d, -n), addDays(d, -1)];
    }
    return { desde: desde, hasta: hasta, prev: prev, nota: nota };
  }

  function suma(lista, fn) {
    let s = 0;
    for (let i = 0; i < lista.length; i++) s += num(fn(lista[i]));
    return s;
  }

  // Todos los números de un período, calculados con los MISMOS criterios para el actual y el anterior.
  function calcPeriodo(a, b) {
    const ped = pedidosCache.filter((p) => p._dia >= a && p._dia <= b);
    const ok = ped.filter((p) => p.estado !== "cancelado"); // un pedido cancelado no es ingreso
    const ingresos = suma(ok, (p) => p.subtotal);
    const entregados = suma(ok.filter((p) => p.estado === "entregado"), (p) => p.subtotal);
    // Caja: solo cuenta lo que ya se cobró. Lo que está con pago pendiente se ve aparte, como "por cobrar".
    const okPagados = ok.filter(esPagado);
    const cobrado = suma(okPagados, (p) => p.subtotal);
    const porCobrar = ingresos - cobrado;
    const nPorCobrar = ok.length - okPagados.length;
    const gastosPeriodo = gastosAll.filter((g) => g._f >= a && g._f <= b);
    const inversion = gastosPeriodo.filter(esInversion); // aparte: no cuenta en caja ni en ganancia
    const gastos = gastosPeriodo.filter((g) => !esInversion(g));
    const totalInversion = suma(inversion, (g) => g.monto);
    const totalGastos = suma(gastos, (g) => g.monto);
    const saldo = cobrado - totalGastos;

    // Ganancia neta = ingresos − costo de las piezas vendidas − otros gastos. El filamento y la luz ya van
    // dentro del costo de las piezas, así que esos dos gastos no se restan de nuevo.
    let costoPiezas = 0, ingConCosto = 0, pedSinCosto = 0, pedEstimado = 0;
    ok.forEach((p) => {
      const c = costoPedido(p);
      costoPiezas += c.costo;
      if (c.completo) ingConCosto += num(p.subtotal);
      else pedSinCosto++;
      if (c.estimado) pedEstimado++;
    });
    const gastosOp = suma(gastos.filter((g) => CAT_EN_COSTO.indexOf(normCat(g.categoria)) < 0), (g) => g.monto);
    const ganancia = ingresos - costoPiezas - gastosOp;
    return {
      ok: ok,
      cancelados: ped.length - ok.length,
      ingresos: ingresos,
      entregados: entregados,
      cobrado: cobrado,
      porCobrar: porCobrar,
      nPorCobrar: nPorCobrar,
      gastos: gastos,
      inversion: inversion,
      totalInversion: totalInversion,
      totalGastos: totalGastos,
      saldo: saldo,
      ticket: ok.length ? ingresos / ok.length : 0,
      margen: cobrado > 0 ? (saldo / cobrado) * 100 : 0,
      costoPiezas: costoPiezas,
      gastosOp: gastosOp,
      gastosEnCosto: totalGastos - gastosOp,
      ganancia: ganancia,
      margenNeto: ingresos > 0 ? (ganancia / ingresos) * 100 : 0,
      pedSinCosto: pedSinCosto,
      ingSinCosto: ingresos - ingConCosto,
      pedEstimado: pedEstimado,
    };
  }

  function fmtRango(a, b) {
    return a === b ? fmtDM(a) : fmtDM(a) + " al " + fmtDM(b);
  }

  function deltaPct(cur, prev, invertido) {
    if (!prev) {
      return '<span class="delta flat">' + (cur ? "sin datos en el período anterior" : "sin datos en este ni en el anterior") + "</span>";
    }
    const v = ((cur - prev) / Math.abs(prev)) * 100;
    const r = Math.round(Math.abs(v));
    if (r < 1) return '<span class="delta flat"><span aria-hidden="true">■</span> casi igual</span> que el anterior';
    const sube = v > 0;
    const bueno = invertido ? !sube : sube;
    return (
      '<span class="delta ' + (bueno ? "good" : "bad") + '"><span aria-hidden="true">' + (sube ? "▲" : "▼") + "</span> " + r + "%" +
      '<span class="sr-only">' + (sube ? " más" : " menos") + "</span></span> vs. anterior"
    );
  }
  function deltaMonto(cur, prev) {
    const d = cur - prev;
    if (Math.round(d) === 0) return '<span class="delta flat"><span aria-hidden="true">■</span> igual</span> que el anterior';
    const bueno = d > 0;
    return (
      '<span class="delta ' + (bueno ? "good" : "bad") + '"><span aria-hidden="true">' + (d > 0 ? "▲" : "▼") + "</span> " + fmtMoney(Math.abs(d)) +
      '<span class="sr-only">' + (d > 0 ? " más" : " menos") + "</span></span> vs. anterior"
    );
  }

  function kpiHtml(label, val, cls, metas) {
    return (
      '<div class="kpi"><div class="label">' + label + '</div><div class="val' + (cls ? " " + cls : "") + '">' + val + "</div>" +
      metas.filter(Boolean).map((m) => '<div class="meta">' + m + "</div>").join("") + "</div>"
    );
  }

  function niceMax(v) {
    if (!(v > 0)) return 1000;
    const pot = Math.pow(10, Math.floor(Math.log10(v)));
    const f = v / pot;
    const nf = f <= 1 ? 1 : f <= 2 ? 2 : f <= 4 ? 4 : f <= 6 ? 6 : f <= 8 ? 8 : 10;
    return nf * pot;
  }
  function fmtEje(v) {
    if (v === 0) return "0";
    if (v >= 1000) return String(Math.round((v / 1000) * 10) / 10).replace(".", ",") + "k";
    return String(Math.round(v));
  }

  // Barras del gráfico: por día (hasta 45 días), por semana (hasta ~9 meses) o por mes.
  function armarBuckets(desde, hasta, lista) {
    const dias = diffDays(desde, hasta) + 1;
    const gran = dias <= 45 ? "día" : dias <= 270 ? "semana" : "mes";
    const hoy = todayStr();
    const out = [];
    let indice;
    if (gran === "día") {
      for (let i = 0; i < dias; i++) {
        const d = addDays(desde, i);
        out.push({ desde: d, hasta: d, etiqueta: String(Number(d.slice(8))), titulo: fmtDM(d) });
      }
      indice = (dia) => diffDays(desde, dia);
    } else if (gran === "semana") {
      const dow = new Date(desde + "T12:00:00Z").getUTCDay(); // 0 = domingo
      const lunes0 = addDays(desde, -((dow + 6) % 7));
      const n = Math.floor(diffDays(lunes0, hasta) / 7) + 1;
      for (let i = 0; i < n; i++) {
        const a = addDays(lunes0, i * 7);
        out.push({ desde: a, hasta: addDays(a, 6), etiqueta: fmtDM(a), titulo: "semana del " + fmtDM(a) });
      }
      indice = (dia) => Math.floor(diffDays(lunes0, dia) / 7);
    } else {
      const y0 = Number(desde.slice(0, 4)), m0 = Number(desde.slice(5, 7));
      const n = (Number(hasta.slice(0, 4)) * 12 + Number(hasta.slice(5, 7))) - (y0 * 12 + m0) + 1;
      for (let i = 0; i < n; i++) {
        const t = y0 * 12 + (m0 - 1) + i;
        const y = Math.floor(t / 12), m = (t % 12) + 1;
        const a = y + "-" + String(m).padStart(2, "0") + "-01";
        out.push({ desde: a, hasta: monthEndStr(a), etiqueta: MESES[m - 1] + " " + String(y).slice(2), titulo: MESES[m - 1] + " " + y });
      }
      indice = (dia) => (Number(dia.slice(0, 4)) * 12 + Number(dia.slice(5, 7))) - (y0 * 12 + m0);
    }
    out.forEach((b) => { b.valor = 0; b.pedidos = 0; b.hoy = hoy >= b.desde && hoy <= b.hasta; });
    lista.forEach((p) => {
      const i = indice(p._dia);
      if (i >= 0 && i < out.length) { out[i].valor += num(p.subtotal); out[i].pedidos++; }
    });
    return { gran: gran, buckets: out };
  }

  function drawChart() {
    const box = document.getElementById("dash-chart");
    const c = dash.chart;
    if (!box || !c) return;
    const W = Math.max(Math.round(box.clientWidth) || 560, 260);
    const H = W < 420 ? 190 : 220;
    const pl = 42, pr = 8, pt = 22, pb = 26;
    const plotW = W - pl - pr, plotH = H - pt - pb;
    const n = c.buckets.length;
    const max = c.buckets.reduce((m, b) => Math.max(m, b.valor), 0);
    const tope = max > 0 ? niceMax(max) : 1000;
    const slot = plotW / n;
    const bw = Math.min(slot * 0.66, 48);
    const paso = Math.max(1, Math.ceil((n * (c.gran === "día" ? 28 : 46)) / plotW));
    let svg = '<svg viewBox="0 0 ' + W + " " + H + '" width="' + W + '" height="' + H + '" role="img" aria-label="' + escAttr(c.aria) + '">';
    [0, 0.5, 1].forEach((t) => {
      const y = pt + plotH * (1 - t);
      svg += '<line x1="' + pl + '" x2="' + (W - pr) + '" y1="' + y + '" y2="' + y + '" stroke="#ECE6DE"/>';
      svg += '<text x="' + (pl - 6) + '" y="' + (y + 4) + '" text-anchor="end">' + fmtEje(tope * t) + "</text>";
    });
    let pico = -1;
    c.buckets.forEach((b, i) => {
      if (b.valor > 0 && (pico < 0 || b.valor > c.buckets[pico].valor)) pico = i;
    });
    c.buckets.forEach((b, i) => {
      const x = pl + i * slot + (slot - bw) / 2;
      const h = b.valor > 0 ? Math.max((b.valor / tope) * plotH, 2) : 0;
      const y = pt + plotH - h;
      if (b.valor > 0) {
        svg += '<rect x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + h.toFixed(1) + '" rx="2" fill="' + (b.hoy ? "#7A3B33" : "#350A06") + '">' +
          "<title>" + escHtml(b.titulo + (b.hoy ? " (hoy)" : "") + ": " + fmtMoney(b.valor) + " · " + b.pedidos + (b.pedidos === 1 ? " pedido" : " pedidos")) + "</title></rect>";
      }
      if (i % paso === 0) {
        svg += '<text x="' + (x + bw / 2).toFixed(1) + '" y="' + (H - 8) + '" text-anchor="middle">' + escHtml(b.etiqueta) + "</text>";
      }
    });
    if (pico >= 0) {
      const b = c.buckets[pico];
      const cx = pl + pico * slot + slot / 2;
      const yy = pt + plotH - Math.max((b.valor / tope) * plotH, 2) - 5;
      const anc = cx < pl + 50 ? "start" : cx > W - 50 ? "end" : "middle";
      const ax = anc === "start" ? cx - bw / 2 : anc === "end" ? cx + bw / 2 : cx;
      svg += '<text x="' + ax.toFixed(1) + '" y="' + yy.toFixed(1) + '" text-anchor="' + anc + '" style="fill:#241008;font-weight:600">' + escHtml(fmtMoney(b.valor)) + "</text>";
    } else {
      svg += '<text x="' + (pl + plotW / 2) + '" y="' + (pt + plotH / 2) + '" text-anchor="middle">Sin ventas en este período</text>';
    }
    box.innerHTML = svg + "</svg>";
  }

  function barrasHtml(items, total, sufijo) {
    const tope = items.length ? items[0].valor : 0;
    return items
      .map(
        (it) =>
          '<div class="row"><span class="nm">' + it.nombre + '</span><div class="track" aria-hidden="true"><div class="fill" style="width:' +
          (tope ? Math.max((it.valor / tope) * 100, 2) : 0).toFixed(1) + '%"></div></div><span class="amt">' + fmtMoney(it.valor) +
          '<span class="pct">' + (sufijo ? sufijo(it) : total ? Math.round((it.valor / total) * 100) + "%" : "") + "</span></span></div>"
      )
      .join("");
  }

  function normCat(c) {
    const k = String(c || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
    return k || "otro";
  }

  function edadHtml(d) {
    return '<span class="age' + (d >= 2 ? " late" : "") + '">' + (d <= 0 ? "hoy" : d === 1 ? "1 día" : d + " días") + "</span>";
  }

  function setEstadoDash(tipo, html) {
    const el = document.getElementById("dash-status");
    if (!tipo) { el.hidden = true; el.innerHTML = ""; el.className = "dash-status"; return; }
    el.className = "dash-status" + (tipo === "err" ? " err" : "");
    el.innerHTML = html;
    el.hidden = false;
  }

  function renderDashboard() {
    try {
      renderDashboardInterno();
    } catch (e) {
      console.error(e);
      setEstadoDash("err", "No se pudo dibujar el resumen: " + escHtml(e && e.message ? e.message : e));
    }
  }

  function renderDashboardInterno() {
    const hoy = todayStr();
    const R = dashRango(hoy);
    const cur = calcPeriodo(R.desde, R.hasta);
    const prev = R.prev ? calcPeriodo(R.prev[0], R.prev[1]) : null;
    const hayP = !!pedidosEstado.hayDatos;
    const hayG = !!gastosEstado.hayDatos;
    const guion = "—";

    document.getElementById("dash-range").textContent =
      fmtRango(R.desde, R.hasta) + (R.desde === hoy && R.hasta === hoy ? " (hoy)" : "") + " · " +
      (R.prev ? "comparado con " + fmtRango(R.prev[0], R.prev[1]) : "sin comparación");
    const panel = document.getElementById("panel-dashboard");
    panel.setAttribute("aria-busy", dash.visibleLoading || (dash.loading && !(pedidosEstado.intento && gastosEstado.intento)) ? "true" : "false");

    // Avisos: fechas al revés, datos recortados
    const notas = [];
    if (R.nota) notas.push(R.nota);
    if (pedidosEstado.truncado || gastosEstado.truncado) notas.push("Hay más registros que los que se pueden mostrar: los números del dashboard pueden quedar incompletos.");
    const notaEl = document.getElementById("dash-note");
    notaEl.hidden = !notas.length;
    notaEl.className = "dash-note" + (R.nota || notas.length ? " warn" : "");
    notaEl.textContent = notas.join(" ");

    // Estado de la carga
    const fallos = [];
    if (pedidosEstado.intento && !pedidosEstado.ok) fallos.push({ que: "los pedidos", msg: pedidosEstado.error });
    if (gastosEstado.intento && !gastosEstado.ok) fallos.push({ que: "los gastos", msg: gastosEstado.error });
    if (fallos.length) {
      setEstadoDash(
        "err",
        "<span>No se pudieron cargar " + fallos.map((f) => f.que).join(" ni ") + " (" + escHtml(fallos[0].msg) + "). " +
          (hayP && hayG ? "Lo que ves puede estar desactualizado." : "Por eso no se muestran esos números.") +
          '</span><button type="button" class="btn-soft" data-act="reintentar">Reintentar</button>'
      );
    } else if (dash.loading && !(pedidosEstado.intento && gastosEstado.intento)) {
      setEstadoDash("info", "Cargando datos…");
    } else {
      setEstadoDash(null);
    }

    // --- Para atender ahora (todos los pedidos, no depende del período) ---
    const cnt = {};
    ESTADOS.forEach((e) => { cnt[e] = 0; });
    pedidosCache.forEach((p) => { if (cnt[p.estado] !== undefined) cnt[p.estado]++; });
    const nuevos = pedidosCache
      .filter((p) => p.estado === "nuevo")
      .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    const edadMax = nuevos.length ? diffDays(nuevos[0]._dia, hoy) : 0;
    const subNuevos = !hayP ? "" : !nuevos.length ? "Todo al día" : edadMax > 0 ? "El más viejo espera hace " + edadMax + (edadMax === 1 ? " día" : " días") : "Todos llegaron hoy";
    const tile = (est, label, extra, hot) =>
      '<button type="button" class="att' + (hot ? " hot" : "") + '" data-estado="' + est + '"><span class="n">' + (hayP ? cnt[est] : guion) +
      '</span><span class="l">' + label + "</span>" + (extra ? '<span class="sub">' + extra + "</span>" : "") + "</button>";
    document.getElementById("dash-atencion").innerHTML =
      tile("nuevo", "Nuevos sin gestionar", subNuevos, hayP && cnt.nuevo > 0) +
      tile("confirmado", "Confirmados, sin empezar") +
      tile("en_produccion", "En producción") +
      tile("listo", "Listos para entregar");

    // --- Indicadores ---
    const s = cur.cancelados;
    const kIng = hayP
      ? kpiHtml("Ingresos", fmtMoney(cur.ingresos), "", [
          prev ? deltaPct(cur.ingresos, prev.ingresos, false) : "Todo el historial",
          "Entregado: " + fmtMoney(cur.entregados),
        ])
      : kpiHtml("Ingresos", guion, "", ["Sin datos"]);
    const kGas = hayG
      ? kpiHtml("Gastos", fmtMoney(cur.totalGastos), "", [prev ? deltaPct(cur.totalGastos, prev.totalGastos, true) : "Todo el historial"])
      : kpiHtml("Gastos", guion, "", ["Sin datos"]);
    let kSal;
    if (hayP && hayG) {
      kSal = kpiHtml("Saldo de caja", fmtMoney(cur.saldo), cur.saldo >= 0 ? "pos" : "neg", [
        prev ? deltaMonto(cur.saldo, prev.saldo) : "Todo el historial",
        cur.cobrado > 0
          ? (cur.saldo >= 0 ? "Queda el " + Math.round(cur.margen) + "% de lo cobrado" : "Los gastos superan a lo cobrado")
          : cur.ingresos > 0 ? "Todavía no cobraste nada en el período" : "Sin ingresos en el período",
        cur.nPorCobrar > 0 ? "Por cobrar: " + fmtMoney(cur.porCobrar) + " (" + cur.nPorCobrar + (cur.nPorCobrar === 1 ? " pedido" : " pedidos") + " con pago pendiente)" : "",
      ]);
    } else {
      kSal = kpiHtml("Saldo de caja", guion, "", ["Falta cargar datos"]);
    }
    const kPed = hayP
      ? kpiHtml("Pedidos", String(cur.ok.length), "", [
          prev ? deltaPct(cur.ok.length, prev.ok.length, false) : "Todo el historial",
          "Ticket promedio " + fmtMoney(cur.ticket) + (s ? " · " + s + (s === 1 ? " cancelado" : " cancelados") : ""),
        ])
      : kpiHtml("Pedidos", guion, "", ["Sin datos"]);
    document.getElementById("dash-kpis").innerHTML = kIng + kGas + kSal + kPed;
    renderGananciaNeta(cur, prev, hayP, hayG);

    // --- Gráfico de ingresos ---
    const B = armarBuckets(R.desde, R.hasta, cur.ok);
    const pico = B.buckets.reduce((m, b) => (b.valor > (m ? m.valor : 0) ? b : m), null);
    const unidad = B.gran;
    const aria = "Ingresos por " + unidad + ", del " + fmtDMY(R.desde) + " al " + fmtDMY(R.hasta) + ". Total " + fmtMoney(cur.ingresos) +
      (pico ? ". Mejor " + unidad + ": " + pico.titulo + " con " + fmtMoney(pico.valor) + "." : ". Sin ventas en el período.");
    dash.chart = { buckets: B.buckets, gran: B.gran, aria: hayP ? aria : "Ingresos: todavía sin datos." };
    document.getElementById("dash-chart-title").textContent = "Ingresos por " + unidad;
    document.getElementById("dash-chart-hint").textContent = !hayP
      ? "Todavía no hay datos para mostrar."
      : pico
      ? "Mejor " + unidad + ": " + pico.titulo + " (" + fmtMoney(pico.valor) + ")." + (unidad === "semana" ? " Cada barra es una semana, desde el lunes." : unidad === "mes" ? " Cada barra es un mes." : " Los días sin ventas se ven vacíos.")
      : "Sin ventas en este período.";
    if (hayP) drawChart();
    else document.getElementById("dash-chart").innerHTML = '<p class="empty-inline">Sin datos todavía.</p>';
    const conVentas = B.buckets.filter((b) => b.valor > 0);
    document.getElementById("dash-chart-table").innerHTML = conVentas.length
      ? '<table><thead><tr><th>' + (unidad === "día" ? "Día" : unidad === "semana" ? "Semana" : "Mes") + '</th><th>Pedidos</th><th>Ingresos</th></tr></thead><tbody>' +
        conVentas.map((b) => "<tr><td>" + escHtml(b.titulo) + "</td><td>" + b.pedidos + "</td><td>" + fmtMoney(b.valor) + "</td></tr>").join("") + "</tbody></table>"
      : '<p class="empty-inline">Sin ventas en este período.</p>';

    // --- Gastos por categoría ---
    const cats = {};
    cur.gastos.forEach((g) => { const k = normCat(g.categoria); cats[k] = (cats[k] || 0) + num(g.monto); });
    const listaCats = Object.keys(cats)
      .map((k) => ({ nombre: escHtml(CAT_LABEL[k] || (String(k).charAt(0).toUpperCase() + String(k).slice(1))), valor: cats[k] }))
      .sort((a, b) => b.valor - a.valor);
    const notaInv = cur.inversion.length ? " Inversión inicial aparte: " + fmtMoney(cur.totalInversion) + " (no cuenta en la caja ni en la ganancia)." : "";
    document.getElementById("dash-gastos-hint").textContent = !hayG ? "Todavía no hay datos para mostrar." : (cur.gastos.length ? "Total " + fmtMoney(cur.totalGastos) + " en " + cur.gastos.length + (cur.gastos.length === 1 ? " gasto" : " gastos") + "." : "Sin gastos en este período.") + notaInv;
    document.getElementById("dash-gastos-bars").innerHTML = hayG ? barrasHtml(listaCats, cur.totalGastos) : "";

    // --- Ventas por canal ---
    const porCanal = {};
    cur.ok.forEach((p) => {
      const c = porCanal[p.canal] || (porCanal[p.canal] = { valor: 0, n: 0 });
      c.valor += num(p.subtotal);
      c.n++;
    });
    const listaCanal = Object.keys(porCanal)
      .map((k) => ({ nombre: escHtml(CANAL_LABEL[k] || k), valor: porCanal[k].valor, n: porCanal[k].n }))
      .sort((a, b) => b.valor - a.valor);
    document.getElementById("dash-canal-hint").textContent = !hayP ? "Todavía no hay datos para mostrar." : listaCanal.length ? "Ingresos por dónde entró la venta, sin cancelados." : "Sin ventas en este período.";
    document.getElementById("dash-canal-bars").innerHTML = hayP ? barrasHtml(listaCanal, cur.ingresos, (it) => it.n + (it.n === 1 ? " pedido" : " pedidos")) : "";

    // --- Lo más pedido ---
    // Por producto: unidades y, si se conoce el costo de todas, la ganancia (ventas − costo de esas unidades).
    const porProd = {};
    cur.ok.forEach((p) => p.items.forEach((it) => {
      const nombre = String((it && it.nombre) || "Sin nombre");
      const a = porProd[nombre] || (porProd[nombre] = { u: 0, venta: 0, costo: 0, falta: false, conPrecio: false });
      const q = num(it && it.qty);
      a.u += q;
      if (it && it.precio !== null && it.precio !== undefined) {
        a.conPrecio = true;
        a.venta += q * num(it.precio);
        const c = costoItem(it);
        if (c.v === null) a.falta = true;
        else a.costo += q * c.v;
      }
    }));
    const top = Object.keys(porProd).map((k) => [k, porProd[k]]).sort((a, b) => b[1].u - a[1].u).slice(0, 5);
    const gpHtml = (a) =>
      !a.conPrecio
        ? '<span class="gp none">a cotizar</span>'
        : a.falta
        ? '<span class="gp none">sin costo</span>'
        : '<span class="gp' + (a.venta - a.costo < 0 ? " neg" : "") + '">ganancia ' + fmtMoney(a.venta - a.costo) + "</span>";
    document.getElementById("dash-top").innerHTML = !hayP
      ? ""
      : top.length
      ? top.map((t) => "<li><span>" + escHtml(t[0]) + gpHtml(t[1]) + '</span><span class="u">' + t[1].u + " un.</span></li>").join("")
      : '<li class="empty-inline">Sin pedidos en este período.</li>';

    // --- Pedidos nuevos sin gestionar ---
    const vista = nuevos.slice(0, MAX_NUEVOS);
    document.getElementById("dash-nuevos-hint").textContent = !hayP
      ? "Todavía no hay datos para mostrar."
      : nuevos.length
      ? nuevos.length + (nuevos.length === 1 ? " espera respuesta" : " esperan respuesta") + " · del más viejo al más nuevo" + (nuevos.length > MAX_NUEVOS ? " · se muestran " + MAX_NUEVOS : "")
      : "";
    document.getElementById("dash-nuevos-empty").hidden = !(hayP && !nuevos.length);
    document.getElementById("dash-nuevos-tbody").innerHTML = vista
      .map((p) =>
        "<tr><td data-label=\"Hace\">" + edadHtml(diffDays(p._dia, hoy)) + "</td>" +
        "<td data-label=\"Cliente\"><span>" + escHtml(p.cliente_nombre) + canalTag(p.canal) + "<br><span class=\"muted\">" + escHtml(p.cliente_telefono) + "</span></span></td>" +
        "<td data-label=\"Items\">" + resumenItems(p.items) + "</td>" +
        "<td class=\"m\" data-label=\"Subtotal\">" + fmtMoney(p.subtotal) + "</td>" +
        "<td class=\"act\"><button type=\"button\" class=\"btn-soft\" data-ir-pedido=\"" + escAttr(p.id) + "\">Abrir</button></td></tr>"
      )
      .join("");
    document.querySelector("#panel-dashboard table.nt").hidden = !vista.length;
  }

  // Ganancia neta del período, desglosada: ingresos − costo de las piezas − otros gastos.
  function renderGananciaNeta(cur, prev, hayP, hayG) {
    const body = document.getElementById("dash-gn-body");
    document.getElementById("dash-gn-hint").textContent =
      "Ventas − costo de las piezas − otros gastos. El filamento y la luz ya están dentro del costo de las piezas, por eso no se restan dos veces.";
    if (!hayP || !hayG) {
      body.innerHTML = '<p class="empty-inline">Todavía no hay datos para calcularla.</p>';
      return;
    }
    const ing = cur.ingresos;
    const pct = (v) => (ing > 0 ? Math.round((v / ing) * 100) + "%" : "—");
    const linea = (txt, monto, extra, cls, delta) =>
      '<div class="gn-line' + (cls ? " " + cls : "") + '"><span class="t">' + txt + (delta ? '<span class="gn-d">' + delta + "</span>" : "") +
      '</span><span class="a">' + monto + '</span><span class="p">' + extra + "</span></div>";

    const w = (() => {
      if (!(ing > 0)) return [0, 0, 0];
      if (cur.ganancia >= 0) return [cur.costoPiezas / ing, cur.gastosOp / ing, cur.ganancia / ing];
      const t = cur.costoPiezas + cur.gastosOp;
      return t > 0 ? [cur.costoPiezas / t, cur.gastosOp / t, 0] : [0, 0, 0];
    })();
    const ariaBar = ing > 0
      ? "De los ingresos: costo de piezas " + pct(cur.costoPiezas) + ", otros gastos " + pct(cur.gastosOp) + ", ganancia neta " + pct(cur.ganancia) + "."
      : "Sin ingresos en el período.";

    const notas = [];
    if (costosEstado.intento && !costosEstado.ok) {
      notas.push({
        warn: true,
        html: costosEstado.falta
          ? "Todavía no se pueden cargar costos: falta correr <strong>supabase/migracion_dashboard.sql</strong> en Supabase. Mientras tanto, los pedidos nuevos cuentan sin costo."
          : "No se pudieron leer los costos (" + escHtml(costosEstado.error) + "): la ganancia no los descuenta.",
      });
    }
    if (cur.ok.length && cur.pedSinCosto > 0) {
      const parte = ing > 0 ? " (el " + Math.round((cur.ingSinCosto / ing) * 100) + "% de los ingresos)" : "";
      notas.push({
        warn: true,
        html: "Faltan costos en " + cur.pedSinCosto + " de " + cur.ok.length + (cur.ok.length === 1 ? " pedido" : " pedidos") + parte +
          ". Esa parte cuenta sin costo, así que la ganancia puede estar sobreestimada. " +
          '<button type="button" class="btn-soft" data-act="ir-costos">Cargar costos</button>',
      });
    }
    if (cur.pedEstimado > 0) {
      notas.push({ warn: false, html: "En " + cur.pedEstimado + (cur.pedEstimado === 1 ? " pedido" : " pedidos") + " se usó el costo actual del producto, porque no quedó guardado al vender." });
    }
    if (cur.nPorCobrar > 0) {
      notas.push({ warn: false, html: "Hay " + fmtMoney(cur.porCobrar) + " con pago pendiente (" + cur.nPorCobrar + (cur.nPorCobrar === 1 ? " pedido" : " pedidos") + "): la ganancia cuenta esas ventas, pero el saldo de caja solo suma lo cobrado." });
    }
    if (cur.totalInversion > 0) {
      notas.push({ warn: false, html: "Inversión inicial del período (" + fmtMoney(cur.totalInversion) + ") no se resta de la ganancia ni de la caja: se ve aparte." });
    }
    if (cur.gastosEnCosto > 0) {
      notas.push({ warn: false, html: "Filamento y electricidad cargados en Gastos (" + fmtMoney(cur.gastosEnCosto) + ") no se restan otra vez: ya están en el costo de las piezas." });
    }

    body.innerHTML =
      '<div class="gn-grid">' +
        '<div class="gn-main"><div class="gn-val ' + (cur.ganancia >= 0 ? "pos" : "neg") + '" id="dash-gn-val">' + fmtMoney(cur.ganancia) + "</div>" +
          '<div class="gn-sub">' +
            (ing > 0 ? (cur.ganancia >= 0 ? "Margen neto " + Math.round(cur.margenNeto) + "% de lo que entra" : "Los costos y gastos superan a los ingresos") : "Sin ingresos en el período") +
          "</div>" +
          '<div class="gn-sub">' + (prev ? deltaMonto(cur.ganancia, prev.ganancia) : "Todo el historial") + "</div>" +
        "</div>" +
        '<div class="gn-lines">' +
          linea("Ingresos", fmtMoney(ing), ing > 0 ? "100%" : "—") +
          linea("− Costo de piezas", fmtMoney(cur.costoPiezas), pct(cur.costoPiezas), "", prev ? deltaPct(cur.costoPiezas, prev.costoPiezas, true) : "") +
          linea("− Otros gastos", fmtMoney(cur.gastosOp), pct(cur.gastosOp), "", prev ? deltaPct(cur.gastosOp, prev.gastosOp, true) : "") +
          linea("= Ganancia neta", fmtMoney(cur.ganancia), pct(cur.ganancia), "tot") +
        "</div>" +
      "</div>" +
      '<div class="gn-bar" role="img" aria-label="' + escAttr(ariaBar) + '">' +
        '<span class="c1" style="width:' + (w[0] * 100).toFixed(2) + '%"></span>' +
        '<span class="c2" style="width:' + (w[1] * 100).toFixed(2) + '%"></span>' +
        '<span class="c3" style="width:' + (w[2] * 100).toFixed(2) + '%"></span>' +
      "</div>" +
      '<div class="gn-legend" aria-hidden="true"><span><i class="c1"></i>Costo de piezas</span><span><i class="c2"></i>Otros gastos</span><span><i class="c3"></i>Ganancia neta</span></div>' +
      notas.map((n) => '<p class="gn-note' + (n.warn ? " warn" : "") + '">' + n.html + "</p>").join("");
  }

  function canalTag(c) {
    const k = CANALES.includes(c) ? c : "otro";
    return '<span class="canal-tag' + (k === "web" ? " web" : "") + '">' + escHtml(CANAL_LABEL[k]) + "</span>";
  }

  function resumenItems(items) {
    if (!items || !items.length) return "—";
    return items
      .map((it) => num(it && it.qty) + "× " + escHtml((it && it.nombre) || "Sin nombre") + (it && it.tamano ? " (" + escHtml(it.tamano) + ")" : ""))
      .join(", ");
  }

  /* ---- Actualización automática ---- */
  function actualizarTextoActualizado() {
    const el = document.getElementById("dash-upd");
    if (!dash.lastOkAt) { el.textContent = ""; return; }
    const min = Math.floor((Date.now() - dash.lastOkAt) / 60000);
    el.textContent = "Actualizado " + (min < 1 ? "hace un momento" : min < 60 ? "hace " + min + " min" : "hace " + Math.floor(min / 60) + " h");
  }

  function actualizarBadge() {
    const n = pedidosEstado.hayDatos ? pedidosCache.filter((p) => p.estado === "nuevo").length : 0;
    const b = document.getElementById("tab-badge");
    b.hidden = !n;
    b.innerHTML = n ? n + '<span class="sr-only"> pedidos nuevos</span>' : "";
    document.title = (n ? "(" + n + ") " : "") + TITLE_BASE;
  }

  function firmaDe() {
    return pedidosCache.length + "|" + pedidosCache.map((p) => p.id + ":" + p.estado + ":" + p.subtotal + ":" + p.pagado + ":" + p.plazo_entrega).join(",");
  }

  async function refreshDatos(op) {
    if (dash.loading) return;
    const silencioso = !!(op && op.silencioso);
    dash.loading = true;
    dash.visibleLoading = !silencioso;
    const btn = document.getElementById("dash-refresh");
    if (!silencioso) {
      btn.disabled = true;
      btn.textContent = "Actualizando…";
      document.getElementById("panel-dashboard").setAttribute("aria-busy", "true");
    }
    const antes = firmaDe();
    // Si los costos no se pudieron leer (por ejemplo, la migración todavía no estaba corrida), se reintenta junto con lo demás.
    const reintentaCostos = !costosEstado.ok;
    const [okP, okG] = await Promise.all([
      loadPedidos().catch(() => false), loadGastosTodos().catch(() => false), reintentaCostos ? loadCostos().catch(() => false) : null,
    ]);
    if (reintentaCostos && costosEstado.ok) { renderProductos(); renderProdCostos(); }
    renderGastos();
    dash.loading = false;
    dash.visibleLoading = false;
    btn.disabled = false;
    btn.textContent = "↻ Actualizar";
    if (okP && okG) dash.lastOkAt = Date.now();
    renderDashboard();
    actualizarBadge();
    actualizarAvisosPedidos();
    actualizarTextoActualizado();
    if (okP && firmaDe() !== antes) refrescarListaPedidos();
  }

  function iniciarAutoRefresh() {
    setInterval(() => {
      if (document.visibilityState === "visible") refreshDatos({ silencioso: true });
    }, 60000);
    setInterval(actualizarTextoActualizado, 15000);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState !== "visible") return;
      if (Date.now() - dash.lastOkAt > 30000 || !pedidosEstado.ok || !gastosEstado.ok) refreshDatos({ silencioso: true });
      actualizarTextoActualizado();
    });
    actualizarTextoActualizado();
    actualizarBadge();
  }

  /* ============ PEDIDOS ============ */
  const elBuscar = document.getElementById("pedidos-buscar");
  const elFiltroEstado = document.getElementById("pedidos-filtro-estado");
  const elFiltroCanal = document.getElementById("pedidos-filtro-canal");
  const elFiltroPago = document.getElementById("pedidos-filtro-pago");
  const elFiltroPlazo = document.getElementById("pedidos-filtro-plazo");
  const elPlazosAviso = document.getElementById("pedidos-plazos");
  const elPedidosSql = document.getElementById("pedidos-sql");
  const elPedidosTbody = document.getElementById("pedidos-tbody");
  const elPedidosMsg = document.getElementById("pedidos-msg");
  let msgTimer = null;
  let msgTipo = "";

  /* Grupos de la lista: Activos (todo lo que sigue en marcha), Finalizados (entregados) y Cancelados. */
  const GRUPOS = {
    activos: { label: "Activos", estados: ["nuevo", "confirmado", "en_produccion", "listo"] },
    finalizados: { label: "Finalizados", estados: ["entregado"] },
    cancelados: { label: "Cancelados", estados: ["cancelado"] },
    todos: { label: "Todos", estados: ESTADOS.slice() },
  };
  // Un estado raro (que no es ninguno de los seis) se muestra en Activos para que no quede escondido.
  const grupoDe = (estado) => (estado === "entregado" ? "finalizados" : estado === "cancelado" ? "cancelados" : "activos");
  let pedidosGrupo = "activos";
  const ffPedidos = crearFiltroFecha(document.getElementById("pedidos-fecha"), "pedidos", () => renderPedidos());

  // El selector de estado solo ofrece los estados del grupo elegido (y se oculta si el grupo tiene uno solo).
  function poblarFiltroEstado() {
    const est = GRUPOS[pedidosGrupo].estados;
    elFiltroEstado.innerHTML =
      '<option value="todos">' + (pedidosGrupo === "todos" ? "Todos los estados" : "Todos los " + GRUPOS[pedidosGrupo].label.toLowerCase()) + "</option>" +
      est.map((e) => '<option value="' + e + '">' + ESTADO_LABEL[e] + "</option>").join("");
    elFiltroEstado.value = "todos";
    elFiltroEstado.hidden = est.length < 2;
  }
  function setGrupoPedidos(g, estado) {
    pedidosGrupo = GRUPOS[g] ? g : "activos";
    document.querySelectorAll("#pedidos-grupos button[data-grupo]").forEach((b) => b.setAttribute("aria-pressed", b.dataset.grupo === pedidosGrupo ? "true" : "false"));
    poblarFiltroEstado();
    if (estado && GRUPOS[pedidosGrupo].estados.includes(estado)) elFiltroEstado.value = estado;
  }
  poblarFiltroEstado();
  document.getElementById("pedidos-grupos").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-grupo]");
    if (!b) return;
    setGrupoPedidos(b.dataset.grupo);
    renderPedidos();
  });

  elBuscar.addEventListener("input", renderPedidos);
  elFiltroEstado.addEventListener("change", renderPedidos);
  elFiltroCanal.addEventListener("change", renderPedidos);
  elFiltroPago.addEventListener("change", renderPedidos);
  elFiltroPlazo.addEventListener("change", renderPedidos);

  function mostrarMsgPedidos(tipo, texto, op) {
    elPedidosMsg.className = "inline-msg " + tipo;
    elPedidosMsg.textContent = texto;
    if (op && op.accion) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "btn-soft";
      b.style.marginLeft = "10px";
      b.dataset.act = op.accion;
      b.textContent = op.accion === "reintentar" ? "Reintentar" : "Mostrar";
      elPedidosMsg.appendChild(b);
    }
    elPedidosMsg.hidden = false;
    msgTipo = op && op.clave ? op.clave : tipo;
    clearTimeout(msgTimer);
    if (tipo === "ok") msgTimer = setTimeout(ocultarMsgPedidos, 7000);
  }
  function ocultarMsgPedidos() {
    clearTimeout(msgTimer);
    elPedidosMsg.hidden = true;
    elPedidosMsg.textContent = "";
    msgTipo = "";
  }
  elPedidosMsg.addEventListener("click", (e) => {
    const b = e.target.closest("[data-act]");
    if (!b) return;
    if (b.dataset.act === "reintentar") refreshDatos({ manual: true });
    if (b.dataset.act === "mostrar") { pedidosSucio = false; ocultarMsgPedidos(); renderPedidos(); }
  });

  // Aviso fijo cuando no se pudieron leer los pedidos (y se retira solo cuando vuelven a cargar).
  function actualizarAvisosPedidos() {
    if (pedidosEstado.intento && !pedidosEstado.ok) {
      mostrarMsgPedidos("err", "No se pudieron cargar los pedidos (" + pedidosEstado.error + "). Lo que ves puede estar desactualizado.", { accion: "reintentar", clave: "carga" });
    } else if (msgTipo === "carga") {
      ocultarMsgPedidos();
    }
    actualizarBadge();
  }

  // Después de una actualización automática: no se redibuja la lista si el usuario está leyendo un detalle.
  function refrescarListaPedidos() {
    const activo = document.getElementById("panel-pedidos").classList.contains("active");
    const enUso = !!elPedidosTbody.querySelector("tr.detalle-row:not(.hidden-row)") || elPedidosTbody.contains(document.activeElement);
    if (!activo) { pedidosSucio = true; return; }
    if (enUso) {
      pedidosSucio = true;
      mostrarMsgPedidos("info", "Hay cambios en los pedidos.", { accion: "mostrar", clave: "cambios" });
      return;
    }
    renderPedidos();
  }

  // Pedidos que cumplen búsqueda, canal y fechas (sin mirar el grupo ni el estado): de acá salen los números de los chips.
  function pedidosBase() {
    const term = elBuscar.value.trim().toLowerCase();
    const canalFiltro = elFiltroCanal.value;
    const pagoFiltro = elFiltroPago.value;
    const plazoFiltro = elFiltroPlazo.value;
    const hoy = todayStr();
    const rango = ffPedidos.rango();
    return pedidosCache.filter((p) => {
      if (canalFiltro !== "todos" && p.canal !== canalFiltro) return false;
      if (!ffEnRango(rango, p._dia)) return false;
      // Un pedido cancelado no debe nada: no entra ni en "pago pendiente" ni en "pagados".
      if (pagoFiltro === "pendientes" && (esPagado(p) || p.estado === "cancelado")) return false;
      if (pagoFiltro === "pagados" && (!esPagado(p) || p.estado === "cancelado")) return false;
      if (plazoFiltro !== "todos") {
        const pe = plazoEstado(p, hoy);
        if (plazoFiltro === "sin" && p._plazo) return false;
        if (plazoFiltro === "con" && !p._plazo) return false;
        if (plazoFiltro === "vencidos" && !(pe && pe.tipo === "vencido")) return false;
        if (plazoFiltro === "pronto" && !(pe && (pe.tipo === "vencido" || pe.tipo === "hoy" || pe.tipo === "pronto"))) return false;
      }
      if (term && ![p.cliente_nombre, p.cliente_telefono, p.cliente_email].filter(Boolean).join(" ").toLowerCase().includes(term)) return false;
      return true;
    });
  }
  // Lo que se ve en la lista (y lo que baja el Excel).
  function pedidosVisibles(base) {
    const estadoFiltro = elFiltroEstado.value;
    const g = pedidosGrupo;
    const lista = (base || pedidosBase()).filter((p) => (g === "todos" || grupoDe(p.estado) === g) && (estadoFiltro === "todos" || p.estado === estadoFiltro));
    // Mirando plazos, lo que vence antes va primero.
    if (["pronto", "vencidos", "con"].indexOf(elFiltroPlazo.value) >= 0) lista.sort((a, b) => (a._plazo < b._plazo ? -1 : a._plazo > b._plazo ? 1 : 0));
    return lista;
  }

  // Aviso de arriba: pedidos activos con el plazo vencido o que vencen hoy (de todos los pedidos, sin importar los filtros).
  function actualizarAvisoPlazos() {
    const hoy = todayStr();
    let vencidos = 0, hoyN = 0;
    pedidosCache.forEach((p) => {
      const pe = plazoEstado(p, hoy);
      if (!pe) return;
      if (pe.tipo === "vencido") vencidos++;
      else if (pe.tipo === "hoy") hoyN++;
    });
    elPedidosSql.hidden = colsPedidoNuevas !== false;
    if (!vencidos && !hoyN) { elPlazosAviso.hidden = true; elPlazosAviso.innerHTML = ""; return; }
    const partes = [];
    if (vencidos) partes.push("<strong>" + vencidos + (vencidos === 1 ? " pedido con el plazo vencido" : " pedidos con el plazo vencido") + "</strong>");
    if (hoyN) partes.push("<strong>" + hoyN + (hoyN === 1 ? " vence hoy" : " vencen hoy") + "</strong>");
    elPlazosAviso.className = "plazo-aviso" + (vencidos ? " late" : "");
    elPlazosAviso.innerHTML = "<span>" + partes.join(" · ") + '</span><button type="button" class="btn-soft" data-act="ver-plazos">Ver los urgentes</button>';
    elPlazosAviso.hidden = false;
  }
  elPlazosAviso.addEventListener("click", (e) => {
    if (!e.target.closest('[data-act="ver-plazos"]')) return;
    elBuscar.value = "";
    elFiltroCanal.value = "todos";
    elFiltroPago.value = "todos";
    ffPedidos.reiniciar();
    setGrupoPedidos("activos");
    elFiltroPlazo.value = "pronto";
    pedidosSucio = false;
    renderPedidos();
  });
  function actualizarChipsPedidos(base) {
    const n = { activos: 0, finalizados: 0, cancelados: 0, todos: base.length };
    base.forEach((p) => { n[grupoDe(p.estado)]++; });
    document.querySelectorAll("#pedidos-grupos .seg-n").forEach((el) => {
      el.textContent = pedidosEstado.hayDatos ? "(" + n[el.dataset.n] + ")" : "";
    });
  }

  // Botón de pago de cada pedido (no se muestra en cancelados, ni mientras las columnas nuevas no existan en la base).
  function pagoChipHtml(p) {
    if (p.estado === "cancelado" || colsPedidoNuevas === false) return "";
    const ok = esPagado(p);
    const quien = p.cliente_nombre || "este cliente";
    return (
      '<button type="button" class="pago-chip ' + (ok ? "ok" : "pend") + '" data-act="toggle-pago" data-id="' + escAttr(p.id) + '" aria-pressed="' + (ok ? "true" : "false") + '" ' +
      'aria-label="' + escAttr((ok ? "Pagado. Tocá para marcar el pedido de " + quien + " como pago pendiente" : "Pago pendiente. Tocá para marcar el pedido de " + quien + " como pagado")) + '">' +
      (ok ? "✓ Pagado" : "Pago pendiente") + "</button>"
    );
  }
  function subtotalCeldaHtml(p) {
    return '<span class="sub-cell"><span>' + fmtMoney(p.subtotal) + "</span>" + pagoChipHtml(p) + "</span>";
  }
  function entregaCeldaHtml(p) {
    const pe = colsPedidoNuevas === false ? null : plazoEstado(p, todayStr());
    return '<span class="sub-cell"><span>' + escHtml(p.entrega) + "</span>" + (pe && p.estado !== "cancelado" ? '<span class="plazo-chip ' + pe.tipo + '">' + escHtml(pe.texto) + "</span>" : "") + "</span>";
  }

  function renderPedidos() {
    actualizarAvisoPlazos();
    const base = pedidosBase();
    actualizarChipsPedidos(base);
    const list = pedidosVisibles(base);

    document.getElementById("pedidos-empty").style.display = list.length ? "none" : "block";
    document.getElementById("pedidos-count").textContent =
      (pedidosEstado.hayDatos ? "Mostrando " + list.length + " de " + pedidosCache.length + (pedidosCache.length === 1 ? " pedido" : " pedidos") : "") +
      (pedidosEstado.truncado ? " · hay más pedidos viejos que no se cargaron" : "");

    elPedidosTbody.innerHTML = list
      .map((p) => {
        const conocido = ESTADOS.includes(p.estado);
        const estadoClase = conocido ? p.estado : "desconocido";
        const estadoOptions =
          (conocido ? "" : '<option value="' + escAttr(p.estado) + '" selected>Desconocido</option>') +
          ESTADOS.map((e) => '<option value="' + e + '"' + (e === p.estado ? " selected" : "") + ">" + ESTADO_LABEL[e] + "</option>").join("");
        const id = escAttr(p.id);
        return (
          '<tr class="clickable" data-pedido-id="' + id + '"><td data-label="Fecha">' + fmtFecha(p.created_at) +
          '</td><td data-label="Cliente"><span>' + escHtml(p.cliente_nombre) + canalTag(p.canal) + "<br><span class='muted'>" + escHtml(p.cliente_telefono) + '</span></span></td><td data-label="Items">' +
          resumenItems(p.items) + '</td><td data-label="Subtotal">' + subtotalCeldaHtml(p) + '</td><td data-label="Entrega">' + entregaCeldaHtml(p) +
          '</td><td data-label="Estado"><select class="estado-select estado-' + estadoClase + '" data-id="' + id + '" aria-label="Estado del pedido de ' + escAttr(p.cliente_nombre) + '">' +
          estadoOptions + '</select></td><td class="act"><div class="row-acts"><button type="button" class="btn-secondary btn-small btn-detalle" aria-expanded="false" aria-controls="detalle-' + id + '">Detalle</button>' +
          '<button type="button" class="btn-secondary btn-small" data-act="editar-pedido" data-id="' + id + '" aria-label="Editar el pedido de ' + escAttr(p.cliente_nombre) + '">Editar</button>' +
          '<button type="button" class="btn-danger btn-small" data-act="eliminar-pedido" data-id="' + id + '" aria-label="Eliminar el pedido de ' + escAttr(p.cliente_nombre) + '">Eliminar</button></div></td></tr>' +
          '<tr class="detalle-row hidden-row" id="detalle-' + id + '" data-detalle-de="' + id + '"><td colspan="7">' + detallePedido(p) + "</td></tr>"
        );
      })
      .join("");
  }

  // Líneas extra del detalle: si está cobrado y el plazo de entrega prometido.
  function detallePagoPlazo(p) {
    if (colsPedidoNuevas === false) return "";
    let h = "";
    if (p.estado !== "cancelado") h += "<br><strong>Cobro:</strong> " + (esPagado(p) ? "pagado" : '<span class="gp-neg">pago pendiente</span> (no suma al saldo de caja)');
    const pe = plazoEstado(p, todayStr());
    h += "<br><strong>Plazo de entrega:</strong> " + (pe ? (pe.tipo === "vencido" ? '<span class="gp-neg">' + escHtml(pe.largo) + "</span>" : escHtml(pe.largo)) : "sin plazo");
    return h;
  }

  function detallePedido(p) {
    const items = (p.items || [])
      .map((it) => {
        it = it || {};
        const extras = [it.tamano, it.color].filter(Boolean).map(escHtml);
        const precio = it.precio === null || it.precio === undefined ? "a cotizar" : fmtMoney(num(it.precio)) + " c/u";
        let costoTxt = "";
        if (it.precio !== null && it.precio !== undefined) {
          const c = costoItem(it);
          costoTxt = c.v === null
            ? ' · <span class="badge-sc">sin costo</span>'
            : " · costo " + fmtMoney(c.v) + " c/u" + (c.src === "estimado" ? " <em>(costo actual)</em>" : "");
        }
        return (
          "• " + num(it.qty) + "× " + escHtml(it.nombre || "Sin nombre") +
          (extras.length ? " (" + extras.join(", ") + ")" : "") +
          " — " + precio + costoTxt +
          (num(it.descuento_cantidad_pct) ? " <em>(-" + num(it.descuento_cantidad_pct) + "% por cantidad, lista " + fmtMoney(num(it.precio_lista)) + ")</em>" : "") +
          (it.nota ? "<br>&nbsp;&nbsp;<em>Obs: " + escHtml(it.nota) + "</em>" : "")
        );
      })
      .join("<br>");
    // Costo y ganancia del pedido (solo si no está cancelado: un cancelado no cuenta en el dashboard)
    let rentab = "";
    if (p.estado !== "cancelado" && (p.items || []).some((it) => it && it.precio !== null && it.precio !== undefined)) {
      const cp = costoPedido(p);
      const gan = num(p.subtotal) - cp.costo;
      rentab =
        "<br><br><strong>Costo:</strong> " + fmtMoney(cp.costo) + " · <strong>Ganancia:</strong> " +
        '<span class="' + (gan >= 0 ? "gp-pos" : "gp-neg") + '">' + fmtMoney(gan) + "</span>" +
        (num(p.subtotal) > 0 ? " (" + Math.round((gan / num(p.subtotal)) * 100) + "% del cobro)" : "") +
        (cp.faltan ? ' <span class="badge-sc">faltan costos en ' + cp.faltan + (cp.faltan === 1 ? " producto" : " productos") + ": la ganancia real es menor</span>" : "") +
        (cp.estimado ? " <em>(parte con el costo actual del producto)</em>" : "");
    }
    const cotIds = Array.from(new Set((p.items || []).map((it) => it && it.cotizacion_id).filter(Boolean)));
    const cotTxt = cotIds.length
      ? "<br><strong>Cotización:</strong> " + cotIds.map((id) => { const c = cotizacionesCache.find((x) => x.id === id); return escHtml(c ? c.nombre_pieza : "cargada desde la calculadora"); }).join(", ")
      : "";
    return (
      "<strong>Items:</strong><br>" + (items || "—") + rentab +
      "<br><br><strong>Canal:</strong> " + escHtml(CANAL_LABEL[p.canal] || p.canal) + cotTxt +
      "<br><strong>Email:</strong> " + escHtml(p.cliente_email || "—") +
      "<br><strong>Dirección:</strong> " + escHtml(p.direccion || "—") +
      "<br><strong>Pago:</strong> " + escHtml(p.pago || "—") + detallePagoPlazo(p) +
      "<br><strong>Notas:</strong> " + escHtml(p.notas || "—")
    );
  }

  function toggleDetalle(id) {
    const rows = elPedidosTbody.querySelectorAll("tr.detalle-row");
    for (let i = 0; i < rows.length; i++) {
      if (rows[i].dataset.detalleDe !== String(id)) continue;
      const oculto = rows[i].classList.toggle("hidden-row");
      const tr = rows[i].previousElementSibling;
      const btn = tr && tr.querySelector(".btn-detalle");
      if (btn) btn.setAttribute("aria-expanded", oculto ? "false" : "true");
      return;
    }
  }

  // Un solo manejador para toda la tabla (en vez de código dentro de cada fila).
  elPedidosTbody.addEventListener("click", (e) => {
    if (e.target.closest("select, a, input")) return;
    const accion = e.target.closest("button[data-act]");
    if (accion) {
      if (accion.dataset.act === "editar-pedido") abrirEdicionPedido(accion.dataset.id);
      else if (accion.dataset.act === "eliminar-pedido") eliminarPedido(accion.dataset.id);
      else if (accion.dataset.act === "toggle-pago") {
        const p = pedidosCache.find((x) => String(x.id) === String(accion.dataset.id));
        if (p) cambiarPago(p.id, !esPagado(p), accion);
      }
      return;
    }
    const tr = e.target.closest("tr[data-pedido-id]");
    if (tr) toggleDetalle(tr.dataset.pedidoId);
  });
  elPedidosTbody.addEventListener("change", (e) => {
    const sel = e.target.closest("select.estado-select");
    if (sel) cambiarEstado(sel.dataset.id, sel.value, sel);
  });

  async function cambiarEstado(id, nuevoEstado, sel) {
    const p = pedidosCache.find((x) => String(x.id) === String(id));
    if (!p) return;
    const previo = p.estado;
    const volver = (texto) => {
      if (sel) {
        sel.disabled = false;
        sel.value = previo;
        sel.className = "estado-select estado-" + (ESTADOS.includes(previo) ? previo : "desconocido");
      }
      mostrarMsgPedidos("err", texto + " El pedido de " + (p.cliente_nombre || "este cliente") + " quedó como estaba (" + (ESTADO_LABEL[previo] || previo) + ").");
    };
    if (!ESTADOS.includes(nuevoEstado)) { volver("Estado no válido."); return; }
    if (sel) sel.disabled = true;
    let res;
    try {
      res = await stratoSb.from("pedidos").update({ estado: nuevoEstado }).eq("id", id).select("id");
    } catch (e) {
      volver("No se pudo guardar el cambio de estado (" + (e && e.message ? e.message : "error de conexión") + ").");
      return;
    }
    if (res.error) { volver("No se pudo guardar el cambio de estado (" + res.error.message + ")."); return; }
    // Supabase no da error si la regla de seguridad no deja modificar: simplemente no toca ninguna fila.
    if (Array.isArray(res.data) && res.data.length === 0) { volver("El cambio no se guardó (no se encontró el pedido o falta permiso)."); return; }

    p.estado = nuevoEstado;
    if (msgTipo === "err" || msgTipo === "cambios") ocultarMsgPedidos();
    if (sel) {
      sel.disabled = false;
      sel.className = "estado-select estado-" + nuevoEstado;
    }
    // El pedido puede pasar a otro grupo (por ejemplo de Activos a Finalizados) y dejar de verse en la lista actual.
    const sigueVisible = pedidosVisibles().some((x) => String(x.id) === String(id));
    if (!sigueVisible) {
      renderPedidos();
      mostrarMsgPedidos("ok", "El pedido de " + (p.cliente_nombre || "este cliente") + " pasó a «" + (ESTADO_LABEL[nuevoEstado] || nuevoEstado) + "» y ahora está en " + GRUPOS[grupoDe(nuevoEstado)].label + ".");
    } else {
      refrescarFilaPedido(p);
      actualizarChipsPedidos(pedidosBase());
    }
    actualizarAvisoPlazos(); // entregar o cancelar un pedido cambia si su plazo cuenta como urgente
    renderDashboard();
    actualizarBadge();
  }

  // Redibuja solo las celdas de una fila que dependen del estado o del pago (sin tocar el selector de estado que se está usando).
  function refrescarFilaPedido(p) {
    const filas = elPedidosTbody.querySelectorAll("tr[data-pedido-id]");
    for (let i = 0; i < filas.length; i++) {
      if (filas[i].dataset.pedidoId !== String(p.id)) continue;
      filas[i].querySelector('td[data-label="Subtotal"]').innerHTML = subtotalCeldaHtml(p);
      filas[i].querySelector('td[data-label="Entrega"]').innerHTML = entregaCeldaHtml(p);
      const det = filas[i].nextElementSibling;
      if (det && det.classList.contains("detalle-row")) det.firstElementChild.innerHTML = detallePedido(p);
      return filas[i];
    }
    return null;
  }

  // Marca un pedido como pagado o con pago pendiente. El saldo de caja del Dashboard cambia en el acto.
  async function cambiarPago(id, pagado, btn) {
    const p = pedidosCache.find((x) => String(x.id) === String(id));
    if (!p) return;
    const quien = p.cliente_nombre || "este cliente";
    const previo = esPagado(p);
    if (btn) btn.disabled = true;
    const volver = (texto) => {
      if (btn) btn.disabled = false;
      mostrarMsgPedidos("err", texto + " El pedido de " + quien + " quedó como estaba (" + (previo ? "pagado" : "pago pendiente") + ").");
    };
    let res;
    try {
      res = await stratoSb.from("pedidos").update({ pagado: pagado }).eq("id", id).select("id");
    } catch (e) {
      volver("No se pudo guardar el cambio de pago (" + (e && e.message ? e.message : "error de conexión") + ").");
      return;
    }
    if (res.error) {
      const t = String(res.error.message || "") + " " + String(res.error.code || "");
      if (/pagado|PGRST204/i.test(t)) {
        colsPedidoNuevas = false;
        renderPedidos();
        mostrarMsgPedidos("err", "Todavía falta correr " + SQL_PAGO + " en Supabase (agrega el pago pendiente y el plazo de entrega). Corrélo y volvé a intentar.");
        return;
      }
      volver("No se pudo guardar el cambio de pago (" + res.error.message + ").");
      return;
    }
    if (Array.isArray(res.data) && res.data.length === 0) { volver("El cambio no se guardó (no se encontró el pedido o falta permiso)."); return; }

    p.pagado = pagado;
    colsPedidoNuevas = true;
    if (msgTipo === "err" || msgTipo === "cambios") ocultarMsgPedidos();
    // Si con el filtro de pago de ahora el pedido ya no corresponde a la lista, se redibuja; si no, se actualiza solo su fila.
    const sigue = pedidosVisibles().some((x) => String(x.id) === String(id));
    if (!sigue) {
      renderPedidos();
    } else {
      const fila = refrescarFilaPedido(p);
      const nuevo = fila && fila.querySelector(".pago-chip");
      if (nuevo) nuevo.focus({ preventScroll: true });
      actualizarChipsPedidos(pedidosBase());
    }
    mostrarMsgPedidos("ok", "El pedido de " + quien + " (" + fmtMoney(num(p.subtotal)) + ") quedó " + (pagado ? "como pagado: ya suma al saldo de caja." : "con pago pendiente: no suma al saldo de caja hasta que lo marques como pagado."));
    renderDashboard();
  }

  // Desde el dashboard: abre Pedidos ya filtrado por estado, y marca el pedido si se pidió uno.
  function irAPedidos(estado, id) {
    activarPanel(document.getElementById("tab-pedidos"), false);
    elBuscar.value = "";
    elFiltroCanal.value = "todos";
    elFiltroPago.value = "todos";
    elFiltroPlazo.value = "todos";
    ffPedidos.reiniciar(); // los números del Resumen son de todo el historial: se muestra sin filtro de fechas
    setGrupoPedidos(estado && ESTADOS.includes(estado) ? grupoDe(estado) : "todos", estado && ESTADOS.includes(estado) ? estado : null);
    pedidosSucio = false;
    renderPedidos();
    const rows = elPedidosTbody.querySelectorAll("tr[data-pedido-id]");
    let fila = null;
    for (let i = 0; i < rows.length; i++) if (id && rows[i].dataset.pedidoId === String(id)) fila = rows[i];
    if (fila) {
      const sinMov = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      fila.scrollIntoView({ behavior: sinMov ? "auto" : "smooth", block: "center" });
      fila.classList.add("flash");
      setTimeout(() => fila.classList.remove("flash"), 1800);
      const b = fila.querySelector(".btn-detalle");
      if (b) b.focus({ preventScroll: true });
    } else {
      elFiltroEstado.focus({ preventScroll: true });
      window.scrollTo(0, 0);
    }
  }
  window.stratoAdminVerPedido = function (id) { irAPedidos("nuevo", id); }; // compatibilidad con la versión anterior

  /* ============ VENTA MANUAL ============ */
  const elVentaBody = document.getElementById("venta-body");
  const elVentaToggle = document.getElementById("venta-toggle");
  const elVentaItems = document.getElementById("venta-items");
  const elVentaError = document.getElementById("venta-error");
  let ventaOpc = [];
  let ventaGuardando = false;

  // Una venta nueva viene como «Entregado»: si además tiene plazo, ese plazo nunca va a avisar. Se lo decimos al cargarla.
  function actualizarAvisoPlazoVenta() {
    const el = document.getElementById("venta-plazo-aviso");
    if (!el) return;
    el.hidden = !(ventaEditId === null && document.getElementById("venta-plazo").value && document.getElementById("venta-estado").value === "entregado");
  }
  ["venta-plazo", "venta-estado"].forEach((id) => {
    const e = document.getElementById(id);
    e.addEventListener("input", actualizarAvisoPlazoVenta);
    e.addEventListener("change", actualizarAvisoPlazoVenta);
  });

  function armarOpcionesVenta() {
    ventaOpc = [];
    productosCache.filter((p) => p.activo !== false).forEach((p) => {
      const tams = Array.isArray(p.tamanos) ? p.tamanos : [];
      const costoDe = (tam) => (costosMap.has(claveCosto(p.id, tam || "")) ? costosMap.get(claveCosto(p.id, tam || "")) : null);
      if (tams.length) tams.forEach((t) => ventaOpc.push({ pid: p.id, nombre: p.nombre, tam: t.nombre || null, precio: t.precio, costo: costoDe(t.nombre || "") }));
      else ventaOpc.push({ pid: p.id, nombre: p.nombre, tam: null, precio: p.precio, costo: costoDe("") });
    });
  }
  function opcionesVentaHtml() {
    return (
      '<option value="">Elegir producto…</option>' +
      ventaOpc
        .map((o, i) => "<option value=\"" + i + "\">" + escHtml(o.nombre + (o.tam ? " — " + o.tam : "") + (o.precio !== null && o.precio !== undefined ? " · " + fmtMoney(num(o.precio)) : "")) + "</option>")
        .join("") +
      '<option value="otro">Otro (escribir el nombre)</option>'
    );
  }

  function agregarFilaVenta() {
    const div = document.createElement("div");
    div.className = "venta-row";
    div.innerHTML =
      '<label class="vf vf-prod"><span class="vf-t">Producto</span><select class="venta-prod" aria-label="Producto">' + opcionesVentaHtml() + "</select></label>" +
      '<label class="vf"><span class="vf-t">Cant.</span><input type="number" class="venta-qty" aria-label="Cantidad" min="1" step="1" value="1" inputmode="numeric"></label>' +
      '<label class="vf"><span class="vf-t">Precio c/u</span><input type="number" class="venta-precio" aria-label="Precio por unidad, en pesos" min="0" step="1" placeholder="Precio c/u" inputmode="numeric"></label>' +
      '<label class="vf"><span class="vf-t">Costo c/u</span><input type="number" class="venta-costo" aria-label="Costo por unidad, en pesos (privado)" min="0" step="0.01" placeholder="Costo c/u" inputmode="decimal"></label>' +
      '<button type="button" class="row-del venta-del" aria-label="Quitar este producto">✕</button>' +
      '<input type="text" class="venta-otro" aria-label="Nombre del producto" maxlength="80" placeholder="Nombre del producto" hidden>';
    elVentaItems.appendChild(div);
    return div;
  }

  function filasVenta() {
    return Array.from(elVentaItems.querySelectorAll(".venta-row")).map((row) => ({
      row: row,
      sel: row.querySelector(".venta-prod"),
      qty: row.querySelector(".venta-qty"),
      precio: row.querySelector(".venta-precio"),
      costo: row.querySelector(".venta-costo"),
      otro: row.querySelector(".venta-otro"),
    }));
  }

  function actualizarTotalVenta() {
    let total = 0, costo = 0, filas = 0, sinCosto = 0;
    const lista = filasVenta();
    lista.forEach((f) => {
      const q = Number(f.qty.value), p = Number(f.precio.value);
      if (Number.isFinite(q) && Number.isFinite(p) && q > 0 && p >= 0 && f.precio.value !== "") {
        total += q * p;
        filas++;
        const c = f.costo.value === "" ? NaN : Number(f.costo.value);
        if (Number.isFinite(c) && c >= 0) costo += q * c;
        else sinCosto++;
      }
    });
    document.getElementById("venta-total").textContent = fmtMoney(total);
    const lin = document.getElementById("venta-costo-linea");
    if (!filas) {
      lin.innerHTML = "";
    } else if (sinCosto === filas) {
      lin.textContent = "Sin costo cargado: esta venta va a contar sin costo en la ganancia neta.";
    } else {
      const gan = total - costo;
      lin.innerHTML =
        "Costo <strong>" + fmtMoney(costo) + "</strong> · Ganancia <span class=\"" + (gan >= 0 ? "pos" : "neg") + "\">" + fmtMoney(gan) + "</span>" +
        (total > 0 ? " (" + Math.round((gan / total) * 100) + "%)" : "") +
        (sinCosto ? " · faltan costos en " + sinCosto + (sinCosto === 1 ? " producto" : " productos") : "");
    }
    // Si viene de una cotización: cuánto se está cobrando respecto de lo sugerido
    const dif = document.getElementById("venta-origen-diff");
    if (dif && ventaOrigen && lista.length) {
      const p0 = lista[0].precio.value === "" ? NaN : Number(lista[0].precio.value);
      if (!Number.isFinite(p0)) dif.textContent = "";
      else {
        const d = p0 - ventaOrigen.sugerido;
        const pc = ventaOrigen.sugerido > 0 ? Math.round((Math.abs(d) / ventaOrigen.sugerido) * 100) : 0;
        dif.textContent = d === 0 ? "Cobrás justo lo sugerido." : "Cobrás " + fmtMoney(Math.abs(d)) + (d > 0 ? " más" : " menos") + " que lo sugerido" + (ventaOrigen.sugerido > 0 ? " (" + (d > 0 ? "+" : "−") + pc + "%)" : "") + ".";
      }
    }
    return total;
  }

  elVentaItems.addEventListener("change", (e) => {
    const sel = e.target.closest(".venta-prod");
    if (!sel) return;
    const row = sel.closest(".venta-row");
    const otro = row.querySelector(".venta-otro");
    const precio = row.querySelector(".venta-precio");
    if (sel.value === "otro") {
      otro.hidden = false;
      otro.focus();
    } else {
      otro.hidden = true;
      otro.value = "";
      const o = ventaOpc[Number(sel.value)];
      if (o) {
        precio.value = o.precio !== null && o.precio !== undefined && Number.isFinite(Number(o.precio)) ? String(Number(o.precio)) : "";
        row.querySelector(".venta-costo").value = o.costo !== null && o.costo !== undefined ? String(o.costo) : "";
      }
    }
    delete row.dataset.cot; // si cambia el producto, ya no es el de la cotización
    actualizarTotalVenta();
  });
  elVentaItems.addEventListener("input", actualizarTotalVenta);
  elVentaItems.addEventListener("click", (e) => {
    const del = e.target.closest(".venta-del");
    if (!del) return;
    const row = del.closest(".venta-row");
    if (elVentaItems.querySelectorAll(".venta-row").length > 1) row.remove();
    else {
      row.querySelector(".venta-prod").value = "";
      row.querySelector(".venta-qty").value = "1";
      row.querySelector(".venta-precio").value = "";
      row.querySelector(".venta-costo").value = "";
      row.querySelector(".venta-otro").hidden = true;
      row.querySelector(".venta-otro").value = "";
      delete row.dataset.cot;
    }
    actualizarTotalVenta();
  });
  document.getElementById("venta-add-item").addEventListener("click", () => {
    const row = agregarFilaVenta();
    row.querySelector(".venta-prod").focus();
  });

  function mostrarOrigenVenta() {
    const box = document.getElementById("venta-origen");
    if (!ventaOrigen) { box.hidden = true; box.innerHTML = ""; return; }
    const previo = pedidosCache.find((p) => p.estado !== "cancelado" && (p.items || []).some((it) => it && it.cotizacion_id === ventaOrigen.id));
    box.innerHTML =
      '<div class="vo-txt"><strong>Desde la cotización «' + escHtml(ventaOrigen.nombre) + "»</strong><br>" +
      "Sugerido: " + fmtMoney(ventaOrigen.sugerido) + (ventaOrigen.costo !== null ? " · Costo: " + fmtMoney(ventaOrigen.costo) + (ventaOrigen.accesorio ? " (incluye el accesorio de " + fmtMoney(ventaOrigen.accesorio) + ")" : "") : "") +
      ". Cambiá el precio por unidad si querés cobrar otro valor." +
      (previo ? "<br>Ojo: esta cotización ya se cargó como pedido el " + fmtDMY(previo._dia) + "." : "") +
      '<span class="vo-diff" id="venta-origen-diff"></span></div>' +
      '<button type="button" class="btn-soft" id="venta-usar-sugerido">Volver al sugerido</button>';
    box.hidden = false;
  }
  document.getElementById("venta-origen").addEventListener("click", (e) => {
    if (!e.target.closest("#venta-usar-sugerido") || !ventaOrigen) return;
    const f = filasVenta()[0];
    if (f) { f.precio.value = String(ventaOrigen.sugerido); actualizarTotalVenta(); }
  });

  // Vuelve el formulario a "venta nueva": saca las opciones y campos que solo existen al editar un pedido.
  function salirModoEdicion() {
    ventaEditId = null;
    ventaEditOrig = null;
    document.getElementById("venta-titulo").textContent = "Venta manual";
    document.getElementById("venta-ayuda").hidden = false;
    document.getElementById("venta-edit-banner").hidden = true;
    document.getElementById("venta-edit-extra").hidden = true;
    document.getElementById("venta-guardar").textContent = "Guardar venta";
    ["venta-canal-web", "venta-estado-cancelado"].forEach((id) => { const o = document.getElementById(id); o.hidden = true; o.disabled = true; });
    ["venta-entrega", "venta-pago", "venta-estado"].forEach((id) => document.getElementById(id).querySelectorAll("option[data-temp]").forEach((o) => o.remove()));
  }

  function resetVenta() {
    ventaOrigen = null;
    salirModoEdicion();
    mostrarOrigenVenta();
    document.getElementById("form-venta").reset();
    document.getElementById("venta-fecha").value = todayStr();
    document.getElementById("venta-estado").value = "entregado";
    document.getElementById("venta-canal").value = "instagram";
    document.getElementById("venta-plazo").value = "";
    actualizarAvisoPlazoVenta();
    document.getElementById("venta-pagado").checked = true; // una venta cargada a mano suele estar cobrada; destildalo si falta cobrar
    elVentaError.textContent = "";
    armarOpcionesVenta();
    elVentaItems.innerHTML = "";
    agregarFilaVenta();
    actualizarTotalVenta();
  }
  function cerrarVenta() {
    elVentaBody.hidden = true;
    elVentaToggle.setAttribute("aria-expanded", "false");
    elVentaToggle.textContent = "+ Cargar una venta";
  }
  function abrirVenta() {
    activarPanel(document.getElementById("tab-pedidos"), false);
    if (!elVentaBody.hidden && ventaEditId !== null && !confirm("Estás editando un pedido. ¿Descartar los cambios y cargar una venta nueva?")) return;
    if (elVentaBody.hidden || ventaEditId !== null) {
      resetVenta();
      elVentaBody.hidden = false;
      elVentaToggle.setAttribute("aria-expanded", "true");
      elVentaToggle.textContent = "Cerrar";
    }
    document.getElementById("venta-cliente").focus({ preventScroll: true });
    elVentaBody.scrollIntoView({ behavior: "auto", block: "start" });
  }
  // "Cargar como pedido": abre el formulario de venta con la cotización ya puesta (precio sugerido y costo base editables).
  function abrirVentaDesdeCotizacion(id) {
    const c = cotizacionesCache.find((x) => x.id === id);
    if (!c) return;
    if (!elVentaBody.hidden) {
      const hayAlgo = ventaEditId !== null || document.getElementById("venta-cliente").value.trim() !== "" || filasVenta().some((f) => f.precio.value !== "");
      if (hayAlgo && !confirm("Ya tenés una venta a medio cargar. ¿Reemplazarla por esta cotización?")) return;
    }
    const sugerido = Math.round(num(c.total_a_cobrar));
    const cb = costoDeCotizacion(c);
    activarPanel(document.getElementById("tab-pedidos"), false);
    resetVenta();
    ventaOrigen = { id: c.id, nombre: String(c.nombre_pieza || "Pieza"), sugerido: sugerido, costo: cb, accesorio: accesorioDeCotizacion(c) };
    mostrarOrigenVenta();
    elVentaBody.hidden = false;
    elVentaToggle.setAttribute("aria-expanded", "true");
    elVentaToggle.textContent = "Cerrar";
    document.getElementById("venta-cliente").value = limpiarTexto(c.cliente || "", 80);
    document.getElementById("venta-estado").value = "confirmado";
    actualizarAvisoPlazoVenta();
    document.getElementById("venta-pagado").checked = false; // un trabajo por encargar todavía no se cobró
    const f = filasVenta()[0];
    f.sel.value = "otro";
    f.otro.hidden = false;
    f.otro.value = limpiarTexto(ventaOrigen.nombre, 80);
    f.qty.value = "1";
    f.precio.value = String(sugerido);
    f.costo.value = cb === null ? "" : String(cb);
    f.row.dataset.cot = c.id;
    actualizarTotalVenta();
    elVentaBody.scrollIntoView({ behavior: "auto", block: "start" });
    (document.getElementById("venta-cliente").value ? f.precio : document.getElementById("venta-cliente")).focus({ preventScroll: true });
  }

  /* ---- Editar un pedido (usa el mismo formulario que la venta manual) ---- */
  // Asegura que el desplegable tenga el valor guardado (los pedidos de la web traen textos propios de entrega y pago).
  function asegurarOpcion(selectId, valor) {
    const sel = document.getElementById(selectId);
    if (valor === null || valor === undefined || valor === "") { sel.value = ""; if (sel.value !== "") sel.selectedIndex = 0; return; }
    let o = Array.from(sel.options).find((x) => x.value === valor);
    if (!o) {
      o = document.createElement("option");
      o.value = valor;
      o.textContent = valor;
      o.dataset.temp = "1";
      sel.appendChild(o);
    }
    sel.value = valor;
  }

  function abrirEdicionPedido(id) {
    const p = pedidosCache.find((x) => String(x.id) === String(id));
    if (!p) return;
    if (!elVentaBody.hidden) {
      const hayAlgo = ventaEditId !== null || document.getElementById("venta-cliente").value.trim() !== "" || filasVenta().some((f) => f.precio.value !== "");
      if (hayAlgo && !confirm("Ya tenés una venta o una edición a medio cargar. ¿Reemplazarla por este pedido?")) return;
    }
    activarPanel(document.getElementById("tab-pedidos"), false);
    resetVenta();
    ventaEditId = p.id;
    ventaEditOrig = JSON.parse(JSON.stringify(p));
    document.getElementById("venta-titulo").textContent = "Editar pedido";
    document.getElementById("venta-ayuda").hidden = true;
    document.getElementById("venta-guardar").textContent = "Guardar cambios";
    const ban = document.getElementById("venta-edit-banner");
    ban.textContent = "Estás editando el pedido de " + (p.cliente_nombre || "—") + " del " + fmtFecha(p.created_at) + ". Los cambios reemplazan lo guardado; no se avisa al cliente.";
    ban.hidden = false;
    document.getElementById("venta-edit-extra").hidden = false;

    // Opciones que solo existen al editar: canal Web, estado Cancelado y los textos propios de los pedidos de la web
    const web = document.getElementById("venta-canal-web");
    web.hidden = p.canal !== "web";
    web.disabled = p.canal !== "web";
    const canc = document.getElementById("venta-estado-cancelado");
    canc.hidden = false;
    canc.disabled = false;
    document.getElementById("venta-canal").value = CANALES.includes(p.canal) ? p.canal : "otro";
    if (ESTADOS.includes(p.estado)) {
      document.getElementById("venta-estado").value = p.estado;
    } else {
      asegurarOpcion("venta-estado", p.estado);
    }
    document.getElementById("venta-fecha").value = p._dia || todayStr();
    document.getElementById("venta-cliente").value = p.cliente_nombre || "";
    document.getElementById("venta-contacto").value = p.cliente_telefono && p.cliente_telefono !== "—" ? p.cliente_telefono : "";
    asegurarOpcion("venta-entrega", p.entrega || "Retiro / en mano");
    asegurarOpcion("venta-pago", p.pago || "");
    document.getElementById("venta-notas").value = p.notas || "";
    document.getElementById("venta-plazo").value = p._plazo || "";
    actualizarAvisoPlazoVenta();
    document.getElementById("venta-pagado").checked = esPagado(p);
    document.getElementById("venta-email").value = p.cliente_email || "";
    document.getElementById("venta-direccion").value = p.direccion || "";

    elVentaItems.innerHTML = "";
    const items = Array.isArray(p.items) && p.items.length ? p.items : [null];
    items.forEach((it) => {
      const row = agregarFilaVenta();
      if (!it) return;
      const f = { sel: row.querySelector(".venta-prod"), qty: row.querySelector(".venta-qty"), precio: row.querySelector(".venta-precio"), costo: row.querySelector(".venta-costo"), otro: row.querySelector(".venta-otro") };
      const idx = it.producto_id ? ventaOpc.findIndex((o) => o.pid === it.producto_id && (o.tam || null) === (it.tamano || null)) : -1;
      if (idx >= 0) {
        f.sel.value = String(idx);
      } else {
        f.sel.value = "otro";
        f.otro.hidden = false;
        f.otro.value = limpiarTexto(it.nombre || "", 80);
      }
      f.qty.value = String(num(it.qty) || 1);
      f.precio.value = it.precio === null || it.precio === undefined ? "" : String(it.precio);
      f.costo.value = it.costo === null || it.costo === undefined || it.costo === "" ? "" : String(it.costo);
      row._item = it;
      if (it.cotizacion_id) row.dataset.cot = it.cotizacion_id;
    });
    actualizarTotalVenta();
    elVentaBody.hidden = false;
    elVentaToggle.setAttribute("aria-expanded", "true");
    elVentaToggle.textContent = "Cerrar";
    elVentaError.textContent = "";
    elVentaBody.scrollIntoView({ behavior: "auto", block: "start" });
    document.getElementById("venta-cliente").focus({ preventScroll: true });
  }

  async function eliminarPedido(id) {
    const p = pedidosCache.find((x) => String(x.id) === String(id));
    if (!p) return;
    const txt = "¿Eliminar el pedido de " + (p.cliente_nombre || "este cliente") + " (" + fmtMoney(num(p.subtotal)) + ", " + fmtFecha(p.created_at) + ")?\n\n" +
      "Se borra para siempre y deja de contar en el dashboard. Si solo querés que no cuente, mejor cambiá su estado a Cancelado.";
    if (!confirm(txt)) return;
    let res;
    try {
      res = await stratoSb.from("pedidos").delete().eq("id", id).select("id");
    } catch (e) {
      mostrarMsgPedidos("err", "No se pudo eliminar el pedido (" + (e && e.message ? e.message : "error de conexión") + ").");
      return;
    }
    if (res.error) {
      const t = String(res.error.message || "") + " " + String(res.error.code || "");
      mostrarMsgPedidos("err", "No se pudo eliminar el pedido (" + res.error.message + ")." + (/permission denied|42501|row-level/i.test(t) ? " Falta el permiso en Supabase: corré supabase/migracion_monedas_inversion.sql." : ""));
      return;
    }
    if (Array.isArray(res.data) && res.data.length === 0) {
      mostrarMsgPedidos("err", "El pedido no se eliminó (no se encontró o falta el permiso en Supabase: corré supabase/migracion_monedas_inversion.sql).");
      return;
    }
    pedidosCache = pedidosCache.filter((x) => String(x.id) !== String(id));
    if (ventaEditId !== null && String(ventaEditId) === String(id)) { resetVenta(); cerrarVenta(); }
    renderPedidos();
    renderDashboard();
    actualizarBadge();
    renderCotizaciones();
    mostrarMsgPedidos("ok", "Pedido eliminado: " + (p.cliente_nombre || "—") + " · " + fmtMoney(num(p.subtotal)) + ".");
  }

  /* ---- Descargar en Excel lo que se ve en la lista ---- */
  const itemTexto = (it) => {
    it = it || {};
    const extras = [it.tamano, it.color].filter(Boolean).join(", ");
    return num(it.qty) + "× " + (it.nombre || "Sin nombre") + (extras ? " (" + extras + ")" : "");
  };
  function descripcionFiltrosPedidos() {
    const partes = [GRUPOS[pedidosGrupo].label];
    if (elFiltroEstado.value !== "todos") partes.push(ESTADO_LABEL[elFiltroEstado.value] || elFiltroEstado.value);
    if (ffPedidos.activo()) partes.push(ffTexto(ffPedidos.rango()));
    if (elFiltroCanal.value !== "todos") partes.push(CANAL_LABEL[elFiltroCanal.value] || elFiltroCanal.value);
    if (elFiltroPago.value !== "todos") partes.push(elFiltroPago.value === "pendientes" ? "solo pago pendiente" : "solo pagados");
    if (elFiltroPlazo.value !== "todos") partes.push("plazo: " + elFiltroPlazo.options[elFiltroPlazo.selectedIndex].text.toLowerCase());
    if (elBuscar.value.trim()) partes.push("búsqueda «" + elBuscar.value.trim() + "»");
    return partes.join(" · ");
  }
  document.getElementById("pedidos-excel").addEventListener("click", () => {
    const list = pedidosVisibles();
    if (!list.length) { mostrarMsgPedidos("err", "No hay pedidos para descargar con los filtros de ahora."); return; }
    let blob;
    try {
      const hojaPedidos = {
        nombre: "Pedidos",
        cols: [
          { t: "Fecha", w: 12, tipo: "fecha" }, { t: "Cliente", w: 24 }, { t: "Contacto", w: 18 }, { t: "Canal", w: 14 },
          { t: "Productos", w: 46, ajustar: true }, { t: "Subtotal ($U)", w: 14, tipo: "dinero" }, { t: "Entrega", w: 24 }, { t: "Pago", w: 20 },
          { t: "Cobro", w: 16 }, { t: "Plazo de entrega", w: 16, tipo: "fecha" },
          { t: "Estado", w: 15 }, { t: "Email", w: 26 }, { t: "Dirección", w: 28 }, { t: "Notas", w: 30, ajustar: true },
        ],
        filas: list.map((p) => [
          p._dia, p.cliente_nombre, p.cliente_telefono, CANAL_LABEL[p.canal] || p.canal, (p.items || []).map(itemTexto).join("; "), num(p.subtotal),
          p.entrega, p.pago, p.estado === "cancelado" ? "" : esPagado(p) ? "Pagado" : "Pago pendiente", p._plazo, ESTADO_LABEL[p.estado] || p.estado, p.cliente_email, p.direccion, p.notas,
        ]),
      };
      const filasItems = [];
      list.forEach((p) => {
        (p.items || []).forEach((it) => {
          it = it || {};
          const precio = it.precio === null || it.precio === undefined ? null : num(it.precio);
          filasItems.push([p._dia, p.cliente_nombre, ESTADO_LABEL[p.estado] || p.estado, it.nombre || "Sin nombre", it.tamano, it.color, num(it.qty), precio, precio === null ? null : precio * num(it.qty), it.nota]);
        });
      });
      const hojaItems = {
        nombre: "Productos",
        cols: [
          { t: "Fecha", w: 12, tipo: "fecha" }, { t: "Cliente", w: 24 }, { t: "Estado", w: 15 }, { t: "Producto", w: 34 }, { t: "Tamaño", w: 14 }, { t: "Color", w: 14 },
          { t: "Cantidad", w: 10, tipo: "numero" }, { t: "Precio c/u ($U)", w: 15, tipo: "dinero" }, { t: "Total ($U)", w: 14, tipo: "dinero" }, { t: "Observación", w: 30, ajustar: true },
        ],
        filas: filasItems,
      };
      blob = xlsxBlob([hojaPedidos, hojaItems]);
    } catch (e) {
      mostrarMsgPedidos("err", "No se pudo armar el Excel (" + (e && e.message ? e.message : "error") + ").");
      return;
    }
    const nombre = "pedidos-storge-" + todayStr() + ".xlsx";
    descargarBlob(blob, nombre);
    mostrarMsgPedidos("ok", "Se descargó " + nombre + " con " + list.length + (list.length === 1 ? " pedido" : " pedidos") + " (" + descripcionFiltrosPedidos() + "). Tiene dos hojas: Pedidos y Productos.");
  });

  elVentaToggle.addEventListener("click", () => {
    if (elVentaBody.hidden) abrirVenta();
    else cerrarVenta();
  });
  document.getElementById("venta-cancelar").addEventListener("click", () => {
    cerrarVenta();
    elVentaToggle.focus();
  });

  function limpiarTexto(v, max) {
    return String(v || "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
  }

  document.getElementById("form-venta").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (ventaGuardando) return;
    elVentaError.textContent = "";
    const falla = (texto, campo) => {
      elVentaError.textContent = texto;
      if (campo) campo.focus();
      return null;
    };

    const canal = document.getElementById("venta-canal").value;
    const estado = document.getElementById("venta-estado").value;
    const fecha = document.getElementById("venta-fecha").value;
    const cliente = limpiarTexto(document.getElementById("venta-cliente").value, 80);
    const contacto = limpiarTexto(document.getElementById("venta-contacto").value, 40);
    const webEditable = ventaEditOrig !== null && ventaEditOrig.canal === "web"; // un pedido de la web conserva su canal al editarlo
    if (!CANALES.includes(canal) || (canal === "web" && !webEditable)) return falla("Elegí el canal de la venta.", document.getElementById("venta-canal"));
    const estadoRaro = ventaEditOrig !== null && estado === ventaEditOrig.estado; // un estado desconocido que ya tenía se puede dejar igual
    if (!ESTADOS.includes(estado) && !estadoRaro) return falla("Elegí un estado.", document.getElementById("venta-estado"));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return falla("Falta la fecha de la venta.", document.getElementById("venta-fecha"));
    if (fecha > todayStr()) return falla("La fecha de la venta no puede ser futura.", document.getElementById("venta-fecha"));
    const plazo = document.getElementById("venta-plazo").value;
    if (plazo && (!/^\d{4}-\d{2}-\d{2}$/.test(plazo) || plazo < "2020-01-01" || plazo > addDays(todayStr(), 730))) {
      return falla("El plazo de entrega no es una fecha válida (tiene que estar dentro de los próximos 2 años).", document.getElementById("venta-plazo"));
    }
    const pagado = document.getElementById("venta-pagado").checked;
    if (!cliente) return falla("Falta el nombre del cliente.", document.getElementById("venta-cliente"));

    const items = [];
    const filas = filasVenta();
    for (let i = 0; i < filas.length; i++) {
      const f = filas[i];
      const n = i + 1;
      const orig = ventaEditId !== null && f.row._item ? f.row._item : null; // el ítem tal como estaba guardado (solo al editar)
      let nombre, tam = null, pid = null;
      if (f.sel.value === "otro") {
        nombre = limpiarTexto(f.otro.value, 80);
        if (!nombre) return falla("Producto " + n + ": escribí el nombre.", f.otro);
      } else {
        const o = ventaOpc[Number(f.sel.value)];
        if (f.sel.value === "" || !o) return falla("Producto " + n + ": elegí un producto (o \"Otro\" para escribirlo).", f.sel);
        nombre = o.nombre;
        tam = o.tam;
        pid = o.pid;
      }
      const qty = Number(f.qty.value);
      if (!Number.isInteger(qty) || qty < 1 || qty > 9999) return falla("Producto " + n + ": la cantidad tiene que ser un número entero desde 1.", f.qty);
      // Al editar, un producto "a cotizar" (sin precio) puede seguir sin precio.
      const sinPrecio = f.precio.value === "" && orig && (orig.precio === null || orig.precio === undefined);
      if (f.precio.value === "" && !sinPrecio) return falla("Producto " + n + ": falta el precio por unidad.", f.precio);
      const precio = sinPrecio ? null : Number(f.precio.value);
      if (!sinPrecio && (!Number.isFinite(precio) || precio < 0 || precio > 1000000)) return falla("Producto " + n + ": el precio no es válido.", f.precio);
      // Costo por unidad (opcional, privado): queda guardado en el ítem y alimenta la ganancia neta del dashboard.
      let costo = null;
      if (f.costo.value !== "") {
        costo = Number(f.costo.value);
        if (!Number.isFinite(costo) || costo < 0 || costo > 1000000) return falla("Producto " + n + ": el costo no es válido.", f.costo);
        costo = redondear2(costo);
      }
      // ¿Sigue siendo el mismo producto que tenía el pedido? Entonces se conservan sus demás datos (color, observación, cotización…).
      let mismo = false;
      if (orig) {
        mismo = f.sel.value === "otro"
          ? (orig.producto_id === null || orig.producto_id === undefined || !ventaOpc.some((o) => o.pid === orig.producto_id)) && nombre === limpiarTexto(orig.nombre || "", 80)
          : !!pid && pid === orig.producto_id && (tam || null) === (orig.tamano || null);
      }
      let item;
      if (mismo) {
        item = Object.assign({}, orig, { qty: qty, precio: precio, costo: costo });
        // si cambió el precio a mano, el "precio de lista" y el descuento por cantidad que tenía ya no describen la venta
        if (precio !== null && (orig.precio === null || orig.precio === undefined || Number(orig.precio) !== precio)) {
          item.precio_lista = precio;
          item.descuento_cantidad_pct = 0;
        }
      } else {
        item = { producto_id: pid, nombre: nombre, tamano: tam, qty: qty, color: null, nota: null, precio: precio, precio_lista: precio, descuento_cantidad_pct: 0, costo: costo };
        if (f.row.dataset.cot) item.cotizacion_id = f.row.dataset.cot;
      }
      items.push(item);
    }
    if (!items.length) return falla("Agregá al menos un producto.", null);
    const subtotal = items.reduce((s, it) => s + (it.precio === null || it.precio === undefined ? 0 : it.qty * it.precio), 0);

    const editando = ventaEditId !== null;
    const payload = {
      cliente_nombre: cliente,
      cliente_telefono: contacto || "—",
      cliente_email: editando ? limpiarTexto(document.getElementById("venta-email").value, 120) || null : null,
      entrega: document.getElementById("venta-entrega").value,
      direccion: editando ? limpiarTexto(document.getElementById("venta-direccion").value, 200) || null : null,
      pago: document.getElementById("venta-pago").value || null,
      notas: limpiarTexto(document.getElementById("venta-notas").value, 300) || null,
      items: items,
      subtotal: subtotal,
      estado: estado,
      canal: canal,
    };
    // Pago y plazo van en columnas nuevas. Si la base todavía no las tiene y el pedido no necesita nada especial
    // (pagado y sin plazo, que es lo de siempre), se guarda sin ellas para no trabar la carga.
    const necesitaColsNuevas = !pagado || !!plazo || (editando && (ventaEditOrig.plazo_entrega || ventaEditOrig.pagado === false));
    if (colsPedidoNuevas !== false || necesitaColsNuevas) {
      payload.pagado = pagado;
      payload.plazo_entrega = plazo || null;
    }
    // Una venta de hoy se guarda con la hora actual (la pone la base); una de un día anterior, al mediodía de ese día en Uruguay.
    // Al editar, la fecha solo se toca si la cambiaste.
    if (editando) {
      if (fecha !== ventaEditOrig._dia) payload.created_at = fecha === todayStr() ? new Date().toISOString() : fecha + "T12:00:00-03:00";
    } else if (fecha !== todayStr()) {
      payload.created_at = fecha + "T12:00:00-03:00";
    }

    const btn = document.getElementById("venta-guardar");
    const textoBtn = btn.textContent;
    ventaGuardando = true;
    btn.disabled = true;
    btn.textContent = "Guardando…";
    let error = null, sinFilas = false;
    const guardarPayload = async (pl) => {
      if (editando) {
        const res = await stratoSb.from("pedidos").update(pl).eq("id", ventaEditId).select("id");
        return { error: res.error, sinFilas: !res.error && Array.isArray(res.data) && res.data.length === 0 };
      }
      const res = await stratoSb.from("pedidos").insert([pl]);
      return { error: res.error, sinFilas: false };
    };
    try {
      let r = await guardarPayload(payload);
      // Si la base todavía no tiene las columnas nuevas: sin nada especial que guardar se reintenta sin ellas; si no, se avisa.
      if (r.error && "pagado" in payload && /pagado|plazo_entrega/i.test(String(r.error.message || "") + " " + String(r.error.details || ""))) {
        colsPedidoNuevas = false;
        if (necesitaColsNuevas) {
          r = { error: { message: "faltan las columnas del pago y el plazo", faltaSql: true }, sinFilas: false };
        } else {
          const sin = Object.assign({}, payload);
          delete sin.pagado;
          delete sin.plazo_entrega;
          r = await guardarPayload(sin);
        }
      }
      error = r.error;
      sinFilas = r.sinFilas;
    } catch (err) {
      error = { message: err && err.message ? err.message : "error de conexión" };
    }
    ventaGuardando = false;
    btn.disabled = false;
    btn.textContent = textoBtn;
    if (error) {
      const txt = String(error.message || "") + " " + String(error.code || "");
      if (error.faltaSql) {
        elVentaError.textContent = "Todavía falta correr " + SQL_PAGO + " en Supabase (agrega el pago pendiente y el plazo de entrega). Corrélo y volvé a guardar: lo que cargaste sigue acá.";
      } else if (/canal|row-level security|permission denied|42501|PGRST204/i.test(txt)) {
        elVentaError.textContent = editando
          ? "No se pudo guardar el cambio: falta un permiso en Supabase. Corré supabase/migracion_monedas_inversion.sql (y supabase/migracion_dashboard.sql si todavía no lo corriste) y volvé a guardar: lo que cambiaste sigue acá."
          : "Todavía falta correr supabase/migracion_dashboard.sql en Supabase (agrega el canal y el permiso para cargar ventas). Corrélo y volvé a guardar: lo que cargaste sigue acá.";
      } else {
        elVentaError.textContent = "No se pudo guardar " + (editando ? "el cambio" : "la venta") + ": " + (error.message || "error desconocido") + ". Lo que " + (editando ? "cambiaste" : "cargaste") + " sigue acá.";
      }
      return;
    }
    if (sinFilas) {
      elVentaError.textContent = "El cambio no se guardó (no se encontró el pedido o falta permiso en Supabase: corré supabase/migracion_monedas_inversion.sql). Lo que cambiaste sigue acá.";
      return;
    }

    const desdeCot = ventaOrigen ? ventaOrigen.nombre : null;
    const ventaEditIdGuardado = ventaEditId;
    resetVenta();
    cerrarVenta();
    await loadPedidos();
    pedidosSucio = false;
    if (!editando) {
      // la venta nueva tiene que verse: se sacan los filtros
      elFiltroCanal.value = "todos";
      elFiltroPago.value = "todos";
      elFiltroPlazo.value = "todos";
      elBuscar.value = "";
      ffPedidos.reiniciar();
      setGrupoPedidos("todos");
    }
    renderPedidos();
    renderDashboard();
    actualizarAvisosPedidos();
    renderCotizaciones(); // la cotización de origen queda marcada como cargada
    if (editando) {
      const sigue = pedidosVisibles().some((x) => String(x.id) === String(ventaEditIdGuardado));
      mostrarMsgPedidos("ok", "Pedido actualizado: " + cliente + " · " + fmtMoney(subtotal) + " · " + CANAL_LABEL[canal] + " · " + fmtDMY(fecha) + "." +
        (sigue ? "" : " Con los filtros de ahora no se ve en la lista (está en " + GRUPOS[grupoDe(estado)].label + ")."));
    } else {
      mostrarMsgPedidos("ok", "Venta guardada: " + cliente + " · " + fmtMoney(subtotal) + " · " + CANAL_LABEL[canal] + " · " + fmtDMY(fecha) + "." + (desdeCot ? " Cargada desde la cotización «" + desdeCot + "»." : ""));
    }
  });

  /* ============ PRODUCTOS ============ */
  document.getElementById("producto-form-toggle").addEventListener("click", () => {
    document.getElementById("producto-form-toggle").classList.toggle("open");
    document.getElementById("producto-form-body").classList.toggle("open");
  });

  document.getElementById("productos-buscar").addEventListener("input", renderProductos);
  document.getElementById("productos-filtro-categoria").addEventListener("change", renderProductos);
  document.getElementById("productos-filtro-costo").addEventListener("change", renderProductos);

  // Cuántos de los tamaños de un producto (o el producto solo, si no tiene tamaños) tienen costo cargado.
  function costoDeProducto(p) {
    const tams = (Array.isArray(p.tamanos) ? p.tamanos : []).filter((t) => String(t.nombre || "").trim() !== "");
    const claves = tams.length ? tams.map((t) => String(t.nombre).trim()) : [""];
    const vals = claves.map((k) => (costosMap.has(claveCosto(p.id, k)) ? costosMap.get(claveCosto(p.id, k)) : null)).filter((v) => v !== null);
    return { total: claves.length, con: vals.length, min: vals.length ? Math.min.apply(null, vals) : null, max: vals.length ? Math.max.apply(null, vals) : null };
  }

  // Desde el dashboard: "Cargar costos" abre Productos mostrando solo los que les falta.
  function irACostos() {
    activarPanel(document.getElementById("tab-productos"), false);
    document.getElementById("productos-filtro-costo").value = "sin";
    document.getElementById("productos-buscar").value = "";
    document.getElementById("productos-filtro-categoria").value = "todas";
    renderProductos();
    document.getElementById("productos-tbody").closest(".card").scrollIntoView({ behavior: "auto", block: "start" });
  }

  function renderProductos() {
    const term = document.getElementById("productos-buscar").value.trim().toLowerCase();
    const catFiltro = document.getElementById("productos-filtro-categoria").value;

    let list = productosCache;
    if (catFiltro !== "todas") list = list.filter((p) => productoCategoriaIds(p).includes(catFiltro));
    if (term) list = list.filter((p) => p.nombre.toLowerCase().includes(term));
    if (document.getElementById("productos-filtro-costo").value === "sin" && costosEstado.ok) {
      list = list.filter((p) => { const c = costoDeProducto(p); return c.con < c.total; });
    }

    const tbody = document.getElementById("productos-tbody");
    const vacio = document.getElementById("productos-empty");
    vacio.style.display = list.length ? "none" : "block";
    vacio.textContent = productosCache.length && !list.length ? "Ningún producto coincide con el filtro." : "No hay productos todavía.";

    tbody.innerHTML = list
      .map((p) => {
        const img = p.imagenes && p.imagenes[0] ? '<img class="thumb" src="' + p.imagenes[0] + '">' : '<div class="thumb"></div>';
        const tams = Array.isArray(p.tamanos) ? p.tamanos : [];
        const extras = [];
        if (tams.length) extras.push(tams.length + (tams.length === 1 ? " tamaño" : " tamaños"));
        if (p.venta_por_cantidad) extras.push("por cantidad");
        const precioTxt = tams.length
          ? "Desde " + fmtMoney(Math.min.apply(null, tams.map((t) => Number(t.precio))))
          : p.precio == null ? "Cotizar" : fmtMoney(p.precio);
        return (
          "<tr><td>" +
          img +
          "</td><td>" +
          escHtml(p.nombre) +
          (extras.length ? "<br><span class='muted' style='font-size:11px;'>" + extras.join(" · ") + "</span>" : "") +
          costoResumenHtml(p) +
          "</td><td>" +
          (productoCategoriaNombres(p) || "—") +
          "</td><td>" +
          precioTxt +
          "</td><td>" +
          (p.tag ? '<span class="badge-pill">' + escHtml(p.tag) + "</span>" : "—") +
          '</td><td><input type="checkbox" ' +
          (p.activo ? "checked" : "") +
          ' onchange="stratoAdminToggleActivo(\'' +
          p.id +
          "', this.checked)\"></td><td><button type='button' class='btn-secondary btn-small' onclick=\"stratoAdminEditarProducto('" +
          p.id +
          "')\">Editar</button> <button type='button' class='btn-danger btn-small' onclick=\"stratoAdminEliminarProducto('" +
          p.id +
          "')\">Eliminar</button></td></tr>"
        );
      })
      .join("");
  }

  function costoResumenHtml(p) {
    if (!costosEstado.ok) return "";
    const c = costoDeProducto(p);
    if (c.con === 0) return '<br><span class="badge-sc">sin costo</span>';
    const rango = c.min === c.max ? fmtMoney(c.min) : fmtMoney(c.min) + " a " + fmtMoney(c.max);
    if (c.con < c.total) return '<br><span class="badge-sc">costo en ' + c.con + " de " + c.total + " tamaños</span>";
    return "<br><span class='muted' style='font-size:12px;'>Costo " + rango + "</span>";
  }

  window.stratoAdminToggleActivo = async function (id, activo) {
    const { error } = await stratoSb.from("productos").update({ activo }).eq("id", id);
    if (error) { alert("No se pudo actualizar: " + error.message); return; }
    const p = productosCache.find((x) => x.id === id);
    if (p) p.activo = activo;
  };

  window.stratoAdminEliminarProducto = async function (id) {
    if (!confirm("¿Eliminar este producto? No se puede deshacer.")) return;
    const { error } = await stratoSb.from("productos").delete().eq("id", id);
    if (error) { alert("No se pudo eliminar: " + error.message); return; }
    await loadProductos();
    await loadCostos(); // sus costos se borran solos junto con el producto
    renderProductos();
  };

  window.stratoAdminEditarProducto = function (id) {
    const p = productosCache.find((x) => x.id === id);
    if (!p) return;
    editingProductId = id;
    document.getElementById("producto-form-title").textContent = "Editar producto";
    document.getElementById("prod-nombre").value = p.nombre;
    document.getElementById("prod-precio").value = p.precio == null ? "" : p.precio;
    document.getElementById("prod-cotizar").checked = p.precio == null;
    document.getElementById("prod-material").value = p.material || "";
    document.getElementById("prod-colores-multiple").checked = !!p.colores_multiple;
    rteLoadContent(document.getElementById("prod-descripcion"), p.descripcion || "");
    document.getElementById("prod-tag").value = p.tag || "";
    document.getElementById("prod-orden").value = p.orden || 0;
    document.getElementById("prod-activo").checked = p.activo;
    prodColores = (p.colores || []).slice();
    prodImagenes = (p.imagenes || []).slice();
    prodCategoriaIds = productoCategoriaIds(p);
    prodTamanos = (Array.isArray(p.tamanos) ? p.tamanos : []).map((t) => ({
      nombre: t.nombre || "", precio: t.precio,
      costo: costosMap.has(claveCosto(p.id, t.nombre || "")) ? costosMap.get(claveCosto(p.id, t.nombre || "")) : "",
    }));
    prodCostoBase = costosMap.has(claveCosto(p.id, "")) ? costosMap.get(claveCosto(p.id, "")) : "";
    prodEscalones = (Array.isArray(p.escalones_propios) ? p.escalones_propios : []).map((t) => ({ desde: t.desde, descuento_pct: t.descuento_pct }));
    document.getElementById("prod-por-cantidad").checked = !!p.venta_por_cantidad;
    document.getElementById("prod-escalones-propios").checked = Array.isArray(p.escalones_propios) && p.escalones_propios.length > 0;
    renderProdTamanos();
    renderProdEscalones();
    syncCantidadUI();
    renderColorTags();
    renderImgManager();
    renderProdCategoriasCheck();
    document.getElementById("prod-cancel-btn").style.display = "inline-block";
    document.getElementById("prod-submit-btn").textContent = "Guardar cambios";
    if (!document.getElementById("producto-form-body").classList.contains("open")) {
      document.getElementById("producto-form-toggle").click();
    }
    document.getElementById("panel-productos").scrollIntoView({ behavior: "smooth" });
  };

  document.getElementById("prod-cancel-btn").addEventListener("click", resetProductForm);

  function resetProductForm() {
    editingProductId = null;
    document.getElementById("form-producto").reset();
    document.getElementById("prod-descripcion").innerHTML = "";
    document.getElementById("producto-form-title").textContent = "Nuevo producto";
    document.getElementById("prod-submit-btn").textContent = "Guardar producto";
    document.getElementById("prod-cancel-btn").style.display = "none";
    document.getElementById("prod-activo").checked = true;
    prodColores = [];
    prodImagenes = [];
    prodCategoriaIds = [];
    prodTamanos = [];
    prodCostoBase = "";
    prodEscalones = [];
    renderProdTamanos();
    renderProdEscalones();
    syncCantidadUI();
    renderColorTags();
    renderImgManager();
    renderProdCategoriasCheck();
  }

  /* ---- Colores (chips) ---- */
  document.getElementById("prod-color-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const val = e.target.value.trim();
      if (val && !prodColores.includes(val)) {
        prodColores.push(val);
        renderColorTags();
      }
      e.target.value = "";
    }
  });

  function renderColorTags() {
    const wrap = document.getElementById("prod-colores-tags");
    wrap.innerHTML = prodColores
      .map((c, i) => {
        // Un color que no está en la lista de Filamentos (cargado a mano, o de
        // antes de que existiera esa lista) se marca para distinguirlo.
        const manual = filamentosCache.length && !filamentosCache.some((f) => sameColor(f.color, c));
        return (
          '<span class="color-tag">' + escHtml(c) + (manual ? ' <span class="muted" style="font-size:10px;">manual</span>' : "") +
          ' <button type="button" onclick="stratoAdminQuitarColor(' + i + ')">✕</button></span>'
        );
      })
      .join("");
    renderProdFilPicker();
  }
  window.stratoAdminQuitarColor = function (i) {
    prodColores.splice(i, 1);
    renderColorTags();
  };

  /* ---- Imágenes (Supabase Storage) ---- */
  // Cada foto pasa primero por el recortador: así se elige qué parte de la
  // imagen mostrar en vez de subir siempre la foto entera. Se procesan de a
  // una (si se eligieron varias juntas) para no abrir varios modales a la vez.
  document.getElementById("prod-img-input").addEventListener("change", async (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = "";
    for (const file of files) {
      const blob = await stratoOpenCropper(file);
      if (blob) await uploadImagen(blob);
    }
  });

  function renderImgManager() {
    const wrap = document.getElementById("prod-img-manager");
    let html = prodImagenes
      .map((img, i) => {
        if (typeof img === "object" && img.uploading) {
          return '<div class="img-thumb img-uploading">Subiendo…</div>';
        }
        return (
          '<div class="img-thumb"><img src="' +
          img +
          '"><button type="button" class="img-remove" onclick="stratoAdminQuitarImagen(' +
          i +
          ')">✕</button></div>'
        );
      })
      .join("");
    html += '<div class="img-add-tile" onclick="document.getElementById(\'prod-img-input\').click()">+</div>';
    wrap.innerHTML = html;
  }
  window.stratoAdminQuitarImagen = function (i) {
    prodImagenes.splice(i, 1);
    renderImgManager();
  };

  async function uploadImagen(blob) {
    if (!requireSb()) return;
    const tempEntry = { uploading: true, name: "foto" };
    prodImagenes.push(tempEntry);
    renderImgManager();

    // El recortador siempre entrega un jpeg (ver stratoOpenCropper).
    const path = "producto-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8) + ".jpg";
    const { error } = await stratoSb.storage.from("productos-imagenes").upload(path, blob, { contentType: "image/jpeg" });
    const idx = prodImagenes.indexOf(tempEntry);
    if (error) {
      if (idx > -1) prodImagenes.splice(idx, 1);
      alert("No se pudo subir la imagen: " + error.message);
      renderImgManager();
      return;
    }
    const { data } = stratoSb.storage.from("productos-imagenes").getPublicUrl(path);
    if (idx > -1) prodImagenes[idx] = data.publicUrl;
    renderImgManager();
  }

  /* ---- Recortador de foto (canvas), reutilizado para fotos de producto y
     portada de categoría. Devuelve una Promise que resuelve con el Blob
     recortado (cuadrado, jpeg) o null si se canceló. ---- */
  function stratoOpenCropper(file) {
    return new Promise((resolve) => {
      const modal = document.getElementById("crop-modal");
      const stage = document.getElementById("crop-stage");
      const imgEl = document.getElementById("crop-img");
      const boxEl = document.getElementById("crop-box");
      const handleEl = document.getElementById("crop-handle");
      const confirmBtn = document.getElementById("crop-confirm-btn");
      const cancelBtn = document.getElementById("crop-cancel-btn");
      const MIN_SIZE = 40;
      const MAX_OUTPUT = 1200;

      let box = { left: 0, top: 0, size: 0 };
      let stageW = 0;
      let stageH = 0;

      function paintBox() {
        boxEl.style.left = box.left + "px";
        boxEl.style.top = box.top + "px";
        boxEl.style.width = box.size + "px";
        boxEl.style.height = box.size + "px";
      }

      function onImgLoad() {
        // La imagen se muestra con un tamaño exacto que entre en el cuadro (no
        // más ancho que el espacio disponible ni más alto que 480 px). Antes se
        // dejaba al CSS (max-width: 480px), pero el cuadro mide menos de 480 px
        // (520 - 48 de relleno = 472; en celular, bastante menos): la imagen
        // quedaba más ancha que el cuadro, el recorte se calculaba con una
        // escala equivocada y se pasaba del borde inferior de la foto, y el
        // sobrante salía negro en el JPG (franja negra abajo de la foto).
        const wrap = stage.parentElement;
        const wcs = getComputedStyle(wrap);
        const availW = Math.max(
          120,
          wrap.clientWidth - parseFloat(wcs.paddingLeft) - parseFloat(wcs.paddingRight)
        );
        const fit = Math.min(1, availW / imgEl.naturalWidth, 480 / imgEl.naturalHeight);
        imgEl.style.width = Math.max(1, Math.round(imgEl.naturalWidth * fit)) + "px";
        imgEl.style.height = Math.max(1, Math.round(imgEl.naturalHeight * fit)) + "px";
        // Se espera un frame para que el navegador termine de acomodar el
        // tamaño renderizado de la imagen antes de medirlo.
        requestAnimationFrame(() => {
          // Se mide la imagen misma (no el contenedor), que es lo que se recorta.
          stageW = imgEl.clientWidth;
          stageH = imgEl.clientHeight;
          const size0 = Math.min(stageW, stageH);
          box = { left: (stageW - size0) / 2, top: (stageH - size0) / 2, size: size0 };
          paintBox();
        });
      }
      imgEl.addEventListener("load", onImgLoad, { once: true });

      const reader = new FileReader();
      reader.onload = () => {
        imgEl.src = reader.result;
      };
      reader.readAsDataURL(file);

      modal.classList.add("open");

      function clamp(v, lo, hi) {
        return Math.min(Math.max(v, lo), hi);
      }

      function startDrag(e, mode) {
        e.preventDefault();
        const start = { x: e.clientX, y: e.clientY, left: box.left, top: box.top, size: box.size };
        function move(ev) {
          const dx = ev.clientX - start.x;
          const dy = ev.clientY - start.y;
          if (mode === "move") {
            box.left = clamp(start.left + dx, 0, stageW - box.size);
            box.top = clamp(start.top + dy, 0, stageH - box.size);
          } else {
            const delta = (dx + dy) / 2;
            const maxSize = Math.min(stageW - start.left, stageH - start.top);
            box.size = clamp(start.size + delta, MIN_SIZE, maxSize);
          }
          paintBox();
        }
        function up() {
          window.removeEventListener("pointermove", move);
          window.removeEventListener("pointerup", up);
        }
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up, { once: true });
      }

      function onBoxDown(e) {
        if (e.target === handleEl) return; // el handle maneja su propio drag (resize)
        startDrag(e, "move");
      }
      function onHandleDown(e) {
        e.stopPropagation();
        startDrag(e, "resize");
      }

      boxEl.addEventListener("pointerdown", onBoxDown);
      handleEl.addEventListener("pointerdown", onHandleDown);

      function cleanup() {
        modal.classList.remove("open");
        boxEl.removeEventListener("pointerdown", onBoxDown);
        handleEl.removeEventListener("pointerdown", onHandleDown);
        confirmBtn.removeEventListener("click", onConfirm);
        cancelBtn.removeEventListener("click", onCancel);
        imgEl.src = "";
        imgEl.style.width = "";
        imgEl.style.height = "";
      }

      function onConfirm() {
        const natW = imgEl.naturalWidth;
        const natH = imgEl.naturalHeight;
        // Escala por eje (el ancho y el alto mostrados se redondean distinto) y
        // el recuadro nunca sale de la foto original.
        const scaleX = natW / stageW;
        const scaleY = natH / stageH;
        const sx = clamp(box.left * scaleX, 0, natW - 1);
        const sy = clamp(box.top * scaleY, 0, natH - 1);
        const sw = Math.min(box.size * scaleX, natW - sx);
        const sh = Math.min(box.size * scaleY, natH - sy);
        const outSize = Math.min(Math.round(Math.min(sw, sh)) || MIN_SIZE, MAX_OUTPUT);
        const canvas = document.createElement("canvas");
        canvas.width = outSize;
        canvas.height = outSize;
        const ctx = canvas.getContext("2d");
        // Fondo blanco de seguridad: si algo quedara sin cubrir, que sea
        // blanco y no negro (un JPG pasa lo transparente a negro).
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, outSize, outSize);
        ctx.drawImage(imgEl, sx, sy, sw, sh, 0, 0, outSize, outSize);
        canvas.toBlob(
          (blob) => {
            cleanup();
            resolve(blob);
          },
          "image/jpeg",
          0.88
        );
      }
      function onCancel() {
        cleanup();
        resolve(null);
      }

      confirmBtn.addEventListener("click", onConfirm);
      cancelBtn.addEventListener("click", onCancel);
    });
  }

  /* ---- Descripción con formato (negrita / cursiva / subrayado) ----
     contenteditable + document.execCommand: liviano, sin librerías, y
     alcanza para lo que pide el panel. Se sanitiza el HTML antes de
     guardarlo (por si se pega texto con estilos pegados de Word/Docs). */
  const RTE_ALLOWED_TAGS = new Set(["B", "STRONG", "I", "EM", "U", "BR", "DIV", "P", "SPAN"]);
  function sanitizeRte(html) {
    const tmp = document.createElement("div");
    tmp.innerHTML = html;
    (function clean(node) {
      Array.from(node.childNodes).forEach((child) => {
        if (child.nodeType === 1) {
          if (!RTE_ALLOWED_TAGS.has(child.tagName)) {
            while (child.firstChild) node.insertBefore(child.firstChild, child);
            node.removeChild(child);
            return;
          }
          Array.from(child.attributes).forEach((attr) => child.removeAttribute(attr.name));
          clean(child);
        } else if (child.nodeType !== 3) {
          node.removeChild(child);
        }
      });
    })(tmp);
    return tmp.innerHTML;
  }
  function rteLoadContent(editorEl, raw) {
    const text = raw || "";
    if (/<[a-z][\s\S]*>/i.test(text)) {
      editorEl.innerHTML = sanitizeRte(text);
    } else {
      // Descripción vieja guardada como texto plano: se escapa y se
      // convierten los \n en <br> para no perder los saltos de línea.
      const esc = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      editorEl.innerHTML = esc.replace(/\n/g, "<br>");
    }
  }
  try {
    document.execCommand("defaultParagraphSeparator", false, "br");
  } catch (e) {
    /* navegadores viejos: sigue funcionando, solo cambia qué tag usa al tocar Enter */
  }
  document.querySelectorAll(".rte-toolbar button[data-cmd]").forEach((btn) => {
    btn.addEventListener("mousedown", (e) => e.preventDefault()); // no perder la selección de texto
    btn.addEventListener("click", () => {
      document.execCommand(btn.dataset.cmd, false, null);
      document.getElementById("prod-descripcion").focus();
      updateRteToolbarState();
    });
  });
  function updateRteToolbarState() {
    document.querySelectorAll(".rte-toolbar button[data-cmd]").forEach((btn) => {
      let active = false;
      try {
        active = document.queryCommandState(btn.dataset.cmd);
      } catch (e) {
        /* ignorar */
      }
      btn.classList.toggle("active", active);
    });
  }
  const prodDescEl = document.getElementById("prod-descripcion");
  prodDescEl.addEventListener("keyup", updateRteToolbarState);
  prodDescEl.addEventListener("mouseup", updateRteToolbarState);

  /* ---- Foto de portada de categoría ---- */
  document.getElementById("cat-img-input").addEventListener("change", async (e) => {
    const file = (e.target.files || [])[0];
    e.target.value = "";
    if (!file) return;
    const blob = await stratoOpenCropper(file);
    if (blob) await uploadCategoriaImagen(blob);
  });

  async function uploadCategoriaImagen(blob) {
    if (!requireSb()) return;
    renderCatImgManager(true);
    const path = "categoria-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8) + ".jpg";
    const { error } = await stratoSb.storage.from("productos-imagenes").upload(path, blob, { contentType: "image/jpeg" });
    if (error) {
      alert("No se pudo subir la imagen: " + error.message);
      renderCatImgManager(false);
      return;
    }
    const { data } = stratoSb.storage.from("productos-imagenes").getPublicUrl(path);
    catImagenPortada = data.publicUrl;
    renderCatImgManager(false);
  }

  function renderCatImgManager(uploading) {
    const wrap = document.getElementById("cat-img-manager");
    if (uploading) {
      wrap.innerHTML = '<div class="img-thumb img-uploading">Subiendo…</div>';
      return;
    }
    let html = "";
    if (catImagenPortada) {
      html +=
        '<div class="img-thumb"><img src="' +
        catImagenPortada +
        '"><button type="button" class="img-remove" onclick="stratoAdminQuitarImagenCategoria()">✕</button></div>';
    }
    html +=
      '<div class="img-add-tile" onclick="document.getElementById(\'cat-img-input\').click()">' +
      (catImagenPortada ? "↻" : "+") +
      "</div>";
    wrap.innerHTML = html;
  }
  window.stratoAdminQuitarImagenCategoria = function () {
    catImagenPortada = null;
    renderCatImgManager(false);
  };

  /* ---- Guardar producto ---- */
  document.getElementById("form-producto").addEventListener("submit", async (e) => {
    e.preventDefault();
    const errEl = document.getElementById("producto-error");
    errEl.textContent = "";

    const cotizar = document.getElementById("prod-cotizar").checked;
    const precioVal = document.getElementById("prod-precio").value;

    // Tamaños (cada uno con su precio). Las filas totalmente vacías se ignoran;
    // las a medias (solo nombre o solo precio) frenan el guardado.
    const tamanos = [];
    for (const t of prodTamanos) {
      const nombreT = String(t.nombre || "").trim();
      const precioT = t.precio === "" || t.precio == null ? null : Number(t.precio);
      if (!nombreT && precioT == null) continue;
      if (!nombreT || precioT == null || isNaN(precioT) || precioT < 0) {
        errEl.textContent = "Cada tamaño necesita un nombre y un precio (o quitá la fila vacía).";
        return;
      }
      if (tamanos.some((x) => x.nombre.toLowerCase() === nombreT.toLowerCase())) {
        errEl.textContent = "Hay dos tamaños con el mismo nombre: \"" + nombreT + "\".";
        return;
      }
      tamanos.push({ nombre: nombreT, precio: precioT });
    }

    // Costos de fabricación (privados): una fila por tamaño con nombre, o una sola "Por unidad". Vacío = sin costo cargado.
    const filasCosto = [];
    for (const r of filasCostoProd()) {
      const v = r.val;
      if (v === "" || v === null || v === undefined) { filasCosto.push({ tamano: r.key, costo: null }); continue; }
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0 || n > COSTO_MAX) {
        errEl.textContent = "El costo de \"" + r.label + "\" no es válido (tiene que ser un número desde 0).";
        return;
      }
      filasCosto.push({ tamano: r.key, costo: redondear2(n) });
    }

    // Escalones propios (solo si el producto se vende por cantidad y eligió no usar la tabla general).
    const porCantidad = document.getElementById("prod-por-cantidad").checked;
    let escalonesPropios = null;
    if (porCantidad && document.getElementById("prod-escalones-propios").checked) {
      escalonesPropios = [];
      for (const t of prodEscalones) {
        const vacio = (t.desde === "" || t.desde == null) && (t.descuento_pct === "" || t.descuento_pct == null);
        if (vacio) continue;
        const desde = Number(t.desde);
        const pct = Number(t.descuento_pct);
        if (!Number.isInteger(desde) || desde < 2 || !(pct > 0 && pct < 100)) {
          errEl.textContent = "Los escalones propios necesitan una cantidad entera desde 2 y un descuento entre 0 y 100%.";
          return;
        }
        if (escalonesPropios.some((x) => x.desde === desde)) {
          errEl.textContent = "Hay dos escalones propios desde " + desde + " unidades.";
          return;
        }
        escalonesPropios.push({ desde: desde, descuento_pct: pct });
      }
      if (!escalonesPropios.length) {
        errEl.textContent = "Cargá al menos un escalón propio, o desmarcá \"Usar descuentos propios\".";
        return;
      }
      escalonesPropios.sort((a, b) => a.desde - b.desde);
    }

    const payload = {
      nombre: document.getElementById("prod-nombre").value.trim(),
      precio: tamanos.length ? Math.min.apply(null, tamanos.map((t) => t.precio)) : cotizar || precioVal === "" ? null : Number(precioVal),
      colores: prodColores,
      colores_multiple: document.getElementById("prod-colores-multiple").checked,
      material: document.getElementById("prod-material").value.trim(),
      descripcion: sanitizeRte(document.getElementById("prod-descripcion").innerHTML),
      imagenes: prodImagenes.filter((i) => typeof i === "string"),
      tag: document.getElementById("prod-tag").value || null,
      orden: Number(document.getElementById("prod-orden").value || 0),
      activo: document.getElementById("prod-activo").checked,
    };

    // Columnas de la migración v7. Si la base todavía no las tiene (la migración
    // no se corrió) y este producto no usa nada de eso, se omiten para que
    // guardar productos siga funcionando igual que antes.
    const usaV7 = tamanos.length > 0 || porCantidad || escalonesPropios !== null;
    // Con productos cargados se mira si traen la columna; sin productos, si se pudieron leer las tablas nuevas.
    const baseTieneV7 = productosCache.length ? "tamanos" in productosCache[0] : v7TablasOk;
    if (baseTieneV7) {
      payload.tamanos = tamanos;
      payload.venta_por_cantidad = porCantidad;
      payload.escalones_propios = escalonesPropios;
    } else if (usaV7) {
      errEl.textContent = "Falta correr la migración SQL v7 en Supabase (archivo supabase/migracion_v7_filamentos_tamanos_cantidades.sql) para usar tamaños y venta por cantidad.";
      return;
    }

    if (!payload.nombre) { errEl.textContent = "Falta el nombre."; return; }
    if (!prodCategoriaIds.length) { errEl.textContent = "Elegí al menos una categoría (creá una primero si no hay ninguna)."; return; }

    let error, productoId;
    if (editingProductId) {
      productoId = editingProductId;
      ({ error } = await stratoSb.from("productos").update(payload).eq("id", editingProductId));
    } else {
      let data;
      ({ data, error } = await stratoSb.from("productos").insert([payload]).select());
      if (!error && data && data[0]) productoId = data[0].id;
    }
    if (error) { errEl.textContent = error.message; return; }
    if (productoId) editingProductId = productoId; // si algo falla de acá en más, volver a guardar actualiza este mismo producto

    if (productoId) {
      const { error: catError } = await syncProductoCategorias(productoId, prodCategoriaIds);
      if (catError) { errEl.textContent = "Producto guardado, pero falló vincular categorías: " + catError.message; return; }

      const rc = await syncProductoCostos(productoId, filasCosto);
      if (rc.error) {
        errEl.textContent = "Producto guardado, pero no se pudieron guardar los costos: " + rc.error.message + ". Volvé a guardar para reintentar.";
        await loadProductos();
        renderProductos();
        return;
      }
      if (rc.skipped && filasCosto.some((f) => f.costo !== null)) {
        errEl.textContent = "Producto guardado, pero los costos todavía no se pueden guardar: falta correr supabase/migracion_dashboard.sql en Supabase. Cuando lo corras, volvé a guardar este producto.";
        await loadProductos();
        renderProductos();
        return;
      }
    }

    await loadProductos();
    renderProductos();
    resetProductForm();
    renderDashboard(); // los costos nuevos cambian la ganancia estimada
  });

  /* Reemplaza los vínculos producto-categoría por la lista actual (borra e inserta de nuevo). */
  async function syncProductoCategorias(productoId, categoriaIds) {
    const del = await stratoSb.from("producto_categorias").delete().eq("producto_id", productoId);
    if (del.error) return del;
    if (!categoriaIds.length) return { error: null };
    const rows = categoriaIds.map((catId) => ({ producto_id: productoId, categoria_id: catId }));
    return await stratoSb.from("producto_categorias").insert(rows);
  }

  /* ============ CATEGORIAS ============ */
  document.getElementById("cat-cancel-btn").addEventListener("click", resetCategoriaForm);

  function resetCategoriaForm() {
    editingCategoriaId = null;
    document.getElementById("form-categoria").reset();
    document.getElementById("cat-submit-btn").textContent = "Guardar categoría";
    document.getElementById("cat-cancel-btn").style.display = "none";
    catImagenPortada = null;
    renderCatImgManager(false);
  }

  function renderCategorias() {
    const tbody = document.getElementById("categorias-tbody");
    document.getElementById("categorias-empty").style.display = categoriasCache.length ? "none" : "block";
    tbody.innerHTML = categoriasCache
      .map(
        (c) =>
          "<tr><td>" +
          c.orden +
          "</td><td>" +
          escHtml(c.nombre) +
          "</td><td>" +
          escHtml(c.slug) +
          "</td><td>" +
          escHtml(c.descripcion_corta || "—") +
          "</td><td><button type='button' class='btn-secondary btn-small' onclick=\"stratoAdminEditarCategoria('" +
          c.id +
          "')\">Editar</button> <button type='button' class='btn-danger btn-small' onclick=\"stratoAdminEliminarCategoria('" +
          c.id +
          "')\">Eliminar</button></td></tr>"
      )
      .join("");
  }

  window.stratoAdminEditarCategoria = function (id) {
    const c = categoriasCache.find((x) => x.id === id);
    if (!c) return;
    editingCategoriaId = id;
    document.getElementById("cat-slug").value = c.slug;
    document.getElementById("cat-nombre").value = c.nombre;
    document.getElementById("cat-orden").value = c.orden;
    document.getElementById("cat-descripcion").value = c.descripcion_corta || "";
    catImagenPortada = c.imagen_portada || null;
    renderCatImgManager(false);
    document.getElementById("cat-submit-btn").textContent = "Guardar cambios";
    document.getElementById("cat-cancel-btn").style.display = "inline-block";
    document.getElementById("panel-categorias").scrollIntoView({ behavior: "smooth" });
  };

  window.stratoAdminEliminarCategoria = async function (id) {
    if (!confirm("¿Eliminar esta categoría? Los productos que la usan quedarán sin categoría.")) return;
    const { error } = await stratoSb.from("categorias").delete().eq("id", id);
    if (error) { alert("No se pudo eliminar: " + error.message); return; }
    await Promise.all([loadCategorias(), loadProductos()]);
    fillCategoriaSelects();
    renderCategorias();
    renderProductos();
  };

  document.getElementById("form-categoria").addEventListener("submit", async (e) => {
    e.preventDefault();
    const errEl = document.getElementById("categoria-error");
    errEl.textContent = "";
    const payload = {
      slug: document.getElementById("cat-slug").value.trim().toLowerCase().replace(/\s+/g, "-"),
      nombre: document.getElementById("cat-nombre").value.trim(),
      descripcion_corta: document.getElementById("cat-descripcion").value.trim(),
      orden: Number(document.getElementById("cat-orden").value || 0),
      imagen_portada: catImagenPortada,
    };
    if (!payload.slug || !payload.nombre) { errEl.textContent = "Faltan datos."; return; }

    let error;
    if (editingCategoriaId) {
      ({ error } = await stratoSb.from("categorias").update(payload).eq("id", editingCategoriaId));
    } else {
      ({ error } = await stratoSb.from("categorias").insert([payload]));
    }
    if (error) { errEl.textContent = error.message; return; }

    await loadCategorias();
    fillCategoriaSelects();
    renderCategorias();
    resetCategoriaForm();
  });

  /* ============ FILAMENTOS ============ */
  /* Inventario de filamentos: alimenta la calculadora (precio por kg real), los
     colores de cada producto y el circulito de color en la tienda. */
  function sameColor(a, b) {
    return String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase();
  }
  // Precio del rollo en pesos. Si está cargado en dólares se convierte con el dólar de hoy (así sube o baja solo
  // cuando cambiás el tipo de cambio); si todavía no hay dólar cargado, queda el último valor en pesos guardado.
  function precioRolloUYU(f) {
    if (f && f.moneda === "USD" && tc.USD > 0 && f.precio_original !== null && f.precio_original !== undefined && Number.isFinite(Number(f.precio_original))) {
      return Number(f.precio_original) * tc.USD;
    }
    return Number(f && f.precio_rollo);
  }
  const filEnUSD = (f) => !!f && f.moneda === "USD" && Number.isFinite(Number(f.precio_original));
  function precioKgDe(f) {
    const peso = Number(f.peso_rollo_gr);
    return peso > 0 ? (precioRolloUYU(f) / peso) * 1000 : 0;
  }
  function filamentoNombre(f) {
    return f.color + (f.marca ? " — " + f.marca : "") + (f.material ? " (" + f.material + ")" : "");
  }
  function swatchHtml(hex) {
    return hex && /^#[0-9a-fA-F]{3,8}$/.test(hex) ? '<span class="sw" style="background:' + hex + '"></span>' : "";
  }

  async function loadFilamentos() {
    const errEl = document.getElementById("filamentos-load-error");
    const { data, error } = await stratoSb
      .from("filamentos")
      .select("*")
      .order("orden", { ascending: true })
      .order("color", { ascending: true });
    if (error) {
      v7TablasOk = false;
      filamentosCache = [];
      errEl.textContent = "No se pudo cargar Filamentos (¿corriste la migración SQL v7 en Supabase?): " + error.message;
    } else {
      filamentosCache = data || [];
      errEl.textContent = "";
    }
  }

  document.getElementById("filamento-form-toggle").addEventListener("click", () => {
    document.getElementById("filamento-form-toggle").classList.toggle("open");
    document.getElementById("filamento-form-body").classList.toggle("open");
  });
  document.getElementById("filamentos-buscar").addEventListener("input", renderFilamentos);

  function renderFilamentos() {
    const term = document.getElementById("filamentos-buscar").value.trim().toLowerCase();
    const list = filamentosCache.filter(
      (f) => !term || [f.color, f.marca, f.material].filter(Boolean).join(" ").toLowerCase().includes(term)
    );
    document.getElementById("filamentos-empty").style.display = list.length ? "none" : "block";
    document.getElementById("filamentos-tbody").innerHTML = list
      .map(
        (f) =>
          "<tr><td>" + swatchHtml(f.hex) + escHtml(f.color) + "</td><td>" + escHtml(f.marca || "—") + "</td><td>" +
          escHtml(f.material || "—") + "</td><td>" + precioRolloHtml(f) + " <span class='muted'>/ " +
          Number(f.peso_rollo_gr) + " gr</span></td><td>" + fmtMoney(precioKgDe(f)) + '</td><td><input type="checkbox" ' +
          (f.disponible ? "checked" : "") + " onchange=\"stratoAdminToggleFilamento('" + f.id + "', this.checked)\"></td>" +
          "<td><button type='button' class='btn-secondary btn-small' onclick=\"stratoAdminEditarFilamento('" + f.id +
          "')\">Editar</button> <button type='button' class='btn-danger btn-small' onclick=\"stratoAdminEliminarFilamento('" +
          f.id + "')\">Eliminar</button></td></tr>"
      )
      .join("");
  }

  function precioRolloHtml(f) {
    if (!filEnUSD(f)) return fmtMoney(f.precio_rollo);
    return escHtml(fmtMon("USD", Number(f.precio_original))) + " <span class='muted'>" +
      (tc.USD > 0 ? "≈ " + escHtml(fmtMoney(precioRolloUYU(f))) : "· falta cargar el dólar") + "</span>";
  }

  /* Cada vez que cambia la lista de filamentos hay tres lugares que dependen de ella. */
  function refreshFilamentoDependents() {
    renderFilamentos();
    renderColorTags(); // también redibuja el selector de colores del producto
    renderCalcFilRows();
    renderResultados();
  }

  function filMonedaForm() {
    return document.getElementById("fil-moneda").value === "USD" ? "USD" : "UYU";
  }
  // Precio del rollo del formulario, en pesos (null si está en dólares y todavía no hay dólar cargado).
  function filPrecioUYUForm() {
    const v = numVal("fil-precio-rollo");
    if (filMonedaForm() === "USD") return tc.USD > 0 ? v * tc.USD : null;
    return v;
  }
  function updateFilKgPreview() {
    const peso = numVal("fil-peso-rollo");
    const usd = filMonedaForm() === "USD";
    document.getElementById("fil-precio-lbl").textContent = "Precio del rollo (" + (usd ? "US$" : "$U") + ")";
    const pUYU = filPrecioUYUForm();
    document.getElementById("fil-kg-preview").textContent = peso > 0 && pUYU !== null ? fmtMoney((pUYU / peso) * 1000) + " / kg" : "—";
    const eq = document.getElementById("fil-eq");
    if (!usd) eq.textContent = "";
    else if (!(tc.USD > 0)) eq.textContent = "Para pasar los dólares a pesos, primero cargá el valor del dólar en «Tipo de cambio» (arriba).";
    else eq.textContent = "Con el dólar a " + fmtMoney(tc.USD) + ", el rollo equivale a " + fmtMoney(numVal("fil-precio-rollo") * tc.USD) + ". Se actualiza solo si cambiás el dólar.";
  }
  document.getElementById("fil-precio-rollo").addEventListener("input", updateFilKgPreview);
  document.getElementById("fil-peso-rollo").addEventListener("input", updateFilKgPreview);
  document.getElementById("fil-moneda").addEventListener("change", updateFilKgPreview);

  // Cambió el tipo de cambio: se recalculan los filamentos en dólares y todo lo que depende de ellos.
  function tcCambio() {
    calcFilRows.forEach((r) => {
      const f = r.filamento_id ? filamentosCache.find((x) => x.id === r.filamento_id) : null;
      if (f && filEnUSD(f)) r.precio_kg = Math.round(precioKgDe(f) * 100) / 100;
    });
    refreshFilamentoDependents();
    updateFilKgPreview();
    if (gastoEditId === null) formMonedaGasto(true);
    else actualizarEquivGasto();
  }

  function resetFilamentoForm() {
    editingFilamentoId = null;
    document.getElementById("form-filamento").reset();
    document.getElementById("fil-material").value = "PLA";
    document.getElementById("fil-moneda").value = "UYU";
    document.getElementById("fil-peso-rollo").value = 1000;
    document.getElementById("fil-hex").value = "#333333";
    document.getElementById("fil-hex-activo").checked = true;
    document.getElementById("fil-disponible").checked = true;
    document.getElementById("filamento-form-title").textContent = "Nuevo filamento";
    document.getElementById("fil-submit-btn").textContent = "Guardar filamento";
    document.getElementById("fil-cancel-btn").style.display = "none";
    document.getElementById("filamento-error").textContent = "";
    updateFilKgPreview();
  }
  document.getElementById("fil-cancel-btn").addEventListener("click", resetFilamentoForm);

  window.stratoAdminEditarFilamento = function (id) {
    const f = filamentosCache.find((x) => x.id === id);
    if (!f) return;
    editingFilamentoId = id;
    document.getElementById("fil-color").value = f.color;
    document.getElementById("fil-marca").value = f.marca || "";
    document.getElementById("fil-material").value = f.material || "";
    document.getElementById("fil-moneda").value = filEnUSD(f) ? "USD" : "UYU";
    document.getElementById("fil-precio-rollo").value = filEnUSD(f) ? f.precio_original : f.precio_rollo;
    document.getElementById("fil-peso-rollo").value = f.peso_rollo_gr;
    document.getElementById("fil-hex-activo").checked = !!f.hex;
    document.getElementById("fil-hex").value = f.hex && /^#[0-9a-fA-F]{6}$/.test(f.hex) ? f.hex : "#333333";
    document.getElementById("fil-disponible").checked = f.disponible !== false;
    document.getElementById("filamento-form-title").textContent = "Editar filamento";
    document.getElementById("fil-submit-btn").textContent = "Guardar cambios";
    document.getElementById("fil-cancel-btn").style.display = "inline-block";
    document.getElementById("filamento-error").textContent = "";
    updateFilKgPreview();
    if (!document.getElementById("filamento-form-body").classList.contains("open")) {
      document.getElementById("filamento-form-toggle").click();
    }
    document.getElementById("panel-filamentos").scrollIntoView({ behavior: "smooth" });
  };

  window.stratoAdminToggleFilamento = async function (id, disponible) {
    const { error } = await stratoSb.from("filamentos").update({ disponible }).eq("id", id);
    if (error) { alert("No se pudo actualizar: " + error.message); return; }
    const f = filamentosCache.find((x) => x.id === id);
    if (f) f.disponible = disponible;
    refreshFilamentoDependents();
  };

  window.stratoAdminEliminarFilamento = async function (id) {
    if (!confirm("¿Eliminar este filamento? Los productos que ya lo tienen como color siguen mostrándolo, pero deja de estar en esta lista y en la calculadora.")) return;
    const { error } = await stratoSb.from("filamentos").delete().eq("id", id);
    if (error) { alert("No se pudo eliminar: " + error.message); return; }
    if (editingFilamentoId === id) resetFilamentoForm();
    await loadFilamentos();
    refreshFilamentoDependents();
  };

  document.getElementById("form-filamento").addEventListener("submit", async (e) => {
    e.preventDefault();
    const errEl = document.getElementById("filamento-error");
    errEl.textContent = "";
    const payload = {
      color: document.getElementById("fil-color").value.trim(),
      marca: document.getElementById("fil-marca").value.trim(),
      material: document.getElementById("fil-material").value.trim() || "PLA",
      precio_rollo: numVal("fil-precio-rollo"),
      peso_rollo_gr: numVal("fil-peso-rollo"),
      hex: document.getElementById("fil-hex-activo").checked ? document.getElementById("fil-hex").value : null,
      disponible: document.getElementById("fil-disponible").checked,
    };
    if (!payload.color) { errEl.textContent = "Falta el color."; return; }
    if (!(payload.peso_rollo_gr > 0)) { errEl.textContent = "El peso del rollo tiene que ser mayor a 0."; return; }
    // Moneda del precio: en dólares se guarda el precio en US$ y, además, su equivalente en pesos de hoy.
    const previoFil = editingFilamentoId ? filamentosCache.find((x) => x.id === editingFilamentoId) : null;
    if (filMonedaForm() === "USD") {
      if (!(tc.USD > 0)) { errEl.textContent = "Para guardar un precio en dólares, primero cargá el valor del dólar en «Tipo de cambio» (arriba)."; return; }
      const usd = payload.precio_rollo;
      if (!(usd >= 0) || usd > 1e9) { errEl.textContent = "El precio del rollo no es válido."; return; }
      payload.precio_original = redondear2(usd);
      payload.precio_rollo = redondear2(usd * tc.USD);
      payload.moneda = "USD";
    } else if (previoFil && filEnUSD(previoFil)) {
      payload.moneda = "UYU"; // pasa de dólares a pesos
      payload.precio_original = null;
    }
    if (!requireSb()) return;

    let error;
    if (editingFilamentoId) {
      ({ error } = await stratoSb.from("filamentos").update(payload).eq("id", editingFilamentoId));
    } else {
      ({ error } = await stratoSb.from("filamentos").insert([payload]));
    }
    if (error) {
      errEl.textContent = /moneda|precio_original|PGRST204/i.test(String(error.message || "") + " " + String(error.code || ""))
        ? "Todavía falta correr supabase/migracion_monedas_inversion.sql en Supabase (agrega el precio en dólares). Corrélo y volvé a guardar: lo que cargaste sigue acá."
        : error.message;
      return;
    }

    await loadFilamentos();
    resetFilamentoForm();
    refreshFilamentoDependents();
  });

  /* ---- Selector de colores del producto, armado con los filamentos ---- */
  function renderProdFilPicker() {
    const wrap = document.getElementById("prod-fil-picker");
    // Una sola pastilla por nombre de color (si tenés el mismo color en dos
    // marcas, es el mismo color para el cliente).
    const porColor = new Map();
    filamentosCache.forEach((f) => {
      const key = String(f.color).trim().toLowerCase();
      if (!porColor.has(key)) porColor.set(key, { color: String(f.color).trim(), hex: f.hex, marcas: [], disponible: false });
      const e = porColor.get(key);
      if (f.marca && !e.marcas.includes(f.marca)) e.marcas.push(f.marca);
      e.disponible = e.disponible || f.disponible !== false;
      if (!e.hex && f.hex) e.hex = f.hex;
    });
    if (!porColor.size) {
      wrap.innerHTML = '<p class="muted" style="font-size:12px;margin:0;">Todavía no cargaste filamentos (pestaña Filamentos). Mientras tanto podés escribir los colores a mano acá abajo.</p>';
      return;
    }
    wrap.innerHTML = Array.from(porColor.values())
      .map((e) => {
        const activo = prodColores.some((c) => sameColor(c, e.color));
        return (
          '<button type="button" class="fil-pill' + (activo ? " active" : "") + (e.disponible ? "" : " off") +
          '" data-color="' + escHtml(e.color) + '" title="' + escHtml(e.marcas.join(", ") + (e.disponible ? "" : " — sin stock")) +
          '" onclick="stratoAdminToggleColorFil(this.dataset.color)">' + swatchHtml(e.hex) +
          '<span class="fil-name">' + escHtml(e.color) + "</span></button>"
        );
      })
      .join("");
  }
  window.stratoAdminToggleColorFil = function (color) {
    const i = prodColores.findIndex((c) => sameColor(c, color));
    if (i >= 0) prodColores.splice(i, 1);
    else prodColores.push(color);
    renderColorTags();
  };

  /* ============ TAMAÑOS Y VENTA POR CANTIDAD (formulario de producto) ============ */
  function tamanoValido(t) {
    return String(t.nombre || "").trim() !== "" && t.precio !== "" && t.precio != null && !isNaN(Number(t.precio));
  }

  // Con al menos un tamaño válido, el precio base pasa a ser el del más barato
  // y deja de ser editable a mano (así no quedan dos precios contradictorios).
  function syncPrecioDesdeTamanos() {
    const validos = prodTamanos.filter(tamanoValido);
    const precio = document.getElementById("prod-precio");
    const cot = document.getElementById("prod-cotizar");
    if (validos.length) {
      precio.value = Math.min.apply(null, validos.map((t) => Number(t.precio)));
      precio.disabled = true;
      cot.checked = false;
      cot.disabled = true;
    } else {
      precio.disabled = false;
      cot.disabled = false;
    }
  }

  function renderProdTamanos() {
    document.getElementById("prod-tamanos-rows").innerHTML = prodTamanos
      .map(
        (t, i) =>
          '<div class="row-edit"><input type="text" placeholder="Nombre (ej: Chico, 10 cm)" value="' + escHtml(t.nombre) +
          '" oninput="stratoAdminTamanoSet(' + i + ",'nombre',this.value)\"><input type=\"number\" min=\"0\" step=\"1\" placeholder=\"Precio $U\" value=\"" +
          escHtml(t.precio) + '" oninput="stratoAdminTamanoSet(' + i + ",'precio',this.value)\"><button type=\"button\" class=\"row-del\" onclick=\"stratoAdminTamanoDel(" +
          i + ')" aria-label="Quitar">✕</button></div>'
      )
      .join("");
    syncPrecioDesdeTamanos();
    renderProdCostos();
  }
  window.stratoAdminTamanoSet = function (i, key, value) {
    if (prodTamanos[i]) prodTamanos[i][key] = value;
    syncPrecioDesdeTamanos();
    if (key === "nombre") renderProdCostos(); // las filas de costo siguen a los nombres de los tamaños
  };
  window.stratoAdminTamanoDel = function (i) {
    prodTamanos.splice(i, 1);
    renderProdTamanos();
  };
  document.getElementById("prod-add-tamano").addEventListener("click", () => {
    prodTamanos.push({ nombre: "", precio: "" });
    renderProdTamanos();
  });

  /* ---- Costo de fabricación del producto en edición (privado) ---- */
  // Una fila por tamaño con nombre; si el producto no tiene tamaños, una sola fila "Por unidad".
  function filasCostoProd() {
    const nombrados = [];
    prodTamanos.forEach((t, i) => { if (String(t.nombre || "").trim() !== "") nombrados.push({ idx: i, key: String(t.nombre).trim(), label: String(t.nombre).trim(), val: t.costo }); });
    return nombrados.length ? nombrados : [{ idx: -1, key: "", label: "Por unidad", val: prodCostoBase }];
  }

  function renderProdCostos() {
    const wrap = document.getElementById("prod-costos-rows");
    const note = document.getElementById("prod-costos-note");
    const sinTabla = costosEstado.intento && !costosEstado.ok;
    note.hidden = !sinTabla;
    note.textContent = !sinTabla ? "" : costosEstado.falta
      ? "Para guardar costos falta correr supabase/migracion_dashboard.sql en Supabase (SQL Editor). Mientras tanto, el producto se guarda normal pero sin costo."
      : "No se pudieron leer los costos (" + costosEstado.error + "). Si guardás ahora, los costos no se tocan.";
    const opciones =
      '<option value="">Usar cotización…</option>' +
      cotizacionesCache
        .filter((c) => costoDeCotizacion(c) !== null)
        .map((c) => '<option value="' + escAttr(c.id) + '">' + escHtml(c.nombre_pieza) + " — " + fmtMoney(costoDeCotizacion(c)) + "</option>")
        .join("");
    const dis = sinTabla ? " disabled" : "";
    wrap.innerHTML = filasCostoProd()
      .map((r) =>
        '<div class="cost-row"><span class="cost-lbl">' + escHtml(r.label) + "</span>" +
        '<input type="number" class="cost-in" data-idx="' + r.idx + '" min="0" step="0.01" placeholder="Costo $U" inputmode="decimal" aria-label="Costo de fabricación de ' +
        escAttr(r.label) + ' (privado)" value="' + escAttr(r.val === undefined || r.val === null ? "" : r.val) + '"' + dis + ">" +
        '<select class="cost-cot" data-idx="' + r.idx + '" aria-label="Traer el costo de una cotización para ' + escAttr(r.label) + '"' + dis + ">" + opciones + "</select></div>"
      )
      .join("");
  }

  function fijarCostoProd(idx, valor) {
    if (idx === -1) prodCostoBase = valor;
    else if (prodTamanos[idx]) prodTamanos[idx].costo = valor;
  }
  document.getElementById("prod-costos-rows").addEventListener("input", (e) => {
    const inp = e.target.closest(".cost-in");
    if (inp) fijarCostoProd(Number(inp.dataset.idx), inp.value);
  });
  document.getElementById("prod-costos-rows").addEventListener("change", (e) => {
    const sel = e.target.closest(".cost-cot");
    if (!sel || !sel.value) return;
    const c = cotizacionesCache.find((x) => x.id === sel.value);
    sel.value = "";
    const v = costoDeCotizacion(c);
    if (v === null) return;
    const idx = Number(sel.dataset.idx);
    fijarCostoProd(idx, String(v));
    const inp = sel.closest(".cost-row").querySelector(".cost-in");
    if (inp) inp.value = String(v);
  });

  // Guarda los costos del producto: crea o actualiza los que tienen valor y borra los que se vaciaron o ya no existen.
  async function syncProductoCostos(productoId, filas) {
    if (!costosEstado.ok) return { skipped: true, error: null };
    const nuevas = filas.filter((f) => f.costo !== null).map((f) => ({ producto_id: productoId, tamano: f.tamano, costo: f.costo, updated_at: new Date().toISOString() }));
    const quedan = new Set(nuevas.map((n) => n.tamano));
    const prefijo = String(productoId) + "|";
    const viejas = [];
    costosMap.forEach((v, k) => { if (k.indexOf(prefijo) === 0) viejas.push(k.slice(prefijo.length)); });
    if (nuevas.length) {
      const { error } = await stratoSb.from("producto_costos").upsert(nuevas, { onConflict: "producto_id,tamano" });
      if (error) return { error: error };
    }
    for (const t of viejas) {
      if (quedan.has(t)) continue;
      const { error } = await stratoSb.from("producto_costos").delete().eq("producto_id", productoId).eq("tamano", t);
      if (error) return { error: error };
    }
    await loadCostos();
    return { error: null };
  }

  function renderProdEscalones() {
    document.getElementById("prod-escalones-rows").innerHTML = prodEscalones
      .map(
        (t, i) =>
          '<div class="row-edit" style="grid-template-columns:1fr 1fr 36px;"><input type="number" min="2" step="1" placeholder="Desde (unidades)" value="' +
          escHtml(t.desde) + '" oninput="stratoAdminEscalonSet(' + i + ",'desde',this.value)\"><input type=\"number\" min=\"0.5\" max=\"99\" step=\"0.5\" placeholder=\"Descuento %\" value=\"" +
          escHtml(t.descuento_pct) + '" oninput="stratoAdminEscalonSet(' + i + ",'descuento_pct',this.value)\"><button type=\"button\" class=\"row-del\" onclick=\"stratoAdminEscalonDel(" +
          i + ')" aria-label="Quitar">✕</button></div>'
      )
      .join("");
  }
  window.stratoAdminEscalonSet = function (i, key, value) {
    if (prodEscalones[i]) prodEscalones[i][key] = value;
  };
  window.stratoAdminEscalonDel = function (i) {
    prodEscalones.splice(i, 1);
    renderProdEscalones();
  };
  document.getElementById("prod-add-escalon").addEventListener("click", () => {
    prodEscalones.push({ desde: "", descuento_pct: "" });
    renderProdEscalones();
  });

  /* Muestra/oculta los bloques de "vender por cantidad" según las casillas. */
  function syncCantidadUI() {
    const porCantidad = document.getElementById("prod-por-cantidad").checked;
    document.getElementById("prod-cantidad-extra").style.display = porCantidad ? "block" : "none";
    const propios = document.getElementById("prod-escalones-propios").checked;
    document.getElementById("prod-escalones-propios-box").style.display = porCantidad && propios ? "block" : "none";
    if (porCantidad && propios && !prodEscalones.length) {
      prodEscalones.push({ desde: "", descuento_pct: "" });
      renderProdEscalones();
    }
  }
  document.getElementById("prod-por-cantidad").addEventListener("change", syncCantidadUI);
  document.getElementById("prod-escalones-propios").addEventListener("change", syncCantidadUI);

  /* ============ DESCUENTOS POR CANTIDAD (tabla global) ============ */
  async function loadEscalones() {
    const errEl = document.getElementById("escalones-load-error");
    const { data, error } = await stratoSb.from("escalones_cantidad").select("*").order("desde", { ascending: true });
    if (error) {
      v7TablasOk = false;
      escalonesCache = [];
      errEl.textContent = "No se pudo cargar la tabla de descuentos (¿corriste la migración SQL v7 en Supabase?): " + error.message;
    } else {
      escalonesCache = data || [];
      errEl.textContent = "";
    }
  }

  document.getElementById("escalones-toggle").addEventListener("click", () => {
    document.getElementById("escalones-toggle").classList.toggle("open");
    document.getElementById("escalones-body").classList.toggle("open");
  });

  function renderEscalones() {
    document.getElementById("escalones-empty").style.display = escalonesCache.length ? "none" : "block";
    document.getElementById("escalones-tbody").innerHTML = escalonesCache
      .map(
        (t) =>
          "<tr><td>" + Number(t.desde) + " unidades o más</td><td>" + Number(t.descuento_pct) + "%</td><td>" +
          "<button type='button' class='btn-secondary btn-small' onclick=\"stratoAdminEditarEscalon('" + t.id +
          "')\">Editar</button> <button type='button' class='btn-danger btn-small' onclick=\"stratoAdminEliminarEscalon('" +
          t.id + "')\">Eliminar</button></td></tr>"
      )
      .join("");
  }

  function resetEscalonForm() {
    editingEscalonId = null;
    document.getElementById("form-escalon").reset();
    document.getElementById("esc-submit-btn").textContent = "Guardar escalón";
    document.getElementById("esc-cancel-btn").style.display = "none";
    document.getElementById("escalon-error").textContent = "";
  }
  document.getElementById("esc-cancel-btn").addEventListener("click", resetEscalonForm);

  window.stratoAdminEditarEscalon = function (id) {
    const t = escalonesCache.find((x) => x.id === id);
    if (!t) return;
    editingEscalonId = id;
    document.getElementById("esc-desde").value = t.desde;
    document.getElementById("esc-pct").value = t.descuento_pct;
    document.getElementById("esc-submit-btn").textContent = "Guardar cambios";
    document.getElementById("esc-cancel-btn").style.display = "inline-block";
    document.getElementById("escalon-error").textContent = "";
  };

  window.stratoAdminEliminarEscalon = async function (id) {
    if (!confirm("¿Eliminar este escalón de descuento?")) return;
    const { error } = await stratoSb.from("escalones_cantidad").delete().eq("id", id);
    if (error) { alert("No se pudo eliminar: " + error.message); return; }
    if (editingEscalonId === id) resetEscalonForm();
    await loadEscalones();
    renderEscalones();
  };

  document.getElementById("form-escalon").addEventListener("submit", async (e) => {
    e.preventDefault();
    const errEl = document.getElementById("escalon-error");
    errEl.textContent = "";
    const desde = Number(document.getElementById("esc-desde").value);
    const pct = Number(document.getElementById("esc-pct").value);
    if (!Number.isInteger(desde) || desde < 2) { errEl.textContent = "La cantidad tiene que ser un número entero desde 2."; return; }
    if (!(pct > 0 && pct < 100)) { errEl.textContent = "El descuento tiene que estar entre 0 y 100%."; return; }
    if (!requireSb()) return;

    const payload = { desde: desde, descuento_pct: pct };
    let error;
    if (editingEscalonId) {
      ({ error } = await stratoSb.from("escalones_cantidad").update(payload).eq("id", editingEscalonId));
    } else {
      ({ error } = await stratoSb.from("escalones_cantidad").insert([payload]));
    }
    if (error) {
      errEl.textContent = error.code === "23505" || /duplicate|unique/i.test(error.message)
        ? "Ya hay un escalón desde " + desde + " unidades. Editalo en la lista."
        : error.message;
      return;
    }
    await loadEscalones();
    renderEscalones();
    resetEscalonForm();
  });

  /* ============ GASTOS ============ */
  /* La lista sale de `gastosAll` (todos los gastos, los mismos que usa el dashboard) filtrada por fecha acá mismo.
     En pesos, `monto` es lo que pagaste. En dólares o reales, `monto` es el equivalente en pesos (lo que usa todo el
     dashboard) y se guardan además `monto_original` y `tipo_cambio`, para poder editarlo después. */
  const ffGastos = crearFiltroFecha(document.getElementById("gastos-fecha"), "gastos", () => renderGastos());
  const elGastosMsg = document.getElementById("gastos-msg");
  const elGastoMoneda = document.getElementById("gasto-moneda");
  const elGastoMonto = document.getElementById("gasto-monto");
  const elGastoTc = document.getElementById("gasto-tc");
  const elGastoCat = document.getElementById("gasto-categoria");
  let gastoGuardando = false;
  let gastosMsgTimer = null;
  let gastosMsgTipo = "";

  function mostrarMsgGastos(tipo, texto, accion) {
    elGastosMsg.className = "inline-msg " + tipo;
    elGastosMsg.textContent = texto;
    if (accion) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "btn-soft";
      b.style.marginLeft = "10px";
      b.dataset.act = accion;
      b.textContent = "Reintentar";
      elGastosMsg.appendChild(b);
    }
    elGastosMsg.hidden = false;
    gastosMsgTipo = tipo;
    clearTimeout(gastosMsgTimer);
    if (tipo === "ok") gastosMsgTimer = setTimeout(ocultarMsgGastos, 8000);
  }
  function ocultarMsgGastos() {
    clearTimeout(gastosMsgTimer);
    elGastosMsg.hidden = true;
    elGastosMsg.textContent = "";
    gastosMsgTipo = "";
  }
  elGastosMsg.addEventListener("click", (e) => {
    if (e.target.closest("[data-act='reintentar']")) refreshDatos({ manual: true });
  });

  const gastosVisibles = () => gastosAll.filter((g) => ffGastos.dentro(g._f));

  function montoGastoHtml(g) {
    const m = monedaDe(g.moneda);
    const orig = Number(g.monto_original), tcg = Number(g.tipo_cambio);
    let sub = "";
    if (m !== "UYU" && Number.isFinite(orig) && orig > 0) {
      sub = '<span class="orig-mon">' + escHtml(fmtMon(m, orig)) + (Number.isFinite(tcg) && tcg > 0 ? " × " + escHtml(fmtNum(tcg, 4)) : "") + "</span>";
    }
    return escHtml(fmtMoney(num(g.monto))) + sub;
  }

  function renderGastos() {
    const tbody = document.getElementById("gastos-tbody");
    const tfoot = document.getElementById("gastos-tfoot");
    if (gastosEstado.intento && !gastosEstado.ok) {
      mostrarMsgGastos("err", "No se pudieron cargar los gastos (" + gastosEstado.error + "). Lo que ves puede estar desactualizado.", "reintentar");
    } else if (gastosMsgTipo === "err") {
      ocultarMsgGastos();
    }
    const lista = gastosVisibles();
    const vacio = document.getElementById("gastos-empty");
    vacio.style.display = lista.length ? "none" : "block";
    vacio.textContent = gastosAll.length ? "No hay gastos en este período." : "Todavía no registraste gastos.";
    document.getElementById("gastos-count").textContent = gastosEstado.hayDatos
      ? "Mostrando " + lista.length + " de " + gastosAll.length + (gastosAll.length === 1 ? " gasto" : " gastos") + (gastosEstado.truncado ? " · hay más gastos viejos que no se cargaron" : "")
      : "";

    tbody.innerHTML = lista
      .map((g) => {
        const id = escAttr(g.id);
        const inv = esInversion(g);
        return (
          '<tr><td data-label="Fecha">' + (g._f ? fmtDMY(g._f) : "—") + '</td><td data-label="Concepto">' + escHtml(g.concepto) +
          '</td><td data-label="Categoría">' + (inv ? '<span class="tag-inv">Inversión inicial</span>' : escHtml(g.categoria || "—")) +
          '</td><td class="m" data-label="Monto">' + montoGastoHtml(g) + '</td><td data-label="Nota">' + escHtml(g.nota || "—") +
          '</td><td class="act"><div class="row-acts"><button type="button" class="btn-secondary btn-small" data-act="editar-gasto" data-id="' + id +
          '" aria-label="Editar el gasto ' + escAttr(g.concepto) + '">Editar</button><button type="button" class="btn-danger btn-small" data-act="eliminar-gasto" data-id="' + id +
          '" aria-label="Eliminar el gasto ' + escAttr(g.concepto) + '">Eliminar</button></div></td></tr>'
        );
      })
      .join("");

    const normales = lista.filter((g) => !esInversion(g));
    const invers = lista.filter(esInversion);
    const total = suma(normales, (g) => g.monto);
    let pie = '<tr><td colspan="3"><span>Total de gastos' + (normales.length ? " (" + normales.length + ")" : "") + '</span></td><td class="m">' + escHtml(fmtMoney(total)) + "</td><td colspan='2'></td></tr>";
    if (invers.length) {
      pie += '<tr><td colspan="3"><span>Inversión inicial (' + invers.length + ') <span class="muted" style="font-weight:400">· aparte, no cuenta en caja ni ganancia</span></span></td><td class="m">' +
        escHtml(fmtMoney(suma(invers, (g) => g.monto))) + "</td><td colspan='2'></td></tr>";
    }
    tfoot.innerHTML = lista.length ? pie : "";
  }

  /* ---- Formulario ---- */
  function actualizarEquivGasto() {
    const m = monedaDe(elGastoMoneda.value);
    const eq = document.getElementById("gasto-equiv");
    if (m === "UYU") { eq.hidden = true; eq.textContent = ""; return; }
    const v = Number(elGastoMonto.value), r = Number(elGastoTc.value);
    if (elGastoMonto.value !== "" && elGastoTc.value !== "" && Number.isFinite(v) && Number.isFinite(r) && v > 0 && r > 0) {
      eq.textContent = fmtMon(m, v) + " × " + fmtNum(r, 4) + " = " + fmtMoney(redondear2(v * r)) + " (es lo que cuenta en caja y ganancia)";
      eq.hidden = false;
    } else {
      eq.hidden = true;
      eq.textContent = "";
    }
  }
  // Cambia la moneda: rótulos, tipo de cambio sugerido (el guardado) y el equivalente en pesos.
  function formMonedaGasto(cargarTc) {
    const m = monedaDe(elGastoMoneda.value);
    const ext = m !== "UYU";
    document.getElementById("gasto-monto-lbl").textContent = "Monto (" + MONEDAS[m].sim + ")";
    document.getElementById("gasto-tc-wrap").hidden = !ext;
    elGastoTc.required = ext;
    if (ext) {
      document.getElementById("gasto-tc-lbl").textContent = "Tipo de cambio ($U por " + MONEDAS[m].sim + " 1)";
      if (cargarTc) elGastoTc.value = tc[m] ? String(tc[m]) : "";
    } else if (cargarTc) {
      elGastoTc.value = "";
    }
    actualizarEquivGasto();
  }
  function hintCategoriaGasto() {
    document.getElementById("gasto-cat-hint").hidden = normCat(elGastoCat.value) !== CAT_INVERSION;
  }
  elGastoMoneda.addEventListener("change", () => formMonedaGasto(true));
  elGastoMonto.addEventListener("input", actualizarEquivGasto);
  elGastoTc.addEventListener("input", actualizarEquivGasto);
  elGastoCat.addEventListener("change", hintCategoriaGasto);

  function resetGastoForm() {
    gastoEditId = null;
    document.getElementById("form-gasto").reset();
    elGastoCat.querySelectorAll("option[data-temp]").forEach((o) => o.remove());
    document.getElementById("gasto-fecha").value = todayStr();
    document.getElementById("gasto-form-title").textContent = "Registrar gasto";
    document.getElementById("gasto-submit").textContent = "Registrar gasto";
    document.getElementById("gasto-cancelar").hidden = true;
    document.getElementById("gasto-edit-banner").hidden = true;
    document.getElementById("gasto-error").textContent = "";
    formMonedaGasto(true);
    hintCategoriaGasto();
  }
  document.getElementById("gasto-cancelar").addEventListener("click", resetGastoForm);

  function editarGasto(id) {
    const g = gastosAll.find((x) => String(x.id) === String(id));
    if (!g) return;
    resetGastoForm();
    gastoEditId = g.id;
    const m = monedaDe(g.moneda);
    document.getElementById("gasto-concepto").value = g.concepto || "";
    document.getElementById("gasto-fecha").value = g._f || todayStr();
    elGastoMoneda.value = m;
    const orig = Number(g.monto_original), tcg = Number(g.tipo_cambio);
    if (m !== "UYU" && Number.isFinite(orig) && orig > 0) {
      elGastoMonto.value = String(orig);
      elGastoTc.value = Number.isFinite(tcg) && tcg > 0 ? String(tcg) : "";
    } else {
      // gasto en pesos (o en otra moneda sin datos originales): se edita el monto en pesos
      elGastoMoneda.value = "UYU";
      elGastoMonto.value = String(num(g.monto));
      elGastoTc.value = "";
    }
    // categoría: se busca sin importar mayúsculas ni tildes; si no está en la lista, se agrega tal cual
    const buscada = normCat(g.categoria);
    let opt = Array.from(elGastoCat.options).find((o) => normCat(o.value) === buscada);
    if (!opt) {
      opt = document.createElement("option");
      opt.value = g.categoria || "Otro";
      opt.textContent = g.categoria || "Otro";
      opt.dataset.temp = "1";
      elGastoCat.appendChild(opt);
    }
    elGastoCat.value = opt.value;
    document.getElementById("gasto-nota").value = g.nota || "";
    formMonedaGasto(false);
    hintCategoriaGasto();
    document.getElementById("gasto-form-title").textContent = "Editar gasto";
    document.getElementById("gasto-submit").textContent = "Guardar cambios";
    document.getElementById("gasto-cancelar").hidden = false;
    const ban = document.getElementById("gasto-edit-banner");
    ban.textContent = "Estás editando el gasto «" + (g.concepto || "") + "» del " + (g._f ? fmtDMY(g._f) : "—") + ". Los cambios reemplazan lo guardado.";
    ban.hidden = false;
    document.getElementById("gasto-concepto").focus({ preventScroll: true });
    document.getElementById("form-gasto").scrollIntoView({ behavior: "auto", block: "start" });
  }

  async function eliminarGasto(id) {
    const g = gastosAll.find((x) => String(x.id) === String(id));
    if (!confirm("¿Eliminar este gasto" + (g ? " («" + g.concepto + "», " + fmtMoney(num(g.monto)) + ")" : "") + "? No se puede deshacer.")) return;
    let res;
    try {
      res = await stratoSb.from("gastos").delete().eq("id", id).select("id");
    } catch (e) {
      mostrarMsgGastos("err", "No se pudo eliminar el gasto (" + (e && e.message ? e.message : "error de conexión") + ").");
      return;
    }
    if (res.error) { mostrarMsgGastos("err", "No se pudo eliminar el gasto (" + res.error.message + ")."); return; }
    if (Array.isArray(res.data) && res.data.length === 0) { mostrarMsgGastos("err", "El gasto no se eliminó (no se encontró o falta permiso)."); return; }
    gastosAll = gastosAll.filter((x) => String(x.id) !== String(id));
    if (gastoEditId !== null && String(gastoEditId) === String(id)) resetGastoForm();
    renderGastos();
    renderDashboard();
    mostrarMsgGastos("ok", "Gasto eliminado" + (g ? ": " + g.concepto + " · " + fmtMoney(num(g.monto)) : "") + ".");
  }
  window.stratoAdminEliminarGasto = eliminarGasto; // compatibilidad con la versión anterior

  document.getElementById("gastos-tbody").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-act]");
    if (!b) return;
    if (b.dataset.act === "editar-gasto") editarGasto(b.dataset.id);
    else if (b.dataset.act === "eliminar-gasto") eliminarGasto(b.dataset.id);
  });

  document.getElementById("form-gasto").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (gastoGuardando) return;
    const errEl = document.getElementById("gasto-error");
    errEl.textContent = "";
    const falla = (texto, campo) => { errEl.textContent = texto; if (campo) campo.focus(); };

    const concepto = limpiarTexto(document.getElementById("gasto-concepto").value, 120);
    const moneda = monedaDe(elGastoMoneda.value);
    const ingresado = Number(elGastoMonto.value);
    const fecha = document.getElementById("gasto-fecha").value || todayStr();
    if (!concepto) return falla("Falta el concepto.", document.getElementById("gasto-concepto"));
    if (elGastoMonto.value === "" || !Number.isFinite(ingresado) || ingresado <= 0 || ingresado > 1e9) return falla("Falta el monto (tiene que ser mayor a 0).", elGastoMonto);
    if (!FF_RE.test(fecha)) return falla("Falta la fecha.", document.getElementById("gasto-fecha"));

    const previo = gastoEditId !== null ? gastosAll.find((x) => String(x.id) === String(gastoEditId)) : null;
    const payload = {
      concepto: concepto,
      categoria: elGastoCat.value,
      fecha: fecha,
      nota: limpiarTexto(document.getElementById("gasto-nota").value, 300),
    };
    if (moneda === "UYU") {
      payload.monto = redondear2(ingresado);
      // si el gasto estaba en otra moneda y ahora pasa a pesos, se limpian los datos de la otra moneda
      if (previo && monedaDe(previo.moneda) !== "UYU") { payload.moneda = "UYU"; payload.monto_original = null; payload.tipo_cambio = null; }
    } else {
      const r = Number(elGastoTc.value);
      if (elGastoTc.value === "" || !Number.isFinite(r) || r <= 0 || r > 100000) return falla("Falta el tipo de cambio (cuántos $U vale " + MONEDAS[moneda].sim + " 1).", elGastoTc);
      payload.monto = redondear2(ingresado * r);
      if (!(payload.monto > 0)) return falla("Con ese tipo de cambio el monto en pesos da 0. Revisá los números.", elGastoMonto);
      payload.moneda = moneda;
      payload.monto_original = redondear2(ingresado);
      payload.tipo_cambio = r;
    }
    if (payload.monto > 1e9) return falla("El monto es demasiado grande.", elGastoMonto);

    const btn = document.getElementById("gasto-submit");
    const textoBtn = btn.textContent;
    gastoGuardando = true;
    btn.disabled = true;
    btn.textContent = "Guardando…";
    let error = null, sinFilas = false;
    try {
      if (gastoEditId !== null) {
        const res = await stratoSb.from("gastos").update(payload).eq("id", gastoEditId).select("id");
        error = res.error;
        if (!error && Array.isArray(res.data) && res.data.length === 0) sinFilas = true;
      } else {
        ({ error } = await stratoSb.from("gastos").insert([payload]));
      }
    } catch (err) {
      error = { message: err && err.message ? err.message : "error de conexión" };
    }
    gastoGuardando = false;
    btn.disabled = false;
    btn.textContent = textoBtn;
    if (error) {
      const txt = String(error.message || "") + " " + String(error.code || "");
      if (/moneda|monto_original|tipo_cambio|PGRST204/i.test(txt)) {
        errEl.textContent = "Todavía falta correr supabase/migracion_monedas_inversion.sql en Supabase (agrega las monedas). Corrélo y volvé a guardar: lo que cargaste sigue acá.";
      } else {
        errEl.textContent = "No se pudo guardar el gasto: " + (error.message || "error desconocido") + ". Lo que cargaste sigue acá.";
      }
      return;
    }
    if (sinFilas) { errEl.textContent = "El cambio no se guardó (no se encontró el gasto o falta permiso)."; return; }

    const editando = gastoEditId !== null;
    resetGastoForm();
    await loadGastosTodos().catch(() => false);
    renderGastos();
    renderDashboard();
    const fuera = !ffGastos.dentro(fecha);
    mostrarMsgGastos(
      "ok",
      (editando ? "Gasto actualizado: " : "Gasto guardado: ") + concepto + " · " + fmtMoney(payload.monto) +
        (moneda !== "UYU" ? " (" + fmtMon(moneda, payload.monto_original) + ")" : "") +
        (normCat(payload.categoria) === CAT_INVERSION ? " · Inversión inicial: no cuenta en caja ni ganancia" : "") + "." +
        (fuera ? " Queda fuera del período elegido, por eso no se ve en la lista." : "")
    );
  });

  /* ============ CALCULADORA DE COSTOS ============ */
  /*
   Fórmula (verificada contra una calculadora de referencia del rubro):
     horas_uso        = horas_impresion + minutos_adicionales/60
     costo_material    = suma de (gramos_i/1000) * precio_kg_i  — una fila por filamento usado
                         (peso_gr = suma de los gramos de todas las filas)
     costo_electricidad = (potencia_w * horas_uso / 1000) * costo_kwh
     desgaste_maquina  = (costo_reposicion / vida_util_horas) * horas_uso
     uso_maquina       = valor_hora_maquina * horas_uso       (el $U por hora de máquina en uso: proporcional al tiempo de impresión)
     margen_error_monto = margen_error_pct * (material + electricidad + desgaste + uso_maquina + acabados)
     costo_base        = material + electricidad + desgaste + uso_maquina + acabados + margen_error_monto
     total_a_cobrar     = costo_base * margen_ganancia + accesorio_adicional * margen_accesorio   (margen_accesorio = 1: se cobra al costo)
     costo_total        = costo_base + accesorio_adicional
     ganancia_neta      = total_a_cobrar - costo_total
   El "accesorio adicional" NO entra en costo_base ni en el margen de error:
   se suma aparte (es guita que sale del bolsillo tal cual, ej. un herraje comprado
   para esa pieza puntual). Por defecto se cobra al costo (margen_accesorio = 1);
   con un margen mayor se le suma ganancia. Cuenta como costo de la pieza.
  */
  function calcularCosto() {
    const potenciaW = numVal("calc-potencia");
    const vidaUtilHoras = Math.max(numVal("calc-vida-util"), 1);
    const costoReposicion = numVal("calc-costo-reposicion");
    const costoElectricidadKwh = numVal("calc-costo-electricidad");
    const horasImpresion = numVal("calc-horas");
    const minutosAdicionales = numVal("calc-minutos");

    // Filamentos de la pieza: cada fila aporta sus gramos al peso total y su
    // costo (gramos × precio por kg del filamento elegido, o el escrito a mano).
    const filamentos = calcFilRows.map((r) => {
      const f = filamentosCache.find((x) => x.id === r.filamento_id);
      return {
        filamento_id: f ? f.id : null,
        nombre: f ? f.color + (f.marca ? " (" + f.marca + ")" : "") : "manual",
        gramos: Number(r.gramos) || 0,
        precio_kg: Number(r.precio_kg) || 0,
      };
    });
    const pesoGr = filamentos.reduce((sum, f) => sum + f.gramos, 0);
    const costoMaterial = filamentos.reduce((sum, f) => sum + (f.gramos / 1000) * f.precio_kg, 0);
    // Precio por kg promedio ponderado: es el que se muestra y el que queda en
    // "precio_filamento_kg" del historial (compatible con cotizaciones viejas).
    const precioFilamento = pesoGr > 0 ? (costoMaterial / pesoGr) * 1000 : filamentos.length ? filamentos[0].precio_kg : 0;
    const margenErrorPct = numVal("calc-margen-error") / 100;
    const margenGanancia = numVal("calc-margen-ganancia");
    const accesorio = numVal("calc-accesorio");
    const acabados = numVal("calc-acabados");
    const rawMA = Number(document.getElementById("calc-margen-accesorio").value);
    const margenAccesorio = Number.isFinite(rawMA) && rawMA >= 1 ? rawMA : 1; // 1 = el accesorio se cobra al costo

    const horasUso = horasImpresion + minutosAdicionales / 60;
    const valorHora = Math.max(numVal("calc-valor-hora"), 0); // $U por hora de máquina en uso
    const costoElectricidad = ((potenciaW * horasUso) / 1000) * costoElectricidadKwh;
    const desgasteMaquina = (costoReposicion / vidaUtilHoras) * horasUso;
    const usoMaquina = valorHora * horasUso;
    const margenErrorMonto = margenErrorPct * (costoMaterial + costoElectricidad + desgasteMaquina + usoMaquina + acabados);
    const costoBase = costoMaterial + costoElectricidad + desgasteMaquina + usoMaquina + acabados + margenErrorMonto;
    const accesorioCobrado = accesorio * margenAccesorio;
    const costoTotal = costoBase + accesorio;
    const totalACobrar = costoBase * margenGanancia + accesorioCobrado;
    const gananciaNeta = totalACobrar - costoTotal;
    const gananciaPct = totalACobrar > 0 ? (gananciaNeta / totalACobrar) * 100 : 0;

    return {
      filamentos,
      potenciaW, vidaUtilHoras, costoReposicion, precioFilamento, costoElectricidadKwh,
      horasImpresion, minutosAdicionales, pesoGr, margenErrorPct, margenGanancia, accesorio, acabados,
      margenAccesorio, accesorioCobrado, costoTotal,
      horasUso, valorHora, usoMaquina, costoMaterial, costoElectricidad, desgasteMaquina, margenErrorMonto,
      costoBase, totalACobrar, gananciaNeta, gananciaPct,
    };
  }

  function calcLinea(label, sub, monto, prefix) {
    return (
      '<div class="calc-line"><div><div>' + label + "</div>" +
      (sub ? '<div class="sub">' + sub + "</div>" : "") +
      "</div><div>" + (prefix || "") + fmtMoney(monto) + "</div></div>"
    );
  }

  function renderResultados() {
    const r = calcularCosto();
    document.getElementById("calc-horas-uso").textContent = "(" + r.horasUso.toFixed(2) + " h de uso)";
    document.getElementById("calc-peso-total").textContent = r.pesoGr + " gr";

    let html = "";
    const detalleMaterial =
      r.filamentos.length > 1
        ? r.filamentos.map((f) => f.gramos + " gr " + escHtml(f.nombre) + " × " + fmtMoney(f.precio_kg) + "/kg").join(" + ")
        : r.pesoGr + " gr · " + fmtMoney(r.precioFilamento) + "/kg";
    html += calcLinea("Costo material", detalleMaterial, r.costoMaterial);
    html += calcLinea("Costo electricidad", r.potenciaW + " W · " + fmtMoney(r.costoElectricidadKwh) + "/kWh", r.costoElectricidad);
    html += calcLinea("Desgaste máquina", "Amortización por " + r.vidaUtilHoras + " h", r.desgasteMaquina);
    if (r.valorHora > 0) html += calcLinea("Uso de máquina", fmtMoney(r.valorHora) + "/h × " + fmtNum(r.horasUso, 2) + " h", r.usoMaquina);
    html += calcLinea("Margen de error", "+" + Math.round(r.margenErrorPct * 100) + "% sobre costos", r.margenErrorMonto, "+");
    if (r.acabados) html += calcLinea("Insumos extra / acabado", null, r.acabados, "+");
    html += '<div class="calc-line-total"><div>Costo base</div><div>' + fmtMoney(r.costoBase) + "</div></div>";
    if (r.accesorio) {
      const subAcc = r.margenAccesorio > 1
        ? "costo " + fmtMoney(r.accesorio) + " · lo cobrás a " + fmtMoney(r.accesorioCobrado) + " (margen " + r.margenAccesorio + "x)"
        : "se cobra al costo, sin ganancia";
      html += calcLinea("Accesorio adicional", subAcc, r.accesorio, "+");
      html += '<div class="calc-line-total"><div>Costo total (con accesorio)</div><div>' + fmtMoney(r.costoTotal) + "</div></div>";
    }
    html +=
      '<div class="calc-line-final"><div>Total a cobrar <span class="tag">margen ' +
      r.margenGanancia + "x</span></div><div>" + fmtMoney(r.totalACobrar) + "</div></div>";
    html +=
      '<div class="muted" style="font-size:12px;margin-top:4px;">Ganancia neta estimada: +' +
      fmtMoney(r.gananciaNeta) + " · " + r.gananciaPct.toFixed(1) + "%</div>";

    document.getElementById("calc-resultados").innerHTML = html;
    return r;
  }

  document
    .querySelectorAll(
      "#calc-potencia, #calc-vida-util, #calc-costo-reposicion, #calc-costo-electricidad, #calc-valor-hora, " +
        "#calc-horas, #calc-minutos, #calc-margen-ganancia, #calc-accesorio, #calc-margen-accesorio, #calc-acabados"
    )
    .forEach((el) => el.addEventListener("input", renderResultados));

  document.getElementById("calc-margen-error").addEventListener("input", (e) => {
    document.getElementById("calc-margen-error-label").textContent = e.target.value + "%";
    renderResultados();
  });

  /* ---- Filamentos de la pieza (una fila por filamento: elegir + gramos) ---- */
  function defaultFilRow() {
    return { filamento_id: "", gramos: 50, precio_kg: 700 };
  }

  function renderCalcFilRows() {
    const wrap = document.getElementById("calc-filamentos-rows");
    if (!calcFilRows.length) calcFilRows = [defaultFilRow()];
    const opciones =
      '<option value="">Manual (escribo el precio por kg)</option>' +
      filamentosCache
        .map(
          (f) =>
            '<option value="' + f.id + '">' + escHtml(filamentoNombre(f)) + " · " + escHtml(fmtMoney(precioKgDe(f))) + "/kg" +
            (f.disponible === false ? " · sin stock" : "") + "</option>"
        )
        .join("");
    wrap.innerHTML = calcFilRows
      .map(
        (r, i) =>
          '<div class="fil-row" data-i="' + i + '"><select data-k="filamento_id">' + opciones + "</select>" +
          '<input type="number" min="0" step="1" data-k="gramos" placeholder="gramos" value="' + escHtml(r.gramos) + '">' +
          '<input type="number" min="0" step="1" data-k="precio_kg" placeholder="$U / kg" value="' + escHtml(r.precio_kg) + '"' +
          (r.filamento_id ? " readonly" : "") + ">" +
          '<button type="button" class="row-del" data-del="' + i + '" aria-label="Quitar filamento">✕</button></div>'
      )
      .join("");
    wrap.querySelectorAll(".fil-row").forEach((rowEl) => {
      rowEl.querySelector("select").value = calcFilRows[Number(rowEl.dataset.i)].filamento_id || "";
    });
  }

  // Un solo juego de listeners en el contenedor (las filas se redibujan solas).
  (function initCalcFilRows() {
    const wrap = document.getElementById("calc-filamentos-rows");
    wrap.addEventListener("input", (e) => {
      const rowEl = e.target.closest(".fil-row");
      const key = e.target.dataset && e.target.dataset.k;
      if (!rowEl || (key !== "gramos" && key !== "precio_kg")) return;
      calcFilRows[Number(rowEl.dataset.i)][key] = e.target.value;
      renderResultados();
    });
    wrap.addEventListener("change", (e) => {
      const rowEl = e.target.closest(".fil-row");
      if (!rowEl || !e.target.matches('select[data-k="filamento_id"]')) return;
      const row = calcFilRows[Number(rowEl.dataset.i)];
      const f = filamentosCache.find((x) => x.id === e.target.value);
      row.filamento_id = f ? f.id : "";
      if (f) row.precio_kg = Math.round(precioKgDe(f) * 100) / 100;
      syncMaterialDesdeFilamentos();
      renderCalcFilRows();
      renderResultados();
    });
    wrap.addEventListener("click", (e) => {
      const del = e.target.closest("[data-del]");
      if (!del) return;
      calcFilRows.splice(Number(del.dataset.del), 1);
      renderCalcFilRows();
      syncMaterialDesdeFilamentos();
      renderResultados();
    });
    document.getElementById("calc-add-filamento").addEventListener("click", () => {
      calcFilRows.push({ filamento_id: "", gramos: 20, precio_kg: 700 });
      renderCalcFilRows();
      renderResultados();
    });
  })();

  /* El "Material" de la cotización se completa solo con el tipo de los
     filamentos elegidos (ej. "PLA" o "PLA + PETG"). Si no se eligió ninguno de
     la lista queda lo que esté seleccionado a mano. */
  function setMaterialSelect(value) {
    const sel = document.getElementById("calc-material");
    if (!Array.from(sel.options).some((o) => o.value === value)) {
      const opt = document.createElement("option");
      opt.textContent = value;
      opt.dataset.extra = "1";
      sel.appendChild(opt);
    }
    sel.value = value;
  }
  function resetMaterialSelect() {
    const sel = document.getElementById("calc-material");
    sel.querySelectorAll("option[data-extra]").forEach((o) => o.remove());
    sel.value = "PLA";
  }
  function syncMaterialDesdeFilamentos() {
    const materiales = [];
    calcFilRows.forEach((r) => {
      const f = filamentosCache.find((x) => x.id === r.filamento_id);
      if (f && f.material && !materiales.includes(f.material)) materiales.push(f.material);
    });
    if (materiales.length) setMaterialSelect(materiales.join(" + "));
  }

  /* ---- Valor hora de máquina en uso ---- */
  // El de la máquina si lo tiene (columna `valor_hora_uso`); si no, el de siempre ($U 90).
  function valorHoraDe(m) {
    if (!m || m.valor_hora_uso === null || m.valor_hora_uso === undefined || m.valor_hora_uso === "") return VALOR_HORA_DEFECTO;
    const v = Number(m.valor_hora_uso);
    return Number.isFinite(v) && v >= 0 ? v : VALOR_HORA_DEFECTO;
  }

  /* ---- Selector de máquina ---- */
  function fillMaquinaSelect() {
    const sel = document.getElementById("calc-maquina");
    const activas = maquinasCache.filter((m) => m.activa);
    sel.innerHTML =
      '<option value="">— Elegí una máquina o cargá los datos a mano —</option>' +
      activas.map((m) => '<option value="' + m.id + '">' + escHtml(m.nombre) + " (" + m.potencia_w + " W)</option>").join("");
  }

  document.getElementById("calc-maquina").addEventListener("change", (e) => {
    const m = maquinasCache.find((x) => x.id === e.target.value);
    if (m) {
      document.getElementById("calc-potencia").value = m.potencia_w;
      document.getElementById("calc-vida-util").value = m.vida_util_horas;
      document.getElementById("calc-costo-reposicion").value = m.costo_reposicion;
      document.getElementById("calc-valor-hora").value = valorHoraDe(m);
    }
    renderResultados();
  });

  /* ---- Limpiar (también cancela una edición en curso) ---- */
  document.getElementById("calc-limpiar-btn").addEventListener("click", () => {
    editingCotizacionId = null;
    document.getElementById("calc-guardar-btn").textContent = "Guardar cotización";
    document.getElementById("calc-editing-label").textContent = "";
    document.getElementById("calc-maquina").value = "";
    document.getElementById("calc-potencia").value = 200;
    document.getElementById("calc-vida-util").value = 5000;
    document.getElementById("calc-costo-reposicion").value = 0;
    document.getElementById("calc-valor-hora").value = VALOR_HORA_DEFECTO;
    document.getElementById("calc-costo-electricidad").value = 10;
    document.getElementById("calc-nombre-pieza").value = "";
    document.getElementById("calc-cliente").value = "";
    document.getElementById("calc-horas").value = 0;
    document.getElementById("calc-minutos").value = 30;
    calcFilRows = [defaultFilRow()];
    renderCalcFilRows();
    resetMaterialSelect();
    document.getElementById("calc-margen-error").value = 35;
    document.getElementById("calc-margen-error-label").textContent = "35%";
    document.getElementById("calc-margen-ganancia").value = 2;
    document.getElementById("calc-accesorio").value = 0;
    document.getElementById("calc-margen-accesorio").value = 1;
    document.getElementById("calc-acabados").value = 0;
    document.getElementById("calc-altura-capa").value = "0.20";
    document.getElementById("calc-relleno").value = 20;
    document.getElementById("calc-error").textContent = "";
    renderResultados();
  });

  /* ---- Guardar cotización ---- */
  // Guarda (o actualiza, si se está editando una) la cotización del formulario. Devuelve su id, o null si no se pudo.
  async function guardarCotizacion() {
    const errEl = document.getElementById("calc-error");
    errEl.textContent = "";
    const nombrePieza = document.getElementById("calc-nombre-pieza").value.trim();
    if (!nombrePieza) { errEl.textContent = "Poné un nombre para la pieza antes de guardar."; return null; }
    if (!requireSb()) return null;

    const r = calcularCosto();
    const maquinaSel = document.getElementById("calc-maquina");
    const maquinaNombre = maquinaSel.value ? maquinaSel.options[maquinaSel.selectedIndex].text : "Manual (sin máquina guardada)";

    const payload = {
      nombre_pieza: nombrePieza,
      cliente: document.getElementById("calc-cliente").value.trim() || null,
      maquina_nombre: maquinaNombre,
      material_nombre: document.getElementById("calc-material").value,
      inputs: {
        potencia_w: r.potenciaW,
        vida_util_horas: r.vidaUtilHoras,
        costo_reposicion: r.costoReposicion,
        valor_hora_maquina: r.valorHora,
        precio_filamento_kg: r.precioFilamento,
        filamentos: r.filamentos,
        costo_electricidad_kwh: r.costoElectricidadKwh,
        horas_impresion: r.horasImpresion,
        minutos_adicionales: r.minutosAdicionales,
        peso_gr: r.pesoGr,
        margen_error_pct: r.margenErrorPct,
        margen_ganancia: r.margenGanancia,
        costo_accesorio: r.accesorio,
        margen_accesorio: r.margenAccesorio,
        costo_acabados: r.acabados,
        altura_capa: document.getElementById("calc-altura-capa").value,
        relleno_pct: numVal("calc-relleno"),
      },
      resultados: {
        horas_uso: r.horasUso,
        costo_material: r.costoMaterial,
        costo_electricidad: r.costoElectricidad,
        desgaste_maquina: r.desgasteMaquina,
        costo_uso_maquina: r.usoMaquina,
        margen_error_monto: r.margenErrorMonto,
        costo_base: r.costoBase,
        costo_total: r.costoTotal,
        ganancia_neta: r.gananciaNeta,
        ganancia_pct: r.gananciaPct,
      },
      total_a_cobrar: r.totalACobrar,
    };

    let error, cotId = editingCotizacionId;
    if (editingCotizacionId) {
      ({ error } = await stratoSb.from("cotizaciones").update(payload).eq("id", editingCotizacionId));
    } else {
      let data;
      ({ data, error } = await stratoSb.from("cotizaciones").insert([payload]).select());
      cotId = data && data[0] ? data[0].id : null;
    }
    if (error) { errEl.textContent = error.message; return null; }
    if (!cotId) { errEl.textContent = "La cotización se guardó, pero no se pudo abrir el pedido: buscala en el historial y tocá \"Cargar como pedido\"."; }

    editingCotizacionId = null;
    document.getElementById("calc-guardar-btn").textContent = "Guardar cotización";
    document.getElementById("calc-editing-label").textContent = "";

    await loadCotizaciones();
    renderCotizaciones();
    return cotId;
  }

  document.getElementById("calc-guardar-btn").addEventListener("click", () => { guardarCotizacion(); });

  // Guardar y, de una, cargarla como pedido (con el total sugerido y el costo base ya puestos).
  document.getElementById("calc-pedido-btn").addEventListener("click", async () => {
    const btn = document.getElementById("calc-pedido-btn");
    btn.disabled = true;
    try {
      const id = await guardarCotizacion();
      if (id) abrirVentaDesdeCotizacion(id);
    } finally {
      btn.disabled = false;
    }
  });

  const ffCot = crearFiltroFecha(document.getElementById("cotizaciones-fecha"), "cotizaciones", () => renderCotizaciones());

  function renderCotizaciones() {
    const tbody = document.getElementById("cotizaciones-tbody");
    const lista = cotizacionesCache.filter((c) => ffCot.dentro(diaUY(c.created_at)));
    const vacio = document.getElementById("cotizaciones-empty");
    vacio.style.display = lista.length ? "none" : "block";
    vacio.textContent = cotizacionesCache.length ? "No hay cotizaciones en este período." : "Todavía no guardaste ninguna cotización.";
    document.getElementById("cotizaciones-count").textContent = cotizacionesCache.length
      ? "Mostrando " + lista.length + " de " + cotizacionesCache.length + (cotizacionesCache.length === 1 ? " cotización" : " cotizaciones")
      : "";
    // Cotizaciones que ya se cargaron como pedido (un pedido cancelado no cuenta)
    const cargadas = new Map();
    pedidosCache.forEach((p) => {
      if (p.estado === "cancelado") return;
      (p.items || []).forEach((it) => { if (it && it.cotizacion_id && !cargadas.has(it.cotizacion_id)) cargadas.set(it.cotizacion_id, p); });
    });
    tbody.innerHTML = lista
      .map((c) => {
        // Costo total (base + accesorio) y ganancia sobre el total: se calculan igual para las cotizaciones viejas y las nuevas.
        const ct = costoDeCotizacion(c);
        const tot = num(c.total_a_cobrar);
        const gp = ct !== null && tot > 0 ? (((tot - ct) / tot) * 100).toFixed(1) + "%" : "—";
        const costoBase = ct !== null ? fmtMoney(ct) : "—";
        const ped = cargadas.get(c.id);
        return (
          "<tr><td>" + fmtFecha(c.created_at) + "</td><td>" + escHtml(c.nombre_pieza) +
          (ped ? '<span class="cot-cargada">Cargada como pedido (' + escHtml(ped.cliente_nombre) + ", " + fmtDMY(ped._dia) + ")</span>" : "") + "</td><td>" +
          escHtml(c.cliente || "—") + "</td><td>" + escHtml(c.maquina_nombre || "—") + "</td><td>" +
          costoBase + "</td><td>" + fmtMoney(c.total_a_cobrar) + "</td><td>" + gp +
          "</td><td><button type='button' class='btn btn-small' onclick=\"stratoAdminCotizacionAPedido('" +
          c.id + "')\">Cargar como pedido</button> <button type='button' class='btn-secondary btn-small' onclick=\"stratoAdminEditarCotizacion('" +
          c.id + "')\">Editar</button> <button type='button' class='btn-danger btn-small' onclick=\"stratoAdminEliminarCotizacion('" +
          c.id + "')\">Eliminar</button></td></tr>"
        );
      })
      .join("");
  }

  window.stratoAdminCotizacionAPedido = function (id) { abrirVentaDesdeCotizacion(id); };

  window.stratoAdminEditarCotizacion = function (id) {
    const c = cotizacionesCache.find((x) => x.id === id);
    if (!c) return;
    editingCotizacionId = id;
    const inp = c.inputs || {};

    // El historial guarda el nombre de la máquina usada, no su id — intentamos
    // volver a seleccionarla en el desplegable comparando por nombre; si no
    // matchea (se borró, o era carga manual), queda en "Manual" y los valores
    // de potencia/vida útil/costo de reposición igual se cargan de `inputs`.
    const maquinaSel = document.getElementById("calc-maquina");
    const match = maquinasCache.find((m) => m.nombre + " (" + m.potencia_w + " W)" === c.maquina_nombre);
    maquinaSel.value = match ? match.id : "";

    document.getElementById("calc-potencia").value = inp.potencia_w ?? 200;
    document.getElementById("calc-vida-util").value = inp.vida_util_horas ?? 5000;
    document.getElementById("calc-costo-reposicion").value = inp.costo_reposicion ?? 0;
    // Las cotizaciones anteriores al valor hora no lo tenían: se abren en 0 para que su precio no cambie al guardarlas de nuevo.
    const sinValorHora = inp.valor_hora_maquina === undefined || inp.valor_hora_maquina === null;
    document.getElementById("calc-valor-hora").value = sinValorHora ? 0 : inp.valor_hora_maquina;
    document.getElementById("calc-costo-electricidad").value = inp.costo_electricidad_kwh ?? 10;
    document.getElementById("calc-nombre-pieza").value = c.nombre_pieza || "";
    document.getElementById("calc-cliente").value = c.cliente || "";
    document.getElementById("calc-horas").value = inp.horas_impresion ?? 0;
    document.getElementById("calc-minutos").value = inp.minutos_adicionales ?? 30;
    // Filamentos: las cotizaciones nuevas guardan el detalle fila por fila; las
    // viejas solo tienen peso total + precio por kg, que se cargan como una fila manual.
    // Se conserva el precio por kg que se usó entonces (puede haber cambiado desde).
    if (Array.isArray(inp.filamentos) && inp.filamentos.length) {
      calcFilRows = inp.filamentos.map((f) => ({
        filamento_id: f.filamento_id && filamentosCache.some((x) => x.id === f.filamento_id) ? f.filamento_id : "",
        gramos: f.gramos ?? 0,
        precio_kg: f.precio_kg ?? 700,
      }));
    } else {
      calcFilRows = [{ filamento_id: "", gramos: inp.peso_gr ?? 50, precio_kg: inp.precio_filamento_kg ?? 700 }];
    }
    renderCalcFilRows();
    setMaterialSelect(c.material_nombre || "PLA");
    const margenErrorPctVal = Math.round((inp.margen_error_pct ?? 0.35) * 100);
    document.getElementById("calc-margen-error").value = margenErrorPctVal;
    document.getElementById("calc-margen-error-label").textContent = margenErrorPctVal + "%";
    document.getElementById("calc-margen-ganancia").value = inp.margen_ganancia ?? 2;
    document.getElementById("calc-accesorio").value = inp.costo_accesorio ?? 0;
    document.getElementById("calc-margen-accesorio").value = inp.margen_accesorio ?? 1; // las cotizaciones viejas cobraban el accesorio al costo
    document.getElementById("calc-acabados").value = inp.costo_acabados ?? 0;
    document.getElementById("calc-altura-capa").value = inp.altura_capa ?? "0.20";
    document.getElementById("calc-relleno").value = inp.relleno_pct ?? 20;

    document.getElementById("calc-guardar-btn").textContent = "Guardar cambios";
    document.getElementById("calc-editing-label").textContent = "— editando cotización guardada" +
      (sinValorHora ? " (es anterior al valor hora de máquina: queda en $U 0 para no cambiar su precio; ponelo si querés sumarlo)" : "");
    document.getElementById("calc-error").textContent = "";

    renderResultados();
    document.getElementById("panel-calculadora").scrollIntoView({ behavior: "smooth" });
  };

  window.stratoAdminEliminarCotizacion = async function (id) {
    if (!confirm("¿Eliminar esta cotización del historial?")) return;
    const { error } = await stratoSb.from("cotizaciones").delete().eq("id", id);
    if (error) { alert("No se pudo eliminar: " + error.message); return; }
    cotizacionesCache = cotizacionesCache.filter((c) => c.id !== id);
    renderCotizaciones();
  };

  /* ---- Mis máquinas (CRUD) ---- */
  async function loadMaquinas() {
    const { data, error } = await stratoSb.from("maquinas_3d").select("*").order("orden", { ascending: true });
    if (!error) maquinasCache = data || [];
  }

  async function loadCotizaciones() {
    const { data, error } = await stratoSb
      .from("cotizaciones")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(200);
    if (!error) cotizacionesCache = data || [];
  }

  function renderMaquinas() {
    const tbody = document.getElementById("maquinas-tbody");
    document.getElementById("maquinas-empty").style.display = maquinasCache.length ? "none" : "block";
    tbody.innerHTML = maquinasCache
      .map(
        (m) =>
          "<tr><td>" + escHtml(m.nombre) + (m.marca ? "<br><span class='muted'>" + escHtml(m.marca) + "</span>" : "") +
          "</td><td>" + m.potencia_w + " W</td><td>" + m.vida_util_horas + " h</td><td>" + fmtMoney(m.costo_reposicion) +
          "</td><td>" + fmtMoney(valorHoraDe(m)) + "/h</td><td><button type='button' class='btn-secondary btn-small' onclick=\"stratoAdminEditarMaquina('" +
          m.id + "')\">Editar</button> <button type='button' class='btn-danger btn-small' onclick=\"stratoAdminEliminarMaquina('" +
          m.id + "')\">Eliminar</button></td></tr>"
      )
      .join("");
  }

  window.stratoAdminEditarMaquina = function (id) {
    const m = maquinasCache.find((x) => x.id === id);
    if (!m) return;
    editingMaquinaId = id;
    document.getElementById("maq-nombre").value = m.nombre;
    document.getElementById("maq-marca").value = m.marca || "";
    document.getElementById("maq-potencia").value = m.potencia_w;
    document.getElementById("maq-vida-util").value = m.vida_util_horas;
    document.getElementById("maq-costo-reposicion").value = m.costo_reposicion;
    document.getElementById("maq-valor-hora").value = valorHoraDe(m);
    document.getElementById("maquina-form-title").textContent = "Editar máquina";
    document.getElementById("maq-submit-btn").textContent = "Guardar cambios";
    document.getElementById("maq-cancel-btn").style.display = "inline-block";
    if (!document.getElementById("maquina-form-body").classList.contains("open")) {
      document.getElementById("maquina-form-toggle").click();
    }
    document.getElementById("panel-calculadora").scrollIntoView({ behavior: "smooth" });
  };

  window.stratoAdminEliminarMaquina = async function (id) {
    if (!confirm("¿Eliminar esta máquina?")) return;
    const { error } = await stratoSb.from("maquinas_3d").delete().eq("id", id);
    if (error) { alert("No se pudo eliminar: " + error.message); return; }
    await loadMaquinas();
    renderMaquinas();
    fillMaquinaSelect();
  };

  document.getElementById("maquina-form-toggle").addEventListener("click", () => {
    document.getElementById("maquina-form-toggle").classList.toggle("open");
    document.getElementById("maquina-form-body").classList.toggle("open");
  });

  document.getElementById("maq-cancel-btn").addEventListener("click", resetMaquinaForm);

  function resetMaquinaForm() {
    editingMaquinaId = null;
    document.getElementById("form-maquina").reset();
    document.getElementById("maq-potencia").value = 200;
    document.getElementById("maq-vida-util").value = 5000;
    document.getElementById("maq-costo-reposicion").value = 0;
    document.getElementById("maq-valor-hora").value = VALOR_HORA_DEFECTO;
    document.getElementById("maquina-form-title").textContent = "Nueva máquina";
    document.getElementById("maq-submit-btn").textContent = "Guardar máquina";
    document.getElementById("maq-cancel-btn").style.display = "none";
  }

  document.getElementById("form-maquina").addEventListener("submit", async (e) => {
    e.preventDefault();
    const errEl = document.getElementById("maquina-error");
    errEl.textContent = "";
    const payload = {
      nombre: document.getElementById("maq-nombre").value.trim(),
      marca: document.getElementById("maq-marca").value.trim(),
      potencia_w: numVal("maq-potencia"),
      vida_util_horas: numVal("maq-vida-util"),
      costo_reposicion: numVal("maq-costo-reposicion"),
      valor_hora_uso: numVal("maq-valor-hora"),
    };
    if (!payload.nombre) { errEl.textContent = "Falta el nombre."; return; }
    if (document.getElementById("maq-valor-hora").value === "" || payload.valor_hora_uso < 0) { errEl.textContent = "El valor hora tiene que ser un número desde 0."; return; }

    const guardar = (pl) => (editingMaquinaId
      ? stratoSb.from("maquinas_3d").update(pl).eq("id", editingMaquinaId)
      : stratoSb.from("maquinas_3d").insert([pl]));
    let { error } = await guardar(payload);
    let aviso = "";
    // La base todavía no tiene la columna del valor hora (falta el SQL): se guarda la máquina igual y se avisa.
    if (error && /valor_hora_uso/i.test(String(error.message || "") + " " + String(error.details || ""))) {
      const sin = Object.assign({}, payload);
      delete sin.valor_hora_uso;
      ({ error } = await guardar(sin));
      aviso = "La máquina se guardó, pero sin su valor hora: falta correr " + SQL_PAGO + " en Supabase. Mientras tanto la calculadora usa $U " + VALOR_HORA_DEFECTO + " por hora (lo podés cambiar en cada cotización).";
    }
    if (error) { errEl.textContent = error.message; return; }

    await loadMaquinas();
    renderMaquinas();
    fillMaquinaSelect();
    resetMaquinaForm();
    errEl.textContent = aviso;
  });

  /* ============ INIT ============ */
  // No hace falta esperar window.stratoReady acá: ese flujo carga el
  // catálogo PÚBLICO (solo productos activos) para el sitio de ventas.
  // El panel admin usa su propio cliente (stratoSb, ya inicializado de forma
  // síncrona en supabase-client.js) y trae sus propios datos completos.
  document.addEventListener("DOMContentLoaded", checkSession);
})();
