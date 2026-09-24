/* ==========================================================================
   STRATO — panel privado (/admin.html)
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

    await Promise.all([loadCategorias(), loadProductos(), loadPedidos()]);
    fillCategoriaSelects();
    renderDashboard();
    renderPedidos();
    renderProductos();
    renderCategorias();

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
        row.style.background = "rgba(201,119,68,0.15)";
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

  /* ============ INIT ============ */
  // No hace falta esperar window.stratoReady acá: ese flujo carga el
  // catálogo PÚBLICO (solo productos activos) para el sitio de ventas.
  // El panel admin usa su propio cliente (stratoSb, ya inicializado de forma
  // síncrona en supabase-client.js) y trae sus propios datos completos.
  document.addEventListener("DOMContentLoaded", checkSession);
})();
