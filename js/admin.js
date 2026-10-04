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
  let gastosCache = [];
  let maquinasCache = [];
  let cotizacionesCache = [];
  let filamentosCache = [];
  let escalonesCache = [];
  let editingMaquinaId = null;
  let editingCotizacionId = null;
  let editingFilamentoId = null;
  let editingEscalonId = null;
  let v7TablasOk = true; // false si no se pudieron leer las tablas de la migración v7 (probablemente no se corrió)

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
  function todayStr() {
    const d = new Date();
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }
  function monthStartStr() {
    const d = new Date();
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-01";
  }
  function fmtMoney(n) {
    if (n === null || n === undefined || isNaN(n)) return "—";
    const sign = n < 0 ? "-" : "";
    return sign + "$U " + Math.round(Math.abs(n)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  }
  function escHtml(s) {
    const d = document.createElement("div");
    d.textContent = s ?? "";
    return d.innerHTML;
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

  async function showApp(user) {
    document.getElementById("login-screen").style.display = "none";
    document.getElementById("app").style.display = "block";
    document.getElementById("user-email").textContent = user.email;

    await Promise.all([
      loadCategorias(), loadProductos(), loadPedidos(), loadMaquinas(), loadCotizaciones(), loadFilamentos(), loadEscalones(),
    ]);
    fillCategoriaSelects();
    renderDashboard();
    renderPedidos();
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

    const hoy = todayStr();
    document.getElementById("gastos-desde").value = monthStartStr();
    document.getElementById("gastos-hasta").value = hoy;
    document.getElementById("dash-desde").value = monthStartStr();
    document.getElementById("dash-hasta").value = hoy;
    document.getElementById("gasto-fecha").value = hoy;
    await loadGastos(monthStartStr(), hoy);
    renderGastos();
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
  document.querySelectorAll("nav.tabs button").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("nav.tabs button").forEach((b) => b.classList.remove("active"));
      document.querySelectorAll(".panel").forEach((p) => p.classList.remove("active"));
      btn.classList.add("active");
      document.getElementById(btn.dataset.panel).classList.add("active");
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

  async function loadPedidos() {
    const { data, error } = await stratoSb.from("pedidos").select("*").order("created_at", { ascending: false });
    if (!error) pedidosCache = data || [];
  }

  async function loadGastos(desde, hasta) {
    let q = stratoSb.from("gastos").select("*").order("fecha", { ascending: false });
    if (desde) q = q.gte("fecha", desde);
    if (hasta) q = q.lte("fecha", hasta);
    const { data, error } = await q;
    if (!error) gastosCache = data || [];
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

  /* ============ DASHBOARD ============ */
  document.getElementById("dash-filtrar").addEventListener("click", renderDashboard);

  function renderDashboard() {
    const desde = document.getElementById("dash-desde").value;
    const hasta = document.getElementById("dash-hasta").value;

    const enRango = pedidosCache.filter((p) => {
      const f = p.created_at ? p.created_at.slice(0, 10) : "";
      return (!desde || f >= desde) && (!hasta || f <= hasta);
    });
    const ingresos = enRango.filter((p) => p.estado !== "cancelado").reduce((s, p) => s + Number(p.subtotal || 0), 0);

    const gastosEnRango = gastosCache.filter((g) => (!desde || g.fecha >= desde) && (!hasta || g.fecha <= hasta));
    const totalGastos = gastosEnRango.reduce((s, g) => s + Number(g.monto || 0), 0);

    document.getElementById("dash-pedidos-count").textContent = enRango.length;
    document.getElementById("dash-ingresos").textContent = fmtMoney(ingresos);
    document.getElementById("dash-gastos").textContent = fmtMoney(totalGastos);
    const saldo = ingresos - totalGastos;
    const saldoEl = document.getElementById("dash-saldo");
    saldoEl.textContent = fmtMoney(saldo);
    saldoEl.className = "dash-total " + (saldo >= 0 ? "positivo" : "negativo");

    const nuevos = pedidosCache.filter((p) => p.estado === "nuevo");
    const tbody = document.getElementById("dash-nuevos-tbody");
    document.getElementById("dash-nuevos-empty").style.display = nuevos.length ? "none" : "block";
    tbody.innerHTML = nuevos
      .map(
        (p) =>
          "<tr><td>" +
          fmtFecha(p.created_at) +
          "</td><td>" +
          escHtml(p.cliente_nombre) +
          "<br><span class='muted'>" +
          escHtml(p.cliente_telefono) +
          "</span></td><td>" +
          resumenItems(p.items) +
          "</td><td>" +
          fmtMoney(p.subtotal) +
          "</td><td><button type='button' class='btn-secondary btn-small' onclick=\"stratoAdminVerPedido('" +
          p.id +
          "')\">Ver en Pedidos</button></td></tr>"
      )
      .join("");
  }

  function fmtFecha(iso) {
    if (!iso) return "—";
    const d = new Date(iso);
    return d.toLocaleDateString("es-UY", { day: "2-digit", month: "2-digit", year: "numeric" });
  }

  function resumenItems(items) {
    if (!items || !items.length) return "—";
    return items.map((it) => it.qty + "× " + escHtml(it.nombre) + (it.tamano ? " (" + escHtml(it.tamano) + ")" : "")).join(", ");
  }

  window.stratoAdminVerPedido = function (id) {
    document.querySelector('nav.tabs button[data-panel="panel-pedidos"]').click();
    document.getElementById("pedidos-buscar").value = "";
    document.getElementById("pedidos-filtro-estado").value = "nuevo";
    renderPedidos();
    setTimeout(() => {
      const row = document.querySelector('tr[data-pedido-id="' + id + '"]');
      if (row) {
        row.scrollIntoView({ behavior: "smooth", block: "center" });
        row.style.background = "rgba(53,10,6,0.08)";
      }
    }, 100);
  };

  /* ============ PEDIDOS ============ */
  document.getElementById("pedidos-buscar").addEventListener("input", renderPedidos);
  document.getElementById("pedidos-filtro-estado").addEventListener("change", renderPedidos);

  function renderPedidos() {
    const term = document.getElementById("pedidos-buscar").value.trim().toLowerCase();
    const estadoFiltro = document.getElementById("pedidos-filtro-estado").value;

    let list = pedidosCache;
    if (estadoFiltro !== "todos") list = list.filter((p) => p.estado === estadoFiltro);
    if (term) {
      list = list.filter((p) =>
        [p.cliente_nombre, p.cliente_telefono, p.cliente_email].filter(Boolean).join(" ").toLowerCase().includes(term)
      );
    }

    const tbody = document.getElementById("pedidos-tbody");
    document.getElementById("pedidos-empty").style.display = list.length ? "none" : "block";

    tbody.innerHTML = list
      .map((p) => {
        const estadoOptions = ESTADOS.map(
          (e) => '<option value="' + e + '"' + (e === p.estado ? " selected" : "") + ">" + ESTADO_LABEL[e] + "</option>"
        ).join("");
        return (
          '<tr class="clickable" data-pedido-id="' +
          p.id +
          '" onclick="if(event.target.tagName!==\'SELECT\' && event.target.tagName!==\'BUTTON\') stratoAdminToggleDetalle(\'' +
          p.id +
          "')\">" +
          "<td>" +
          fmtFecha(p.created_at) +
          "</td><td>" +
          escHtml(p.cliente_nombre) +
          "<br><span class='muted'>" +
          escHtml(p.cliente_telefono) +
          "</span></td><td>" +
          resumenItems(p.items) +
          "</td><td>" +
          fmtMoney(p.subtotal) +
          "</td><td>" +
          escHtml(p.entrega) +
          '</td><td><select class="estado-select estado-' +
          p.estado +
          '" onchange="stratoAdminCambiarEstado(\'' +
          p.id +
          "', this.value)\">" +
          estadoOptions +
          "</select></td><td><button type='button' class='btn-secondary btn-small' onclick=\"stratoAdminToggleDetalle('" +
          p.id +
          "')\">Detalle</button></td></tr>" +
          '<tr class="detalle-row hidden-row" id="detalle-' +
          p.id +
          '"><td colspan="7">' +
          detallePedido(p) +
          "</td></tr>"
        );
      })
      .join("");
  }

  function detallePedido(p) {
    const items = (p.items || [])
      .map(
        (it) =>
          "• " + it.qty + "× " + escHtml(it.nombre) +
          (it.tamano || it.color ? " (" + [it.tamano, it.color].filter(Boolean).map(escHtml).join(", ") + ")" : "") +
          " — " + fmtMoney(it.precio) + " c/u" +
          (it.descuento_cantidad_pct ? " <em>(-" + escHtml(it.descuento_cantidad_pct) + "% por cantidad, lista " + fmtMoney(it.precio_lista) + ")</em>" : "") +
          (it.nota ? "<br>&nbsp;&nbsp;<em>Obs: " + escHtml(it.nota) + "</em>" : "")
      )
      .join("<br>");
    return (
      "<strong>Items:</strong><br>" +
      (items || "—") +
      "<br><br><strong>Email:</strong> " +
      escHtml(p.cliente_email || "—") +
      "<br><strong>Dirección:</strong> " +
      escHtml(p.direccion || "—") +
      "<br><strong>Pago:</strong> " +
      escHtml(p.pago || "—") +
      "<br><strong>Notas:</strong> " +
      escHtml(p.notas || "—")
    );
  }

  window.stratoAdminToggleDetalle = function (id) {
    const row = document.getElementById("detalle-" + id);
    if (row) row.classList.toggle("hidden-row");
  };

  window.stratoAdminCambiarEstado = async function (id, nuevoEstado) {
    const { error } = await stratoSb.from("pedidos").update({ estado: nuevoEstado }).eq("id", id);
    if (error) {
      alert("No se pudo actualizar el estado: " + error.message);
      return;
    }
    const p = pedidosCache.find((x) => x.id === id);
    if (p) p.estado = nuevoEstado;
    renderDashboard();
    renderPedidos();
  };

  /* ============ PRODUCTOS ============ */
  document.getElementById("producto-form-toggle").addEventListener("click", () => {
    document.getElementById("producto-form-toggle").classList.toggle("open");
    document.getElementById("producto-form-body").classList.toggle("open");
  });

  document.getElementById("productos-buscar").addEventListener("input", renderProductos);
  document.getElementById("productos-filtro-categoria").addEventListener("change", renderProductos);

  function renderProductos() {
    const term = document.getElementById("productos-buscar").value.trim().toLowerCase();
    const catFiltro = document.getElementById("productos-filtro-categoria").value;

    let list = productosCache;
    if (catFiltro !== "todas") list = list.filter((p) => productoCategoriaIds(p).includes(catFiltro));
    if (term) list = list.filter((p) => p.nombre.toLowerCase().includes(term));

    const tbody = document.getElementById("productos-tbody");
    document.getElementById("productos-empty").style.display = list.length ? "none" : "block";

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
    prodTamanos = (Array.isArray(p.tamanos) ? p.tamanos : []).map((t) => ({ nombre: t.nombre || "", precio: t.precio }));
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
        // Se espera un frame para que el navegador termine de acomodar el
        // tamaño renderizado de la imagen (max-width/max-height) antes de medirlo.
        requestAnimationFrame(() => {
          stageW = stage.clientWidth;
          stageH = stage.clientHeight;
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
      }

      function onConfirm() {
        const scale = imgEl.naturalWidth / stageW;
        const sx = box.left * scale;
        const sy = box.top * scale;
        const ssize = box.size * scale;
        const outSize = Math.min(Math.round(ssize) || MIN_SIZE, MAX_OUTPUT);
        const canvas = document.createElement("canvas");
        canvas.width = outSize;
        canvas.height = outSize;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(imgEl, sx, sy, ssize, ssize, 0, 0, outSize, outSize);
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

    if (productoId) {
      const { error: catError } = await syncProductoCategorias(productoId, prodCategoriaIds);
      if (catError) { errEl.textContent = "Producto guardado, pero falló vincular categorías: " + catError.message; return; }
    }

    await loadProductos();
    renderProductos();
    resetProductForm();
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
  function precioKgDe(f) {
    const peso = Number(f.peso_rollo_gr);
    return peso > 0 ? (Number(f.precio_rollo) / peso) * 1000 : 0;
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
          escHtml(f.material || "—") + "</td><td>" + fmtMoney(f.precio_rollo) + " <span class='muted'>/ " +
          Number(f.peso_rollo_gr) + " gr</span></td><td>" + fmtMoney(precioKgDe(f)) + '</td><td><input type="checkbox" ' +
          (f.disponible ? "checked" : "") + " onchange=\"stratoAdminToggleFilamento('" + f.id + "', this.checked)\"></td>" +
          "<td><button type='button' class='btn-secondary btn-small' onclick=\"stratoAdminEditarFilamento('" + f.id +
          "')\">Editar</button> <button type='button' class='btn-danger btn-small' onclick=\"stratoAdminEliminarFilamento('" +
          f.id + "')\">Eliminar</button></td></tr>"
      )
      .join("");
  }

  /* Cada vez que cambia la lista de filamentos hay tres lugares que dependen de ella. */
  function refreshFilamentoDependents() {
    renderFilamentos();
    renderColorTags(); // también redibuja el selector de colores del producto
    renderCalcFilRows();
    renderResultados();
  }

  function updateFilKgPreview() {
    const precio = numVal("fil-precio-rollo");
    const peso = numVal("fil-peso-rollo");
    document.getElementById("fil-kg-preview").textContent = peso > 0 ? fmtMoney((precio / peso) * 1000) + " / kg" : "—";
  }
  document.getElementById("fil-precio-rollo").addEventListener("input", updateFilKgPreview);
  document.getElementById("fil-peso-rollo").addEventListener("input", updateFilKgPreview);

  function resetFilamentoForm() {
    editingFilamentoId = null;
    document.getElementById("form-filamento").reset();
    document.getElementById("fil-material").value = "PLA";
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
    document.getElementById("fil-precio-rollo").value = f.precio_rollo;
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
    if (!requireSb()) return;

    let error;
    if (editingFilamentoId) {
      ({ error } = await stratoSb.from("filamentos").update(payload).eq("id", editingFilamentoId));
    } else {
      ({ error } = await stratoSb.from("filamentos").insert([payload]));
    }
    if (error) { errEl.textContent = error.message; return; }

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
  }
  window.stratoAdminTamanoSet = function (i, key, value) {
    if (prodTamanos[i]) prodTamanos[i][key] = value;
    syncPrecioDesdeTamanos();
  };
  window.stratoAdminTamanoDel = function (i) {
    prodTamanos.splice(i, 1);
    renderProdTamanos();
  };
  document.getElementById("prod-add-tamano").addEventListener("click", () => {
    prodTamanos.push({ nombre: "", precio: "" });
    renderProdTamanos();
  });

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
  document.getElementById("gastos-filtrar").addEventListener("click", async () => {
    await loadGastos(document.getElementById("gastos-desde").value, document.getElementById("gastos-hasta").value);
    renderGastos();
  });

  function renderGastos() {
    const tbody = document.getElementById("gastos-tbody");
    const tfoot = document.getElementById("gastos-tfoot");
    document.getElementById("gastos-empty").style.display = gastosCache.length ? "none" : "block";

    tbody.innerHTML = gastosCache
      .map(
        (g) =>
          "<tr><td>" +
          g.fecha +
          "</td><td>" +
          escHtml(g.concepto) +
          "</td><td>" +
          escHtml(g.categoria || "—") +
          "</td><td>" +
          fmtMoney(g.monto) +
          "</td><td>" +
          escHtml(g.nota || "—") +
          "</td><td><button type='button' class='btn-danger btn-small' onclick=\"stratoAdminEliminarGasto('" +
          g.id +
          "')\">Eliminar</button></td></tr>"
      )
      .join("");

    const total = gastosCache.reduce((s, g) => s + Number(g.monto || 0), 0);
    tfoot.innerHTML = '<tr><td colspan="3">Total</td><td>' + fmtMoney(total) + "</td><td colspan='2'></td></tr>";
  }

  window.stratoAdminEliminarGasto = async function (id) {
    if (!confirm("¿Eliminar este gasto?")) return;
    const { error } = await stratoSb.from("gastos").delete().eq("id", id);
    if (error) { alert("No se pudo eliminar: " + error.message); return; }
    gastosCache = gastosCache.filter((g) => g.id !== id);
    renderGastos();
    renderDashboard();
  };

  document.getElementById("form-gasto").addEventListener("submit", async (e) => {
    e.preventDefault();
    const errEl = document.getElementById("gasto-error");
    errEl.textContent = "";
    const payload = {
      concepto: document.getElementById("gasto-concepto").value.trim(),
      monto: Number(document.getElementById("gasto-monto").value || 0),
      categoria: document.getElementById("gasto-categoria").value,
      fecha: document.getElementById("gasto-fecha").value || todayStr(),
      nota: document.getElementById("gasto-nota").value.trim(),
    };
    if (!payload.concepto || !payload.monto) { errEl.textContent = "Faltan datos."; return; }

    const { error } = await stratoSb.from("gastos").insert([payload]);
    if (error) { errEl.textContent = error.message; return; }

    document.getElementById("form-gasto").reset();
    document.getElementById("gasto-fecha").value = todayStr();
    await loadGastos(document.getElementById("gastos-desde").value, document.getElementById("gastos-hasta").value);
    renderGastos();
    renderDashboard();
  });

  /* ============ CALCULADORA DE COSTOS ============ */
  /*
   Fórmula (verificada contra una calculadora de referencia del rubro):
     horas_uso        = horas_impresion + minutos_adicionales/60
     costo_material    = suma de (gramos_i/1000) * precio_kg_i  — una fila por filamento usado
                         (peso_gr = suma de los gramos de todas las filas)
     costo_electricidad = (potencia_w * horas_uso / 1000) * costo_kwh
     desgaste_maquina  = (costo_reposicion / vida_util_horas) * horas_uso
     margen_error_monto = margen_error_pct * (material + electricidad + desgaste + acabados)
     costo_base        = material + electricidad + desgaste + acabados + margen_error_monto
     total_a_cobrar     = costo_base * margen_ganancia + accesorio_adicional
     ganancia_neta      = total_a_cobrar - costo_base
   El "accesorio adicional" NO entra en costo_base ni en el margen de error:
   se suma al final, sin llevar margen de ganancia (es guita que sale del
   bolsillo tal cual, ej. un herraje comprado para esa pieza puntual).
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

    const horasUso = horasImpresion + minutosAdicionales / 60;
    const costoElectricidad = ((potenciaW * horasUso) / 1000) * costoElectricidadKwh;
    const desgasteMaquina = (costoReposicion / vidaUtilHoras) * horasUso;
    const margenErrorMonto = margenErrorPct * (costoMaterial + costoElectricidad + desgasteMaquina + acabados);
    const costoBase = costoMaterial + costoElectricidad + desgasteMaquina + acabados + margenErrorMonto;
    const totalACobrar = costoBase * margenGanancia + accesorio;
    const gananciaNeta = totalACobrar - costoBase;
    const gananciaPct = totalACobrar > 0 ? (gananciaNeta / totalACobrar) * 100 : 0;

    return {
      filamentos,
      potenciaW, vidaUtilHoras, costoReposicion, precioFilamento, costoElectricidadKwh,
      horasImpresion, minutosAdicionales, pesoGr, margenErrorPct, margenGanancia, accesorio, acabados,
      horasUso, costoMaterial, costoElectricidad, desgasteMaquina, margenErrorMonto,
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
    html += calcLinea("Margen de error", "+" + Math.round(r.margenErrorPct * 100) + "% sobre costos", r.margenErrorMonto, "+");
    if (r.acabados) html += calcLinea("Insumos extra / acabado", null, r.acabados, "+");
    if (r.accesorio) html += calcLinea("Accesorio adicional", "no lleva margen de ganancia", r.accesorio, "+");
    html += '<div class="calc-line-total"><div>Costo base</div><div>' + fmtMoney(r.costoBase) + "</div></div>";
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
      "#calc-potencia, #calc-vida-util, #calc-costo-reposicion, #calc-costo-electricidad, " +
        "#calc-horas, #calc-minutos, #calc-margen-ganancia, #calc-accesorio, #calc-acabados"
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
    document.getElementById("calc-acabados").value = 0;
    document.getElementById("calc-altura-capa").value = "0.20";
    document.getElementById("calc-relleno").value = 20;
    document.getElementById("calc-error").textContent = "";
    renderResultados();
  });

  /* ---- Guardar cotización ---- */
  document.getElementById("calc-guardar-btn").addEventListener("click", async () => {
    const errEl = document.getElementById("calc-error");
    errEl.textContent = "";
    const nombrePieza = document.getElementById("calc-nombre-pieza").value.trim();
    if (!nombrePieza) { errEl.textContent = "Poné un nombre para la pieza antes de guardar."; return; }
    if (!requireSb()) return;

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
        precio_filamento_kg: r.precioFilamento,
        filamentos: r.filamentos,
        costo_electricidad_kwh: r.costoElectricidadKwh,
        horas_impresion: r.horasImpresion,
        minutos_adicionales: r.minutosAdicionales,
        peso_gr: r.pesoGr,
        margen_error_pct: r.margenErrorPct,
        margen_ganancia: r.margenGanancia,
        costo_accesorio: r.accesorio,
        costo_acabados: r.acabados,
        altura_capa: document.getElementById("calc-altura-capa").value,
        relleno_pct: numVal("calc-relleno"),
      },
      resultados: {
        horas_uso: r.horasUso,
        costo_material: r.costoMaterial,
        costo_electricidad: r.costoElectricidad,
        desgaste_maquina: r.desgasteMaquina,
        margen_error_monto: r.margenErrorMonto,
        costo_base: r.costoBase,
        ganancia_neta: r.gananciaNeta,
        ganancia_pct: r.gananciaPct,
      },
      total_a_cobrar: r.totalACobrar,
    };

    let error;
    if (editingCotizacionId) {
      ({ error } = await stratoSb.from("cotizaciones").update(payload).eq("id", editingCotizacionId));
    } else {
      ({ error } = await stratoSb.from("cotizaciones").insert([payload]));
    }
    if (error) { errEl.textContent = error.message; return; }

    editingCotizacionId = null;
    document.getElementById("calc-guardar-btn").textContent = "Guardar cotización";
    document.getElementById("calc-editing-label").textContent = "";

    await loadCotizaciones();
    renderCotizaciones();
  });

  function renderCotizaciones() {
    const tbody = document.getElementById("cotizaciones-tbody");
    document.getElementById("cotizaciones-empty").style.display = cotizacionesCache.length ? "none" : "block";
    tbody.innerHTML = cotizacionesCache
      .map((c) => {
        const gp = c.resultados && c.resultados.ganancia_pct != null ? c.resultados.ganancia_pct.toFixed(1) + "%" : "—";
        const costoBase = c.resultados && c.resultados.costo_base != null ? fmtMoney(c.resultados.costo_base) : "—";
        return (
          "<tr><td>" + fmtFecha(c.created_at) + "</td><td>" + escHtml(c.nombre_pieza) + "</td><td>" +
          escHtml(c.cliente || "—") + "</td><td>" + escHtml(c.maquina_nombre || "—") + "</td><td>" +
          costoBase + "</td><td>" + fmtMoney(c.total_a_cobrar) + "</td><td>" + gp +
          "</td><td><button type='button' class='btn-secondary btn-small' onclick=\"stratoAdminEditarCotizacion('" +
          c.id + "')\">Editar</button> <button type='button' class='btn-danger btn-small' onclick=\"stratoAdminEliminarCotizacion('" +
          c.id + "')\">Eliminar</button></td></tr>"
        );
      })
      .join("");
  }

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
    document.getElementById("calc-acabados").value = inp.costo_acabados ?? 0;
    document.getElementById("calc-altura-capa").value = inp.altura_capa ?? "0.20";
    document.getElementById("calc-relleno").value = inp.relleno_pct ?? 20;

    document.getElementById("calc-guardar-btn").textContent = "Guardar cambios";
    document.getElementById("calc-editing-label").textContent = "— editando cotización guardada";
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
          "</td><td><button type='button' class='btn-secondary btn-small' onclick=\"stratoAdminEditarMaquina('" +
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
    };
    if (!payload.nombre) { errEl.textContent = "Falta el nombre."; return; }

    let error;
    if (editingMaquinaId) {
      ({ error } = await stratoSb.from("maquinas_3d").update(payload).eq("id", editingMaquinaId));
    } else {
      ({ error } = await stratoSb.from("maquinas_3d").insert([payload]));
    }
    if (error) { errEl.textContent = error.message; return; }

    await loadMaquinas();
    renderMaquinas();
    fillMaquinaSelect();
    resetMaquinaForm();
  });

  /* ============ INIT ============ */
  // No hace falta esperar window.stratoReady acá: ese flujo carga el
  // catálogo PÚBLICO (solo productos activos) para el sitio de ventas.
  // El panel admin usa su propio cliente (stratoSb, ya inicializado de forma
  // síncrona en supabase-client.js) y trae sus propios datos completos.
  document.addEventListener("DOMContentLoaded", checkSession);
})();
