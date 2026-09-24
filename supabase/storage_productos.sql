-- Bucket de Storage para las imágenes de producto subidas desde /admin.html
-- Mismo patrón que RGOL: el botón "+" del panel las sube acá y esa URL pública
-- se guarda directo en productos.imagenes.

insert into storage.buckets (id, name, public)
values ('productos-imagenes', 'productos-imagenes', true)
on conflict (id) do nothing;

-- Cualquiera puede leer/ver las imágenes (así se muestran en el catálogo público)
create policy "Lectura publica imagenes productos"
on storage.objects for select
using (bucket_id = 'productos-imagenes');

-- Solo el admin autenticado (el panel /admin) puede subir, reemplazar o borrar imágenes
create policy "Subida admin imagenes productos"
on storage.objects for insert
to authenticated
with check (bucket_id = 'productos-imagenes');

create policy "Actualizacion admin imagenes productos"
on storage.objects for update
to authenticated
using (bucket_id = 'productos-imagenes');

create policy "Borrado admin imagenes productos"
on storage.objects for delete
to authenticated
using (bucket_id = 'productos-imagenes');
