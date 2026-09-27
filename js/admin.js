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
  let editingMaquinaId = null;

  let editingProductId = null;
  let editingCategoriaId = null;
  let prodImagenes = []; // strings (url) o {uploading:true, tempId, name}
  let prodColores = [];

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

    await Promise.all([loadCategorias(), loadProductos(), loadPedidos(), loadMaquinas(), loadCotizaciones()]);
    fillCategoriaSelects();
    renderDashboard();
    renderPedidos();
    renderProductos();
    renderCategorias();
    renderMaquinas();
    fillMaquinaSelect();
    renderCotizaciones();
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
    const { data, error } = await stratoSb
      .from("productos")
      .select("*, categorias(id, nombre, slug)")
      .order("orden", { ascending: true });
    if (!error) productosCache = data || [];
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
    const opts = categoriasCache.map((c) => '<option value="' + c.id + '">' + escHtml(c.nombre) + "</option>").join("");
    document.getElementById("prod-categoria").innerHTML = opts || '<option value="">Creá una categoría primero</option>';

    const filtro = document.getElementById("productos-filtro-categoria");
    filtro.innerHTML =
      '<option value="todas">Todas las categorías</option>' +
      categoriasCache.map((c) => '<option value="' + c.id + '">' + escHtml(c.nombre) + "</option>").join("");
  }

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
    return items.map((it) => it.qty + "× " + escHtml(it.nombre)).join(", ");
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
      .map((it) => "• " + it.qty + "× " + escHtml(it.nombre) + (it.color ? " (" + escHtml(it.color) + ")" : "") + " — " + fmtMoney(it.precio))
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
    if (catFiltro !== "todas") list = list.filter((p) => p.categoria_id === catFiltro);
    if (term) list = list.filter((p) => p.nombre.toLowerCase().includes(term));

    const tbody = document.getElementById("productos-tbody");
    document.getElementById("productos-empty").style.display = list.length ? "none" : "block";

    tbody.innerHTML = list
      .map((p) => {
        const img = p.imagenes && p.imagenes[0] ? '<img class="thumb" src="' + p.imagenes[0] + '">' : '<div class="thumb"></div>';
        return (
          "<tr><td>" +
          img +
          "</td><td>" +
          escHtml(p.nombre) +
          "</td><td>" +
          escHtml(p.categorias ? p.categorias.nombre : "—") +
          "</td><td>" +
          (p.precio == null ? "Cotizar" : fmtMoney(p.precio)) +
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
    document.getElementById("prod-categoria").value = p.categoria_id || "";
    document.getElementById("prod-precio").value = p.precio == null ? "" : p.precio;
    document.getElementById("prod-cotizar").checked = p.precio == null;
    document.getElementById("prod-material").value = p.material || "";
    document.getElementById("prod-descripcion").value = p.descripcion || "";
    document.getElementById("prod-tag").value = p.tag || "";
    document.getElementById("prod-orden").value = p.orden || 0;
    document.getElementById("prod-activo").checked = p.activo;
    prodColores = (p.colores || []).slice();
    prodImagenes = (p.imagenes || []).slice();
    renderColorTags();
    renderImgManager();
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
    document.getElementById("producto-form-title").textContent = "Nuevo producto";
    document.getElementById("prod-submit-btn").textContent = "Guardar producto";
    document.getElementById("prod-cancel-btn").style.display = "none";
    document.getElementById("prod-activo").checked = true;
    prodColores = [];
    prodImagenes = [];
    renderColorTags();
    renderImgManager();
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
      .map(
        (c, i) =>
          '<span class="color-tag">' + escHtml(c) + ' <button type="button" onclick="stratoAdminQuitarColor(' + i + ')">✕</button></span>'
      )
      .join("");
  }
  window.stratoAdminQuitarColor = function (i) {
    prodColores.splice(i, 1);
    renderColorTags();
  };

  /* ---- Imágenes (Supabase Storage) ---- */
  document.getElementById("prod-img-input").addEventListener("change", async (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = "";
    for (const file of files) {
      await uploadImagen(file);
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

  async function uploadImagen(file) {
    if (!requireSb()) return;
    const tempEntry = { uploading: true, name: file.name };
    prodImagenes.push(tempEntry);
    renderImgManager();

    const ext = (file.name.split(".").pop() || "jpg").toLowerCase();
    const path = "producto-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8) + "." + ext;

    const { error } = await stratoSb.storage.from("productos-imagenes").upload(path, file);
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

  /* ---- Guardar producto ---- */
  document.getElementById("form-producto").addEventListener("submit", async (e) => {
    e.preventDefault();
    const errEl = document.getElementById("producto-error");
    errEl.textContent = "";

    const cotizar = document.getElementById("prod-cotizar").checked;
    const precioVal = document.getElementById("prod-precio").value;

    const payload = {
      nombre: document.getElementById("prod-nombre").value.trim(),
      categoria_id: document.getElementById("prod-categoria").value || null,
      precio: cotizar || precioVal === "" ? null : Number(precioVal),
      colores: prodColores,
      material: document.getElementById("prod-material").value.trim(),
      descripcion: document.getElementById("prod-descripcion").value.trim(),
      imagenes: prodImagenes.filter((i) => typeof i === "string"),
      tag: document.getElementById("prod-tag").value || null,
      orden: Number(document.getElementById("prod-orden").value || 0),
      activo: document.getElementById("prod-activo").checked,
    };

    if (!payload.nombre) { errEl.textContent = "Falta el nombre."; return; }
    if (!payload.categoria_id) { errEl.textContent = "Elegí una categoría (creá una primero si no hay ninguna)."; return; }

    let error;
    if (editingProductId) {
      ({ error } = await stratoSb.from("productos").update(payload).eq("id", editingProductId));
    } else {
      ({ error } = await stratoSb.from("productos").insert([payload]));
    }
    if (error) { errEl.textContent = error.message; return; }

    await loadProductos();
    renderProductos();
    resetProductForm();
  });

  /* ============ CATEGORIAS ============ */
  document.getElementById("cat-cancel-btn").addEventListener("click", resetCategoriaForm);

  function resetCategoriaForm() {
    editingCategoriaId = null;
    document.getElementById("form-categoria").reset();
    document.getElementById("cat-submit-btn").textContent = "Guardar categoría";
    document.getElementById("cat-cancel-btn").style.display = "none";
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
     costo_material    = (peso_gr/1000) * precio_filamento_kg
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
    const precioFilamento = numVal("calc-precio-filamento");
    const costoElectricidadKwh = numVal("calc-costo-electricidad");
    const horasImpresion = numVal("calc-horas");
    const minutosAdicionales = numVal("calc-minutos");
    const pesoGr = numVal("calc-peso");
    const margenErrorPct = numVal("calc-margen-error") / 100;
    const margenGanancia = numVal("calc-margen-ganancia");
    const accesorio = numVal("calc-accesorio");
    const acabados = numVal("calc-acabados");

    const horasUso = horasImpresion + minutosAdicionales / 60;
    const costoMaterial = (pesoGr / 1000) * precioFilamento;
    const costoElectricidad = ((potenciaW * horasUso) / 1000) * costoElectricidadKwh;
    const desgasteMaquina = (costoReposicion / vidaUtilHoras) * horasUso;
    const margenErrorMonto = margenErrorPct * (costoMaterial + costoElectricidad + desgasteMaquina + acabados);
    const costoBase = costoMaterial + costoElectricidad + desgasteMaquina + acabados + margenErrorMonto;
    const totalACobrar = costoBase * margenGanancia + accesorio;
    const gananciaNeta = totalACobrar - costoBase;
    const gananciaPct = totalACobrar > 0 ? (gananciaNeta / totalACobrar) * 100 : 0;

    return {
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

    let html = "";
    html += calcLinea("Costo material", r.pesoGr + " gr · " + fmtMoney(r.precioFilamento) + "/kg", r.costoMaterial);
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
      "#calc-potencia, #calc-vida-util, #calc-costo-reposicion, #calc-precio-filamento, #calc-costo-electricidad, " +
        "#calc-horas, #calc-minutos, #calc-peso, #calc-margen-ganancia, #calc-accesorio, #calc-acabados"
    )
    .forEach((el) => el.addEventListener("input", renderResultados));

  document.getElementById("calc-margen-error").addEventListener("input", (e) => {
    document.getElementById("calc-margen-error-label").textContent = e.target.value + "%";
    renderResultados();
  });

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

  /* ---- Limpiar ---- */
  document.getElementById("calc-limpiar-btn").addEventListener("click", () => {
    document.getElementById("calc-maquina").value = "";
    document.getElementById("calc-potencia").value = 200;
    document.getElementById("calc-vida-util").value = 5000;
    document.getElementById("calc-costo-reposicion").value = 0;
    document.getElementById("calc-precio-filamento").value = 0;
    document.getElementById("calc-costo-electricidad").value = 0;
    document.getElementById("calc-nombre-pieza").value = "";
    document.getElementById("calc-cliente").value = "";
    document.getElementById("calc-horas").value = 0;
    document.getElementById("calc-minutos").value = 30;
    document.getElementById("calc-peso").value = 50;
    document.getElementById("calc-material").value = "PLA";
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

    const { error } = await stratoSb.from("cotizaciones").insert([payload]);
    if (error) { errEl.textContent = error.message; return; }

    await loadCotizaciones();
    renderCotizaciones();
  });

  function renderCotizaciones() {
    const tbody = document.getElementById("cotizaciones-tbody");
    document.getElementById("cotizaciones-empty").style.display = cotizacionesCache.length ? "none" : "block";
    tbody.innerHTML = cotizacionesCache
      .map((c) => {
        const gp = c.resultados && c.resultados.ganancia_pct != null ? c.resultados.ganancia_pct.toFixed(1) + "%" : "—";
        return (
          "<tr><td>" + fmtFecha(c.created_at) + "</td><td>" + escHtml(c.nombre_pieza) + "</td><td>" +
          escHtml(c.cliente || "—") + "</td><td>" + escHtml(c.maquina_nombre || "—") + "</td><td>" +
          fmtMoney(c.total_a_cobrar) + "</td><td>" + gp +
          "</td><td><button type='button' class='btn-danger btn-small' onclick=\"stratoAdminEliminarCotizacion('" +
          c.id + "')\">Eliminar</button></td></tr>"
        );
      })
      .join("");
  }

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
