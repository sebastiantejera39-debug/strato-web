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

  if (typeof stratoInitCartUI === "function") stratoInitCartUI();
  if (typeof stratoInitProductUI === "function") stratoInitProductUI();

  // Avisa a scripts de página (por ej. checkout.html) que ya pueden leer
  // STRATO_PRODUCTS/STRATO_CATEGORIES con los datos definitivos.
  document.dispatchEvent(new CustomEvent("strato:catalog-ready"));
});
