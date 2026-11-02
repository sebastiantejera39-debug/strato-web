/* ==========================================================================
   STORGE LAB — carrito de compras
   Persiste en localStorage. No depende de backend: pensado para arrancar
   ya mismo con checkout por WhatsApp, y poder sumar Mercado Pago más
   adelante (como hizo RGOL.UY) sin tener que rehacer esta parte.
   ========================================================================== */

/* ---- Configuración: reemplazar con los datos reales del negocio ---- */
const STRATO_WHATSAPP_NUMBER = "59898037399"; // formato 598XXXXXXXX, sin +
const STRATO_INSTAGRAM = "storge.lab"; // TODO: usuario real de Instagram (ya confirmado: @storge.lab)

const CART_KEY = "strato_cart_v1";

/* ---- Cupones de descuento ----
   Cada cupón: código en MAYÚSCULAS -> { tipo: "porcentaje", valor: 1 a 90, desde: "AAAA-MM-DD", hasta: "AAAA-MM-DD" }.
   `desde` y `hasta` son días de Uruguay, los dos incluidos (se pueden omitir: sin `hasta` no vence).
   Solo hay descuentos en porcentaje. El cupón se aplica sobre el precio de cada unidad que ya tiene el descuento
   por cantidad, y se redondea al peso por unidad (igual que el descuento por cantidad).
   OJO: el que COBRA es el servidor. Hay que copiar el mismo cupón a CUPONES en
   netlify/functions/create-preference.js (y subir los dos archivos juntos): si no coinciden, Mercado Pago y el
   pedido guardado rechazan el código. Para apagar un cupón antes de tiempo basta con borrarlo de los dos. */
const STRATO_CUPONES = {
  CYBER15: { tipo: "porcentaje", valor: 15, desde: "2026-11-02", hasta: "2026-11-05" }, // Cyber Monday
};

const CUPON_KEY = "strato_cupon_v1";

function stratoGetCart() {
  try {
    const raw = localStorage.getItem(CART_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    return [];
  }
}

function stratoSaveCart(cart) {
  localStorage.setItem(CART_KEY, JSON.stringify(cart));
  stratoUpdateCartCount();
}

/* La "línea" del carrito es producto + color + tamaño: el mismo producto en
   dos tamaños (o dos colores) distintos son líneas separadas. */
function stratoLineKey(productId, color, size) {
  return productId + "::" + (color || "default") + "::" + (size || "default");
}

function stratoAddToCart(productId, qty, color, size) {
  const cart = stratoGetCart();
  const key = stratoLineKey(productId, color, size);
  const existing = cart.find((l) => stratoLineKey(l.id, l.color, l.size) === key);
  if (existing) {
    existing.qty += qty;
  } else {
    cart.push({ id: productId, qty: qty, color: color || null, size: size || null, note: "" });
  }
  stratoSaveCart(cart);
  stratoRenderCartDrawer();
  stratoShowToast("Agregado al carrito");
}

/* Las funciones "ByKey" son las que usa el drawer: identifican la línea por
   su clave (producto + color + tamaño), así no hay que meter textos con
   comillas dentro de atributos onclick. */
function stratoUpdateLineQtyByKey(key, qty) {
  let cart = stratoGetCart();
  if (qty <= 0) {
    cart = cart.filter((l) => stratoLineKey(l.id, l.color, l.size) !== key);
  } else {
    const line = cart.find((l) => stratoLineKey(l.id, l.color, l.size) === key);
    if (line) line.qty = qty;
  }
  stratoSaveCart(cart);
  stratoRenderCartDrawer();
}

function stratoRemoveLineByKey(key) {
  stratoUpdateLineQtyByKey(key, 0);
}

/* Observación puntual de ese producto en el carrito (ej. aclarar un color,
   un detalle del pedido). Guarda sin re-dibujar el drawer, para no perder
   el foco/cursor mientras el cliente está escribiendo. */
function stratoSetLineNoteByKey(key, note) {
  const cart = stratoGetCart();
  const line = cart.find((l) => stratoLineKey(l.id, l.color, l.size) === key);
  if (!line) return;
  line.note = note;
  stratoSaveCart(cart);
}

/* Versiones anteriores (producto + color): se mantienen por compatibilidad. */
function stratoUpdateLineQty(productId, color, qty, size) {
  stratoUpdateLineQtyByKey(stratoLineKey(productId, color, size), qty);
}
function stratoRemoveLine(productId, color, size) {
  stratoUpdateLineQtyByKey(stratoLineKey(productId, color, size), 0);
}
function stratoSetLineNote(productId, color, note, size) {
  stratoSetLineNoteByKey(stratoLineKey(productId, color, size), note);
}

function stratoClearCart() {
  localStorage.removeItem(CART_KEY);
  localStorage.removeItem(CUPON_KEY);
  stratoUpdateCartCount();
}

/* ---- Cupón aplicado (código guardado en localStorage) ---- */

/* Día de hoy en Uruguay (UTC-3 todo el año), AAAA-MM-DD. Igual que el servidor. */
function stratoHoyUY() {
  return new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/* "ok" | "invalido" | "futuro" (todavía no empieza) | "vencido" */
function stratoCuponEstado(code) {
  if (!code || !Object.prototype.hasOwnProperty.call(STRATO_CUPONES, code)) return "invalido";
  const c = STRATO_CUPONES[code];
  if (!c || c.tipo !== "porcentaje" || !(c.valor > 0 && c.valor <= 90)) return "invalido";
  const hoy = stratoHoyUY();
  if (c.desde && hoy < c.desde) return "futuro";
  if (c.hasta && hoy > c.hasta) return "vencido";
  return "ok";
}

/* El código guardado, solo si sigue vigente (un cupón que venció mientras tanto deja de contar solo). */
function stratoGetCuponCode() {
  try {
    const code = localStorage.getItem(CUPON_KEY);
    return code && stratoCuponEstado(code) === "ok" ? code : null;
  } catch (e) {
    return null;
  }
}

/* Porcentaje del cupón aplicado (0 si no hay). */
function stratoCuponPct() {
  const code = stratoGetCuponCode();
  return code ? STRATO_CUPONES[code].valor : 0;
}

/* Precio de UNA unidad con el cupón: sobre el precio que ya trae el descuento por cantidad, redondeado al peso. */
function stratoCuponUnit(unit, pct) {
  return Math.max(1, Math.round((unit * (100 - pct)) / 100));
}

/* Cuánto ahorra el cupón (suma de lo que baja cada unidad por su cantidad). */
function stratoCartDescuento() {
  return stratoCartDetailed().reduce((sum, l) => sum + (l.lineTotal == null ? 0 : l.lineTotal - l.lineFinal), 0);
}

/* Lo que paga el cliente (sin el recargo de Mercado Pago). */
function stratoCartTotal() {
  return stratoCartDetailed().reduce((sum, l) => sum + (l.lineFinal || 0), 0);
}

function stratoAplicarCupon(inputEl) {
  const feedbackEl = document.getElementById("cartCuponFeedback");
  const raw = (inputEl && inputEl.value ? inputEl.value : "").trim().toUpperCase();
  if (!raw) return;
  const estado = stratoCuponEstado(raw);
  if (estado === "ok") {
    localStorage.setItem(CUPON_KEY, raw);
    stratoRenderCartDrawer();
  } else if (feedbackEl) {
    feedbackEl.textContent =
      estado === "futuro" ? "Ese cupón todavía no está vigente." : estado === "vencido" ? "Ese cupón ya venció." : "Ese cupón no es válido.";
  }
}

function stratoQuitarCupon() {
  localStorage.removeItem(CUPON_KEY);
  stratoRenderCartDrawer();
}

/* ---- Precios: tamaño elegido + descuento por cantidad ----
   Un producto puede tener tamaños (cada uno con su precio) y/o descuento por
   cantidad (escalones "desde N unidades, X%"). El escalón se decide por el
   TOTAL de unidades de ese producto en el carrito, sumando todos sus colores
   y tamaños. El precio unitario con descuento se redondea al peso: es el
   mismo número que se muestra, que se cobra por Mercado Pago y que se
   guarda en el pedido. */
function stratoProductTiers(product) {
  if (!product || !product.byQuantity) return [];
  const own = product.ownTiers && product.ownTiers.length ? product.ownTiers : null;
  return (own || STRATO_TIERS).slice().sort((a, b) => a.from - b.from);
}

/* Escalón que corresponde a esa cantidad total: {from, pct}, o null si no llega a ninguno. */
function stratoTierFor(product, totalQty) {
  let hit = null;
  stratoProductTiers(product).forEach((t) => {
    if (totalQty >= t.from) hit = t;
  });
  return hit;
}

/* Tamaño elegido (si el nombre guardado ya no existe, cae al primero). null si el producto no tiene tamaños. */
function stratoFindSize(product, sizeName) {
  const sizes = (product && product.sizes) || [];
  if (!sizes.length) return null;
  return sizes.find((s) => s.name === sizeName) || sizes[0];
}

/* Precio de lista de UNA unidad, sin descuento por cantidad. null = a cotizar. */
function stratoBasePrice(product, sizeName) {
  const size = stratoFindSize(product, sizeName);
  if (size) return size.price;
  return product.price == null ? null : product.price;
}

function stratoUnitPrice(product, sizeName, totalQty) {
  const base = stratoBasePrice(product, sizeName);
  if (base == null) return null;
  const tier = stratoTierFor(product, totalQty);
  return tier ? Math.round(base * (1 - tier.pct / 100)) : base;
}

function stratoCartDetailed() {
  const lines = stratoGetCart()
    .map((line) => {
      const product = STRATO_PRODUCTS.find((p) => p.id === line.id);
      if (!product) return null;
      return Object.assign({}, line, { product: product });
    })
    .filter(Boolean);

  const totalByProduct = {};
  lines.forEach((l) => {
    totalByProduct[l.id] = (totalByProduct[l.id] || 0) + l.qty;
  });

  lines.forEach((l) => {
    const size = stratoFindSize(l.product, l.size);
    const tier = stratoTierFor(l.product, totalByProduct[l.id]);
    l.key = stratoLineKey(l.id, l.color, l.size);
    l.sizeName = size ? size.name : null; // nombre ya validado contra el producto actual
    l.productQty = totalByProduct[l.id];
    l.pct = tier ? tier.pct : 0;
    l.unitBase = stratoBasePrice(l.product, l.size);
    l.unit = l.unitBase == null ? null : tier ? Math.round(l.unitBase * (1 - tier.pct / 100)) : l.unitBase;
    l.lineBase = l.unitBase == null ? null : l.unitBase * l.qty;
    l.lineTotal = l.unit == null ? null : l.unit * l.qty;
  });

  // Cupón: precio por unidad ya con el cupón (igual al que cobra el servidor).
  const cuponPct = stratoCuponPct();
  lines.forEach((l) => {
    l.unitFinal = l.unit == null ? null : cuponPct ? stratoCuponUnit(l.unit, cuponPct) : l.unit;
    l.lineFinal = l.unitFinal == null ? null : l.unitFinal * l.qty;
  });
  return lines;
}

function stratoCartCount() {
  return stratoGetCart().reduce((sum, l) => sum + l.qty, 0);
}

/* Suma a precio de lista, antes de cualquier descuento. */
function stratoCartListSubtotal() {
  return stratoCartDetailed().reduce((sum, l) => sum + (l.lineBase || 0), 0);
}

/* Subtotal ya con el descuento por cantidad aplicado (sobre esto se calcula el cupón). */
function stratoCartSubtotal() {
  return stratoCartDetailed().reduce((sum, l) => sum + (l.lineTotal || 0), 0);
}

/* Cuánto se ahorra el cliente por comprar en cantidad. */
function stratoCartVolumeDiscount() {
  return Math.max(0, stratoCartListSubtotal() - stratoCartSubtotal());
}

/* Texto "Chico · Negro" que describe la variante de una línea. */
function stratoLineVariantText(line) {
  return [line.sizeName, line.color || line.product.material].filter(Boolean).join(" · ");
}

function stratoEsc(str) {
  return String(str == null ? "" : str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function stratoUpdateCartCount() {
  const count = stratoCartCount();
  document.querySelectorAll(".cart-count").forEach((el) => {
    el.textContent = count;
    el.style.display = count > 0 ? "flex" : "none";
  });
}

/* ---- Placeholder visual reutilizado en carrito / lightbox / grid ---- */
function stratoPlaceholderArt(product, variantIndex) {
  const variant = ((variantIndex || 0) % 4) + 1;
  return (
    '<div class="placeholder-art placeholder-art--' +
    variant +
    '"><span class="layers-mark"><span></span><span></span><span></span></span><small>Foto próximamente</small></div>'
  );
}

/* ---- Foto real si el producto ya tiene imágenes cargadas (admin), si no, placeholder ---- */
function stratoProductMedia(product, variantIndex) {
  if (product && product.images && product.images.length) {
    return '<img src="' + product.images[0] + '" alt="' + (product.name || "").replace(/"/g, "&quot;") + '" loading="lazy">';
  }
  return stratoPlaceholderArt(product, variantIndex);
}

/* ---- Render del panel lateral del carrito ---- */
function stratoRenderCartDrawer() {
  const itemsEl = document.getElementById("cartItems");
  const footEl = document.getElementById("cartFoot");
  if (!itemsEl) return;

  const lines = stratoCartDetailed();

  // Cada cambio vuelve a dibujar el panel: si el foco estaba en un − o + del
  // teclado, se recuerda para devolvérselo al mismo botón (si no, quien usa
  // Tab perdería el lugar en cada click).
  let refocus = null;
  const focused = document.activeElement;
  if (focused && itemsEl.contains(focused) && focused.dataset && (focused.dataset.act === "dec" || focused.dataset.act === "inc")) {
    const row = focused.closest(".cart-item");
    if (row) refocus = { key: row.dataset.key, act: focused.dataset.act };
  }

  if (!lines.length) {
    itemsEl.innerHTML =
      '<div class="cart-drawer__empty"><p class="eyebrow">Tu carrito</p><p>Todavía no agregaste productos.</p><a href="catalogo.html" class="btn btn-ghost btn-sm">Ver catálogo</a></div>';
    if (footEl) footEl.style.display = "none";
    return;
  }

  if (footEl) footEl.style.display = "block";

  itemsEl.innerHTML = lines
    .map((line, i) => {
      const p = line.product;
      let priceHtml;
      if (line.lineTotal == null) {
        priceHtml = stratoEsc(p.priceLabel || "Cotizar");
      } else {
        priceHtml = "$U " + line.lineTotal.toLocaleString("es-UY");
        if (line.pct > 0) {
          priceHtml =
            '<s class="cart-item__price-old">$U ' + line.lineBase.toLocaleString("es-UY") + "</s><br>" +
            priceHtml +
            '<span class="cart-item__disc">-' + line.pct + "% por cantidad</span>";
        }
      }
      return (
        '<div class="cart-item" data-key="' + stratoEsc(line.key) + '">' +
        '<div class="cart-item__thumb">' + stratoProductMedia(p, i) + "</div>" +
        "<div>" +
        '<div class="cart-item__title">' + stratoEsc(p.name) + "</div>" +
        '<div class="cart-item__meta">' + stratoEsc(stratoLineVariantText(line)) + "</div>" +
        '<div class="cart-item__qty">' +
        '<button type="button" data-act="dec" aria-label="Menos">–</button>' +
        '<input type="number" class="cart-item__qty-input" data-act="qty" min="1" max="9999" value="' + line.qty + '" aria-label="Cantidad">' +
        '<button type="button" data-act="inc" aria-label="Más">+</button>' +
        "</div>" +
        '<button type="button" class="cart-item__remove" data-act="remove" aria-label="Quitar ' + stratoEsc(p.name) + '">Quitar</button>' +
        '<div class="cart-item__note">' +
        '<input type="text" class="cart-item__note-input" data-act="note" placeholder="Observación (color, detalle...)" value="' +
        stratoEsc(line.note || "") + '">' +
        "</div>" +
        "</div>" +
        '<div class="cart-item__price">' + priceHtml + "</div>" +
        "</div>"
      );
    })
    .join("");

  const subtotal = stratoCartSubtotal();
  const cuponCode = stratoGetCuponCode();
  const cuponAplicado = cuponCode && STRATO_CUPONES[cuponCode];
  const cuponTxt = cuponAplicado ? cuponCode + " (-" + cuponAplicado.valor + "%)" : "";
  const descuento = stratoCartDescuento();
  const total = stratoCartTotal();

  if (footEl) {
    const cuponHtml = cuponAplicado
      ? '<div class="cart-cupon--applied">' +
        "<span>Cupón <strong>" +
        cuponCode +
        "</strong> aplicado (-" + cuponAplicado.valor + "%)</span>" +
        '<button type="button" onclick="stratoQuitarCupon()">Quitar</button>' +
        "</div>"
      : '<div class="cart-cupon">' +
        '<input type="text" id="cartCuponInput" class="cart-cupon__input" placeholder="Código de descuento" maxlength="30" ' +
        "onkeydown=\"if(event.key==='Enter'){event.preventDefault();stratoAplicarCupon(this);}\">" +
        '<button type="button" class="btn btn-ghost btn-sm" onclick="stratoAplicarCupon(document.getElementById(\'cartCuponInput\'))">Aplicar</button>' +
        "</div>" +
        '<p id="cartCuponFeedback" class="cart-cupon__feedback"></p>';

    // Con descuento por cantidad: "Subtotal" a precio de lista, la fila del
    // ahorro, y después (si hay) el cupón. Sin descuento por cantidad queda
    // exactamente como siempre.
    const ahorroCantidad = stratoCartVolumeDiscount();
    let rowsHtml =
      '<div class="cart-drawer__row"><span>Subtotal</span><span>$U ' + (subtotal + ahorroCantidad).toLocaleString("es-UY") + "</span></div>";
    if (ahorroCantidad > 0) {
      rowsHtml +=
        '<div class="cart-drawer__row cart-drawer__row--descuento"><span>Descuento por cantidad</span><span>-$U ' +
        ahorroCantidad.toLocaleString("es-UY") +
        "</span></div>";
    }
    if (descuento > 0) {
      rowsHtml +=
        '<div class="cart-drawer__row cart-drawer__row--descuento"><span>Cupón ' + cuponTxt + "</span><span>-$U " +
        descuento.toLocaleString("es-UY") +
        "</span></div>";
    }
    rowsHtml += '<div class="cart-drawer__row total"><span>Total</span><span>$U ' + total.toLocaleString("es-UY") + "</span></div>";

    footEl.innerHTML =
      cuponHtml +
      rowsHtml +
      '<p class="muted" style="font-size:0.78rem;margin:0.75rem 0 1rem;">Los productos a cotizar se coordinan por WhatsApp. Envío no incluido.</p>' +
      '<a href="checkout.html" class="btn btn-primary btn-block">Finalizar pedido</a>' +
      '<button type="button" class="btn btn-ghost btn-block cart-drawer__continue" onclick="stratoCloseCart()">Seguir comprando</button>';
  }

  if (refocus) {
    const rows = itemsEl.querySelectorAll(".cart-item");
    for (const row of rows) {
      if (row.dataset.key === refocus.key) {
        const btn = row.querySelector('[data-act="' + refocus.act + '"]');
        if (btn) btn.focus({ preventScroll: true });
        break;
      }
    }
  }
}

/* ---- Apertura / cierre del drawer ---- */
/* Teclado: al abrir el carrito el foco pasa al botón de cerrar, y al cerrarlo
   vuelve a donde estaba. Escape cierra (ver el listener de abajo) y Tab no
   se escapa hacia la página que queda detrás. */
let stratoCartLastFocus = null;
function stratoOpenCart() {
  const drawer = document.getElementById("cartDrawer");
  if (!drawer) return;
  const active = document.activeElement;
  stratoCartLastFocus = active && active !== document.body ? active : null;
  drawer.setAttribute("role", "dialog");
  drawer.setAttribute("aria-label", "Tu carrito");
  drawer.classList.add("open");
  document.getElementById("cartBackdrop").classList.add("open");
  const close = document.getElementById("cartClose");
  if (close) close.focus({ preventScroll: true });
}
function stratoCloseCart() {
  document.getElementById("cartDrawer").classList.remove("open");
  document.getElementById("cartBackdrop").classList.remove("open");
  if (stratoCartLastFocus && stratoCartLastFocus.isConnected) stratoCartLastFocus.focus({ preventScroll: true });
  stratoCartLastFocus = null;
}

/* Escape cierra lo que esté arriba (carrito, o la ficha de producto, o antes
   que nada el desplegable de colores abierto). Tab queda atrapado dentro del
   carrito o de la ficha mientras están abiertos. */
function stratoFocusables(container) {
  return Array.from(
    container.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')
  ).filter((el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden");
}
document.addEventListener("keydown", (e) => {
  const drawer = document.getElementById("cartDrawer");
  const lightbox = document.getElementById("productLightbox");
  const cartOpen = !!(drawer && drawer.classList.contains("open"));
  const lightboxOpen = !!(lightbox && lightbox.classList.contains("open"));

  if (e.key === "Escape") {
    const colorBox = document.querySelector(".color-multiselect.open");
    if (lightboxOpen && colorBox) {
      colorBox.classList.remove("open");
    } else if (cartOpen) {
      stratoCloseCart();
    } else if (lightboxOpen && typeof stratoCloseProduct === "function") {
      stratoCloseProduct();
    } else {
      return;
    }
    e.preventDefault();
    return;
  }

  if (e.key === "Tab" && (cartOpen || lightboxOpen)) {
    const container = cartOpen ? drawer : lightbox.querySelector(".lightbox__panel");
    if (!container) return;
    const items = stratoFocusables(container);
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (!container.contains(active)) {
      e.preventDefault();
      (e.shiftKey ? last : first).focus();
    } else if (e.shiftKey && (active === first || active === container)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  }
});

/* ---- Toast simple ---- */
function stratoShowToast(message) {
  let toast = document.querySelector(".toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.className = "toast";
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => toast.classList.remove("show"), 2200);
}

/* ---- Link de WhatsApp con mensaje precargado ---- */
function stratoWhatsAppLink(message) {
  return "https://wa.me/" + STRATO_WHATSAPP_NUMBER + "?text=" + encodeURIComponent(message);
}

/* Llamado desde main.js una vez que el catálogo (estático o en vivo) está
   listo, así el carrito ya puede resolver nombres/precios/fotos de producto. */
let stratoCartEventsReady = false;
function stratoInitCartEvents() {
  const itemsEl = document.getElementById("cartItems");
  if (!itemsEl || stratoCartEventsReady) return;
  stratoCartEventsReady = true;

  const lineOf = (el) => {
    const row = el.closest(".cart-item");
    return row ? row.dataset.key : null;
  };
  const currentQty = (key) => {
    const line = stratoGetCart().find((l) => stratoLineKey(l.id, l.color, l.size) === key);
    return line ? line.qty : 0;
  };

  itemsEl.addEventListener("click", (e) => {
    const actEl = e.target.closest("[data-act]");
    if (!actEl) return;
    const key = lineOf(actEl);
    if (!key) return;
    const act = actEl.dataset.act;
    if (act === "dec") stratoUpdateLineQtyByKey(key, currentQty(key) - 1);
    else if (act === "inc") stratoUpdateLineQtyByKey(key, currentQty(key) + 1);
    else if (act === "remove") stratoRemoveLineByKey(key);
  });

  // Cantidad escrita a mano (útil para pedidos de 20, 50, 100 unidades).
  itemsEl.addEventListener("change", (e) => {
    const el = e.target.closest('[data-act="qty"]');
    if (!el) return;
    const key = lineOf(el);
    if (!key) return;
    let qty = parseInt(el.value, 10);
    if (isNaN(qty) || qty < 1) qty = 1;
    stratoUpdateLineQtyByKey(key, Math.min(qty, 9999));
  });

  itemsEl.addEventListener("input", (e) => {
    const el = e.target.closest('[data-act="note"]');
    if (!el) return;
    const key = lineOf(el);
    if (key) stratoSetLineNoteByKey(key, el.value);
  });
}

function stratoInitCartUI() {
  stratoInitCartEvents();
  stratoUpdateCartCount();
  stratoRenderCartDrawer();

  const cartToggle = document.getElementById("cartToggle");
  const cartClose = document.getElementById("cartClose");
  const cartBackdrop = document.getElementById("cartBackdrop");
  if (cartToggle) cartToggle.addEventListener("click", stratoOpenCart);
  if (cartClose) cartClose.addEventListener("click", stratoCloseCart);
  if (cartBackdrop) cartBackdrop.addEventListener("click", stratoCloseCart);
}
