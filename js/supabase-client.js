/* ==========================================================================
   STORGE LAB — cliente de Supabase
   Mismo enfoque que RGOL: un cliente inicializado acá, con la URL y la
   "anon/publishable key" del proyecto (es pública a propósito — la protección
   real está en las políticas de RLS del lado de la base, no en ocultar esta
   clave). Mientras no la reemplaces, el sitio sigue funcionando igual que
   antes con los datos de js/products.js.

   Cómo activarlo:
   1) Creá el proyecto en supabase.com y corré supabase/schema.sql,
      supabase/storage_productos.sql y supabase/seed.sql (en ese orden)
      en el SQL Editor.
   2) Reemplazá las dos constantes de acá abajo con los datos de
      Project Settings → API de tu proyecto.
   ========================================================================== */

const STRATO_SUPABASE_URL = "https://elpckhakeiezcnahxmoz.supabase.co";
const STRATO_SUPABASE_ANON_KEY = "sb_publishable_7F0HV4PNBbEmr7fb3ZTYdA_n9AdfzXa";

const STRATO_SUPABASE_CONFIGURED =
  !STRATO_SUPABASE_URL.includes("TU-PROYECTO") && !STRATO_SUPABASE_ANON_KEY.includes("TU-ANON");

let stratoSb = null;
if (STRATO_SUPABASE_CONFIGURED && window.supabase) {
  stratoSb = window.supabase.createClient(STRATO_SUPABASE_URL, STRATO_SUPABASE_ANON_KEY);
}
// Se expone también como propiedad de window (además de la variable de script
// que ya comparten todas las etiquetas <script> de la página) para que
// cualquier chequeo tipo `window.stratoSb` funcione sin sorpresas.
window.stratoSb = stratoSb;

/**
 * Trae categorías y productos activos desde Supabase y los vuelca en los
 * mismos arrays STRATO_CATEGORIES / STRATO_PRODUCTS que ya usa el resto del
 * sitio (catalog.js, cart.js), así no hace falta tocar nada más cuando el
 * catálogo pasa a ser dinámico. Si Supabase no está configurado, o falla la
 * carga, no hace nada y el sitio sigue mostrando los datos estáticos.
 */
async function stratoLoadLiveCatalog() {
  if (!stratoSb) return false;

  try {
    const [{ data: categorias, error: errCat }, { data: productos, error: errProd }] = await Promise.all([
      stratoSb.from("categorias").select("*").order("orden", { ascending: true }),
      stratoSb
        .from("productos")
        .select("*, categorias(slug)")
        .eq("activo", true)
        .order("orden", { ascending: true }),
    ]);

    if (errCat || errProd) {
      console.warn("Strato: no se pudo cargar el catálogo desde Supabase, uso los datos locales.", errCat || errProd);
      return false;
    }

    if (categorias && categorias.length) {
      const mapped = categorias.map((c) => ({ slug: c.slug, name: c.nombre, short: c.descripcion_corta || "" }));
      STRATO_CATEGORIES.length = 0;
      STRATO_CATEGORIES.push(...mapped);
    }

    if (productos) {
      const mapped = productos.map((p) => ({
        id: p.id,
        name: p.nombre,
        category: p.categorias ? p.categorias.slug : null,
        price: p.precio,
        priceLabel: p.precio == null ? "Cotizar" : undefined,
        colors: p.colores || [],
        material: p.material || "",
        tag: p.tag || undefined,
        description: p.descripcion || "",
        images: p.imagenes || [],
      }));
      STRATO_PRODUCTS.length = 0;
      STRATO_PRODUCTS.push(...mapped);
    }

    return true;
  } catch (e) {
    console.warn("Strato: error cargando catálogo en vivo, uso los datos locales.", e);
    return false;
  }
}

/**
 * Inserta un pedido en Supabase cuando se confirma el checkout. Es
 * "best effort": si Supabase no está configurado o falla la escritura, no
 * interrumpe el flujo de WhatsApp — el pedido igual llega por ese medio.
 */
async function stratoInsertPedido(pedido) {
  if (!stratoSb) return { ok: false, reason: "not-configured" };
  try {
    const { error } = await stratoSb.from("pedidos").insert([pedido]);
    if (error) {
      console.warn("Strato: no se pudo guardar el pedido en Supabase.", error);
      return { ok: false, reason: error.message };
    }
    return { ok: true };
  } catch (e) {
    console.warn("Strato: error guardando el pedido en Supabase.", e);
    return { ok: false, reason: String(e) };
  }
}

/* Se dispara apenas carga este script (no espera al DOMContentLoaded) para
   que la carga en vivo empiece lo antes posible. Todo lo demás (cart.js,
   catalog.js, main.js) espera esta promesa antes de dibujar nada en pantalla. */
window.stratoReady = stratoLoadLiveCatalog();
