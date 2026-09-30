/* ==========================================================================
   STORGE LAB — render de productos, filtros de catálogo y lightbox de producto
   ========================================================================== */

function stratoCategoryName(slug) {
  const cat = STRATO_CATEGORIES.find((c) => c.slug === slug);
  return cat ? cat.name : "";
}

/* Un producto puede estar en más de una categoría (producto_categorias es
   una relación muchos-a-muchos) — esto arma el texto "Decoración · Jardín"
   que se muestra en la tarjeta y en el lightbox. */
function stratoCategoryNames(product) {
  const cats = (product && product.categories) || [];
  return cats
    .map((slug) => stratoCategoryName(slug))
    .filter(Boolean)
    .join(" · ");
}

/* ---- Galería de fotos: cuando el producto tiene más de una imagen, se
   pueden pasar con flechas o puntitos, tanto en la tarjeta del catálogo
   como en el lightbox de "ver producto". data-product-id identifica el
   producto para que un solo listener delegado (stratoInitGalleries)
   sirva a todas las instancias, sin re-atarlo en cada render. ---- */
function stratoGalleryHtml(product) {
  const images = (product && product.images) || [];
  if (!images.length) return '<div class="product-gallery">' + stratoPlaceholderArt(product, 0) + "</div>";

  const alt = (product.name || "").replace(/"/g, "&quot;");
  let html = '<div class="product-gallery" data-product-id="' + product.id + '" data-index="0">';
  html += '<div class="product-gallery__track"><img src="' + images[0] + '" alt="' + alt + '" loading="lazy"></div>';
  if (images.length > 1) {
    html +=
      '<button type="button" class="product-gallery__nav product-gallery__nav--prev" aria-label="Foto anterior">‹</button>' +
      '<button type="button" class="product-gallery__nav product-gallery__nav--next" aria-label="Foto siguiente">›</button>' +
      '<div class="product-gallery__dots">' +
      images.map((_, i) => '<span class="product-gallery__dot' + (i === 0 ? " active" : "") + '"></span>').join("") +
      "</div>";
  }
  html += "</div>";
  return html;
}

function stratoGallerySetIndex(wrapper, index) {
  const product = STRATO_PRODUCTS.find((p) => p.id === wrapper.dataset.productId);
  if (!product || !product.images || !product.images.length) return;
  const total = product.images.length;
  index = ((index % total) + total) % total;
  wrapper.dataset.index = index;
  const img = wrapper.querySelector(".product-gallery__track img");
  if (img) img.src = product.images[index];
  wrapper.querySelectorAll(".product-gallery__dot").forEach((dot, i) => dot.classList.toggle("active", i === index));
}

/* Un solo listener delegado (fase de captura, para adelantarse al onclick
   de .product-card__frame que abre el lightbox) cubre todas las galerías
   de la página, incluso las que se re-dibujan al filtrar. */
let stratoGalleriesReady = false;
function stratoInitGalleries() {
  if (stratoGalleriesReady) return;
  stratoGalleriesReady = true;
  document.addEventListener(
    "click",
    (e) => {
      const wrapper = e.target.closest(".product-gallery");
      if (!wrapper) return;
      const nav = e.target.closest(".product-gallery__nav");
      const dot = e.target.closest(".product-gallery__dot");
      if (!nav && !dot) return;
      e.preventDefault();
      e.stopPropagation();
      if (nav) {
        const current = parseInt(wrapper.dataset.index || "0", 10);
        stratoGallerySetIndex(wrapper, current + (nav.classList.contains("product-gallery__nav--prev") ? -1 : 1));
      } else {
        const dots = Array.from(wrapper.querySelectorAll(".product-gallery__dot"));
        stratoGallerySetIndex(wrapper, dots.indexOf(dot));
      }
    },
    true
  );
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
    stratoGalleryHtml(product) +
    '<div class="product-card__overlay"><span>Ver producto</span></div>' +
    "</div>" +
    '<div class="product-card__body">' +
    '<div class="product-card__cat">' +
    stratoCategoryNames(product) +
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

/* ---- Carrusel de categorías del home: lee STRATO_CATEGORIES (la lista
   real, con foto de portada si el admin le cargó una) y arma una tira que
   se desplaza sola en loop infinito. La lista se duplica una vez para que
   el salto de "vuelta al principio" sea invisible (CSS anima -50% de un
   track que mide el doble del ancho real). ---- */
function stratoRenderCategoryCarousel() {
  const track = document.getElementById("categoryCarouselTrack");
  if (!track || !STRATO_CATEGORIES.length) return;

  const cardHtml = (c, i) => {
    const style = c.image ? ' style="background-image:url(&quot;' + c.image + '&quot;)"' : "";
    const cls = "category-card" + (c.image ? "" : " category-card--g" + (i % 5));
    return (
      '<a class="' + cls + '" href="catalogo.html?cat=' + c.slug + '"' + style + ">" +
      '<span class="category-card__label">' + c.name + (c.short ? "<span>" + c.short + "</span>" : "") + "</span>" +
      "</a>"
    );
  };

  const cards = STRATO_CATEGORIES.map(cardHtml);
  track.innerHTML = cards.join("") + cards.join(""); // duplicado para el loop
  // Velocidad proporcional a la cantidad de categorías: parejo con 5 o con 15.
  track.style.animationDuration = Math.max(STRATO_CATEGORIES.length * 4, 14) + "s";
}

/* ---- Catálogo con filtro por categoría (multiselección: se puede elegir
   más de una a la vez y se ve la unión de ambas — un producto que ya
   pertenece a varias categorías aparece si CUALQUIERA de ellas está
   marcada). El set vacío equivale a "Todos". La selección se refleja en
   la URL como ?cat=a,b para poder compartir/recargar el filtro. ---- */
function stratoInitCatalog() {
  const grid = document.getElementById("productGrid");
  if (!grid) return;

  const params = new URLSearchParams(window.location.search);
  const initial = (params.get("cat") || "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s && s !== "todos");
  const activeCats = new Set(initial);

  function syncUrl() {
    const url = new URL(window.location);
    if (activeCats.size) url.searchParams.set("cat", Array.from(activeCats).join(","));
    else url.searchParams.delete("cat");
    window.history.replaceState({}, "", url);
  }

  function apply() {
    const list = !activeCats.size
      ? STRATO_PRODUCTS
      : STRATO_PRODUCTS.filter((p) => (p.categories || []).some((c) => activeCats.has(c)));
    stratoRenderGrid("productGrid", list);
    const countEl = document.getElementById("filterCount");
    if (countEl) countEl.textContent = list.length + (list.length === 1 ? " producto" : " productos");
    document.querySelectorAll(".filter-tabs button").forEach((b) => {
      const isTodos = b.dataset.cat === "todos";
      b.classList.toggle("active", isTodos ? !activeCats.size : activeCats.has(b.dataset.cat));
    });
  }

  document.querySelectorAll(".filter-tabs button").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn.dataset.cat === "todos") {
        activeCats.clear();
      } else if (activeCats.has(btn.dataset.cat)) {
        activeCats.delete(btn.dataset.cat);
      } else {
        activeCats.add(btn.dataset.cat);
      }
      syncUrl();
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

  document.getElementById("lbMedia").innerHTML = stratoGalleryHtml(product);
  document.getElementById("lbCat").textContent = stratoCategoryNames(product);
  document.getElementById("lbTitle").textContent = product.name;
  document.getElementById("lbPrice").textContent = stratoFormatPrice(product);
  // La descripción se carga desde el editor con formato del admin (negrita,
  // cursiva, subrayado, saltos de línea) y ya viene sanitizada al guardarse
  // allá — por eso innerHTML acá, y no textContent.
  document.getElementById("lbDesc").innerHTML = product.description || "";
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
  stratoRenderCategoryCarousel();
  stratoInitGalleries();
  stratoInitCatalog();
  stratoInitFeatured();

  const lbClose = document.getElementById("lbClose");
  const lbBackdrop = document.getElementById("lbBackdrop");
  if (lbClose) lbClose.addEventListener("click", stratoCloseProduct);
  if (lbBackdrop) lbBackdrop.addEventListener("click", stratoCloseProduct);
}
