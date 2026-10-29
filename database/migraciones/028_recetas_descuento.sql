-- C3: recetas y descuento por venta (Stock RF07 a RF09, RN50, RN51, RN64 a RN66). La receta admite sub-recetas
-- (una línea puede ser un elaborado intermedio) y merma/rendimiento, y guarda su historial de versiones. El
-- descuento llega como mensaje de Ventas y es idempotente por (ID_Operacion, línea, ítem): `operacion_clave`.
-- Re-ejecutable: cada ALTER se arma solo si su columna centinela no existe.

SET @sql = (
  SELECT IF(COUNT(*) = 0,
    "ALTER TABLE producto_insumos
       MODIFY COLUMN insumo_id INT NULL,
       ADD COLUMN componente_producto_id INT NULL,
       ADD COLUMN merma_pct DECIMAL(5,2) NOT NULL DEFAULT 0,
       ADD CONSTRAINT fk_pi_subreceta FOREIGN KEY (componente_producto_id) REFERENCES productos(id),
       ADD CONSTRAINT uq_pi_producto_subreceta UNIQUE (producto_id, componente_producto_id)",
    'SELECT 1')
  FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'producto_insumos' AND column_name = 'componente_producto_id'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Cada cambio de la receta de un artículo guarda una versión (RF09).
CREATE TABLE IF NOT EXISTS recetas_versiones (
  id          INT         AUTO_INCREMENT PRIMARY KEY,
  producto_id INT         NOT NULL,
  version     INT         NOT NULL,
  lineas      MEDIUMTEXT  NOT NULL,
  user_id     INT         NULL,
  created_at  TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_receta_version UNIQUE (producto_id, version),
  CONSTRAINT fk_receta_producto FOREIGN KEY (producto_id) REFERENCES productos(id) ON DELETE CASCADE
);

SET @sql = (
  SELECT IF(COUNT(*) = 0,
    "ALTER TABLE stock_movimientos
       ADD COLUMN operacion_clave  VARCHAR(160) CHARACTER SET ascii COLLATE ascii_bin NULL,
       ADD COLUMN venta_no_fiscal  TINYINT(1) NOT NULL DEFAULT 0,
       ADD CONSTRAINT uq_mov_operacion_clave UNIQUE (operacion_clave)",
    'SELECT 1')
  FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'stock_movimientos' AND column_name = 'operacion_clave'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
