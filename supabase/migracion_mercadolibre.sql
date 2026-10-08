-- STORGE LAB — migración: publicación automática en Mercado Libre
--
-- Segura de correr sobre tu base EN USO: no borra ni cambia nada de lo que ya
-- tenés, solo agrega tablas y columnas nuevas. Se puede correr más de una vez.
--
-- Cómo usarla: Supabase → SQL Editor → pegar todo este archivo → Run.
--
-- Qué guarda:
--   ml_config         → tus reglas de precio para ML (recargo %, costo del envío
--                       gratis, redondeo, tipo de publicación, stock, garantía).
--                       La edita el panel admin.
--   ml_cuenta         → la conexión con tu cuenta de Mercado Libre (tokens).
--                       PRIVADA: sin ninguna política, así que ni la tienda ni
--                       el panel la pueden leer; solo las funciones de Netlify
--                       con la llave de servicio.
--   ml_oauth_estados  → códigos de un solo uso para el botón "Conectar". Privada.
--   ml_publicaciones  → qué producto/tamaño/color está publicado en qué aviso
--                       de ML, con su precio y estado. El panel la lee; solo
--                       las funciones la escriben.
--   productos.*_ml    → opciones de ML por producto (categoría, descripción
--                       propia para ML, atributos extra).

-- ============ 1) CONFIGURACIÓN ============
create table if not exists ml_config (
  id integer primary key default 1 check (id = 1),     -- una sola fila
  recargo_pct numeric not null default 15 check (recargo_pct >= 0 and recargo_pct <= 100),
  costo_envio numeric not null default 0 check (costo_envio >= 0),  -- $U que se suman para cubrir el envío gratis
  redondear_a integer not null default 10 check (redondear_a >= 1), -- 1 = sin redondeo; 10 = sube al múltiplo de 10
  tipo_publicacion text not null default 'gold_special',           -- gold_special = Clásica, gold_pro = Premium
  stock_por_variante integer not null default 10 check (stock_por_variante >= 1 and stock_por_variante <= 999),
  dias_fabricacion integer check (dias_fabricacion is null or (dias_fabricacion >= 1 and dias_fabricacion <= 45)),
  garantia text not null default '30 días',
  sync_auto boolean not null default true,              -- true = la sincronización de cada hora está prendida
  ultima_sync_at timestamptz,
  ultima_sync_resumen text,
  updated_at timestamptz not null default now()
);
insert into ml_config (id) values (1) on conflict (id) do nothing;

alter table ml_config enable row level security;
drop policy if exists "ml_config admin" on ml_config;
create policy "ml_config admin" on ml_config for all
  using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');
grant select, update on ml_config to authenticated;

-- ============ 2) CUENTA (tokens) — PRIVADA ============
create table if not exists ml_cuenta (
  id integer primary key default 1 check (id = 1),
  ml_user_id bigint not null,
  nickname text,
  site_id text,
  access_token text not null,
  refresh_token text not null,
  expires_at timestamptz not null,
  user_products boolean not null default false,  -- la cuenta publica con el modelo nuevo de ML ("User Products")
  updated_at timestamptz not null default now()
);
alter table ml_cuenta enable row level security;
-- Sin políticas a propósito: solo la llave de servicio (funciones de Netlify) la ve.
revoke all on ml_cuenta from anon, authenticated;

create table if not exists ml_oauth_estados (
  estado text primary key,
  created_at timestamptz not null default now()
);
alter table ml_oauth_estados enable row level security;
revoke all on ml_oauth_estados from anon, authenticated;

-- ============ 3) PUBLICACIONES ============
create table if not exists ml_publicaciones (
  id uuid primary key default gen_random_uuid(),
  producto_id uuid not null references productos(id) on delete cascade,
  tamano text not null default '',      -- '' = producto sin tamaños
  color text not null default '',       -- '' = un aviso con todos los colores como variantes (modelo clásico)
  ml_item_id text unique,
  permalink text,
  modo text not null default 'clasico', -- clasico | user_products
  categoria_id text,
  precio numeric,
  stock integer,
  estado text,                          -- active | paused | closed | under_review ...
  variaciones jsonb not null default '[]', -- modelo clásico: [{color, variation_id, stock}]
  desc_hash text,
  ultima_sync timestamptz,
  ultimo_error text,
  created_at timestamptz not null default now(),
  unique (producto_id, tamano, color)
);
alter table ml_publicaciones enable row level security;
drop policy if exists "ml_publicaciones admin lee" on ml_publicaciones;
create policy "ml_publicaciones admin lee" on ml_publicaciones for select
  using (auth.role() = 'authenticated');
grant select on ml_publicaciones to authenticated;
create index if not exists idx_ml_publicaciones_producto on ml_publicaciones(producto_id);

-- ============ 4) OPCIONES DE ML POR PRODUCTO ============
alter table productos add column if not exists ml_categoria_id text;   -- null = la elige el predictor de ML
alter table productos add column if not exists descripcion_ml text;    -- null = usa la descripción de la web, en texto plano
alter table productos add column if not exists ml_atributos jsonb;     -- [{"id":"MATERIAL","value_name":"PLA"}] extra u obligatorios que falten

-- Listo. Después de correr esto, en /admin.html aparece la pestaña
-- "Mercado Libre" con todo funcionando (falta cargar las variables en Netlify:
-- ver MERCADOLIBRE.md).
