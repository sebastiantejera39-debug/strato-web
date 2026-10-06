/* ==========================================================================
   STORGE LAB — comportamiento compartido de la interfaz
   (menú mobile, año del footer, animación simple al hacer scroll)
   ========================================================================== */

document.addEventListener("DOMContentLoaded", async () => {
  // Menú mobile
  const nav = document.querySelector(".main-nav");
  const toggle = document.querySelector(".nav-toggle");
  if (toggle && nav) {
    toggle.addEventListener("click", () => nav.classList.toggle("open"));
  }

  // Año dinámico en el footer
  document.querySelectorAll("[data-year]").forEach((el) => {
    el.textContent = new Date().getFullYear();
  });

  // Animación de entrada simple al hacer scroll
  const revealEls = document.querySelectorAll(".reveal");
  if ("IntersectionObserver" in window && revealEls.length) {
    const obs = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add("in");
            obs.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.15 }
    );
    revealEls.forEach((el) => obs.observe(el));
  } else {
    revealEls.forEach((el) => el.classList.add("in"));
  }

  // Espera a que el catálogo (Supabase en vivo, o los datos estáticos de
  // products.js si todavía no está configurado) esté listo antes de dibujar
  // cualquier cosa que dependa de productos: carrito, grillas, lightbox.
  if (window.stratoReady) {
    try {
      await window.stratoReady;
    } catch (e) {
      /* stratoLoadLiveCatalog ya maneja sus propios errores; esto es solo
         una red de seguridad para no bloquear el resto de la página. */
    }
  }

  // Lista "Categorías" del pie de página: en TODAS las páginas que la tienen
  // (Inicio, Catálogo, Nosotros, Contacto), con las categorías reales.
  stratoRenderFooterCategories();

  if (typeof stratoInitCartUI === "function") stratoInitCartUI();
  if (typeof stratoInitProductUI === "function") stratoInitProductUI();

  // Avisa a scripts de página (por ej. checkout.html) que ya pueden leer
  // STRATO_PRODUCTS/STRATO_CATEGORIES con los datos definitivos.
  document.dispatchEvent(new CustomEvent("strato:catalog-ready"));
});

/* Lista "Categorías" del pie de página. Sale de STRATO_CATEGORIES (la lista real
   de Supabase, o la de respaldo de products.js si no respondió), así una categoría
   nueva o renombrada desde el panel admin aparece sola en el pie de TODAS las
   páginas. Antes solo se actualizaba donde estaba cargado catalog.js (Inicio y
   Catálogo) y en Nosotros y Contacto quedaba la lista fija del HTML. Es seguro
   que catalog.js haga lo mismo: el resultado es idéntico. */
function stratoRenderFooterCategories() {
  const list = document.getElementById("footerCategories");
  if (!list || typeof STRATO_CATEGORIES === "undefined" || !STRATO_CATEGORIES.length) return;
  const esc = (s) =>
    String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  list.innerHTML = STRATO_CATEGORIES.map(
    (c) => '<li><a href="catalogo.html?cat=' + encodeURIComponent(c.slug) + '">' + esc(c.name) + "</a></li>"
  ).join("");
}
