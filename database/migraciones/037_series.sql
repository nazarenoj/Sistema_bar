-- C12: artículos con número de serie (Stock RF26, RF37, RF41, RN05, RN71, RN79). Función STK-SERIE (requiere VEN-SERIE): cada unidad
-- es una serie con su estado (Disponible / Comprometida / Vendida / Baja), su historial inmodificable y su garantía.
-- Re-ejecutable: tablas IF NOT EXISTS, ALTER condicionado a su columna, triggers con DROP IF EXISTS.

SET @sql = (SELECT IF(COUNT(*) = 0, "ALTER TABLE productos ADD COLUMN controla_serie TINYINT(1) NOT NULL DEFAULT 0", 'SELECT 1')
  FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'productos' AND column_name = 'controla_serie');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

CREATE TABLE IF NOT EXISTS series (
  id                    BIGINT       AUTO_INCREMENT PRIMARY KEY,
  id_global             VARCHAR(40)  CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  producto_id           INT          NOT NULL,
  numero_serie          VARCHAR(80)  NOT NULL,
  estado                ENUM('disponible', 'comprometida', 'vendida', 'baja', 'convertida') NOT NULL DEFAULT 'disponible',
  deposito_id           INT          NOT NULL,
  id_compromiso         VARCHAR(60)  NULL,
  costo_unitario        DECIMAL(14,4) NULL,
  fecha_fin_garantia    DATE         NULL,
  condicion_devolucion  ENUM('sin_falla', 'con_falla') NULL,
  motivo_baja           VARCHAR(255) NULL,
  updated_at            TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT uq_serie_id_global UNIQUE (id_global),
  CONSTRAINT uq_serie_numero UNIQUE (producto_id, numero_serie),
  CONSTRAINT fk_serie_producto FOREIGN KEY (producto_id) REFERENCES productos(id),
  CONSTRAINT fk_serie_deposito FOREIGN KEY (deposito_id) REFERENCES depositos(id),
  KEY idx_serie_estado (producto_id, estado)
);

-- Historial de solo agregar (RF41): ingreso, compromiso, venta, devolución, baja, conversión y conteos.
CREATE TABLE IF NOT EXISTS serie_historial (
  id          BIGINT       AUTO_INCREMENT PRIMARY KEY,
  serie_id    BIGINT       NOT NULL,
  evento      ENUM('ingreso', 'compromiso', 'liberacion', 'venta', 'devolucion', 'baja', 'conversion', 'conteo') NOT NULL,
  detalle     TEXT         NULL,
  documento   VARCHAR(60)  NULL,
  user_id     INT          NULL,
  created_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_serie_hist FOREIGN KEY (serie_id) REFERENCES series(id),
  KEY idx_serie_hist (serie_id, id)
);
DROP TRIGGER IF EXISTS serie_historial_no_update;
CREATE TRIGGER serie_historial_no_update BEFORE UPDATE ON serie_historial FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'El historial de una serie es inmodificable';
DROP TRIGGER IF EXISTS serie_historial_no_delete;
CREATE TRIGGER serie_historial_no_delete BEFORE DELETE ON serie_historial FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'El historial de una serie es inmodificable';

INSERT IGNORE INTO rol_permisos (rol_id, permiso, nivel)
SELECT r.id, p.permiso, p.nivel FROM roles r JOIN (
  SELECT 'gerente' rol, 'stock.series.gestionar' permiso, 'permitido' nivel UNION ALL
  SELECT 'encargado', 'stock.series.gestionar', 'permitido' UNION ALL
  SELECT 'deposito', 'stock.series.gestionar', 'permitido' UNION ALL
  SELECT 'gerente', 'stock.series.baja', 'requiere_autorizacion' UNION ALL
  SELECT 'encargado', 'stock.series.baja', 'requiere_autorizacion'
) p ON p.rol = r.codigo;
