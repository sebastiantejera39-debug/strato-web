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
    '<h3 class="product-card__title"><button type="button" class="product-card__title-btn" onclick="stratoOpenProduct(\'' +
    product.id +
    "')\">" +
    product.name +
    "</button></h3>" +
    (stratoProductTiers(product).length ? '<div class="product-card__bulk">Descuento por cantidad</div>' : "") +
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
  const product = STRATO_PRODUCTS.find((p) => p.id === id);
  // Con tamaños el cliente tiene que elegir uno (cada uno tiene su precio):
  // en vez de agregar a ciegas, se abre la ficha del producto.
  if (product && product.sizes && product.sizes.length) {
    stratoOpenProduct(id);
    return;
  }
  stratoAddToCart(id, 1, null, null);
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
   real, con foto de portada si el admin le cargó una) y arma una tira dentro
   de un contenedor con scroll horizontal NATIVO:
   - celular: se desliza con el dedo;
   - PC: se arrastra con el mouse apretado, con las flechas de los costados
     o con el trackpad;
   - además avanza solo, despacio, y se detiene con el mouse encima, al tocarlo
     o arrastrarlo, con el foco del teclado, y no avanza solo si el sistema
     pide "reducir movimiento" (sigue pudiéndose mover a mano).
   La lista se repite varias veces (1 real, con links y foco; el resto son
   copias decorativas, aria-hidden y sin foco) para que no tenga principio ni
   fin: cuando la posición se aleja de la copia real, se la devuelve a ella
   sin que se note (todas las copias son idénticas y miden lo mismo). ---- */
let stratoCarouselStop = null;
function stratoRenderCategoryCarousel() {
  const track = document.getElementById("categoryCarouselTrack");
  if (!track || !STRATO_CATEGORIES.length) return;
  const scroller = track.parentElement;
  const band = scroller.closest(".category-band") || scroller.parentElement;
  if (stratoCarouselStop) stratoCarouselStop(); // si se vuelve a dibujar, se desarma lo anterior

  const n = STRATO_CATEGORIES.length;
  const LEFT = 2; // copias a la izquierda de la real (margen para deslizar hacia atrás)
  const SPEED = 45; // px por segundo del avance automático
  const RESUME_TOUCH = 3000; // ms que espera para volver a avanzar solo después de tocarlo
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const ac = typeof AbortController === "function" ? new AbortController() : null;
  const on = (el, type, fn, opts) => el.addEventListener(type, fn, ac ? Object.assign({ signal: ac.signal }, opts || {}) : opts);

  const cardHtml = (c, i, real) => {
    const style = c.image ? ' style="background-image:url(&quot;' + c.image + '&quot;)"' : "";
    const cls = "category-card" + (c.image ? "" : " category-card--g" + (i % 5));
    return (
      '<a class="' + cls + '" href="catalogo.html?cat=' + c.slug + '"' + style + ' draggable="false"' +
      (real ? "" : ' aria-hidden="true" tabindex="-1"') + ">" +
      '<span class="category-card__label">' + c.name + (c.short ? "<span>" + c.short + "</span>" : "") + "</span>" +
      "</a>"
    );
  };
  const setHtml = (real) => STRATO_CATEGORIES.map((c, i) => cardHtml(c, i, real)).join("");
  const build = (rightCopies) => {
    let html = "";
    for (let k = 0; k < LEFT; k++) html += setHtml(false);
    html += setHtml(true);
    for (let k = 0; k < rightCopies; k++) html += setHtml(false);
    track.innerHTML = html;
  };

  scroller.setAttribute("role", "group");
  scroller.setAttribute("aria-roledescription", "carrusel");
  scroller.setAttribute("aria-label", "Categorías");

  let S = 0; // ancho de UNA copia de la lista (tarjetas + espacios), medido
  let V = 0; // ancho visible
  let pos = 0; // posición "real" (decimal) del avance automático
  let lastSet = 0; // última posición que puso el código (para distinguirla de la del usuario)
  let rightCopies = 2;

  const wrap = (v) => LEFT * S + ((((v - LEFT * S) % S) + S) % S);
  const setScroll = (v) => {
    lastSet = v;
    scroller.scrollLeft = v;
  };
  const measure = () => {
    V = scroller.clientWidth;
    const a = track.children[0];
    const b = track.children[n];
    if (!a || !b) return false;
    S = b.getBoundingClientRect().left - a.getBoundingClientRect().left;
    return S > 0;
  };
  // Arma las copias necesarias (las de la derecha tienen que cubrir al menos un ancho de pantalla
  // más margen) y coloca la tira en la copia real; `rel` (0–1) conserva el avance al redimensionar.
  const setup = (rel) => {
    rightCopies = 2;
    build(rightCopies);
    if (!measure()) return;
    const need = Math.ceil(V / S) + 2;
    if (need !== rightCopies) {
      rightCopies = need;
      build(rightCopies);
      measure();
    }
    pos = LEFT * S + (rel || 0) * S;
    setScroll(pos);
  };

  /* ---- Estado de pausa ---- */
  let hovering = false;
  let touching = false;
  let dragging = false;
  let focusInside = false;
  let visible = true;
  let resumeAt = 0;
  let idleTimer = 0;
  const holdFor = (ms) => {
    resumeAt = Math.max(resumeAt, performance.now() + ms);
  };

  /* ---- Avance automático ---- */
  let raf = 0;
  let last = 0;
  const tick = (t) => {
    raf = requestAnimationFrame(tick);
    const dt = Math.min(0.1, (t - last) / 1000);
    last = t;
    if (!S || reduceMotion.matches || !visible || document.hidden) return;
    if (hovering || touching || dragging || focusInside || performance.now() < resumeAt) return;
    pos = wrap(pos + SPEED * dt);
    setScroll(pos);
  };

  /* ---- Lo que mueve el usuario (dedo, arrastre, flechas, trackpad, teclado) ---- */
  on(scroller, "scroll", () => {
    if (Math.abs(scroller.scrollLeft - lastSet) < 1.5) return; // lo movió el avance automático
    pos = scroller.scrollLeft;
    lastSet = pos;
    holdFor(RESUME_TOUCH);
    clearTimeout(idleTimer);
    // Cuando termina de moverse, se lo devuelve a la copia real (sin que se note).
    idleTimer = setTimeout(() => {
      if (touching || dragging || !S) return;
      const w = wrap(scroller.scrollLeft);
      if (Math.abs(w - scroller.scrollLeft) > 0.5) setScroll(w);
      pos = w;
    }, 160);
  }, { passive: true });

  /* Mouse: arrastrar apretando. Dedo: deslizar nativo (solo se detiene el avance). */
  let drag = null;
  let suppressClick = false;
  on(scroller, "pointerdown", (e) => {
    suppressClick = false;
    if (e.pointerType !== "mouse") {
      touching = true;
      return;
    }
    if (e.button !== 0) return;
    drag = { id: e.pointerId, x: e.clientX, left: scroller.scrollLeft, moved: false };
  });
  on(scroller, "pointermove", (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x;
    if (!drag.moved) {
      if (Math.abs(dx) < 6) return;
      drag.moved = true;
      dragging = true;
      suppressClick = true; // lo que sigue al soltar es el final de un arrastre, no un clic en la tarjeta
      scroller.classList.add("is-dragging");
      try { scroller.setPointerCapture(e.pointerId); } catch (_) {}
    }
    scroller.scrollLeft = drag.left - dx;
  });
  const endPress = (e) => {
    if (e.pointerType !== "mouse") {
      touching = false;
      holdFor(RESUME_TOUCH);
    }
    if (!drag) return;
    if (drag.moved) {
      dragging = false;
      scroller.classList.remove("is-dragging");
      try { scroller.releasePointerCapture(drag.id); } catch (_) {}
      holdFor(1200);
    }
    drag = null;
  };
  on(scroller, "pointerup", endPress);
  on(scroller, "pointercancel", endPress);
  on(scroller, "click", (e) => {
    if (suppressClick) {
      e.preventDefault();
      e.stopPropagation();
      suppressClick = false;
    }
  }, true);
  on(scroller, "keydown", () => { suppressClick = false; });
  on(scroller, "dragstart", (e) => e.preventDefault());

  /* Pausas: mouse encima (incluye las flechas) y foco del teclado. */
  on(band, "pointerenter", (e) => { if (e.pointerType === "mouse") hovering = true; });
  on(band, "pointerleave", (e) => {
    if (e.pointerType === "mouse") {
      hovering = false;
      holdFor(500);
    }
  });
  on(scroller, "focusin", () => { focusInside = true; });
  on(scroller, "focusout", (e) => {
    focusInside = !!(e.relatedTarget && scroller.contains(e.relatedTarget));
    if (!focusInside) holdFor(1000);
  });

  /* Flechas (solo se ven con mouse; ver CSS): una tarjeta por clic. */
  band.querySelectorAll(".category-band__nav").forEach((b) => b.remove());
  const mkNav = (dir) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "category-band__nav category-band__nav--" + (dir < 0 ? "prev" : "next");
    b.setAttribute("aria-label", dir < 0 ? "Categorías anteriores" : "Categorías siguientes");
    b.textContent = dir < 0 ? "‹" : "›";
    on(b, "click", () => {
      if (!S) return;
      holdFor(RESUME_TOUCH);
      scroller.scrollBy({ left: dir * (S / n), behavior: reduceMotion.matches ? "auto" : "smooth" });
    });
    return b;
  };
  band.appendChild(mkNav(-1));
  band.appendChild(mkNav(1));

  /* Solo avanza mientras se ve en pantalla; si cambia el ancho, se rearma. */
  let io = null;
  if ("IntersectionObserver" in window) {
    io = new IntersectionObserver((entries) => { visible = entries[entries.length - 1].isIntersecting; });
    io.observe(scroller);
  }
  let ro = null;
  let resizeTimer = 0;
  if ("ResizeObserver" in window) {
    ro = new ResizeObserver(() => {
      if (scroller.clientWidth === V) return;
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        const rel = S ? (((scroller.scrollLeft - LEFT * S) % S) + S) % S / S : 0;
        setup(rel);
      }, 150);
    });
    ro.observe(scroller);
  }

  setup(0);
  raf = requestAnimationFrame((t) => { last = t; raf = requestAnimationFrame(tick); });

  stratoCarouselStop = () => {
    cancelAnimationFrame(raf);
    clearTimeout(idleTimer);
    clearTimeout(resizeTimer);
    if (ac) ac.abort();
    if (io) io.disconnect();
    if (ro) ro.disconnect();
    band.querySelectorAll(".category-band__nav").forEach((b) => b.remove());
    stratoCarouselStop = null;
  };
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
let stratoLastFocus = null;

/* Los bloques nuevos de la ficha (tamaños, descuentos por cantidad, total y
   cantidad editable) se crean desde acá en vez de estar escritos en cada
   HTML: así index.html y catalogo.html no necesitan cambios cada vez que la
   ficha suma algo, y no se pueden desincronizar entre sí. */
function stratoEnsureLightboxExtras() {
  const colors = document.getElementById("lbColors");
  if (!colors) return;

  // Accesibilidad: la ficha es un diálogo con nombre, y los − / + tienen
  // etiqueta (en el HTML solo dicen "–" y "+").
  const lb = document.getElementById("productLightbox");
  if (lb && !lb.hasAttribute("role")) {
    lb.setAttribute("role", "dialog");
    lb.setAttribute("aria-modal", "true");
    lb.setAttribute("aria-labelledby", "lbTitle");
    const qtyBtns = lb.querySelectorAll(".lightbox__qty button");
    if (qtyBtns[0]) qtyBtns[0].setAttribute("aria-label", "Menos");
    if (qtyBtns[1]) qtyBtns[1].setAttribute("aria-label", "Más");
  }

  if (!document.getElementById("lbSizes")) {
    const d = document.createElement("div");
    d.id = "lbSizes";
    d.className = "lightbox__sizes";
    colors.parentNode.insertBefore(d, colors);
  }
  if (!document.getElementById("lbTiers")) {
    const d = document.createElement("div");
    d.id = "lbTiers";
    d.className = "lightbox__tiers";
    colors.parentNode.insertBefore(d, colors);
  }

  // Cantidad: el <span> de siempre pasa a ser un campo numérico (se puede
  // escribir 50 o 100 directamente en vez de apretar "+" muchas veces).
  const qtyEl = document.getElementById("lbQty");
  if (qtyEl && qtyEl.tagName !== "INPUT") {
    const input = document.createElement("input");
    input.type = "number";
    input.id = "lbQty";
    input.className = "lightbox__qty-input";
    input.min = "1";
    input.max = "9999";
    input.value = "1";
    input.setAttribute("aria-label", "Cantidad");
    qtyEl.replaceWith(input);
    input.addEventListener("input", () => {
      const lightbox = document.getElementById("productLightbox");
      let qty = parseInt(input.value, 10);
      if (isNaN(qty) || qty < 1) qty = 1;
      lightbox.dataset.qty = Math.min(qty, 9999);
      stratoRefreshLightboxPrice();
    });
    input.addEventListener("change", () => {
      input.value = document.getElementById("productLightbox").dataset.qty || "1";
    });
  }

  const qtyRow = document.querySelector("#productLightbox .lightbox__qty");
  if (qtyRow && !document.getElementById("lbTotal")) {
    const t = document.createElement("span");
    t.id = "lbTotal";
    t.className = "lightbox__total";
    qtyRow.appendChild(t);
  }
}

function stratoOpenProduct(id) {
  const product = STRATO_PRODUCTS.find((p) => p.id === id);
  if (!product) return;
  const lightbox = document.getElementById("productLightbox");
  if (!lightbox) {
    window.location.href = "catalogo.html?producto=" + id;
    return;
  }
  stratoCurrentProduct = product;
  stratoEnsureLightboxExtras();

  document.getElementById("lbMedia").innerHTML = stratoGalleryHtml(product);
  document.getElementById("lbCat").textContent = stratoCategoryNames(product);
  document.getElementById("lbTitle").textContent = product.name;
  document.getElementById("lbPrice").textContent = stratoFormatPrice(product);
  // La descripción se carga desde el editor con formato del admin (negrita,
  // cursiva, subrayado, saltos de línea) y ya viene sanitizada al guardarse
  // allá — por eso innerHTML acá, y no textContent.
  document.getElementById("lbDesc").innerHTML = product.description || "";
  stratoResetLightboxDesc();
  document.getElementById("lbMaterial").textContent = "Material: " + product.material;

  lightbox.dataset.qty = "1";
  const qtyEl = document.getElementById("lbQty");
  if (qtyEl) qtyEl.value = "1";
  // La ficha abre con el tamaño MÁS BARATO elegido (el mismo precio que dice "Desde $U X" en la
  // tarjeta), no con el primero de la lista: antes un producto cuya lista empieza por el más caro
  // abría con ese precio ya elegido.
  lightbox.dataset.size = product.sizes && product.sizes.length ? stratoCheapestSize(product.sizes).name : "";
  // Con tamaños o descuentos hay más cosas que mostrar: el cuadro se hace un poco más alto.
  lightbox.classList.toggle("lightbox--rich", !!(product.sizes && product.sizes.length) || stratoProductTiers(product).length > 0);

  stratoRenderLightboxSizes(product, lightbox);
  stratoRenderLightboxColors(product, lightbox);
  stratoRefreshLightboxPrice();

  // Teclado: se recuerda de dónde se abrió (ej. el título de la tarjeta) para
  // devolverle el foco al cerrar, y el foco entra al cuadro de la ficha (no a
  // un botón: así, al abrirla con mouse o dedo, no aparece ningún anillo de
  // foco; con Tab el primer salto va al botón de cerrar).
  const active = document.activeElement;
  stratoLastFocus = active && active !== document.body ? active : null;
  const panel = lightbox.querySelector(".lightbox__panel");
  // En celular el cuadro entero se desplaza como una hoja: sin esto, si la
  // ficha anterior se había cerrado scrolleada hacia abajo, la siguiente se
  // abría ya corrida (sin la foto ni el título a la vista).
  if (panel) panel.scrollTop = 0;
  lightbox.classList.add("open");
  document.body.style.overflow = "hidden";
  if (panel) {
    panel.setAttribute("tabindex", "-1");
    panel.focus({ preventScroll: true });
  }
}

/* El tamaño más barato de la lista (si hay empate, el primero). */
function stratoCheapestSize(sizes) {
  return sizes.reduce((best, sz) => (sz.price < best.price ? sz : best), sizes[0]);
}

/* Rótulo de las opciones: "Pack" si todas son packs/combos/cantidades ("Pack x20",
   "x10"…), "Tamaño" en cualquier otro caso. */
function stratoSizesLabel(sizes) {
  const isPack = (name) => /^\s*(pack|combo|set|x\s?\d+|\d+\s*(unidades|unidad|unid|un|u)\b)/i.test(name || "");
  return sizes.length && sizes.every((sz) => isPack(sz.name)) ? "Pack" : "Tamaño";
}

/* ---- Tamaños: botones con el nombre y el precio de cada uno. ---- */
function stratoRenderLightboxSizes(product, lightbox) {
  const wrap = document.getElementById("lbSizes");
  if (!wrap) return;
  const sizes = product.sizes || [];
  wrap.innerHTML = "";
  if (!sizes.length) {
    wrap.style.display = "none";
    return;
  }
  wrap.style.display = "";
  const label = document.createElement("div");
  label.className = "lightbox__field-label";
  label.textContent = stratoSizesLabel(sizes);
  wrap.appendChild(label);

  const row = document.createElement("div");
  row.className = "size-pills";
  sizes.forEach((sz) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "size-pill" + (sz.name === lightbox.dataset.size ? " active" : "");
    btn.innerHTML = '<span class="size-pill__name">' + stratoEsc(sz.name) + '</span><span class="size-pill__price">' + stratoMoney(sz.price) + "</span>";
    btn.addEventListener("click", () => {
      lightbox.dataset.size = sz.name;
      row.querySelectorAll(".size-pill").forEach((b) => b.classList.toggle("active", b === btn));
      stratoRefreshLightboxPrice();
    });
    row.appendChild(btn);
  });
  wrap.appendChild(row);
}

/* Unidades de este producto que ya hay en el carrito (en cualquier color o
   tamaño): se suman a la cantidad de la ficha para calcular el escalón, igual
   que va a hacer el carrito. */
function stratoUnitsInCart(productId) {
  return stratoGetCart()
    .filter((l) => l.id === productId)
    .reduce((sum, l) => sum + l.qty, 0);
}

/* Redibuja precio, tabla de descuentos y total de la ficha según el tamaño y
   la cantidad elegidos. Un producto simple (sin tamaños ni descuentos) se ve
   exactamente igual que antes: solo el precio. */
function stratoRefreshLightboxPrice() {
  const product = stratoCurrentProduct;
  const lightbox = document.getElementById("productLightbox");
  if (!product || !lightbox) return;

  const qty = Math.max(1, parseInt(lightbox.dataset.qty || "1", 10) || 1);
  const size = lightbox.dataset.size || null;
  const base = stratoBasePrice(product, size);
  const tiers = stratoProductTiers(product);
  const inCart = tiers.length ? stratoUnitsInCart(product.id) : 0;
  const tier = stratoTierFor(product, inCart + qty);
  const unit = base == null ? null : tier ? Math.round(base * (1 - tier.pct / 100)) : base;

  const priceEl = document.getElementById("lbPrice");
  if (base == null) {
    priceEl.textContent = stratoFormatPrice(product);
  } else if (!(product.sizes && product.sizes.length) && !tiers.length) {
    priceEl.textContent = stratoFormatPrice(product);
  } else if (tier) {
    priceEl.innerHTML =
      stratoMoney(unit) + ' <span class="lightbox__unit">c/u</span> <s class="lightbox__price-old">' + stratoMoney(base) +
      '</s> <span class="lightbox__disc">-' + tier.pct + "%</span>";
  } else {
    priceEl.innerHTML = stratoMoney(base) + (tiers.length ? ' <span class="lightbox__unit">c/u</span>' : "");
  }

  // Tabla de descuentos: cada botón lleva la cantidad a ese escalón.
  const tiersEl = document.getElementById("lbTiers");
  if (tiersEl) {
    if (!tiers.length || base == null) {
      tiersEl.innerHTML = "";
      tiersEl.style.display = "none";
    } else {
      tiersEl.style.display = "";
      let html = '<div class="lightbox__field-label">Descuento por cantidad</div><div class="tier-chips">';
      html += stratoTierChip(1, base, 0, !tier);
      tiers.forEach((t) => {
        html += stratoTierChip(t.from, Math.round(base * (1 - t.pct / 100)), t.pct, !!tier && tier.from === t.from);
      });
      html += "</div>";
      if (inCart > 0) html += '<div class="lightbox__tiers-note">Ya tenés ' + inCart + " en el carrito: se suman para el descuento.</div>";
      tiersEl.innerHTML = html;
      tiersEl.querySelectorAll(".tier-chip").forEach((btn) => {
        btn.addEventListener("click", () => {
          const target = Math.max(1, parseInt(btn.dataset.from, 10) - inCart);
          lightbox.dataset.qty = String(target);
          document.getElementById("lbQty").value = String(target);
          stratoRefreshLightboxPrice();
        });
      });
    }
  }

  const totalEl = document.getElementById("lbTotal");
  if (totalEl) {
    if (unit != null && (qty > 1 || tiers.length)) {
      totalEl.innerHTML = 'Total <strong>' + stratoMoney(unit * qty) + "</strong>";
      totalEl.style.display = "";
    } else {
      totalEl.textContent = "";
      totalEl.style.display = "none";
    }
  }
}

function stratoTierChip(from, unitPrice, pct, active) {
  return (
    '<button type="button" class="tier-chip' + (active ? " active" : "") + '" data-from="' + from + '">' +
    '<span class="tier-chip__qty">' + (from === 1 ? "1 un." : from + "+ un.") + "</span>" +
    '<span class="tier-chip__price">' + stratoMoney(unitPrice) + (pct ? " · -" + pct + "%" : "") + "</span>" +
    "</button>"
  );
}

/* ---- Colores. Vienen del admin (pestaña Filamentos): se ocultan los que
   están marcados "sin stock" y, si el filamento tiene código de color, se
   muestra un circulito al lado del nombre. ---- */
function stratoFilamentFor(colorName) {
  const key = String(colorName || "").trim().toLowerCase();
  return STRATO_FILAMENTS.find((f) => String(f.color || "").trim().toLowerCase() === key) || null;
}

function stratoColorAvailable(colorName) {
  const f = stratoFilamentFor(colorName);
  return !f || f.available !== false;
}

function stratoColorDotHtml(colorName) {
  const f = stratoFilamentFor(colorName);
  if (!f || !f.hex || !/^#[0-9a-fA-F]{3,8}$/.test(f.hex)) return "";
  return '<span class="color-dot" style="background:' + f.hex + '"></span>';
}

/* ---- Selector de color del lightbox: la mayoría de los productos permite
   un solo color (menú desplegable), pero un producto puede marcarse
   en el admin para permitir elegir varios a la vez (desplegable con
   casilleros). En ambos casos el resultado termina en lightbox.dataset.color
   como un string plano — con varios colores marcados queda algo como
   "Blanco, Negro" — así el carrito/checkout/WhatsApp no necesitan saber
   nada de esto, ya tratan el color como texto. ---- */
function stratoRenderLightboxColors(product, lightbox) {
  const wrap = document.getElementById("lbColors");
  wrap.innerHTML = "";
  const all = product.colors || [];
  const colors = all.filter(stratoColorAvailable);
  if (!colors.length) {
    lightbox.dataset.color = "";
    if (all.length) {
      wrap.innerHTML = '<p class="muted" style="font-size:0.82rem;margin:0;">Colores sin stock por el momento. Escribinos por WhatsApp y lo coordinamos.</p>';
    }
    return;
  }
  if (product.colorsMultiple) {
    stratoRenderColorMultiSelect(wrap, colors, lightbox);
  } else if (colors.some((c) => stratoColorDotHtml(c))) {
    stratoRenderColorSingleSwatch(wrap, colors, lightbox);
  } else {
    stratoRenderColorDropdown(wrap, colors, lightbox);
  }
}

function stratoRenderColorDropdown(wrap, colors, lightbox) {
  const select = document.createElement("select");
  select.className = "lightbox__color-select";
  select.setAttribute("aria-label", "Color");
  colors.forEach((c) => {
    const opt = document.createElement("option");
    opt.value = c;
    opt.textContent = c;
    select.appendChild(opt);
  });
  select.addEventListener("change", () => {
    lightbox.dataset.color = select.value;
  });
  wrap.appendChild(select);
  lightbox.dataset.color = colors[0];
}

/* Un solo color, con circulito: un select nativo no puede dibujar el color,
   así que se arma un desplegable propio con el mismo aspecto que el de varios. */
function stratoRenderColorSingleSwatch(wrap, colors, lightbox) {
  const box = document.createElement("div");
  box.className = "color-multiselect color-single";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "color-multiselect__btn";
  btn.setAttribute("aria-label", "Color");
  const panel = document.createElement("div");
  panel.className = "color-multiselect__panel";

  function choose(c) {
    lightbox.dataset.color = c;
    btn.innerHTML = '<span class="color-multiselect__label">' + stratoColorDotHtml(c) + stratoEsc(c) + "</span>";
    panel.querySelectorAll(".color-multiselect__row").forEach((r) => r.classList.toggle("selected", r.dataset.color === c));
    box.classList.remove("open");
  }

  colors.forEach((c) => {
    const row = document.createElement("div");
    row.className = "color-multiselect__row";
    row.dataset.color = c;
    row.innerHTML = stratoColorDotHtml(c) + stratoEsc(c);
    row.addEventListener("click", () => choose(c));
    panel.appendChild(row);
  });

  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    box.classList.toggle("open");
  });

  box.appendChild(btn);
  box.appendChild(panel);
  wrap.appendChild(box);
  choose(colors[0]);
}

function stratoRenderColorMultiSelect(wrap, colors, lightbox) {
  const selected = new Set([colors[0]]);
  const box = document.createElement("div");
  box.className = "color-multiselect";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "color-multiselect__btn";
  const panel = document.createElement("div");
  panel.className = "color-multiselect__panel";

  function syncLabel() {
    btn.textContent = selected.size ? Array.from(selected).join(", ") : "Elegí uno o más colores";
    lightbox.dataset.color = Array.from(selected).join(", ");
  }

  colors.forEach((c) => {
    const row = document.createElement("label");
    row.className = "color-multiselect__row";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = selected.has(c);
    cb.addEventListener("change", () => {
      if (cb.checked) selected.add(c);
      else selected.delete(c);
      syncLabel();
    });
    row.appendChild(cb);
    const dot = stratoColorDotHtml(c);
    if (dot) row.insertAdjacentHTML("beforeend", dot);
    row.appendChild(document.createTextNode(" " + c));
    panel.appendChild(row);
  });

  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    box.classList.toggle("open");
  });

  box.appendChild(btn);
  box.appendChild(panel);
  wrap.appendChild(box);
  syncLabel();
}

// Un único listener delegado (no uno por lightbox abierto) que cierra el
// desplegable de colores al tocar afuera.
document.addEventListener("click", (e) => {
  const openBox = document.querySelector(".color-multiselect.open");
  if (openBox && !openBox.contains(e.target)) openBox.classList.remove("open");
});

/* ---- Descripción recortada con "Ver más" en el lightbox: por defecto se
   muestra recortada a pocas líneas; si el texto no entra ahí, aparece el
   botón para desplegarla. El resto de la info (título, precio, material,
   colores, cantidad, botón) queda siempre fijo y visible — solo el texto de
   la descripción se desplaza por dentro cuando está desplegada y no entra
   en el alto disponible. ---- */
function stratoResetLightboxDesc() {
  const desc = document.getElementById("lbDesc");
  const toggle = document.getElementById("lbDescToggle");
  if (!desc || !toggle) return;
  desc.classList.remove("is-expanded", "has-more");
  desc.scrollTop = 0;
  toggle.textContent = "Ver más";
  toggle.style.display = "none";
  // Se mide en el próximo frame: recién ahí el navegador ya aplicó el
  // recorte (max-height) y scrollHeight refleja el alto real del contenido.
  requestAnimationFrame(() => {
    if (desc.scrollHeight > desc.clientHeight + 2) {
      desc.classList.add("has-more");
      toggle.style.display = "inline-flex";
    }
  });
}

function stratoToggleLightboxDesc() {
  const desc = document.getElementById("lbDesc");
  const toggle = document.getElementById("lbDescToggle");
  if (!desc || !toggle) return;
  const expanded = desc.classList.toggle("is-expanded");
  toggle.textContent = expanded ? "Ver menos" : "Ver más";
  if (!expanded) desc.scrollTop = 0;
}

function stratoCloseProduct() {
  const lightbox = document.getElementById("productLightbox");
  if (lightbox) lightbox.classList.remove("open");
  document.body.style.overflow = "";
  if (stratoLastFocus && stratoLastFocus.isConnected) stratoLastFocus.focus({ preventScroll: true });
  stratoLastFocus = null;
}

function stratoChangeQty(delta) {
  const lightbox = document.getElementById("productLightbox");
  let qty = parseInt(lightbox.dataset.qty || "1", 10) + delta;
  if (qty < 1) qty = 1;
  if (qty > 9999) qty = 9999;
  lightbox.dataset.qty = qty;
  document.getElementById("lbQty").value = qty;
  stratoRefreshLightboxPrice();
}

function stratoAddCurrentToCart() {
  const lightbox = document.getElementById("productLightbox");
  if (!stratoCurrentProduct) return;
  const qty = Math.max(1, parseInt(lightbox.dataset.qty || "1", 10) || 1);
  const color = lightbox.dataset.color || null;
  const size = lightbox.dataset.size || null;
  stratoAddToCart(stratoCurrentProduct.id, qty, color, size);
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
