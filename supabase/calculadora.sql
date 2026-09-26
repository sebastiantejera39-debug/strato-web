-- STRATO — calculadora de costos de impresión 3D (panel admin)
-- Corré esto en Supabase → SQL Editor, en cualquier momento después de
-- schema.sql (no depende de storage_productos.sql ni seed.sql).
--
-- Agrega dos tablas nuevas, ambas 100% internas (no las lee el sitio
-- público, solo el panel /admin.html autenticado):
--   - maquinas_3d: tus impresoras, para elegir un preset en la calculadora.
--   - cotizaciones: el historial de "Guardar cotización" de la calculadora.

-- ============ MAQUINAS (impresoras propias) ============
create table if not exists maquinas_3d (
  id uuid primary key default gen_random_uuid(),
  nombre text not null,
  marca text,
  potencia_w numeric not null default 200,
  vida_util_horas numeric not null default 5000,
  costo_reposicion numeric not null default 0,
  activa boolean not null default true,
  orden integer not null default 0,
  created_at timestamptz not null default now()
);

-- ============ COTIZACIONES (historial de la calculadora) ============
create table if not exists cotizaciones (
  id uuid primary key default gen_random_uuid(),
  nombre_pieza text not null,
  cliente text,
  maquina_nombre text,
  material_nombre text,
  inputs jsonb not null default '{}',      -- todos los valores que se usaron
  resultados jsonb not null default '{}',  -- todos los montos calculados
  total_a_cobrar numeric not null default 0,
  created_at timestamptz not null default now()
);

-- ============ ROW LEVEL SECURITY ============
alter table maquinas_3d enable row level security;
alter table cotizaciones enable row level security;

-- Nada de acceso público: solo el panel admin autenticado.
create policy "maquinas admin" on maquinas_3d for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');
create policy "cotizaciones admin" on cotizaciones for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

grant select, insert, update, delete on maquinas_3d, cotizaciones to authenticated;

create index if not exists idx_cotizaciones_created on cotizaciones(created_at desc);
create index if not exists idx_maquinas_orden on maquinas_3d(orden);
