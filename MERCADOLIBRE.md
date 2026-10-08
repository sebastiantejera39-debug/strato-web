# Publicar en Mercado Libre desde el panel — puesta en marcha

Desde la pestaña **Mercado Libre** de `/admin.html` publicás tus productos con un botón. Después se mantienen al día solos cada hora: precio, stock por color, pausas y descripción.

**Precio en ML** = precio web + recargo % + costo del envío gratis, redondeado hacia arriba. Todos los avisos van con **envío gratis**.

## 1. Supabase (2 minutos)

1. **SQL Editor →** pegá todo `supabase/migracion_mercadolibre.sql` **→ Run**.
2. **Project Settings → API Keys →** copiá la **secret key** (empieza con `sb_secret_…`; en proyectos viejos se llama `service_role`). **No la pegues nunca en el sitio ni en GitHub.**

## 2. Aplicación en Mercado Libre (5 minutos)

Entrá a **developers.mercadolibre.com.uy → Mis aplicaciones → Crear aplicación**, con tu cuenta de vendedor:

- **Nombre:** Storge Lab
- **URI de redirect:** `https://storgelab.netlify.app/api/ml-callback` (exacta, sin barra al final)
- **PKCE:** destildado
- **Permisos / scopes:** lectura, escritura y `offline_access` (acceso sin estar conectado)
- **Notificaciones / tópicos:** no hace falta ninguno

Al guardar te da un **App ID** (Client ID) y una **Secret Key** (Client Secret).

## 3. Variables en Netlify

**Netlify → el sitio → Site configuration → Environment variables → Add a variable.** Tildá "Contains secret values" en las que son secretas.

| Variable | Valor |
|---|---|
| `SUPABASE_SERVICE_ROLE_KEY` | la secret key del paso 1 (secreta) |
| `ML_CLIENT_ID` | el App ID del paso 2 |
| `ML_CLIENT_SECRET` | la Secret Key del paso 2 (secreta) |
| `ADMIN_EMAILS` | el mail con el que entrás al panel (solo ese usuario puede publicar) |

## 4. Subir a GitHub

- **Raíz del repo:** `admin.html`, `netlify.toml`, `MERCADOLIBRE.md`
- **`js/`:** `admin-ml.js` (nuevo)
- **`supabase/`:** `migracion_mercadolibre.sql` (nuevo)
- **`netlify/`:** arrastrá **la carpeta `netlify` completa desde Finder** a la raíz del repo. Así GitHub crea `netlify/lib/ml.js`, que es una carpeta nueva, y suma `netlify/functions/ml-admin.js`, `ml-callback.js` y `ml-sync-cron.js`. `create-preference.js` no cambió.

Después del deploy, revisá que en **Netlify → Functions** aparezcan `ml-admin`, `ml-callback` y `ml-sync-cron`. Esta última tiene que figurar como "Scheduled".

## 5. Usarlo

1. **Panel → Mercado Libre → Conectar con Mercado Libre → Autorizar.** Volvés al panel con "Cuenta conectada".
2. Cargá el **recargo %** y el **costo del envío gratis**. El ejemplo de abajo te muestra el precio final.
   - Para saber cuánto poner de envío, mirá en tu cuenta de ML cuánto te cobran por enviar gratis.
   - Para el recargo, sumá la comisión de ML de tu tipo de publicación.
3. En cada producto, tocá **Vista previa**. ML valida el aviso sin publicarlo y te muestra:
   - la categoría que eligió,
   - el título y el precio de cada aviso,
   - los datos obligatorios que faltan.

   Si falta algo, cargalo en **Opciones → Atributos extra**, una línea por dato, por ejemplo `SHAPE = Redonda`. En Opciones también podés corregir la categoría o escribir una descripción propia para ML.
4. **Publicar.** Listo.

## Cómo se arman los avisos

- **Un aviso por tamaño**, con los colores como variantes.
- Si tu cuenta usa el modelo nuevo de ML ("User Products"), va **un aviso por color**, y ML los agrupa en la misma ficha. El panel lo detecta solo.
- **Stock:** un número fijo por color (imprimís a pedido). Los colores marcados "sin stock" en Filamentos quedan en 0.
- **Pausas:**
  - Si ocultás un producto en la web, se pausa en ML.
  - Si borrás un tamaño o un color, se pausa su aviso.
- **Descripción:** sale de la web pasada a texto plano, más el material, "impresa en 3D a pedido en Montevideo", los días de fabricación (si los cargaste) y "envío gratis".
  - **ML no permite** links, teléfonos, WhatsApp ni redes: la vista previa te avisa si hay algo de eso.
- **No pasan a ML:** los descuentos por cantidad y los cupones (ML tiene sus propias promociones), ni los productos "a cotizar".

## Lo que no hace (todavía)

- **Ventas:** las ventas de ML no entran a la tabla de pedidos de la web. Las ves en Mercado Libre.
- **Cambios hechos en ML:** si cambiás un precio directo en ML, la sincronización lo vuelve a poner como dice la web.

## Si algo falla

- **"Falta configurar …":** falta esa variable en Netlify, o el deploy todavía no terminó.
- **"Se venció la conexión":** tocá Reconectar.
- **Error al publicar por envíos:** revisá que **Mercado Envíos** esté activo en tu cuenta de vendedor.
- **Aviso "Finalizado":** se cerró en ML. Tocá **Desvincular** y publicalo de nuevo.
