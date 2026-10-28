USE sistema_chepola;

ALTER TABLE pedido_productos
  ADD COLUMN nombre      VARCHAR(255) NOT NULL DEFAULT '' AFTER cantidad,
  ADD COLUMN descripcion TEXT                             AFTER nombre;

-- Rellena los registros existentes con los datos actuales del producto
UPDATE pedido_productos pp
JOIN productos p ON pp.producto_id = p.id
SET pp.nombre = p.nombre,
    pp.descripcion = p.descripcion;
