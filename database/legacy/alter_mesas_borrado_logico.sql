USE sistema_chepola;

-- Borrado lógico de mesas: al "eliminar" una mesa no se borra la fila (rompería la FK de los
-- pedidos históricos que la referencian), solo se marca como inactiva y deja de listarse.
ALTER TABLE mesas
  ADD COLUMN activa TINYINT(1) NOT NULL DEFAULT 1;

-- El número de mesa ya no puede ser único de forma global: si se "elimina" la mesa 5, tiene que
-- poder crearse una mesa 5 nueva sin chocar con la fila vieja (inactiva) que se conserva por su
-- historial. La unicidad entre mesas activas ahora se valida en la aplicación (ver mesaModel.create).
ALTER TABLE mesas
  DROP INDEX numero_mesa;
