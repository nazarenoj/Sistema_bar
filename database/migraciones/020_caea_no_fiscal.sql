-- B8: CAEA y comprobantes no fiscales (Ventas RF11, RF12, RN15, RN55, RN84).
-- Re-ejecutable: cada ALTER se arma solo si su columna centinela no existe.

-- CAEA del período (quincena) y punto de venta. `tope_informe` es la fecha límite para informar a ARCA.
CREATE TABLE IF NOT EXISTS caea (
  id                       INT        AUTO_INCREMENT PRIMARY KEY,
  punto_venta              SMALLINT UNSIGNED NOT NULL,
  periodo                  CHAR(6)    NOT NULL,
  orden                    TINYINT    NOT NULL,
  caea                     CHAR(14)   NOT NULL,
  vigencia_desde           DATE       NOT NULL,
  vigencia_hasta           DATE       NOT NULL,
  tope_informe             DATE       NULL,
  sin_movimiento_informado TINYINT(1) NOT NULL DEFAULT 0,
  created_at               TIMESTAMP  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_caea_periodo UNIQUE (punto_venta, periodo, orden)
);

-- Contador atómico local por clave (RN55): numeración con CAEA y de los comprobantes no fiscales.
-- No consulta a ARCA, no tiene respuesta tardía ni estado indeterminado.
CREATE TABLE IF NOT EXISTS contadores_comprobante (
  clave  VARCHAR(40) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  ultimo INT UNSIGNED NOT NULL DEFAULT 0
);

SET @sql = (
  SELECT IF(COUNT(*) = 0,
    "ALTER TABLE facturas
       ADD COLUMN modalidad        ENUM('CAE', 'CAEA') NOT NULL DEFAULT 'CAE',
       ADD COLUMN caea_id          INT        NULL,
       ADD COLUMN informado_ms     BIGINT     NULL,
       ADD COLUMN intentos_informe INT        NOT NULL DEFAULT 0,
       ADD KEY idx_facturas_caea_pendiente (modalidad, informado_ms)",
    'SELECT 1')
  FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'facturas' AND column_name = 'modalidad'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Una venta no fiscal queda "pendiente de facturación" hasta que existe una factura aprobada de su cuenta.
SET @sql = (
  SELECT IF(COUNT(*) = 0,
    "ALTER TABLE ventas
       ADD COLUMN condicion_fiscal  VARCHAR(20) NOT NULL DEFAULT 'fiscal',
       ADD COLUMN tipo_no_fiscal    VARCHAR(20) NULL,
       ADD COLUMN numero_no_fiscal  INT UNSIGNED NULL",
    'SELECT 1')
  FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'ventas' AND column_name = 'condicion_fiscal'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

INSERT IGNORE INTO parametros (clave, valor) VALUES
  ('dias_alerta_no_fiscal', '30'),   -- RN84: ventas no fiscales sin regularizar hace más de N días
  ('dias_alerta_informe_caea', '2'); -- EX06: aviso antes del plazo para informar los CAEA
