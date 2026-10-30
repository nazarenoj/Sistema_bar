-- C7: lotes y vencimiento, FEFO, lote indicado (Stock RF20, RN06, RN73, RN74; Ventas RF48, EX57). Función STK-LOTES.
-- Cada ítem decide si controla lote; el saldo por lote sale de los movimientos (`lote_id`). Los lotes ya registrados
-- se conservan aunque la función se desactive. Re-ejecutable: ALTER condicionados a su columna centinela.

SET @sql = (
  SELECT IF(COUNT(*) = 0,
    "ALTER TABLE insumos
       ADD COLUMN controla_lote    TINYINT(1) NOT NULL DEFAULT 0,
       ADD COLUMN vida_util_dias   INT        NULL,
       ADD COLUMN vencido_politica ENUM('bloquear', 'advertir') NOT NULL DEFAULT 'bloquear'",
    'SELECT 1')
  FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'insumos' AND column_name = 'controla_lote'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql = (
  SELECT IF(COUNT(*) = 0,
    "ALTER TABLE productos
       ADD COLUMN controla_lote    TINYINT(1) NOT NULL DEFAULT 0,
       ADD COLUMN vida_util_dias   INT        NULL,
       ADD COLUMN vencido_politica ENUM('bloquear', 'advertir') NOT NULL DEFAULT 'bloquear'",
    'SELECT 1')
  FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'productos' AND column_name = 'controla_lote'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

CREATE TABLE IF NOT EXISTS lotes (
  id                 BIGINT       AUTO_INCREMENT PRIMARY KEY,
  id_global          VARCHAR(40)  CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  insumo_id          INT          NULL,
  producto_id        INT          NULL,
  codigo             VARCHAR(60)  NOT NULL,
  fecha_elaboracion  DATE         NULL,
  fecha_vencimiento  DATE         NULL,
  bloqueado          TINYINT(1)   NOT NULL DEFAULT 0,
  motivo_bloqueo     VARCHAR(255) NULL,
  created_at         TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_lote_id_global UNIQUE (id_global),
  CONSTRAINT fk_lote_insumo    FOREIGN KEY (insumo_id)   REFERENCES insumos(id),
  CONSTRAINT fk_lote_producto  FOREIGN KEY (producto_id) REFERENCES productos(id),
  CONSTRAINT ck_lote_un_item   CHECK ((insumo_id IS NULL) <> (producto_id IS NULL)),
  KEY idx_lote_insumo (insumo_id, fecha_vencimiento),
  KEY idx_lote_producto (producto_id, fecha_vencimiento)
);
-- Un código de lote es único por ítem (los NULL de la otra columna no chocan: se arma la clave con el ítem que corresponde).
SET @sql = (
  SELECT IF(COUNT(*) = 0,
    "ALTER TABLE lotes ADD COLUMN item_clave VARCHAR(80) AS (CONCAT(COALESCE(insumo_id, 0), ':', COALESCE(producto_id, 0), ':', codigo)) STORED, ADD UNIQUE KEY uq_lote_item_codigo (item_clave)",
    'SELECT 1')
  FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'lotes' AND column_name = 'item_clave'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- El movimiento guarda el lote efectivo, el lote que Ventas indicó (si lo hubo) y el origen del lote (RN73).
SET @sql = (
  SELECT IF(COUNT(*) = 0,
    "ALTER TABLE stock_movimientos
       ADD COLUMN lote_id        BIGINT NULL,
       ADD COLUMN origen_lote    ENUM('indicado', 'fefo') NULL,
       ADD COLUMN lote_indicado  VARCHAR(60) NULL,
       ADD CONSTRAINT fk_mov_lote FOREIGN KEY (lote_id) REFERENCES lotes(id),
       ADD KEY idx_mov_lote (lote_id, deposito_id)",
    'SELECT 1')
  FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'stock_movimientos' AND column_name = 'lote_id'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- La línea de pedido admite el lote indicado (Ventas RF48): opcional, solo con Stock y STK-LOTES.
SET @sql = (
  SELECT IF(COUNT(*) = 0, "ALTER TABLE pedido_productos ADD COLUMN lote_indicado VARCHAR(60) NULL", 'SELECT 1')
  FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'pedido_productos' AND column_name = 'lote_indicado'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

INSERT IGNORE INTO parametros (clave, valor) VALUES ('lotes_dias_alerta', '3');
