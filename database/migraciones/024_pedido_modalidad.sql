-- B2: pedido y salón (Ventas RF05, RF06, RN09, RN10, RN11). El pedido tiene modalidad (salón, mostrador/barra,
-- para llevar, delivery, retiro), origen, mozo o vendedor y, en el salón, la silla. Los pedidos que no son de
-- salón cuelgan de una mesa "virtual" propia (oculta en el salón): así usan el mismo cierre, venta y factura.
-- Re-ejecutable: cada ALTER se arma solo si su columna centinela no existe.

SET @sql = (
  SELECT IF(COUNT(*) = 0,
    "ALTER TABLE mesas ADD COLUMN es_virtual TINYINT(1) NOT NULL DEFAULT 0", 'SELECT 1')
  FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'mesas' AND column_name = 'es_virtual'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @sql = (
  SELECT IF(COUNT(*) = 0,
    "ALTER TABLE pedidos
       ADD COLUMN modalidad  ENUM('salon', 'mostrador', 'para_llevar', 'delivery', 'retiro') NOT NULL DEFAULT 'salon',
       ADD COLUMN origen     ENUM('local', 'ventas_online', 'plataforma') NOT NULL DEFAULT 'local',
       ADD COLUMN mozo_id    INT          NULL,
       ADD COLUMN silla_id   INT          NULL,
       ADD COLUMN referencia VARCHAR(255) NULL,
       ADD KEY idx_pedidos_silla (silla_id, estado)",
    'SELECT 1')
  FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'pedidos' AND column_name = 'modalidad'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @sql = (
  SELECT IF(COUNT(*) = 0,
    "ALTER TABLE pedido_productos ADD COLUMN observaciones VARCHAR(255) NULL", 'SELECT 1')
  FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'pedido_productos' AND column_name = 'observaciones'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @sql = (
  SELECT IF(COUNT(*) = 0,
    "ALTER TABLE ventas
       ADD COLUMN modalidad VARCHAR(20) NOT NULL DEFAULT 'salon',
       ADD COLUMN mozo_id   INT NULL",
    'SELECT 1')
  FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'ventas' AND column_name = 'modalidad'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Ítems quitados de un pedido: quién, cuándo y por qué (RN11). De solo agregar.
CREATE TABLE IF NOT EXISTS item_anulaciones (
  id          INT           AUTO_INCREMENT PRIMARY KEY,
  pedido_id   INT           NOT NULL,
  producto_id INT           NOT NULL,
  nombre      VARCHAR(255)  NOT NULL,
  cantidad    INT           NOT NULL,
  precio_unitario DECIMAL(10,2) NOT NULL,
  motivo      VARCHAR(255)  NULL,
  user_id     INT           NULL,
  created_at  TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_anulacion_pedido (pedido_id)
);

DROP TRIGGER IF EXISTS item_anulaciones_no_update;
CREATE TRIGGER item_anulaciones_no_update BEFORE UPDATE ON item_anulaciones FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Las anulaciones de ítems son de solo agregar';
DROP TRIGGER IF EXISTS item_anulaciones_no_delete;
CREATE TRIGGER item_anulaciones_no_delete BEFORE DELETE ON item_anulaciones FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Las anulaciones de ítems son de solo agregar';
