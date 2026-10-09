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
  function mlPrice(base, p) {
    if (!cfg) return null;
    const raw = Math.round(Number(base) * (1 + Number(cfg.recargo_pct || 0) / 100) + shipFor(p));
    const r = Number(cfg.redondear_a) > 1 ? Number(cfg.redondear_a) : 1;
    return Math.ceil(raw / r) * r;
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
    renderExample();
    $("ml-last-sync").textContent = cfg.ultima_sync_at
      ? "Última sincronización automática: " + new Date(cfg.ultima_sync_at).toLocaleString("es-UY") + " — " + (cfg.ultima_sync_resumen || "")
      : "";
  }

  function readConfigForm() {
    const n = (id, d) => { const v = Number($(id).value); return $(id).value === "" || isNaN(v) ? d : v; };
    return {
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
    };
  }

  function renderExample() {
    if (!cfg) return;
    const draft = Object.assign({}, cfg, readConfigForm());
    const keep = cfg;
    cfg = draft;
    const base = 650;
    const fin = mlPrice(base);
    cfg = keep;
    $("ml-example").innerHTML =
      "Ejemplo: un producto de <strong>" + money(base) + "</strong> en la web → " + money(base) +
      " + " + draft.recargo_pct + "% + " + money(draft.costo_envio) + " de envío = <strong>" + money(fin) + "</strong> en Mercado Libre, con envío gratis.";
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

  function renderPubs(p) {
    const list = pubsOf(p.id);
    if (!list.length) return '<span class="muted">Sin publicar</span>';
    return list
      .sort((a, b) => (a.tamano + a.color).localeCompare(b.tamano + b.color))
      .map((x) => {
        const label = [x.tamano, x.color].filter(Boolean).join(" · ");
        const est = x.estado || "active";
        return (
          '<div class="ml-pub">' +
          (label ? esc(label) + " " : "") +
          '<span class="ml-badge ' + esc(est) + '">' + esc(ESTADOS[est] || est) + "</span> " +
          (x.precio != null ? money(x.precio) + " " : "") +
          (x.permalink ? '<a href="' + esc(x.permalink) + '" target="_blank" rel="noopener">ver ' + esc(x.ml_item_id) + "</a>" : esc(x.ml_item_id || "")) +
          (x.ultimo_error ? '<div class="ml-err">' + esc(x.ultimo_error) + "</div>" : "") +
          (est === "closed" ? ' <button type="button" class="btn-secondary btn-small" data-ml="unlink" data-pub="' + esc(x.id) + '">Desvincular</button>' : "") +
          "</div>"
        );
      })
      .join("");
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
            '<div class="muted" style="font-size:11px">envío ' + money(shipFor(p)) + (p.ml_costo_envio != null ? " (propio)" : " (general)") + "</div>" : "—") + "</td>" +
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
  function previewHtml(id) {
    const pv = previews.get(id);
    if (!pv) return '<div class="ml-box">Armando la vista previa…</div>';
    if (pv.error) return '<div class="ml-box"><span class="ml-err">' + esc(pv.error) + "</span></div>";
    const avisos = pv.avisos_ml
      .map((a) =>
        "<li><strong>" + esc(a.titulo) + "</strong>" + (a.color ? " · " + esc(a.color) : "") + " — " + money(a.precio_ml) +
        ' <span class="muted">(web ' + money(a.precio_web) + ")</span>" +
        (a.activo ? "" : ' <span class="ml-badge paused">sin stock / oculto: no se publica</span>') +
        (a.variantes.length ? '<br><span class="muted">Variantes: ' + a.variantes.map((v) => esc(v.color) + (v.stock ? "" : " (sin stock)")).join(", ") + "</span>" : "") +
        "</li>"
      )
      .join("");
    const faltan = pv.faltan.length
      ? "<h4>Datos obligatorios que faltan</h4><ul>" +
        pv.faltan.map((f) => "<li><strong>" + esc(f.nombre) + "</strong> (" + esc(f.id) + ")" + (f.valores.length ? ' <span class="muted">— por ejemplo: ' + f.valores.map(esc).join(", ") + "</span>" : "") + "</li>").join("") +
        '</ul><p class="muted" style="font-size:12px">Cargalos en "Opciones" → Atributos extra, una línea por dato: <code>' + esc(pv.faltan[0].id) + " = valor</code>.</p>"
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
      (pv.categoria.sugerida ? ", sugerida por ML — si no es la correcta, cambiala en Opciones" : "") + ")</span></p>" +
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

  /* ------------------------------------------------------------ publicar / sincronizar */
  function summary(r) {
    const parts = [];
    if (r.creados) parts.push(r.creados + " aviso" + (r.creados > 1 ? "s" : "") + " nuevo" + (r.creados > 1 ? "s" : ""));
    if (r.actualizados) parts.push(r.actualizados + " actualizado" + (r.actualizados > 1 ? "s" : ""));
    if (r.pausados) parts.push(r.pausados + " pausado" + (r.pausados > 1 ? "s" : ""));
    if (!parts.length && !r.errores.length) parts.push("sin cambios");
    return parts.join(", ");
  }

  async function runProduct(id, action, force) {
    let total = { creados: 0, actualizados: 0, pausados: 0, errores: [], avisos: [] };
    for (let i = 0; i < 6; i++) {
      const r = await api(action, { producto_id: id, force: !!force });
      total.creados += r.creados || 0;
      total.actualizados += r.actualizados || 0;
      total.pausados += r.pausados || 0;
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

  async function unlink(pubId) {
    if (!confirm("¿Desvincular este aviso? No se borra de Mercado Libre; solo deja de estar conectado con la web, y el producto se puede volver a publicar.")) return;
    try {
      await api("unlink", { publicacion_id: pubId });
      await reloadPubs();
      renderTable();
    } catch (e) {
      $("ml-progress").className = "ml-progress ml-err";
      $("ml-progress").textContent = e.message;
    }
  }

  /* ------------------------------------------------------------ eventos */
  function bind() {
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
      if (action === "unlink") return unlink(btn.getAttribute("data-pub"));
      const tr = btn.closest("tr[data-id]") || btn.closest("tr").previousElementSibling;
      const id = tr && tr.getAttribute("data-id");
      if (!id) return;
      if (action === "preview") doPreview(id);
      else if (action === "options") {
        if (openRows.get(id) === "options") openRows.delete(id);
        else openRows.set(id, "options");
        renderTable();
      } else if (action === "publish" || action === "sync") doRun(id, action, btn);
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
