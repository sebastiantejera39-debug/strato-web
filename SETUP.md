# Puesta en marcha: Supabase + GitHub + Netlify

Guía paso a paso para dejar Storge Lab funcionando con catálogo dinámico, panel
admin y deploy continuo — el mismo circuito que ya armaste para RGOL.UY.
Son cuentas y pasos tuyos (login, contraseñas, tokens); yo te dejo todo el
código listo para que esto sea copiar/pegar y un par de clics.

Tiempo estimado: 15-20 minutos.

---

## 1) Supabase — base de datos + login del admin

1. Entrá a [supabase.com](https://supabase.com) → **New project** (podés usar
   la misma organización de RGOL o crear una nueva — son proyectos
   independientes, no comparten datos).
   - Nombre sugerido: `strato`
   - Guardá la **contraseña de la base de datos** que te pida generar en un
     lugar seguro (no la vas a necesitar para nada de lo que sigue, pero
     Supabase te la pide igual).
   - Elegí la región más cercana (South America si está disponible).

2. Una vez creado, andá a **SQL Editor** (menú izquierdo) y corré, **en este
   orden**, pegando el contenido completo de cada archivo y clickeando "Run":
   1. `supabase/schema.sql`
   2. `supabase/storage_productos.sql`
   3. `supabase/seed.sql` (esto carga las 5 categorías y 16 productos
      placeholder para que el panel no arranque vacío — podés borrarlos
      después desde `/admin.html` cuando cargues los reales)

3. Andá a **Authentication → Users → Add user** y create tu usuario admin
   (el email/contraseña con los que vas a entrar a `/admin.html`). No hace
   falta que sea el mismo que usás para RGOL.

4. Andá a **Project Settings → API** y copiá dos valores:
   - **Project URL**
   - **anon / publishable key** (la pública, NO la `service_role` — esa
     nunca va en el código del sitio)

5. Abrí `js/supabase-client.js` en este proyecto y reemplazá:
   ```js
   const STRATO_SUPABASE_URL = "https://TU-PROYECTO.supabase.co";
   const STRATO_SUPABASE_ANON_KEY = "TU-ANON-PUBLISHABLE-KEY";
   ```
   por los dos valores que copiaste. Guardá el archivo.

   A partir de acá, tanto el sitio público como `/admin.html` leen y escriben
   contra ese proyecto. Podés abrir `index.html` local (o ya desplegado) y
   deberías ver los mismos productos que cargó `seed.sql`.

---

## 2) GitHub — repo del código

Mismo patrón que RGOL: un repo, deploy continuo desde Netlify.

1. En [github.com](https://github.com), creá un repo nuevo (podés llamarlo
   `strato-web`), vacío (sin README/gitignore automáticos).
2. En tu Mac, dentro de la carpeta `strato-web/` (la de este entregable):
   ```bash
   cd strato-web
   git init
   git add .
   git commit -m "Primer commit: esqueleto de Strato"
   git branch -M main
   git remote add origin https://github.com/TU-USUARIO/strato-web.git
   git push -u origin main
   ```
   (Si `gh` está instalado y logueado, `gh repo create strato-web --private --source=. --push`
   hace los tres últimos pasos de una.)

---

## 3) Netlify — deploy continuo

1. En [app.netlify.com](https://app.netlify.com) → **Add new site → Import an
   existing project → Deploy with GitHub**.
2. Elegí el repo `strato-web`.
3. Build command: dejalo **vacío**. Publish directory: `.`
4. Deploy. Cada `git push` a `main` va a redesplegar solo, igual que RGOL.
5. Una vez desplegado, en **Site settings → Domain management** podés
   cambiarle el nombre al subdominio `.netlify.app` (o sumar un dominio propio
   más adelante).

---

## Checklist rápido después de todo esto

- [ ] `js/supabase-client.js` tiene la URL y anon key reales (no los `TU-...`)
- [ ] `js/cart.js` tiene el número de WhatsApp e Instagram reales (ver README.md)
- [ ] Podés entrar a `/admin.html` con el usuario que creaste en Supabase
- [ ] Un pedido de prueba desde `checkout.html` aparece en la pestaña
      **Pedidos** del panel admin
- [ ] El sitio ya está online en Netlify con deploy automático desde GitHub

Cualquier paso de estos que quieras que revisemos juntos (por ejemplo, si un
`git push` da error de autenticación, o el SQL tira algún error puntual),
pasame el mensaje exacto y lo resolvemos.
