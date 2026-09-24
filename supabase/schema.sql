-- STRATO — esquema de base de datos (Supabase / Postgres)
-- Mismo enfoque que el schema.sql de RGOL.UY: tablas simples + Row Level Security,
-- pero adaptado al modelo de Strato (se imprime a pedido, no hay talles ni stock
-- que descontar como con las camisetas).
--
-- Cómo usarlo: pegá este archivo completo en Supabase → SQL Editor → Run.
-- Después corré seed.sql para cargar las categorías y productos de arranque.

-- ============ CATEGORIAS ============
create table if not exists categorias (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  nombre text not null,
  descripcion_corta text,
  orden integer not null default 0,
  created_at timestamptz not null default now()
);

-- ============ PRODUCTOS ============
create table if not exists productos (
  id uuid primary key default gen_random_uuid(),
  nombre text not null,
  categoria_id uuid references categorias(id) on delete set null,
  precio numeric,                       -- null = "a cotizar" (ej: personalizados)
  colores text[] not null default '{}',
  material text,
  descripcion text,
  imagenes text[] not null default '{}', -- URLs del bucket productos-imagenes
  tag text,                              -- 'Destacado', 'Nuevo' o null
  activo boolean not null default true,  -- false = oculto del catálogo público
  orden integer not null default 0,
  created_at timestamptz not null default now()
);

-- ============ PEDIDOS (se crean solos desde checkout.html) ============
create table if not exists pedidos (
  id uuid primary key default gen_random_uuid(),
  cliente_nombre text not null,
  cliente_telefono text not null,
  cliente_email text,
  entrega text not null,                 -- 'Retiro en Montevideo' | 'Envío'
  direccion text,
  pago text,
  notas text,
  items jsonb not null default '[]',     -- [{producto_id, nombre, qty, color, precio}]
  subtotal numeric not null default 0,
  estado text not null default 'nuevo',  -- nuevo | confirmado | en_produccion | listo | entregado | cancelado
  created_at timestamptz not null default now()
);

-- ============ GASTOS (filamento, envíos, publicidad, etc.) ============
create table if not exists gastos (
  id uuid primary key default gen_random_uuid(),
  concepto text not null,
  monto numeric not null check (monto > 0),
  categoria text,           -- filamento | electricidad | envios | herramientas | otro
  forma_pago text,
  fecha date not null default current_date,
  nota text,
  created_at timestamptz not null default now()
);

-- ============ ROW LEVEL SECURITY ============
alter table categorias enable row level security;
alter table productos enable row level security;
alter table pedidos enable row level security;
alter table gastos enable row level security;

-- Lectura pública del catálogo (para la web, sin login)
create policy "categorias publicas" on categorias for select using (true);
create policy "productos publicos" on productos for select using (activo = true);

-- El checkout público puede CREAR un pedido, pero no leer ni tocar pedidos ajenos
create policy "pedidos insert publico" on pedidos for insert with check (true);

-- Todo lo demás (alta/baja/edición de catálogo, ver y gestionar pedidos, gastos)
-- solo para el panel admin autenticado
create policy "categorias admin" on categorias for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');
create policy "productos admin" on productos for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');
create policy "pedidos admin select" on pedidos for select using (auth.role() = 'authenticated');
create policy "pedidos admin update" on pedidos for update using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');
create policy "pedidos admin delete" on pedidos for delete using (auth.role() = 'authenticated');
create policy "gastos admin" on gastos for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

-- ============ GRANTS ============
-- Postgres exige el GRANT de tabla además de las políticas de RLS.
grant select on categorias, productos to anon, authenticated;
grant insert on pedidos to anon, authenticated;
grant select, update, delete on pedidos to authenticated;
grant select, insert, update, delete on categorias, productos, gastos to authenticated;

-- ============ ÍNDICES ÚTILES ============
create index if not exists idx_productos_categoria on productos(categoria_id);
create index if not exists idx_productos_activo on productos(activo);
create index if not exists idx_pedidos_estado on pedidos(estado);
create index if not exists idx_pedidos_created on pedidos(created_at desc);
create index if not exists idx_gastos_fecha on gastos(fecha desc);
