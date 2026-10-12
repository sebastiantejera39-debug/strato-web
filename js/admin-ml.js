/* ==========================================================================
   STORGE LAB — pestaña "Mercado Libre" del panel admin
   Habla con /api/ml-admin (netlify/functions/ml-admin.js). Lee la
   configuración, los productos y las publicaciones directo de Supabase con la
   sesión del admin; publicar y sincronizar lo hace siempre la función de
   Netlify (los tokens de ML nunca llegan al navegador).
   ========================================================================== */
(function () {
  "use strict";

  const API = "/api/ml-admin";
  const $ = (id) => document.getElementById(id);
  let loaded = false;
  let busy = false;
  let cfg = null;
  let productos = [];
  let pubs = [];
  let account = null;
  const openRows = new Map(); // producto_id -> "preview" | "options"
  const previews = new Map();

  function esc(s) {
    const d = document.createElement("div");
    d.textContent = s == null ? "" : String(s);
    return d.innerHTML;
  }
  function money(n) {
    return "$U " + Math.round(Number(n) || 0).toLocaleString("es-UY");
  }

  async function sessionToken() {
    const { data } = await stratoSb.auth.getSession();
    return data && data.session ? data.session.access_token : null;
  }

  async function api(action, extra) {
    const token = await sessionToken();
    if (!token) throw new Error("Tu sesión venció. Volvé a entrar al panel.");
    let res;
    try {
      res = await fetch(API, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
        body: JSON.stringify(Object.assign({ action }, extra || {})),
      });
    } catch (e) {
      throw new Error("No hay conexión con el servidor.");
    }
    let data = {};
    try { data = await res.json(); } catch (e) { /* respuesta vacía */ }
    if (res.status === 404) throw new Error("La función de Mercado Libre todavía no está publicada en Netlify (subí la carpeta netlify/ a GitHub).");
    if (!res.ok) {
      const err = new Error(data.error || "Error " + res.status);
      err.code = data.code;
      throw err;
    }
    return data;
  }

  /* ------------------------------------------------------------ precio */
  function shipFor(p) {
    const own = p && p.ml_costo_envio != null && p.ml_costo_envio !== "" ? Number(p.ml_costo_envio) : NaN;
    return Number.isFinite(own) && own >= 0 ? own : Number(cfg.costo_envio || 0);
  }
  // Costo fijo por unidad vendida de ML Uruguay en productos de menos de $U 1.000 (igual que el servidor).
  const FIXED_TIERS = [
    { from: 0, to: 500, fee: 15 },
    { from: 500, to: 750, fee: 25 },
    { from: 750, to: 1000, fee: 40 },
    { from: 1000, to: Infinity, fee: 0 },
  ];
  function fixedFee(price) {
    const t = FIXED_TIERS.find((x) => price >= x.from && price < x.to);
    return t ? t.fee : 0;
  }
  const hasCommissionCols = () => !!cfg && "incluir_comision" in cfg && "comision_pct" in cfg;
  function commissionFor(p) {
    const own = p && p.ml_comision_pct != null && p.ml_comision_pct !== "" ? Number(p.ml_comision_pct) : NaN;
    if (Number.isFinite(own) && own >= 0 && own <= 60) return own;
    const g = cfg && cfg.comision_pct != null ? Number(cfg.comision_pct) : 14;
    return Number.isFinite(g) && g >= 0 && g <= 60 ? g : 14;
  }
  // Lo que te queda con un precio dado: precio − comisión − costo fijo − envío gratis.
  function mlNet(price, p) {
    return Math.round(price - (price * commissionFor(p)) / 100 - fixedFee(price) - shipFor(p));
  }
  // Mismo cálculo que mlPrice() del servidor (netlify/lib/ml.js).
  function mlPrice(base, p) {
    if (!cfg) return null;
    const r = Number(cfg.redondear_a) > 1 ? Number(cfg.redondear_a) : 1;
    const env = shipFor(p);
    const rec = Number(cfg.recargo_pct || 0);
    if (cfg.incluir_comision !== true) {
      const raw = Math.round(Number(base) * (1 + rec / 100) + env);
      return Math.ceil(raw / r) * r;
    }
    const up = (n) => Math.ceil(Number((n / r).toFixed(6))) * r;
    const target = Number(base) * (1 + rec / 100);
    const c = commissionFor(p) / 100;
    for (const t of FIXED_TIERS) {
      let price = up((target + env + t.fee) / (1 - c));
      if (price < t.from) price = up(t.from);
      if (price < t.to) return price;
    }
    return up((target + env) / (1 - c));
  }
  function sizes(p) {
    const t = (Array.isArray(p.tamanos) ? p.tamanos : [])
      .map((x) => ({ name: String((x && x.nombre) || "").trim(), price: Number(x && x.precio) }))
      .filter((x) => x.name && !isNaN(x.price));
    if (t.length) return t;
    return [{ name: "", price: p.precio == null ? NaN : Number(p.precio) }];
  }
  function priceRange(p, fn) {
    const vals = sizes(p).map((s) => s.price).filter((n) => Number.isFinite(n) && n > 0).map(fn);
    if (!vals.length) return '<span class="muted">a cotizar</span>';
    const min = Math.min(...vals), max = Math.max(...vals);
    return min === max ? money(min) : money(min) + " – " + money(max);
  }

  /* ------------------------------------------------------------ carga */
  async function loadAll() {
    const [c, pr, pu] = await Promise.all([
      stratoSb.from("ml_config").select("*").eq("id", 1).maybeSingle(),
      stratoSb.from("productos").select("*").order("orden", { ascending: true }),
      stratoSb.from("ml_publicaciones").select("*"),
    ]);
    if (c.error || pu.error) {
      $("ml-migration-card").style.display = "block";
      cfg = null;
    } else {
      $("ml-migration-card").style.display = "none";
      cfg = c.data;
    }
    productos = pr.data || [];
    pubs = pu.data || [];
  }

  async function init() {
    if (loaded) return;
    loaded = true;
    await loadAll();
    fillConfig();
    renderTable();
    await refreshStatus();
    showReturnMessage();
  }

  /* ------------------------------------------------------------ cuenta */
  async function refreshStatus() {
    const dot = $("ml-dot"), txt = $("ml-status-text"), help = $("ml-status-help"), errEl = $("ml-status-error");
    errEl.textContent = "";
    if (!cfg) {
      txt.textContent = "Falta correr la migración de Supabase.";
      return;
    }
    try {
      account = await api("status");
    } catch (e) {
      account = null;
      dot.className = "ml-dot warn";
      txt.textContent = "No se pudo revisar la conexión.";
      errEl.textContent = e.message;
      return;
    }
    const connect = $("ml-connect-btn"), disc = $("ml-disconnect-btn");
    if (account.conectado && account.valido) {
      dot.className = "ml-dot on";
      txt.innerHTML = "Conectada como <strong>" + esc(account.nickname || "tu cuenta") + "</strong>";
      help.textContent = account.user_products
        ? "Tu cuenta usa el modelo nuevo de Mercado Libre: cada color se publica como un aviso propio y ML los agrupa en una misma ficha."
        : "Cada tamaño se publica como un aviso, con los colores como variantes.";
      connect.textContent = "Reconectar";
      disc.style.display = "";
    } else if (account.conectado) {
      dot.className = "ml-dot warn";
      txt.textContent = "La conexión venció o falló.";
      errEl.textContent = account.error || "";
      help.textContent = "Tocá Reconectar.";
      connect.textContent = "Reconectar";
      disc.style.display = "";
    } else {
      dot.className = "ml-dot";
      txt.textContent = "Sin conectar.";
      help.innerHTML = "En tu aplicación de Mercado Libre, la URI de redirect tiene que ser exactamente <strong>" + esc(account.redirect_uri) + "</strong>.";
      connect.textContent = "Conectar con Mercado Libre";
      disc.style.display = "none";
    }
  }

  async function connect() {
    const btn = $("ml-connect-btn");
    btn.disabled = true;
    try {
      const { url } = await api("auth-url");
      location.href = url;
    } catch (e) {
      $("ml-status-error").textContent = e.message;
      btn.disabled = false;
    }
  }

  async function disconnect() {
    if (!confirm("¿Desconectar la cuenta de Mercado Libre? Los avisos ya publicados siguen en ML, pero dejan de sincronizarse.")) return;
    try {
      await api("disconnect");
      await refreshStatus();
    } catch (e) {
      $("ml-status-error").textContent = e.message;
    }
  }

  function showReturnMessage() {
    const q = new URLSearchParams(location.search);
    if (!q.has("ml")) return;
    if (q.get("ml") === "ok") {
      $("ml-status-help").innerHTML = '<span class="ml-ok">¡Listo! Cuenta conectada.</span>';
    } else {
      $("ml-status-error").textContent = q.get("msg") || "No se pudo conectar.";
    }
    history.replaceState(null, "", location.pathname);
  }

  /* ------------------------------------------------------------ config */
  function fillConfig() {
    if (!cfg) return;
    const lbl = document.querySelector('label[for="ml-envio"]');
    if (lbl) lbl.textContent = "Costo del envío general ($U)";
    $("ml-recargo").value = cfg.recargo_pct;
    $("ml-envio").value = cfg.costo_envio;
    $("ml-redondeo").value = String(cfg.redondear_a);
    if (![...$("ml-redondeo").options].some((o) => o.value === String(cfg.redondear_a))) $("ml-redondeo").value = "1";
    $("ml-tipo").value = cfg.tipo_publicacion;
    $("ml-stock").value = cfg.stock_por_variante;
    $("ml-dias").value = cfg.dias_fabricacion || "";
    $("ml-garantia").value = cfg.garantia || "";
    $("ml-sync-auto").checked = cfg.sync_auto !== false;
    ensureCommissionFields();
    if (hasCommissionCols()) {
      $("ml-incluir-comision").checked = cfg.incluir_comision === true;
      $("ml-comision").value = cfg.comision_pct;
    }
    renderExample();
    $("ml-last-sync").textContent = cfg.ultima_sync_at
      ? "Última sincronización automática: " + new Date(cfg.ultima_sync_at).toLocaleString("es-UY") + " — " + (cfg.ultima_sync_resumen || "")
      : "";
  }

  function readConfigForm() {
    const n = (id, d) => { const v = Number($(id).value); return $(id).value === "" || isNaN(v) ? d : v; };
    return Object.assign(commissionPatch(), {
      recargo_pct: Math.min(100, Math.max(0, n("ml-recargo", 0))),
      costo_envio: Math.max(0, Math.round(n("ml-envio", 0))),
      redondear_a: Number($("ml-redondeo").value) || 1,
      tipo_publicacion: $("ml-tipo").value,
      stock_por_variante: Math.min(999, Math.max(1, Math.round(n("ml-stock", 10)))),
      dias_fabricacion: $("ml-dias").value === "" ? null : Math.min(45, Math.max(1, Math.round(n("ml-dias", 1)))),
      garantia: (function (g) {
        // ML pide número + unidad: "30" pasa a "30 días".
        g = g.trim().toLowerCase();
        if (/^sin\b|^no\b|^ninguna$|^0$/.test(g)) return "Sin garantía";
        if (/^\d+$/.test(g)) return g + " días";
        return /^\d+\s*(d[ií]as?|mes(es)?|a[ñn]os?)$/.test(g) ? g : "30 días";
      })($("ml-garantia").value),
      sync_auto: $("ml-sync-auto").checked,
    });
  }
  // Los campos de comisión se suman solo si ya corriste el SQL nuevo (si no, la base no los tiene).
  function commissionPatch() {
    if (!hasCommissionCols() || !$("ml-comision")) return {};
    const v = Number($("ml-comision").value);
    return {
      incluir_comision: $("ml-incluir-comision").checked,
      comision_pct: $("ml-comision").value === "" || isNaN(v) ? 14 : Math.min(60, Math.max(0, v)),
    };
  }

  function ensureCommissionFields() {
    if ($("ml-comision")) return;
    const form = $("ml-config-form");
    const anchor = $("ml-config-save");
    if (!form || !anchor) return;
    const box = document.createElement("div");
    box.id = "ml-comision-box";
    box.innerHTML =
      '<div class="grid2">' +
      '<div class="inline-check" style="margin-top:6px"><input type="checkbox" id="ml-incluir-comision"><label for="ml-incluir-comision">Incluir la comisión de Mercado Libre en el precio</label></div>' +
      '<div><label for="ml-comision">Comisión por venta de ML (%)</label><input type="number" id="ml-comision" min="0" max="60" step="0.5"></div>' +
      "</div>" +
      '<p class="muted" id="ml-comision-help" style="font-size:12px;margin:-4px 0 14px;"></p>';
    form.insertBefore(box, anchor);
    ["ml-incluir-comision", "ml-comision"].forEach((id) => $(id).addEventListener("input", () => { renderExample(); }));
    $("ml-incluir-comision").addEventListener("change", renderExample);
  }

  function renderExample() {
    if (!cfg) return;
    const draft = Object.assign({}, cfg, readConfigForm());
    const keep = cfg;
    cfg = draft;
    const base = 650;
    const fin = mlPrice(base);
    const net = mlNet(fin);
    const com = commissionFor();
    const fijo = fixedFee(fin);
    cfg = keep;
    const help = $("ml-comision-help");
    if (help) {
      help.textContent = hasCommissionCols()
        ? "Mercado Libre cobra entre 11,5 % y 17 % según la categoría (lo ves en ML: \"Conocé el cargo de tu producto\"), más un costo fijo por unidad si el precio es menor a $U 1.000 ($U 15 / 25 / 40). Con esto prendido, el precio se calcula para que esos cargos y el envío no te coman el precio de la web; el \"Recargo\" de arriba pasa a ser tu ganancia extra (puede ser 0). Cada producto puede tener su propia comisión en Opciones."
        : "Falta correr en Supabase la parte nueva de supabase/migracion_mercadolibre.sql (3 líneas al final) para poder prender esto.";
      $("ml-incluir-comision").disabled = !hasCommissionCols();
      $("ml-comision").disabled = !hasCommissionCols();
    }
    const incl = draft.incluir_comision === true;
    // La explicación de arriba (que viene en admin.html) cambia según cómo se calcule el precio.
    const form = $("ml-config-form");
    const intro = form && form.previousElementSibling;
    if (intro && intro.tagName === "P" && /precio web \+ recargo|comisión y el costo fijo/.test(intro.textContent)) {
      intro.innerHTML = 'Todos los avisos van con <strong>envío gratis</strong>. El precio en ML se calcula solo desde el precio de la web: ' +
        (incl
          ? "<em>el precio más bajo con el que, después de la comisión de ML, su costo fijo y el envío, te queda el precio web + el recargo</em>, redondeado hacia arriba."
          : "<em>precio web + recargo % + costo del envío</em>, redondeado hacia arriba (sin sumar la comisión de ML).") +
        ' Si cambiás algo acá, tocá "Sincronizar todo" para aplicarlo a lo ya publicado.';
    }
    const quedan = net >= base
      ? "te quedan <strong>" + money(net) + "</strong>"
      : '<strong class="ml-err" style="display:inline">te quedan solo ' + money(net) + "</strong> (menos que los " + money(base) + " de la web)";
    $("ml-example").innerHTML =
      "Ejemplo: un producto de <strong>" + money(base) + "</strong> en la web → " +
      (incl
        ? "se publica a <strong>" + money(fin) + "</strong> (con el recargo de " + draft.recargo_pct + "% y el envío de " + money(draft.costo_envio) + ")"
        : money(base) + " + " + draft.recargo_pct + "% + " + money(draft.costo_envio) + " de envío = <strong>" + money(fin) + "</strong>") +
      " en Mercado Libre, con envío gratis. Con una comisión de " + com + "%" + (fijo ? " + " + money(fijo) + " de costo fijo" : "") + ", " + quedan + ".";
  }

  async function saveConfig(e) {
    e.preventDefault();
    const msg = $("ml-config-msg");
    msg.textContent = "";
    const patch = Object.assign(readConfigForm(), { updated_at: new Date().toISOString() });
    const { error } = await stratoSb.from("ml_config").update(patch).eq("id", 1);
    if (error) {
      msg.className = "error-msg";
      msg.textContent = "No se pudo guardar: " + error.message;
      return;
    }
    cfg = Object.assign({}, cfg, patch);
    msg.className = "ok-msg";
    msg.textContent = "Guardado. Para aplicarlo a lo ya publicado, tocá \"Sincronizar todo ahora\".";
    renderTable();
  }

  /* ------------------------------------------------------------ tabla */
  function pubsOf(id) {
    return pubs.filter((x) => x.producto_id === id);
  }

  const ESTADOS = { active: "Activo", paused: "Pausado", closed: "Finalizado", under_review: "En revisión", inactive: "Inactivo" };

  // Mensajes rojos que dejaba la versión anterior; ya no corresponden (no son errores).
  const OLD_NOTES = [/^Ese tamaño\/color ya no está en la web/i, /^El aviso está finalizado en Mercado Libre/i];
  function isOldNote(t) {
    return OLD_NOTES.some((re) => re.test(String(t || "")));
  }

  const keyOf = (t, c) => (t || "") + "\u0000" + (c || "");

  // Qué tamaño/color tiene que estar publicado hoy (igual que planUnits en el servidor).
  function wantedKeys(p, list) {
    const porColor = list.some((x) => x.color);
    const seen = new Set();
    const colors = (Array.isArray(p.colores) ? p.colores : [])
      .map((c) => String(c == null ? "" : c).trim())
      .filter((c) => c && !seen.has(c.toLowerCase()) && seen.add(c.toLowerCase()));
    const keys = [];
    sizes(p).forEach((s) => {
      if (!Number.isFinite(s.price) || s.price <= 0) return;
      if (porColor && colors.length) colors.forEach((c) => keys.push(keyOf(s.name, c)));
      else keys.push(keyOf(s.name, ""));
    });
    return new Set(keys.slice(0, 30));
  }

  // Separa los avisos vigentes de los "retirados" (color/tamaño que ya no está en la web).
  // ¿La base ya tiene la columna "oculto" (SQL 4c)? Sin ella no se ofrece la ✕.
  const hasHideCol = () => pubs.some((x) => "oculto" in x);

  function splitPubs(p) {
    const all = pubsOf(p.id).sort((a, b) => ((a.tamano || "") + (a.color || "")).localeCompare((b.tamano || "") + (b.color || "")));
    // Los que sacaste de la lista (✕) van aparte, plegados.
    const hidden = all.filter((x) => x.oculto === true);
    const list = all.filter((x) => x.oculto !== true);
    const wanted = wantedKeys(p, list);
    if (!wanted.size) return { current: list, retired: [], hidden }; // producto sin precio: no se toca nada
    return {
      current: list.filter((x) => wanted.has(keyOf(x.tamano, x.color))),
      retired: list.filter((x) => !wanted.has(keyOf(x.tamano, x.color))),
      hidden,
    };
  }

  function pubRowHtml(x) {
    const label = [x.tamano, x.color].filter(Boolean).join(" · ");
    const est = x.estado || "active";
    const err = x.ultimo_error && !isOldNote(x.ultimo_error) ? x.ultimo_error : "";
    return (
      '<div class="ml-pub">' +
      (label ? esc(label) + " " : "") +
      '<span class="ml-badge ' + esc(est) + '">' + esc(ESTADOS[est] || est) + "</span> " +
      (x.precio != null ? money(x.precio) + " " : "") +
      (x.permalink ? '<a href="' + esc(x.permalink) + '" target="_blank" rel="noopener">ver ' + esc(x.ml_item_id) + "</a>" : esc(x.ml_item_id || "")) +
      (err ? '<div class="ml-err">' + esc(err) + "</div>" : "") +
      "</div>"
    );
  }

  function currentRowHtml(x) {
    if ((x.estado || "active") !== "closed") return pubRowHtml(x);
    // Finalizado o borrado desde Mercado Libre: no es un error, se puede publicar de nuevo.
    return (
      pubRowHtml(x).replace(/<\/div>$/, "") +
      '<div class="ml-note">Lo finalizaste o borraste en Mercado Libre; ese aviso no se puede reactivar. ' +
      'Si ese color/tamaño sigue en la web, podés publicarlo de nuevo.</div>' +
      '<button type="button" class="btn-secondary btn-small" style="margin-top:4px" data-ml="relist" data-pub="' + esc(x.id) + '">Publicar de nuevo</button>' +
      (hasHideCol()
        ? ' <button type="button" class="btn-secondary btn-small ml-x" style="margin-top:4px" data-ml="hide" data-pub="' + esc(x.id) +
          '" title="Sacar de la lista. No se vuelve a publicar solo (lo podés recuperar en \'ocultos\').">✕ Sacar</button>'
        : "") +
      "</div>"
    );
  }

  // Avisos que sacaste de la lista con la ✕: siguen guardados (para que no se vuelvan a publicar solos).
  function hiddenHtml(rows) {
    const n = rows.length;
    return (
      '<div class="ml-pub ml-retired ml-hidden"><details><summary>' + n + " oculto" + (n > 1 ? "s" : "") + "</summary>" +
      '<div class="ml-note">Estaban finalizados en Mercado Libre y los sacaste de la lista: no se vuelven a publicar solos.</div>' +
      rows.map((x) => pubRowHtml(x).replace(/<\/div>$/, "") +
        '<button type="button" class="btn-secondary btn-small" style="margin-top:2px" data-ml="unhide" data-pub="' + esc(x.id) + '">Volver a mostrar</button></div>').join("") +
      "</details></div>"
    );
  }

  function retiredHtml(rows) {
    const n = rows.length;
    const activos = rows.some((x) => (x.estado || "active") === "active");
    return (
      '<div class="ml-pub ml-retired"><details><summary>' + n + " aviso" + (n > 1 ? "s" : "") + " retirado" + (n > 1 ? "s" : "") +
      '</summary><div class="ml-note">Ese color o tamaño ya no está en la web.</div>' + rows.map(pubRowHtml).join("") + "</details>" +
      '<div class="ml-note">' + (activos ? "Se pausan en la próxima sincronización. " : "Están pausados: no se ven en Mercado Libre. ") +
      '"Limpiar" los finaliza allá y los saca de esta lista.</div>' +
      '<button type="button" class="btn-secondary btn-small" style="margin-top:4px" data-ml="clean">Limpiar</button></div>'
    );
  }

  function renderPubs(p) {
    if (!pubsOf(p.id).length) return '<span class="muted">Sin publicar</span>';
    const { current, retired, hidden } = splitPubs(p);
    const closed = current.filter((x) => (x.estado || "active") === "closed");
    const bulk = hasHideCol() && closed.length > 1
      ? '<div><button type="button" class="btn-secondary btn-small ml-x" style="margin:4px 0" data-ml="hideall" title="Sacar de la lista todos los finalizados de este producto">✕ Sacar los ' + closed.length + " finalizados</button></div>"
      : "";
    return bulk + current.map(currentRowHtml).join("") + (retired.length ? retiredHtml(retired) : "") + (hidden.length ? hiddenHtml(hidden) : "");
  }

  // Cuánto te queda por venta, comparado con el precio de la web (el peor tamaño del producto).
  function marginLine(p) {
    let worst = null;
    sizes(p).forEach((sz) => {
      if (!Number.isFinite(sz.price) || sz.price <= 0) return;
      const price = mlPrice(sz.price, p);
      const net = mlNet(price, p);
      const diff = net - sz.price;
      if (!worst || diff < worst.diff) worst = { diff, net, web: sz.price, name: sz.name };
    });
    if (!worst) return "";
    const com = commissionFor(p) + "%" + (p.ml_comision_pct != null && p.ml_comision_pct !== "" ? " propia" : "");
    const tip = "Después de la comisión de ML (" + com + " + costo fijo) y del envío gratis. Es una estimación con la comisión que cargaste.";
    return worst.diff < -0.5
      ? '<div class="ml-err" title="' + esc(tip) + '">te quedan ' + money(worst.net) + " · " + money(-worst.diff) + " menos que la web</div>"
      : '<div class="muted" style="font-size:11px" title="' + esc(tip) + '">te quedan ' + money(worst.net) + "</div>";
  }

  function renderTable() {
    const tbody = $("ml-tbody");
    const q = ($("ml-search").value || "").trim().toLowerCase();
    const list = productos.filter((p) => !q || String(p.nombre).toLowerCase().includes(q));
    $("ml-empty").style.display = list.length ? "none" : "block";
    tbody.innerHTML = list
      .map((p) => {
        const img = (p.imagenes || [])[0];
        const has = pubsOf(p.id).length > 0;
        const row =
          '<tr data-id="' + esc(p.id) + '">' +
          "<td>" + (img ? '<img class="thumb" src="' + esc(img) + '" alt="">' : '<div class="thumb"></div>') + "</td>" +
          "<td><strong>" + esc(p.nombre) + "</strong>" + (p.activo === false ? '<div class="muted" style="font-size:11px">Oculto en la web</div>' : "") + "</td>" +
          "<td>" + priceRange(p, (n) => n) + "</td>" +
          "<td>" + (cfg ? priceRange(p, (n) => mlPrice(n, p)) +
            '<div class="muted" style="font-size:11px">envío ' + money(shipFor(p)) + (p.ml_costo_envio != null ? " (propio)" : " (general)") + "</div>" + marginLine(p) : "—") + "</td>" +
          "<td>" + renderPubs(p) + "</td>" +
          '<td><div class="ml-actions">' +
          '<button type="button" class="btn-secondary btn-small" data-ml="preview">Vista previa</button>' +
          (has
            ? '<button type="button" class="btn btn-small" data-ml="sync">Sincronizar</button>'
            : '<button type="button" class="btn btn-small" data-ml="publish">Publicar</button>') +
          '<button type="button" class="btn-secondary btn-small" data-ml="options">Opciones</button>' +
          "</div></td></tr>";
        const open = openRows.get(p.id);
        const detail = open
          ? '<tr class="detalle-row"><td colspan="6">' + (open === "options" ? optionsHtml(p) : previewHtml(p.id)) + "</td></tr>"
          : "";
        return row + detail;
      })
      .join("");
  }

  /* ------------------------------------------------------------ vista previa */
  // Bloque "Comisión y margen" de la vista previa: compara lo configurado con lo que ML cobra de verdad.
  function comisionHtml(id, pv) {
    const c = pv.comision;
    if (!c) return "";
    const p = productos.find((x) => x.id === id);
    let html = "<h4>Comisión y margen</h4>";
    const objetivo = money(c.objetivo);
    if (c.real) {
      const ok = c.real.neto >= c.objetivo - 1;
      html +=
        "<p>Con el precio de <strong>" + money(c.precio_ml) + "</strong>, Mercado Libre cobra <strong>" + c.real.pct + "%</strong>" +
        (c.real.fijo ? " + " + money(c.real.fijo) + " fijos" : "") + " = " + money(c.real.total) + ", y el envío gratis te cuesta " + money(c.envio) +
        ". Te quedan <strong>" + money(c.real.neto) + "</strong>. " +
        (ok
          ? '<span class="ml-ok">Cubre el precio de la web' + (c.objetivo > 0 ? " (" + objetivo + ")" : "") + ".</span>"
          : '<span class="ml-err" style="display:inline">Es menos que ' + objetivo + " (precio web + tu recargo): perdés " + money(c.objetivo - c.real.neto) + " por venta.</span>") +
        "</p>";
      const diff = Math.abs(c.real.pct - c.configurada_pct) >= 0.5;
      if (diff) {
        html += '<p class="muted" style="font-size:12px">Tenés cargada una comisión de ' + c.configurada_pct + "% " + (c.propia ? "(propia de este producto)" : "(la general)") +
          ", pero en esta categoría ML cobra " + c.real.pct + "%.</p>";
        if (p && "ml_comision_pct" in p) {
          html += '<div class="ml-actions" style="margin-bottom:8px"><button type="button" class="btn-secondary btn-small" data-ml="usepct" data-pct="' + esc(c.real.pct) + '">Usar ' + esc(c.real.pct) + "% en este producto</button></div>";
        }
      }
    } else {
      html += '<p class="muted">No pude consultar a ML cuánto cobra en esta categoría. Con la comisión que cargaste (' + c.configurada_pct + "%) te quedan " + money(c.neto_modelo) + " (objetivo: " + objetivo + ").</p>";
    }
    if (!c.incluida) {
      html += '<p class="muted" style="font-size:12px">La comisión todavía <strong>no está incluida</strong> en el precio. Para que ML no te coma el precio de la web, prendé "Incluir la comisión de Mercado Libre en el precio" en la configuración de arriba.</p>';
    }
    return html;
  }

  // Otras categorías que sugiere ML, para cuando la elegida no es la correcta (por ejemplo una de electrónica
  // que pide "tipo de alimentación"). "Usar esta" la deja fija en el producto.
  function categoriasHtml(id, pv) {
    const alt = (pv.categoria && pv.categoria.alternativas) || [];
    const p = productos.find((x) => x.id === id);
    if (!alt.length || !p || !("ml_categoria_id" in p)) {
      return alt.length ? '<p class="muted" style="font-size:12px">Si no es la correcta, cambiala en Opciones.</p>' : '<p class="muted" style="font-size:12px">Si no es la correcta, cambiala en Opciones (Categoría).</p>';
    }
    return (
      '<p class="muted" style="font-size:12px;margin-bottom:4px">¿No es esa? Mercado Libre también sugiere estas. Tocá "Usar esta" y se vuelve a validar:</p><ul style="margin-bottom:10px">' +
      alt.map((x) =>
        "<li>" + esc(x.ruta || x.nombre) + ' <span class="muted">(' + esc(x.id) + ')</span> <button type="button" class="btn-secondary btn-small" data-ml="usecat" data-cat="' + esc(x.id) + '">Usar esta</button></li>'
      ).join("") + "</ul>"
    );
  }

  function previewHtml(id) {
    const pv = previews.get(id);
    if (!pv) return '<div class="ml-box">Armando la vista previa…</div>';
    if (pv.error) return '<div class="ml-box"><span class="ml-err">' + esc(pv.error) + "</span></div>";
    const avisos = pv.avisos_ml
      .map((a) =>
        "<li><strong>" + esc(a.titulo) + "</strong>" + (a.color ? " · " + esc(a.color) : "") + " — " + money(a.precio_ml) +
        ' <span class="muted">(web ' + money(a.precio_web) + (a.neto != null ? " · te quedan " + money(a.neto) : "") + ")</span>" +
        (a.activo ? "" : ' <span class="ml-badge paused">sin stock / oculto: no se publica</span>') +
        (a.variantes.length ? '<br><span class="muted">Variantes: ' + a.variantes.map((v) => esc(v.color) + (v.stock ? "" : " (sin stock)")).join(", ") + "</span>" : "") +
        "</li>"
      )
      .join("");
    const faltan = pv.faltan.length
      ? "<h4>Datos obligatorios que faltan</h4><ul>" +
        pv.faltan.map((f) =>
          "<li><strong>" + esc(f.nombre) + "</strong> (" + esc(f.id) + ")" + (f.pedido_por_ml ? ' <span class="muted">— lo pide ML al validar</span>' : "") +
          (f.valores.length && productoTieneAtributos(id)
            ? '<div class="ml-actions" style="margin:4px 0 2px"><span class="muted" style="font-size:12px;align-self:center">Elegí uno:</span> ' +
              f.valores.map((v) => '<button type="button" class="btn-secondary btn-small" data-ml="useattr" data-attr="' + esc(f.id) + '" data-val="' + esc(v) + '">' + esc(v) + "</button>").join(" ") + "</div>"
            : (f.valores.length ? ' <span class="muted">— por ejemplo: ' + f.valores.map(esc).join(", ") + "</span>" : "")) +
          "</li>").join("") +
        '</ul><p class="muted" style="font-size:12px">Al elegir uno se guarda en el producto (Opciones → Atributos extra: <code>' + esc(pv.faltan[0].id) + " = valor</code>) y se vuelve a validar. Si el dato no tiene opciones, cargalo ahí a mano.</p>"
      : "";
    const val = pv.validacion
      ? pv.validacion.ok
        ? '<p class="ml-ok"><strong>✓ Mercado Libre validó el aviso' + (pv.validacion.con_avisos ? ' (con avisos, mirá \"Para revisar\")' : '') + '.</strong> Se puede publicar.</p>'
        : '<p class="ml-err"><strong>Mercado Libre todavía no lo acepta:</strong> ' + esc(pv.validacion.mensaje) + "</p>" +
          (pv.validacion.detalle ? '<details style="margin:-4px 0 10px"><summary class="muted" style="cursor:pointer;font-size:12px">Ver respuesta completa de ML</summary><pre>' + esc(pv.validacion.detalle) + "</pre></details>" : "")
      : "";
    return (
      '<div class="ml-box">' + val +
      "<h4>Categoría</h4><p>" + esc(pv.categoria.ruta || pv.categoria.nombre) + ' <span class="muted">(' + esc(pv.categoria.id) +
      (pv.categoria.sugerida ? ", sugerida por ML" : "") + ")</span></p>" +
      categoriasHtml(id, pv) +
      comisionHtml(id, pv) +
      "<h4>Avisos que se crean</h4>" +
      (pv.por_color && pv.avisos_ml.length > 1
        ? '<p class="muted" style="font-size:12px;margin-bottom:6px">Mercado Libre pide un aviso por color, pero los junta en <strong>una sola publicación</strong> con selector de color: el comprador ve una ficha y elige el color ahí.</p>'
        : "") +
      "<ul>" + (avisos || "<li>Ninguno</li>") + "</ul>" +
      faltan +
      (pv.avisos.length ? "<h4>Para revisar</h4><ul>" + pv.avisos.map((a) => "<li>" + esc(a) + "</li>").join("") + "</ul>" : "") +
      "<h4>Datos que se completan solos</h4><p class=\"muted\">" + pv.atributos.map((a) => esc(a.id) + (a.value_name ? ": " + esc(a.value_name) : "")).join(" · ") + "</p>" +
      "<h4>Descripción (texto plano)</h4><pre>" + esc(pv.descripcion) + "</pre>" +
      "<p class=\"muted\" style=\"font-size:12px\">Envío gratis · " + (pv.modo === "user_products" ? "un aviso por color (modelo nuevo de ML)" : pv.por_color ? "un aviso por color" : "colores como variantes") + "</p>" +
      "</div>"
    );
  }

  async function doPreview(id) {
    if (openRows.get(id) === "preview") { openRows.delete(id); renderTable(); return; }
    openRows.set(id, "preview");
    previews.delete(id);
    renderTable();
    try {
      previews.set(id, await api("preview", { producto_id: id }));
    } catch (e) {
      previews.set(id, { error: e.message });
    }
    renderTable();
  }

  /* ------------------------------------------------------------ opciones */
  function attrsToText(a) {
    return (Array.isArray(a) ? a : []).map((x) => x.id + " = " + (x.value_name || x.value_id || "")).join("\n");
  }
  function textToAttrs(t) {
    return String(t || "")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const i = l.indexOf("=");
        if (i < 1) return null;
        const id = l.slice(0, i).trim().toUpperCase().replace(/\s+/g, "_");
        const v = l.slice(i + 1).trim();
        return id && v ? { id, value_name: v } : null;
      })
      .filter(Boolean);
  }

  function optionsHtml(p) {
    return (
      '<div class="ml-box"><form data-ml-options="' + esc(p.id) + '">' +
      '<div class="grid2"><div><label>Categoría de ML (opcional)</label><input type="text" name="cat" placeholder="Vacío = la elige Mercado Libre (ej: MLU1234)" value="' + esc(p.ml_categoria_id || "") + '"></div>' +
      '<div><label>Atributos extra (uno por línea: ID = valor)</label><textarea name="attrs" rows="3" placeholder="MATERIAL = PLA&#10;SHAPE = Redondo">' + esc(attrsToText(p.ml_atributos)) + "</textarea></div></div>" +
      '<div class="grid2"><div><label>Costo del envío gratis de este producto ($U)</label><input type="number" name="envio" min="0" step="1" placeholder="Vacío = el general (' + esc(money(cfg ? cfg.costo_envio : 0)) + ')" value="' + esc(p.ml_costo_envio != null ? p.ml_costo_envio : "") + '"></div>' +
      '<div class="muted" style="font-size:12px;padding-top:22px">Lo ves en Mercado Libre → Publicaciones, columna Envíos ("Pagás $ …"). Se suma al precio de este producto en ML.</div></div>' +
      ("ml_comision_pct" in p
        ? '<div class="grid2"><div><label>Comisión de ML de este producto (%)</label><input type="number" name="comision" min="0" max="60" step="0.5" placeholder="Vacío = la general (' + esc(commissionFor(null)) + '%)" value="' + esc(p.ml_comision_pct != null ? p.ml_comision_pct : "") + '"></div>' +
          '<div class="muted" style="font-size:12px;padding-top:22px">Lo que cobra ML por venta en la categoría de este producto (la Vista previa te dice cuál es). Solo cuenta si "Incluir la comisión" está prendido.</div></div>'
        : "") +
      '<label>Descripción para Mercado Libre (opcional)</label>' +
      '<textarea name="desc" rows="6" placeholder="Vacío = se usa la descripción de la web, pasada a texto plano. Sin links, teléfonos ni redes: ML no los permite.">' + esc(p.descripcion_ml || "") + "</textarea>" +
      '<div class="ml-actions"><button type="submit" class="btn btn-small">Guardar opciones</button>' +
      '<button type="button" class="btn-secondary btn-small" data-ml="options">Cerrar</button></div>' +
      '<p class="ok-msg" data-msg style="margin:8px 0 0"></p>' +
      "</form></div>"
    );
  }

  async function saveOptions(form) {
    const id = form.getAttribute("data-ml-options");
    const msg = form.querySelector("[data-msg]");
    const cat = form.cat.value.trim().toUpperCase();
    if (cat && !/^MLU\d+$/.test(cat)) {
      msg.className = "error-msg";
      msg.textContent = "La categoría tiene que ser algo como MLU1234 (o dejala vacía).";
      return;
    }
    const envioTxt = form.envio.value.trim();
    const envio = envioTxt === "" ? null : Math.round(Number(envioTxt));
    if (envio !== null && (!Number.isFinite(envio) || envio < 0)) {
      msg.className = "error-msg";
      msg.textContent = "El costo del envío tiene que ser un número (o dejalo vacío para usar el general).";
      return;
    }
    const patch = {
      ml_costo_envio: envio,
      ml_categoria_id: cat || null,
      ml_atributos: textToAttrs(form.attrs.value),
      descripcion_ml: form.desc.value.trim() || null,
    };
    if (form.comision) {
      const txt = form.comision.value.trim();
      const com = txt === "" ? null : Number(txt);
      if (com !== null && (!Number.isFinite(com) || com < 0 || com > 60)) {
        msg.className = "error-msg";
        msg.textContent = "La comisión tiene que ser un porcentaje entre 0 y 60 (o dejala vacía para usar la general).";
        return;
      }
      patch.ml_comision_pct = com;
    }
    const { error } = await stratoSb.from("productos").update(patch).eq("id", id);
    if (error) {
      msg.className = "error-msg";
      msg.textContent = "No se pudo guardar: " + error.message;
      return;
    }
    const p = productos.find((x) => x.id === id);
    if (p) Object.assign(p, patch);
    msg.className = "ok-msg";
    renderTable();
    const m2 = document.querySelector('form[data-ml-options="' + id + '"] [data-msg]');
    if (m2) { m2.className = "ok-msg"; }
    (m2 || msg).textContent = pubsOf(id).length
      ? "Guardado. Tocá Sincronizar para mandar el precio y la descripción nuevos a ML."
      : "Guardado. Probá la vista previa.";
  }

  const productoTieneAtributos = (id) => {
    const p = productos.find((x) => x.id === id);
    return !!p && "ml_atributos" in p;
  };

  // Guarda en "Atributos extra" del producto el dato elegido en la vista previa y la vuelve a validar.
  async function useAttr(id, attrId, valueName) {
    const p = productos.find((x) => x.id === id);
    attrId = String(attrId || "").trim().toUpperCase();
    valueName = String(valueName || "").trim();
    if (!p || !/^[A-Z0-9_]+$/.test(attrId) || !valueName) return;
    const list = (Array.isArray(p.ml_atributos) ? p.ml_atributos : []).filter((x) => x && String(x.id).toUpperCase() !== attrId);
    list.push({ id: attrId, value_name: valueName });
    const { error } = await stratoSb.from("productos").update({ ml_atributos: list }).eq("id", id);
    const prog = $("ml-progress");
    if (error) {
      prog.className = "ml-progress ml-err";
      prog.textContent = "No se pudo guardar el dato: " + error.message;
      return;
    }
    p.ml_atributos = list;
    prog.className = "ml-progress ml-ok";
    prog.textContent = p.nombre + ": " + attrId + " = " + valueName + " guardado. Estoy armando la vista previa de nuevo…";
    openRows.delete(id);
    doPreview(id);
  }

  // Guarda la categoría elegida en la vista previa y la vuelve a validar.
  async function useCat(id, cat) {
    cat = String(cat || "").trim().toUpperCase();
    const p = productos.find((x) => x.id === id);
    if (!p || !/^MLU\d+$/.test(cat)) return;
    const { error } = await stratoSb.from("productos").update({ ml_categoria_id: cat }).eq("id", id);
    const prog = $("ml-progress");
    if (error) {
      prog.className = "ml-progress ml-err";
      prog.textContent = "No se pudo guardar la categoría: " + error.message;
      return;
    }
    p.ml_categoria_id = cat;
    prog.className = "ml-progress ml-ok";
    prog.textContent = p.nombre + ": categoría " + cat + " guardada. Estoy armando la vista previa de nuevo…";
    openRows.delete(id);
    doPreview(id);
  }

  // Guarda en el producto la comisión real que cobra ML (la que mostró la vista previa).
  async function usePct(id, pct) {
    const v = Number(pct);
    const p = productos.find((x) => x.id === id);
    if (!p || !Number.isFinite(v)) return;
    const { error } = await stratoSb.from("productos").update({ ml_comision_pct: v }).eq("id", id);
    const prog = $("ml-progress");
    if (error) {
      prog.className = "ml-progress ml-err";
      prog.textContent = "No se pudo guardar la comisión: " + error.message;
      return;
    }
    p.ml_comision_pct = v;
    previews.delete(id);
    openRows.delete(id);
    prog.className = "ml-progress ml-ok";
    prog.textContent = p.nombre + ": comisión de " + v + "% guardada. " +
      (cfg && cfg.incluir_comision === true ? "Tocá Sincronizar para aplicar el precio nuevo en ML." : 'Falta prender "Incluir la comisión de Mercado Libre en el precio" en la configuración y sincronizar.');
    renderTable();
  }

  /* ------------------------------------------------------------ publicar / sincronizar */
  function summary(r) {
    const parts = [];
    if (r.creados) parts.push(r.creados + " aviso" + (r.creados > 1 ? "s" : "") + " nuevo" + (r.creados > 1 ? "s" : ""));
    if (r.actualizados) parts.push(r.actualizados + " actualizado" + (r.actualizados > 1 ? "s" : ""));
    if (r.pausados) parts.push(r.pausados + " pausado" + (r.pausados > 1 ? "s" : ""));
    if (r.vinculados) parts.push(r.vinculados + " aviso" + (r.vinculados > 1 ? "s" : "") + " de ML vinculado" + (r.vinculados > 1 ? "s" : ""));
    if (r.renombrados) parts.push("nombre nuevo en " + r.renombrados + " aviso" + (r.renombrados > 1 ? "s" : ""));
    if (r.limpiados) parts.push(r.limpiados + " borrado" + (r.limpiados > 1 ? "s" : "") + " en ML quitado" + (r.limpiados > 1 ? "s" : "") + " de la lista");
    if (!parts.length && !r.errores.length) parts.push("sin cambios");
    return parts.join(", ");
  }

  async function runProduct(id, action, force) {
    let total = { creados: 0, actualizados: 0, pausados: 0, renombrados: 0, limpiados: 0, vinculados: 0, errores: [], avisos: [] };
    for (let i = 0; i < 6; i++) {
      const r = await api(action, { producto_id: id, force: !!force });
      total.creados += r.creados || 0;
      total.actualizados += r.actualizados || 0;
      total.pausados += r.pausados || 0;
      total.renombrados += r.renombrados || 0;
      total.vinculados += r.vinculados || 0;
      total.limpiados += r.limpiados || 0;
      total.errores = total.errores.concat(r.errores || []);
      total.avisos = total.avisos.concat(r.avisos || []);
      if (!r.pendiente) break;
    }
    return total;
  }

  async function reloadPubs() {
    const { data } = await stratoSb.from("ml_publicaciones").select("*");
    pubs = data || pubs;
  }

  async function doRun(id, action, btn) {
    if (busy) return;
    const p = productos.find((x) => x.id === id);
    if (action === "publish" && !confirm("¿Publicar \"" + (p ? p.nombre : "") + "\" en Mercado Libre?")) return;
    busy = true;
    if (btn) btn.disabled = true;
    const prog = $("ml-progress");
    prog.className = "ml-progress";
    prog.textContent = (action === "publish" ? "Publicando " : "Sincronizando ") + (p ? p.nombre : "") + "…";
    try {
      const r = await runProduct(id, action, action === "sync");
      await reloadPubs();
      const extra = r.errores.length ? " · Errores: " + r.errores.join(" | ") : "";
      const notes = r.avisos.length ? " · " + Array.from(new Set(r.avisos)).join(" | ") : "";
      prog.className = "ml-progress " + (r.errores.length ? "ml-err" : "ml-ok");
      prog.textContent = (p ? p.nombre + ": " : "") + summary(r) + extra + notes;
    } catch (e) {
      prog.className = "ml-progress ml-err";
      prog.textContent = e.message;
      if (e.code === "RECONNECT" || e.code === "NOT_CONNECTED") refreshStatus();
    } finally {
      busy = false;
      renderTable();
    }
  }

  async function syncAll() {
    if (busy) return;
    const ids = Array.from(new Set(pubs.filter((x) => x.ml_item_id).map((x) => x.producto_id)));
    const prog = $("ml-progress");
    if (!ids.length) {
      prog.className = "ml-progress";
      prog.textContent = "Todavía no hay productos publicados.";
      return;
    }
    busy = true;
    $("ml-sync-all").disabled = true;
    let ok = 0;
    const errs = [];
    try {
      for (let i = 0; i < ids.length; i++) {
        const p = productos.find((x) => x.id === ids[i]);
        prog.className = "ml-progress";
        prog.textContent = "Sincronizando " + (i + 1) + " de " + ids.length + (p ? ": " + p.nombre : "") + "…";
        try {
          await api("refresh", { producto_id: ids[i] });
          const r = await runProduct(ids[i], "sync", true);
          if (r.errores.length) errs.push((p ? p.nombre : ids[i]) + ": " + r.errores.join(" | "));
          else ok++;
        } catch (e) {
          errs.push((p ? p.nombre : ids[i]) + ": " + e.message);
          if (e.code === "RECONNECT" || e.code === "NOT_CONNECTED") break;
        }
      }
      await reloadPubs();
      prog.className = "ml-progress " + (errs.length ? "ml-err" : "ml-ok");
      prog.textContent = ok + " de " + ids.length + " productos sincronizados." + (errs.length ? " Con error: " + errs.join(" · ") : "");
    } finally {
      busy = false;
      $("ml-sync-all").disabled = false;
      renderTable();
    }
  }

  // Finaliza en ML los avisos retirados (color/tamaño que ya no está en la web) y los saca de la lista.
  async function doClean(id, btn) {
    if (busy) return;
    const p = productos.find((x) => x.id === id);
    const n = p ? splitPubs(p).retired.length : 0;
    if (!n) return;
    if (!confirm(
      "¿Finalizar en Mercado Libre " + (n === 1 ? "el aviso retirado" : "los " + n + " avisos retirados") + " de \"" + p.nombre + "\"?\n\n" +
      "Ese color/tamaño ya no está en tu web. Finalizar es definitivo: un aviso finalizado no se puede reactivar (si más adelante lo querés, se publica uno nuevo)."
    )) return;
    busy = true;
    if (btn) btn.disabled = true;
    const prog = $("ml-progress");
    prog.className = "ml-progress";
    prog.textContent = "Limpiando " + p.nombre + "…";
    try {
      let quitados = 0, errs = [];
      for (let i = 0; i < 8; i++) {
        const r = await api("clean", { producto_id: id });
        quitados += r.quitados || 0;
        errs = errs.concat(r.errores || []);
        if (!r.pendiente) break;
      }
      await reloadPubs();
      prog.className = "ml-progress " + (errs.length ? "ml-err" : "ml-ok");
      prog.textContent = p.nombre + ": " + quitados + " aviso" + (quitados === 1 ? "" : "s") + " finalizado" + (quitados === 1 ? "" : "s") +
        " y quitado" + (quitados === 1 ? "" : "s") + " de la lista." + (errs.length ? " No se pudo con: " + errs.join(" | ") : "");
    } catch (e) {
      prog.className = "ml-progress ml-err";
      prog.textContent = e.message;
      if (e.code === "RECONNECT" || e.code === "NOT_CONNECTED") refreshStatus();
    } finally {
      busy = false;
      renderTable();
    }
  }

  // Un aviso finalizado en ML no se puede reactivar: se desvincula y la sincronización crea uno nuevo.
  async function relist(pubId, btn) {
    if (busy) return;
    const pub = pubs.find((x) => x.id === pubId);
    if (!pub) return;
    if (!confirm("¿Publicar de nuevo este aviso? Se crea uno nuevo en Mercado Libre (el finalizado no se puede reactivar).")) return;
    try {
      await api("unlink", { publicacion_id: pubId });
      await reloadPubs();
    } catch (e) {
      $("ml-progress").className = "ml-progress ml-err";
      $("ml-progress").textContent = e.message;
      return;
    }
    await doRun(pub.producto_id, "sync", btn);
  }

  // ✕: saca de la lista avisos finalizados (o los vuelve a mostrar). No toca nada en Mercado Libre.
  async function hideRows(ids, oculto) {
    if (busy || !ids.length) return;
    const prog = $("ml-progress");
    try {
      const r = await api("hide", { publicacion_ids: ids, oculto });
      await reloadPubs();
      renderTable();
      prog.className = "ml-progress ml-ok";
      prog.textContent = oculto
        ? (r.cambiados || 0) + " aviso" + (r.cambiados === 1 ? "" : "s") + " sacado" + (r.cambiados === 1 ? "" : "s") + ' de la lista; no se vuelven a publicar solos. Para recuperarlos: "ocultos" → "Volver a mostrar".'
        : "Se volvió a mostrar" + (ids.length > 1 ? "n " + ids.length + " avisos." : " el aviso.");
    } catch (e) {
      prog.className = "ml-progress ml-err";
      prog.textContent = e.message;
    }
  }

  // Estilos de lo nuevo (avisos retirados / finalizados), sin tocar admin.html.
  function injectStyles() {
    if (document.getElementById("ml-extra-style")) return;
    const st = document.createElement("style");
    st.id = "ml-extra-style";
    st.textContent =
      "#ml-tbody .ml-badge.closed{background:rgba(0,0,0,.07);color:#6b6b6b}" +
      "#ml-tbody .ml-note{color:#6b6b6b;font-size:12px;margin-top:2px}" +
      "#ml-tbody .ml-retired{margin-top:6px;padding:6px 8px;border:1px dashed var(--border);border-radius:3px;background:rgba(0,0,0,.02)}" +
      "#ml-tbody .ml-retired summary{cursor:pointer;color:#6b6b6b}" +
      "#ml-tbody .ml-retired .ml-badge{background:rgba(0,0,0,.07);color:#6b6b6b}" +
      "#ml-tbody .ml-x{color:#6b6b6b}";
    document.head.appendChild(st);
  }

  /* ------------------------------------------------------------ eventos */
  function bind() {
    injectStyles();
    $("ml-connect-btn").addEventListener("click", connect);
    $("ml-disconnect-btn").addEventListener("click", disconnect);
    $("ml-config-form").addEventListener("submit", saveConfig);
    ["ml-recargo", "ml-envio", "ml-redondeo"].forEach((id) => $(id).addEventListener("input", renderExample));
    $("ml-search").addEventListener("input", renderTable);
    $("ml-sync-all").addEventListener("click", syncAll);
    $("ml-tbody").addEventListener("click", (e) => {
      const btn = e.target.closest("[data-ml]");
      if (!btn) return;
      const action = btn.getAttribute("data-ml");
      if (action === "relist") return relist(btn.getAttribute("data-pub"), btn);
      if (action === "hide") return hideRows([btn.getAttribute("data-pub")], true);
      if (action === "unhide") return hideRows([btn.getAttribute("data-pub")], false);
      if (action === "hideall") {
        const tr0 = btn.closest("tr[data-id]");
        const pid = tr0 && tr0.getAttribute("data-id");
        const prod = productos.find((x) => x.id === pid);
        const ids = prod ? splitPubs(prod).current.filter((x) => (x.estado || "active") === "closed").map((x) => x.id) : [];
        return hideRows(ids, true);
      }
      if (action === "useattr") {
        const row = btn.closest("tr").previousElementSibling;
        return useAttr(row && row.getAttribute("data-id"), btn.getAttribute("data-attr"), btn.getAttribute("data-val"));
      }
      if (action === "usecat") {
        const row = btn.closest("tr").previousElementSibling;
        return useCat(row && row.getAttribute("data-id"), btn.getAttribute("data-cat"));
      }
      if (action === "usepct") {
        const row = btn.closest("tr").previousElementSibling;
        return usePct(row && row.getAttribute("data-id"), btn.getAttribute("data-pct"));
      }
      const tr = btn.closest("tr[data-id]") || btn.closest("tr").previousElementSibling;
      const id = tr && tr.getAttribute("data-id");
      if (!id) return;
      if (action === "preview") doPreview(id);
      else if (action === "options") {
        if (openRows.get(id) === "options") openRows.delete(id);
        else openRows.set(id, "options");
        renderTable();
      } else if (action === "clean") doClean(id, btn);
      else if (action === "publish" || action === "sync") doRun(id, action, btn);
    });
    $("ml-tbody").addEventListener("submit", (e) => {
      const form = e.target.closest("form[data-ml-options]");
      if (!form) return;
      e.preventDefault();
      saveOptions(form);
    });

    const tab = document.querySelector('nav.tabs button[data-panel="panel-mercadolibre"]');
    tab.addEventListener("click", () => init().catch((e) => { loaded = false; $("ml-status-error").textContent = e.message; }));

    // Vuelta desde Mercado Libre (?ml=ok / ?ml=error): abrir la pestaña apenas haya sesión.
    if (new URLSearchParams(location.search).has("ml")) {
      const wait = setInterval(() => {
        if ($("app") && $("app").style.display === "block") {
          clearInterval(wait);
          tab.click();
        }
      }, 300);
      setTimeout(() => clearInterval(wait), 60000);
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", bind);
  else bind();
})();
