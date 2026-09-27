/* ==========================================================================
   STORGE LAB — carrito de compras
   Persiste en localStorage. No depende de backend: pensado para arrancar
   ya mismo con checkout por WhatsApp, y poder sumar Mercado Pago más
   adelante (como hizo RGOL.UY) sin tener que rehacer esta parte.
   ========================================================================== */

/* ---- Configuración: reemplazar con los datos reales del negocio ---- */
const STRATO_WHATSAPP_NUMBER = "59800000000"; // TODO: número real, formato 598XXXXXXXX
const STRATO_INSTAGRAM = "storge.lab"; // TODO: usuario real de Instagram (ya confirmado: @storge.lab)

const CART_KEY = "strato_cart_v1";

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

function stratoLineKey(productId, color) {
  return productId + "::" + (color || "default");
}

function stratoAddToCart(productId, qty, color) {
  const cart = stratoGetCart();
  const key = stratoLineKey(productId, color);
  const existing = cart.find((l) => stratoLineKey(l.id, l.color) === key);
  if (existing) {
    existing.qty += qty;
  } else {
    cart.push({ id: productId, qty: qty, color: color || null });
  }
  stratoSaveCart(cart);
  stratoRenderCartDrawer();
  stratoShowToast("Agregado al carrito");
}

function stratoUpdateLineQty(productId, color, qty) {
  let cart = stratoGetCart();
  const key = stratoLineKey(productId, color);
  if (qty <= 0) {
    cart = cart.filter((l) => stratoLineKey(l.id, l.color) !== key);
  } else {
    const line = cart.find((l) => stratoLineKey(l.id, l.color) === key);
    if (line) line.qty = qty;
  }
  stratoSaveCart(cart);
  stratoRenderCartDrawer();
}

function stratoRemoveLine(productId, color) {
  stratoUpdateLineQty(productId, color, 0);
}

function stratoClearCart() {
  localStorage.removeItem(CART_KEY);
  stratoUpdateCartCount();
}

function stratoCartDetailed() {
  const cart = stratoGetCart();
  return cart
    .map((line) => {
      const product = STRATO_PRODUCTS.find((p) => p.id === line.id);
      if (!product) return null;
      return Object.assign({}, line, { product: product });
    })
    .filter(Boolean);
}

function stratoCartCount() {
  return stratoGetCart().reduce((sum, l) => sum + l.qty, 0);
}

function stratoCartSubtotal() {
  return stratoCartDetailed().reduce((sum, l) => {
    const price = l.product.price || 0;
    return sum + price * l.qty;
  }, 0);
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
      const priceText = p.price != null ? "$U " + (p.price * line.qty).toLocaleString("es-UY") : p.priceLabel || "Cotizar";
      return (
        '<div class="cart-item">' +
        '<div class="cart-item__thumb">' +
        stratoProductMedia(p, i) +
        "</div>" +
        "<div>" +
        '<div class="cart-item__title">' +
        p.name +
        "</div>" +
        '<div class="cart-item__meta">' +
        (line.color ? line.color : p.material) +
        "</div>" +
        '<div class="cart-item__qty">' +
        '<button onclick="stratoUpdateLineQty(\'' +
        p.id +
        "', " +
        (line.color ? "'" + line.color + "'" : "null") +
        ", " +
        (line.qty - 1) +
        ')">–</button>' +
        "<span>" +
        line.qty +
        "</span>" +
        '<button onclick="stratoUpdateLineQty(\'' +
        p.id +
        "', " +
        (line.color ? "'" + line.color + "'" : "null") +
        ", " +
        (line.qty + 1) +
        ')">+</button>' +
        "</div>" +
        '<a class="cart-item__remove" onclick="stratoRemoveLine(\'' +
        p.id +
        "', " +
        (line.color ? "'" + line.color + "'" : "null") +
        ')">Quitar</a>' +
        "</div>" +
        '<div class="cart-item__price">' +
        priceText +
        "</div>" +
        "</div>"
      );
    })
    .join("");

  const subtotal = stratoCartSubtotal();
  if (footEl) {
    footEl.innerHTML =
      '<div class="cart-drawer__row total"><span>Subtotal</span><span>$U ' +
      subtotal.toLocaleString("es-UY") +
      "</span></div>" +
      '<p class="muted" style="font-size:0.78rem;margin-bottom:1rem;">Los productos a cotizar se coordinan por WhatsApp. Envío no incluido.</p>' +
      '<a href="checkout.html" class="btn btn-primary btn-block">Finalizar pedido</a>';
  }
}

/* ---- Apertura / cierre del drawer ---- */
function stratoOpenCart() {
  document.getElementById("cartDrawer").classList.add("open");
  document.getElementById("cartBackdrop").classList.add("open");
}
function stratoCloseCart() {
  document.getElementById("cartDrawer").classList.remove("open");
  document.getElementById("cartBackdrop").classList.remove("open");
}

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
function stratoInitCartUI() {
  stratoUpdateCartCount();
  stratoRenderCartDrawer();

  const cartToggle = document.getElementById("cartToggle");
  const cartClose = document.getElementById("cartClose");
  const cartBackdrop = document.getElementById("cartBackdrop");
  if (cartToggle) cartToggle.addEventListener("click", stratoOpenCart);
  if (cartClose) cartClose.addEventListener("click", stratoCloseCart);
  if (cartBackdrop) cartBackdrop.addEventListener("click", stratoCloseCart);
}
