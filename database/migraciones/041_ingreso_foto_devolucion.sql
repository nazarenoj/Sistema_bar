-- C16: ingreso por foto (Stock RF05, EX03) y devolución a proveedor (RF40, RN80, EX58). Re-ejecutable: ALTER condicionado a su columna
-- centinela, tablas IF NOT EXISTS, semillas con INSERT IGNORE.

-- Borrador de ingreso a partir de la foto o el PDF de una factura o remito. No toca el stock hasta que un usuario lo confirma.
CREATE TABLE IF NOT EXISTS ingreso_borradores (
  id              INT          AUTO_INCREMENT PRIMARY KEY,
  id_global       VARCHAR(40)  CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  estado          ENUM('pendiente_lectura', 'borrador', 'confirmado', 'descartado') NOT NULL,
  imagen          LONGBLOB     NOT NULL,
  imagen_tipo     VARCHAR(40)  NOT NULL,
  imagen_nombre   VARCHAR(150) NULL,
  encabezado      TEXT         NULL,
  lineas          TEXT         NULL,
  deposito_id     INT          NULL,
  ingreso_id_global VARCHAR(40) CHARACTER SET ascii COLLATE ascii_bin NULL,
  user_id         INT          NULL,
  created_at      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  confirmado_at   TIMESTAMP    NULL,
  CONSTRAINT uq_borrador_id_global UNIQUE (id_global)
);

-- La imagen queda adjunta al ingreso que se generó con el borrador.
SET @sql = (
  SELECT IF(COUNT(*) = 0, 'ALTER TABLE stock_ingresos ADD COLUMN imagen_borrador_id INT NULL', 'SELECT 1')
  FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'stock_ingresos' AND column_name = 'imagen_borrador_id'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Diccionario de equivalencias (descripción del proveedor -> ítem y presentación de Stock) que aprenden las próximas lecturas.
CREATE TABLE IF NOT EXISTS equivalencias_stock (
  id              INT          AUTO_INCREMENT PRIMARY KEY,
  clave           VARCHAR(260) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  proveedor_cuit  VARCHAR(11)  NULL,
  descripcion     VARCHAR(200) NOT NULL,
  item_tipo       ENUM('insumo', 'producto') NOT NULL,
  item_id         INT          NOT NULL,
  presentacion_id INT          NULL,
  CONSTRAINT uq_equivalencia_clave UNIQUE (clave)
);

-- Devolución de mercadería a un proveedor: egreso al costo del ingreso original, "Pendiente de nota de crédito" hasta cargarla.
CREATE TABLE IF NOT EXISTS devoluciones_proveedor (
  id                 INT           AUTO_INCREMENT PRIMARY KEY,
  id_global          VARCHAR(40)   CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  movimiento_id      BIGINT        NOT NULL,
  ingreso_id_global  VARCHAR(40)   CHARACTER SET ascii COLLATE ascii_bin NULL,
  egreso_id          BIGINT        NOT NULL,
  item_tipo          ENUM('insumo', 'producto') NOT NULL,
  item_id            INT           NOT NULL,
  deposito_id        INT           NOT NULL,
  lote_id            BIGINT        NULL,
  cantidad           DECIMAL(14,3) NOT NULL,
  costo_unitario     DECIMAL(14,4) NULL,
  proveedor          VARCHAR(150)  NULL,
  motivo             VARCHAR(255)  NOT NULL,
  estado             ENUM('pendiente_nc', 'con_nc') NOT NULL DEFAULT 'pendiente_nc',
  nota_credito_clave VARCHAR(80)   CHARACTER SET ascii COLLATE ascii_bin NULL,
  nota_credito_importe DECIMAL(14,2) NULL,
  user_id            INT           NULL,
  created_at         TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_devprov_id_global UNIQUE (id_global),
  CONSTRAINT uq_devprov_nc UNIQUE (nota_credito_clave),
  KEY idx_devprov_movimiento (movimiento_id)
);

INSERT IGNORE INTO parametros (clave, valor) VALUES ('ingreso_foto_max_mb', '8');
