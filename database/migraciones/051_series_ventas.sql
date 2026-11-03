-- D10: artículos con número de serie en Ventas (Ventas RF33, RN05, RN79, EX33). Función VEN-SERIE.
-- Re-ejecutable: ALTER condicionados a su columna centinela, tablas IF NOT EXISTS.

-- El tipo "serializado" y el plazo de garantía del artículo (0 = sin garantía registrada).
SET @sql = (
  SELECT IF(COUNT(*) = 0,
    "ALTER TABLE productos MODIFY tipo ENUM('estandar','variante','pesable','fraccionable','combo','elaborado','servicio','serializado') NOT NULL DEFAULT 'estandar'",
    'SELECT 1')
  FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'productos' AND column_name = 'tipo' AND column_type LIKE '%serializado%'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql = (
  SELECT IF(COUNT(*) = 0, 'ALTER TABLE productos ADD COLUMN plazo_garantia_dias INT NOT NULL DEFAULT 0', 'SELECT 1')
  FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'productos' AND column_name = 'plazo_garantia_dias'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- La serie elegida en la línea del pedido.
SET @sql = (
  SELECT IF(COUNT(*) = 0, 'ALTER TABLE pedido_productos ADD COLUMN serie VARCHAR(80) NULL', 'SELECT 1')
  FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'pedido_productos' AND column_name = 'serie'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Cada serie vendida, con su garantía (Fecha_Fin_Garantia = fecha de la venta + el plazo de ese momento, que no se recalcula, RN79) y su
-- devolución. Una misma serie no se vende dos veces sin una devolución previa (RN05): la clave vigente es única mientras no se devolvió.
CREATE TABLE IF NOT EXISTS ventas_series (
  id                 INT          AUTO_INCREMENT PRIMARY KEY,
  producto_id        INT          NOT NULL,
  numero_serie       VARCHAR(80)  NOT NULL,
  venta_id_global    VARCHAR(40)  CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  nombre             VARCHAR(255) NOT NULL,
  fecha_venta        DATETIME     NOT NULL,
  fecha_fin_garantia DATE         NULL,
  devuelta           TINYINT(1)   NOT NULL DEFAULT 0,
  con_falla          TINYINT(1)   NULL,
  motivo_falla       VARCHAR(255) NULL,
  devuelta_at        DATETIME     NULL,
  clave_vigente      VARCHAR(120) CHARACTER SET ascii COLLATE ascii_bin AS (IF(devuelta = 0, CONCAT(producto_id, ':', numero_serie), NULL)) STORED,
  CONSTRAINT uq_ventas_series_vigente UNIQUE (clave_vigente),
  KEY idx_vs_venta (venta_id_global),
  KEY idx_vs_serie (numero_serie)
);
