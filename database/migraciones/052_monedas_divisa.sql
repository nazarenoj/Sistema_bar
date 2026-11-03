-- F2 + D11: monedas y cotizaciones (Usuarios RF14, RN17, EX12) y cobro en moneda extranjera (Ventas RF28, RN44, EX32). Función VEN-DIVISA.
-- Re-ejecutable: tablas IF NOT EXISTS, ALTER condicionados a su columna centinela, semillas con INSERT IGNORE.

CREATE TABLE IF NOT EXISTS monedas (
  codigo   VARCHAR(3)  NOT NULL PRIMARY KEY,
  nombre   VARCHAR(60) NOT NULL,
  simbolo  VARCHAR(5)  NOT NULL,
  es_local TINYINT(1)  NOT NULL DEFAULT 0,
  activa   TINYINT(1)  NOT NULL DEFAULT 1
);
INSERT IGNORE INTO monedas (codigo, nombre, simbolo, es_local) VALUES ('ARS', 'Peso argentino', '$', 1);
INSERT IGNORE INTO monedas (codigo, nombre, simbolo, es_local) VALUES ('USD', 'Dólar estadounidense', 'US$', 0), ('EUR', 'Euro', '€', 0);

-- Cotizaciones (comprador y vendedor, con fecha y hora): de solo agregar. La vigente es la última cargada para la fecha (RN17).
CREATE TABLE IF NOT EXISTS cotizaciones (
  id          INT           AUTO_INCREMENT PRIMARY KEY,
  moneda      VARCHAR(3)    NOT NULL,
  comprador   DECIMAL(14,4) NOT NULL,
  vendedor    DECIMAL(14,4) NOT NULL,
  fecha_hora  DATETIME      NOT NULL,
  origen      ENUM('manual', 'automatica') NOT NULL DEFAULT 'manual',
  user_id     INT           NULL,
  created_at  TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_cotizacion_moneda (moneda, fecha_hora),
  CONSTRAINT fk_cotizacion_moneda FOREIGN KEY (moneda) REFERENCES monedas(codigo)
);
DROP TRIGGER IF EXISTS cotizaciones_no_update;
CREATE TRIGGER cotizaciones_no_update BEFORE UPDATE ON cotizaciones FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Las cotizaciones son de solo agregar';
DROP TRIGGER IF EXISTS cotizaciones_no_delete;
CREATE TRIGGER cotizaciones_no_delete BEFORE DELETE ON cotizaciones FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Las cotizaciones son de solo agregar';

-- Antigüedad máxima de una cotización para usarla en un cobro (EX32: 24 horas por defecto).
INSERT IGNORE INTO parametros (clave, valor) VALUES ('cotizacion_antiguedad_horas', '24');

-- La moneda de cada forma de pago, y la cotización que fijó cada cobro en divisa (viaja a Financiero, que no vuelve a cotizar).
SET @sql = (
  SELECT IF(COUNT(*) = 0, "ALTER TABLE formas_pago ADD COLUMN moneda VARCHAR(3) NOT NULL DEFAULT 'ARS'", 'SELECT 1')
  FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'formas_pago' AND column_name = 'moneda'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql = (
  SELECT IF(COUNT(*) = 0, 'ALTER TABLE pago_venta ADD COLUMN moneda VARCHAR(3) NULL, ADD COLUMN importe_divisa DECIMAL(14,2) NULL, ADD COLUMN cotizacion DECIMAL(14,4) NULL, ADD COLUMN cotizacion_id INT NULL', 'SELECT 1')
  FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'pago_venta' AND column_name = 'cotizacion'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

INSERT IGNORE INTO rol_permisos (rol_id, permiso, nivel)
SELECT r.id, p.permiso, p.nivel FROM roles r JOIN (
  SELECT 'gerente' rol, 'usuarios.cotizaciones.cargar' permiso, 'permitido' nivel UNION ALL
  SELECT 'encargado', 'usuarios.cotizaciones.cargar', 'permitido'
) p ON p.rol = r.codigo;
