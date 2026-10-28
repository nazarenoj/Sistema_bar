USE sistema_chepola;

CREATE TABLE IF NOT EXISTS insumos (
  id             INT            AUTO_INCREMENT PRIMARY KEY,
  nombre         VARCHAR(255)   NOT NULL,
  unidad         VARCHAR(50)    NOT NULL,
  costo_unitario DECIMAL(10,2),
  stock          DECIMAL(10,3)  NOT NULL DEFAULT 0,
  disponible     TINYINT(1)     NOT NULL DEFAULT 1,
  created_at     TIMESTAMP      DEFAULT CURRENT_TIMESTAMP,
  updated_at     TIMESTAMP      DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- Receta: cuánto de cada insumo consume una unidad de un producto.
-- Si se borra el producto, su receta se borra con él (le pertenece).
-- Si se intenta borrar un insumo usado en alguna receta, falla por FK (ver insumoModel.remove).
CREATE TABLE IF NOT EXISTS producto_insumos (
  id                 INT           AUTO_INCREMENT PRIMARY KEY,
  producto_id        INT           NOT NULL,
  insumo_id          INT           NOT NULL,
  cantidad_consumida DECIMAL(10,3) NOT NULL,
  CONSTRAINT fk_pi_producto FOREIGN KEY (producto_id) REFERENCES productos(id) ON DELETE CASCADE,
  CONSTRAINT fk_pi_insumo   FOREIGN KEY (insumo_id)   REFERENCES insumos(id),
  CONSTRAINT uq_pi_producto_insumo UNIQUE (producto_id, insumo_id)
);
