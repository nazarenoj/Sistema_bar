-- D3: listas de precios múltiples (Ventas RF34, RF35, RN32, EX23). Función VEN-LISTAS. La lista Minorista es la base: usa el
-- precio del catálogo y no guarda precios propios. Re-ejecutable: tablas IF NOT EXISTS, ALTER condicionados, semillas con INSERT IGNORE.

CREATE TABLE IF NOT EXISTS listas_precio (
  id             INT          AUTO_INCREMENT PRIMARY KEY,
  nombre         VARCHAR(80)  NOT NULL,
  tipo           ENUM('minorista', 'mayorista', 'online', 'personal', 'otra') NOT NULL DEFAULT 'otra',
  es_base        TINYINT(1)   NOT NULL DEFAULT 0,
  activa         TINYINT(1)   NOT NULL DEFAULT 1,
  vigente_desde  DATE         NULL,
  vigente_hasta  DATE         NULL,
  created_at     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_lista_precio_nombre UNIQUE (nombre)
);
INSERT IGNORE INTO listas_precio (nombre, tipo, es_base) VALUES ('Minorista', 'minorista', 1);

-- Precio de un artículo en una lista; sin fila se usa el precio base.
CREATE TABLE IF NOT EXISTS lista_precio_items (
  lista_id    INT           NOT NULL,
  producto_id INT           NOT NULL,
  precio      DECIMAL(10,2) NOT NULL,
  PRIMARY KEY (lista_id, producto_id),
  CONSTRAINT fk_lpi_lista FOREIGN KEY (lista_id) REFERENCES listas_precio(id) ON DELETE CASCADE
);

-- La terminal puede tener su lista; el pedido y cada línea guardan la que se usó.
SET @sql = (
  SELECT IF(COUNT(*) = 0, 'ALTER TABLE terminales ADD COLUMN lista_precio_id INT NULL', 'SELECT 1')
  FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'terminales' AND column_name = 'lista_precio_id'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql = (
  SELECT IF(COUNT(*) = 0, 'ALTER TABLE pedidos ADD COLUMN lista_precio_id INT NULL', 'SELECT 1')
  FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'pedidos' AND column_name = 'lista_precio_id'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql = (
  SELECT IF(COUNT(*) = 0, 'ALTER TABLE pedido_productos ADD COLUMN lista_precio_id INT NULL', 'SELECT 1')
  FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'pedido_productos' AND column_name = 'lista_precio_id'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
