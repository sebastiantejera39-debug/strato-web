# Strato — sitio web + panel admin

Sitio (HTML/CSS/JS puro, sin build) para el emprendimiento de impresión 3D
**Strato**, con catálogo dinámico contra Supabase y un panel privado en
`/admin.html`. Mismo circuito técnico que RGOL.UY: Supabase (datos + login +
fotos) → GitHub (repo) → Netlify (deploy continuo).

**Para dejarlo funcionando de punta a punta (Supabase, GitHub, Netlify),
seguí `SETUP.md`.** Este README es más bien referencia de "qué es cada
cosa" una vez que ya está armado.

## Cómo funciona el catálogo dinámico

El sitio arranca siempre con los datos de `js/products.js` (estáticos, los
mismos 16 productos placeholder que carga `supabase/seed.sql`). Apenas
`js/supabase-client.js` detecta que completaste la URL y la anon key reales,
pisa esos datos con lo que haya en la base — así el sitio funciona
igual de bien antes y después de conectar Supabase, sin pasos intermedios
raros.

```
Carga la página
  → products.js (datos estáticos de arranque)
  → supabase-client.js intenta traer categorías/productos en vivo
  → si Supabase está configurado y responde: reemplaza los datos
  → si no (todavía sin configurar, o falla la red): sigue con los estáticos
  → recién ahí se dibuja el carrito, la grilla y el lightbox
```

Los pedidos del checkout se mandan siempre por WhatsApp (como antes), y
además —si Supabase está configurado— quedan guardados en la tabla
`pedidos`, visibles y gestionables desde `/admin.html`.

## Estructura

```
strato-web/
├── index.html             Home
├── catalogo.html          Catálogo con filtro por categoría
├── checkout.html          Carrito → datos de entrega → WhatsApp (+ Supabase)
├── nosotros.html          Historia, proceso, materiales
├── contacto.html          Formulario de personalizados + contacto directo
├── gracias.html           Página post-pedido
├── admin.html             Panel privado (login, pedidos, productos, categorías, gastos)
├── css/style.css          Diseño del sitio público (paleta, tipografía, componentes)
├── js/products.js         Datos de arranque (categorías + productos placeholder)
├── js/supabase-client.js  ⚠️ Acá van la URL y la anon key de tu proyecto Supabase
├── js/cart.js             Carrito (localStorage) + WhatsApp + número/IG del negocio
├── js/catalog.js          Render de productos, filtros, lightbox de producto
├── js/main.js             Bootstrap de cada página: espera el catálogo, menú mobile, animaciones
├── js/admin.js            Toda la lógica del panel privado
├── supabase/schema.sql          Tablas + políticas de seguridad (RLS)
├── supabase/storage_productos.sql  Bucket de imágenes de producto
├── supabase/seed.sql            Categorías/productos de arranque
├── images/favicon.svg
├── netlify.toml, robots.txt, sitemap.xml
├── SETUP.md               Guía paso a paso: Supabase + GitHub + Netlify
```

## Lo primero que tenés que cambiar

1. **Supabase** (URL + anon key) en `js/supabase-client.js` — ver `SETUP.md`.

2. **Número de WhatsApp e Instagram** — en `js/cart.js`, arriba de todo:
   ```js
   const STRATO_WHATSAPP_NUMBER = "59800000000"; // formato 598XXXXXXXX, sin +
   const STRATO_INSTAGRAM = "strato.uy";
   ```
   También hay links de WhatsApp/Instagram/email hardcodeados en el header y footer de cada página (buscá `wa.me/598` y `instagram.com/strato.uy` para reemplazar todos de una).

3. **Productos, precios y fotos reales** — una vez que Supabase está
   configurado, todo esto se carga desde `/admin.html` (pestaña
   **Productos**): nombre, categoría, precio (o "a cotizar"), colores,
   material, descripción, y las fotos se suben ahí mismo (van a un bucket de
   Supabase Storage, no hace falta subir archivos a mano al repo). Las filas
   que cargó `seed.sql` se pueden editar o borrar desde ahí.

   Si todavía NO configuraste Supabase, podés seguir editando
   `js/products.js` a mano como en la versión anterior del esqueleto — el
   sitio lo sigue leyendo como fallback.

## El panel privado (`/admin.html`)

No está linkeado desde ningún menú público (a propósito, como en RGOL). Pestañas:

- **Dashboard** — pedidos y $ facturado en un rango de fechas, gastos, saldo, y los pedidos "nuevos" sin gestionar.
- **Pedidos** — todos los pedidos que llegaron por `checkout.html`, con su detalle (items, dirección, pago, notas) y un selector de estado (nuevo → confirmado → en producción → listo → entregado / cancelado).
- **Productos** — alta/edición/baja, con manejo de fotos (subida directa a Supabase Storage) y un checkbox para ocultar del catálogo público sin borrar.
- **Categorías** — alta/edición/baja de las categorías del menú del catálogo.
- **Gastos** — filamento, electricidad, envíos, etc., con total del período (para ir viendo costos y rentabilidad).

El login es con el usuario que crees en Supabase → Authentication (ver
`SETUP.md`). No hay registro público: los usuarios se crean a mano, uno por
persona que necesite entrar.

## Cómo subirlo a Netlify

Ver `SETUP.md` para el circuito completo (Supabase → GitHub → Netlify).
Si por ahora solo querés ver el esqueleto sin conectar nada: `app.netlify.com`
→ "Add new site" → "Deploy manually" → arrastrá la carpeta `strato-web`
completa. El sitio anda igual, solo que con los datos estáticos de
`products.js` y sin panel admin funcional (porque no tiene con qué
autenticarse).

## Qué falta para que sea un sitio "terminado" (no bloquea el esqueleto)

- Conectar Supabase, GitHub y Netlify (`SETUP.md`)
- Fotos reales de producto y del taller
- Precios definitivos (los actuales son de referencia)
- Definir si el pago queda en "a coordinar por WhatsApp" o se suma Mercado Pago Checkout Pro más adelante — el checkout ya guarda el pedido itemizado en `pedidos`, así que sumar un pago online después no rompe nada de lo que ya está armado (mismo enfoque que usaste en RGOL con una Netlify Function)
- Dominio propio si no querés quedarte con el `.netlify.app`
- Meta descripción / Open Graph con el dominio final una vez lo tengas

## Paleta y tipografía (por si querés tocar el diseño)

Todo está centralizado como variables CSS al principio de `css/style.css`:
- Fondo: `--color-bg` (crema cálido), tarjetas: `--color-paper`
- Texto: `--color-charcoal`, texto secundario: `--color-stone`
- Acento: `--color-accent` (terracota) — es el único color "fuerte" del sitio, úsalo con moderación
- Tipografías (Google Fonts): `Fraunces` para títulos, `Jost` para el resto

`admin.html` usa la misma tipografía pero con una paleta oscura propia
(`--bg-dark`/`--accent` definidos arriba de su propio `<style>`), para que
sea visualmente distinguible del sitio público de un vistazo.
