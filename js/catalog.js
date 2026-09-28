/* ==========================================================================
   STORGE LAB — render de productos, filtros de catálogo y lightbox de producto
   ========================================================================== */

function stratoCategoryName(slug) {
  const cat = STRATO_CATEGORIES.find((c) => c.slug === slug);
  return cat ? cat.name : "";
}

function stratoProductCard(product, index) {
  const priceText = stratoFormatPrice(product);
  const tagHtml = product.tag ? '<span class="product-card__tag">' + product.tag + "</span>" : "";
  return (
    '<div class="product-card reveal in">' +
    '<div class="product-card__frame" onclick="stratoOpenProduct(\'' +
    product.id +
    "')\">" +
    tagHtml +
    stratoProductMedia(product, index) +
    '<div class="product-card__overlay"><span>Ver producto</span></div>' +
    "</div>" +
    '<div class="product-card__body">' +
    '<div class="product-card__cat">' +
    stratoCategoryName(product.category) +
    "</div>" +
    '<h3 class="product-card__title">' +
    product.name +
    "</h3>" +
    '<div class="product-card__foot">' +
    '<span class="product-card__price">' +
    priceText +
    "</span>" +
    '<button class="btn btn-sm btn-ghost" onclick="event.stopPropagation(); stratoQuickAdd(\'' +
    product.id +
    "')\">Agregar</button>" +
    "</div>" +
    "</div>" +
    "</div>"
  );
}

function stratoRenderGrid(containerId, list) {
  const el = document.getElementById(containerId);
  if (!el) return;
  if (!list.length) {
    el.innerHTML = '<p class="muted">No hay productos en esta categoría todavía.</p>';
    return;
  }
  el.innerHTML = list.map((p, i) => stratoProductCard(p, i)).join("");
}

function stratoQuickAdd(id) {
  stratoAddToCart(id, 1, null);
}

/* ---- Barra de filtros del catálogo + lista "Categorías" del footer.
   Se arman siempre a partir de STRATO_CATEGORIES (la lista real que trae
   supabase-client.js, o la de respaldo de products.js si Supabase no
   respondió), así una categoría nueva creada desde el panel admin aparece
   sola en el sitio — no hace falta tocar HTML en cada página. */
function stratoRenderCategoryNav() {
  const tabs = document.getElementById("filterTabs");
  if (tabs) {
    tabs.innerHTML =
      '<button data-cat="todos">Todos</button>' +
      STRATO_CATEGORIES.map((c) => '<button data-cat="' + c.slug + '">' + c.name + "</button>").join("");
  }

  const footerCats = document.getElementById("footerCategories");
  if (footerCats) {
    footerCats.innerHTML = STRATO_CATEGORIES.map(
      (c) => '<li><a href="catalogo.html?cat=' + c.slug + '">' + c.name + "</a></li>"
    ).join("");
  }
}

/* ---- Catálogo con filtro por categoría ---- */
function stratoInitCatalog() {
  const grid = document.getElementById("productGrid");
  if (!grid) return;

  const params = new URLSearchParams(window.location.search);
  let activeCat = params.get("cat") || "todos";

  function apply() {
    const list = activeCat === "todos" ? STRATO_PRODUCTS : STRATO_PRODUCTS.filter((p) => p.category === activeCat);
    stratoRenderGrid("productGrid", list);
    const countEl = document.getElementById("filterCount");
    if (countEl) countEl.textContent = list.length + (list.length === 1 ? " producto" : " productos");
    document.querySelectorAll(".filter-tabs button").forEach((b) => {
      b.classList.toggle("active", b.dataset.cat === activeCat);
    });
  }

  document.querySelectorAll(".filter-tabs button").forEach((btn) => {
    btn.addEventListener("click", () => {
      activeCat = btn.dataset.cat;
      const url = new URL(window.location);
      if (activeCat === "todos") url.searchParams.delete("cat");
      else url.searchParams.set("cat", activeCat);
      window.history.replaceState({}, "", url);
      apply();
    });
  });

  apply();
}

/* ---- Destacados en la home ---- */
function stratoInitFeatured() {
  const el = document.getElementById("featuredGrid");
  if (!el) return;
  const featured = STRATO_PRODUCTS.filter((p) => p.tag === "Destacado").slice(0, 4);
  stratoRenderGrid("featuredGrid", featured.length ? featured : STRATO_PRODUCTS.slice(0, 4));
}

/* ---- Lightbox de producto ---- */
let stratoCurrentProduct = null;

function stratoOpenProduct(id) {
  const product = STRATO_PRODUCTS.find((p) => p.id === id);
  if (!product) return;
  const lightbox = document.getElementById("productLightbox");
  if (!lightbox) {
    window.location.href = "catalogo.html?producto=" + id;
    return;
  }
  stratoCurrentProduct = product;

  document.getElementById("lbMedia").innerHTML = stratoProductMedia(product, 0);
  document.getElementById("lbCat").textContent = stratoCategoryName(product.category);
  document.getElementById("lbTitle").textContent = product.name;
  document.getElementById("lbPrice").textContent = stratoFormatPrice(product);
  document.getElementById("lbDesc").textContent = product.description;
  document.getElementById("lbMaterial").textContent = "Material: " + product.material;

  const colorWrap = document.getElementById("lbColors");
  colorWrap.innerHTML = "";
  if (product.colors && product.colors.length) {
    product.colors.forEach((c, i) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "btn btn-sm btn-ghost" + (i === 0 ? " active" : "");
      btn.textContent = c;
      btn.addEventListener("click", () => {
        colorWrap.querySelectorAll("button").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        lightbox.dataset.color = c;
      });
      colorWrap.appendChild(btn);
    });
    lightbox.dataset.color = product.colors[0];
  } else {
    lightbox.dataset.color = "";
  }

  lightbox.dataset.qty = "1";
  document.getElementById("lbQty").textContent = "1";

  lightbox.classList.add("open");
  document.body.style.overflow = "hidden";
}

function stratoCloseProduct() {
  const lightbox = document.getElementById("productLightbox");
  if (lightbox) lightbox.classList.remove("open");
  document.body.style.overflow = "";
}

function stratoChangeQty(delta) {
  const lightbox = document.getElementById("productLightbox");
  let qty = parseInt(lightbox.dataset.qty || "1", 10) + delta;
  if (qty < 1) qty = 1;
  lightbox.dataset.qty = qty;
  document.getElementById("lbQty").textContent = qty;
}

function stratoAddCurrentToCart() {
  const lightbox = document.getElementById("productLightbox");
  if (!stratoCurrentProduct) return;
  const qty = parseInt(lightbox.dataset.qty || "1", 10);
  const color = lightbox.dataset.color || null;
  stratoAddToCart(stratoCurrentProduct.id, qty, color);
  stratoCloseProduct();
  stratoOpenCart();
}

/* Llamado desde main.js una vez que el catálogo (estático o en vivo) está listo. */
function stratoInitProductUI() {
  stratoRenderCategoryNav();
  stratoInitCatalog();
  stratoInitFeatured();

  const lbClose = document.getElementById("lbClose");
  const lbBackdrop = document.getElementById("lbBackdrop");
  if (lbClose) lbClose.addEventListener("click", stratoCloseProduct);
  if (lbBackdrop) lbBackdrop.addEventListener("click", stratoCloseProduct);
}
