# Publicar en Mercado Libre desde el panel — puesta en marcha

Desde la pestaña **Mercado Libre** de `/admin.html` publicás tus productos con un botón. Después se mantienen al día solos cada hora: precio, stock por color, pausas y descripción.

**Precio en ML**: por defecto, precio web + recargo % + costo del envío gratis, redondeado hacia arriba (ver "Comisión de ML" más abajo para que además cubra lo que ML te cobra por vender). Todos los avisos van con **envío gratis**.

## 1. Supabase (2 minutos)

1. **SQL Editor →** pegá todo `supabase/migracion_mercadolibre.sql` **→ Run**. Se puede correr de nuevo cuantas veces quieras: solo agrega lo que falta. (Si ya la corriste antes, volvé a correrla una vez: la sección 4b agrega la comisión de ML.)
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
- **`js/`:** `admin-ml.js`
- **`supabase/`:** `migracion_mercadolibre.sql`
- **`netlify/`:** arrastrá **la carpeta `netlify` completa desde Finder** a la raíz del repo. Así GitHub crea `netlify/lib/ml.js`, que es una carpeta nueva, y suma `netlify/functions/ml-admin.js`, `ml-callback.js` y `ml-sync-cron.js`. `create-preference.js` no cambió.

Después del deploy, revisá que en **Netlify → Functions** aparezcan `ml-admin`, `ml-callback` y `ml-sync-cron`. Esta última tiene que figurar como "Scheduled".

## 5. Usarlo

1. **Panel → Mercado Libre → Conectar con Mercado Libre → Autorizar.** Volvés al panel con "Cuenta conectada".
2. Cargá el **recargo %** y el **costo del envío gratis**. El ejemplo de abajo te muestra el precio final y **cuánto te queda después de la comisión de ML** (en rojo si te queda menos que el precio de la web).
   - Para saber cuánto poner de envío, mirá en tu cuenta de ML cuánto te cobran por enviar gratis.
   - Para que ML no te coma el margen, prendé **"Incluir la comisión de Mercado Libre en el precio"** (ver abajo).
3. En cada producto, tocá **Vista previa**. ML valida el aviso sin publicarlo y te muestra:
   - la categoría que eligió,
   - el título y el precio de cada aviso,
   - los datos obligatorios que faltan.

   Si falta algo, cargalo en **Opciones → Atributos extra**, una línea por dato, por ejemplo `SHAPE = Redonda`. En Opciones también podés corregir la categoría o escribir una descripción propia para ML.
4. **Publicar.** Listo.

## Comisión de ML en el precio

ML te cobra por cada venta un **cargo por venta** (entre 11,5 % y 17 % del precio total, según la categoría) y, si el precio es menor a $U 1.000, un **costo fijo por unidad**: $U 15 (menos de $U 500), $U 25 ($U 500 a 750) o $U 40 ($U 750 a 1.000). Además pagás el envío gratis. Con la fórmula vieja (web + recargo + envío) la comisión se calculaba sobre un precio que no la cubría, así que en los productos baratos cobrabas menos que en la web.

Para arreglarlo, en la configuración de arriba hay dos campos nuevos (aparecen después de correr el SQL, sección 4b):

- **Incluir la comisión de Mercado Libre en el precio:** apagado = fórmula de siempre. Prendido = el precio en ML es el más bajo (redondeado hacia arriba) con el que, después de la comisión, el costo fijo y el envío, **te queda el precio de la web más el recargo**. Con esto prendido, el recargo pasa a ser tu ganancia extra (puede ser 0).
- **Comisión por venta de ML (%):** la comisión general que usa el cálculo (14 % por defecto).

Cada producto puede tener **su propia comisión** en **Opciones** (vacío = la general). La **Vista previa** consulta a ML cuánto cobra de verdad en la categoría de ese producto y, si difiere de la que cargaste, ofrece el botón **"Usar X% en este producto"**. En la lista de productos, debajo del precio en ML, se ve cuánto te queda por venta (en rojo si es menos que la web). Si cambiás algo, tocá **Sincronizar** para mandar el precio nuevo a ML.

El costo fijo por tramos está escrito en el código con la tabla de ML de hoy: si ML la cambia, hay que actualizarla (`FIXED_TIERS` en `netlify/lib/ml.js` y en `js/admin-ml.js`).

## Avisos que creaste o moviste a mano en ML

Si un aviso de la web quedó **finalizado** en ML (o falta) y en ML hay un aviso suelto con **el mismo nombre y el mismo color**, la sincronización lo **vincula** en vez de dejar un error o publicar un duplicado, y le aplica precio, stock y descripción de la web. Por ejemplo: borraste el aviso de un color y lo agregaste a mano a la familia de otro producto desde ML.

- El nombre del aviso en ML (el de la familia) tiene que ser el mismo que el del producto en la web (más el tamaño, si tiene), y el color tiene que llamarse igual (no importan mayúsculas ni acentos).
- Si hay **dos** avisos que parecen ser el mismo color, no adivina: te avisa cuáles son para que finalices el que sobra.
- Si hay uno con el nombre pero otro color (por ejemplo "Blanco" en vez de "Blanco Hueso"), te lo avisa en "Para revisar" y no lo toca.
- Un aviso ya vinculado a otro producto o color no se vuelve a vincular.

## Cómo se arman los avisos

- **Un aviso por tamaño**, con los colores como variantes.
- Si tu cuenta usa el modelo nuevo de ML ("User Products"), va **un aviso por color**, y ML los agrupa en la misma ficha. El panel lo detecta solo.
- **Stock:** un número fijo por color (imprimís a pedido). Los colores marcados "sin stock" en Filamentos quedan en 0.
- **Pausas:**
  - Si ocultás un producto en la web, se pausa en ML.
  - Si sacás un tamaño o un color de la web, se pausa su aviso y pasa a la lista de **"retirados"** del producto (plegada, sin errores). El botón **Limpiar** los finaliza en ML y los saca de la lista; hasta que lo toques siguen pausados (no se ven en ML).
- **Nombre:** si cambiás el nombre del producto en la web, la sincronización se lo manda a ML. **ML solo deja cambiar el título de un aviso que todavía no vendió**: en los que ya tienen ventas el nombre queda como estaba y la sincronización te lo avisa.
- **Descripción:** sale de la web pasada a texto plano, más el material, "impresa en 3D a pedido en Montevideo", los días de fabricación (si los cargaste) y "envío gratis".
  - **ML no permite** links, teléfonos, WhatsApp ni redes: la vista previa te avisa si hay algo de eso.
- **No pasan a ML:** los descuentos por cantidad y los cupones (ML tiene sus propias promociones), ni los productos "a cotizar".

## Lo que no hace (todavía)

- **Ventas:** las ventas de ML no entran a la tabla de pedidos de la web. Las ves en Mercado Libre.
- **Cambios hechos en ML:** si cambiás un precio directo en ML, la sincronización lo vuelve a poner como dice la web.
- **Productos borrados de la web:** si borrás un producto entero de la web, sus avisos siguen vivos en ML (la web ya no los conoce). Finalizalos desde ML.
- **Modo clásico (colores como variantes en un solo aviso):** si agregás una variante a mano en ML, la próxima sincronización puede sacarla. Con el modelo nuevo (un aviso por color) no pasa.

## Si algo falla

- **"Falta configurar …":** falta esa variable en Netlify, o el deploy todavía no terminó.
- **"Se venció la conexión":** tocá Reconectar.
- **"Mercado Libre no pudo sugerir una categoría para …":** ML adivina la categoría por el nombre del producto. Si no la encuentra, el panel prueba además con la palabra que usa ML (por ejemplo "portafotos" → "portarretratos"). Si igual no, cargá el código a mano en **Opciones → Categoría** (algo como `MLU1234`).
- **"The attributes [XXX] are required for category MLUnnn" (o cualquier dato de la categoría que no tiene que ver con tu producto):** ML eligió una categoría equivocada (por ejemplo, de electrónica para un comedero a mano). En **Vista previa**, debajo de "Categoría", ML ofrece otras categorías con su código: tocá **Usar esta** en la correcta y se guarda en el producto y se valida de nuevo. Si ninguna sirve, buscá el código con `https://api.mercadolibre.com/sites/MLU/domain_discovery/search?q=lo que vendés` (mirá el `category_id`) y cargalo en **Opciones → Categoría**.
- **Error al publicar por envíos:** revisá que **Mercado Envíos** esté activo en tu cuenta de vendedor.
- **Borraste o finalizaste un aviso en ML:** la próxima sincronización lo detecta sola. Si ese color/tamaño ya no está en la web, desaparece de la lista. Si todavía está en la web, queda como **"Finalizado"** (gris, no es un error) con el botón **Publicar de nuevo**, que crea uno nuevo. No se vuelve a crear solo, para no pisar lo que hiciste en ML; si no lo querés en ML, sacá ese color/tamaño de la web.
