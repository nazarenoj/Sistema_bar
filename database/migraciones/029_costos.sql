-- C4: valuación y costos (Stock RF17, RN62, RN63; Ventas RN62, RN75, EX47). Cada movimiento congela el costo con
-- que se valorizó según el método de la instancia (promedio ponderado, PEPS o último costo). Las capas de PEPS y el
-- promedio se llevan siempre, así un cambio de método no obliga a reconstruir nada y no toca lo ya congelado.
-- Re-ejecutable: tablas IF NOT EXISTS y ALTER condicionado a su columna centinela.

-- Costo promedio ponderado y último costo de cada ítem (netos de IVA).
CREATE TABLE IF NOT EXISTS stock_costos (
  item_tipo      ENUM('insumo', 'producto') NOT NULL,
  item_id        INT           NOT NULL,
  costo_promedio DECIMAL(14,4) NULL,
  ultimo_costo   DECIMAL(14,4) NULL,
  actualizado    TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (item_tipo, item_id)
);

-- Capas de ingreso con costo para PEPS: lo que queda de cada ingreso y a qué costo entró.
CREATE TABLE IF NOT EXISTS stock_capas (
  id                 BIGINT        AUTO_INCREMENT PRIMARY KEY,
  item_tipo          ENUM('insumo', 'producto') NOT NULL,
  item_id            INT           NOT NULL,
  movimiento_id      BIGINT        NOT NULL,
  cantidad_restante  DECIMAL(14,3) NOT NULL,
  costo              DECIMAL(14,4) NOT NULL,
  created_at         TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_capa_item (item_tipo, item_id, cantidad_restante, id)
);

SET @sql = (
  SELECT IF(COUNT(*) = 0, "ALTER TABLE stock_movimientos ADD COLUMN costo_provisorio TINYINT(1) NOT NULL DEFAULT 0", 'SELECT 1')
  FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'stock_movimientos' AND column_name = 'costo_provisorio'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Copia local en Ventas del costo de cada línea vendida (Costo_Aplicado, Origen_Costo, Costo_Provisorio), que llega con
-- la confirmación del descuento. La venta no se toca (RN19): el costo se guarda aparte y queda congelado (RN62).
CREATE TABLE IF NOT EXISTS lineas_costo (
  id             INT           AUTO_INCREMENT PRIMARY KEY,
  doc_tipo       VARCHAR(20)   NOT NULL,
  doc_id_global  VARCHAR(40)   CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  linea          INT           NOT NULL,
  costo_unitario DECIMAL(14,4) NULL,
  origen_costo   ENUM('movimiento_stock', 'sin_costo') NOT NULL,
  provisorio     TINYINT(1)    NOT NULL DEFAULT 0,
  detalle        MEDIUMTEXT    NULL,
  confirmado_at  TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_linea_costo UNIQUE (doc_id_global, linea)
);

-- 1 = costo promedio ponderado, 2 = PEPS, 3 = último costo.
INSERT IGNORE INTO parametros (clave, valor) VALUES ('metodo_valuacion', '1');
