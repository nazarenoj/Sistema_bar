-- G9: flujo de fondos, balance de actividad, moneda extranjera y diferencia de cambio, indicadores y consolidación (Financiero RF13 a RF16, RF25, RF26, RN09, RN36, EX10).
-- Re-ejecutable: las columnas se agregan solo si faltan.

SET @sql = (
  SELECT IF(COUNT(*) = 0,
    "ALTER TABLE fin_config ADD COLUMN cotizacion_vencida VARCHAR(10) NOT NULL DEFAULT 'advertir', ADD COLUMN divisas_tolerancia_pct DECIMAL(5,2) NOT NULL DEFAULT 5",
    'SELECT 1')
  FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'fin_config' AND column_name = 'divisas_tolerancia_pct'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Vencimientos que Clientes (a cobrar) y Compras (a pagar) publican por evento: la proyección de fondos se suscribe a ellos y no consulta a esos módulos (RF13, RN37).
-- Cada mensaje trae la foto completa de su origen y reemplaza a la anterior; una foto más vieja que la guardada se ignora.
CREATE TABLE IF NOT EXISTS fin_vencimientos_externos (
  id          INT           AUTO_INCREMENT PRIMARY KEY,
  origen      VARCHAR(20)   NOT NULL,
  sentido     ENUM('cobrar', 'pagar') NOT NULL,
  fecha       DATE          NOT NULL,
  importe     DECIMAL(14,2) NOT NULL,
  version_ms  BIGINT        NOT NULL,
  KEY idx_fin_venc_origen (origen, version_ms)
);

-- El resultado por diferencia de cambio de cada compra o venta de divisas (RF15): informativo, no mueve dinero.
CREATE TABLE IF NOT EXISTS fin_operaciones_divisa (
  id                    INT           AUTO_INCREMENT PRIMARY KEY,
  id_global             VARCHAR(40)   CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  tipo                  ENUM('compra', 'venta') NOT NULL,
  origen_id             INT           NOT NULL,
  destino_id            INT           NOT NULL,
  moneda                CHAR(3)       NOT NULL,
  importe_divisa        DECIMAL(14,2) NOT NULL,
  cotizacion            DECIMAL(14,6) NOT NULL,
  cotizacion_vigente    DECIMAL(14,6) NOT NULL,
  importe_pesos         DECIMAL(14,2) NOT NULL,
  resultado_cambio      DECIMAL(14,2) NOT NULL,
  mov_origen_id         BIGINT        NOT NULL,
  mov_destino_id        BIGINT        NOT NULL,
  autorizante_id        INT           NULL,
  motivo                VARCHAR(255)  NOT NULL,
  user_id               INT           NULL,
  ts_ms                 BIGINT        NOT NULL,
  CONSTRAINT uq_fin_opdiv_id_global UNIQUE (id_global),
  KEY idx_fin_opdiv_ts (ts_ms)
);

INSERT IGNORE INTO rol_permisos (rol_id, permiso, nivel)
SELECT r.id, p.permiso, p.nivel FROM roles r JOIN (
  SELECT 'gerente' rol, 'financiero.informes.ver' permiso, 'permitido' nivel UNION ALL
  SELECT 'administrativo', 'financiero.informes.ver', 'permitido' UNION ALL
  SELECT 'contador', 'financiero.informes.ver', 'permitido' UNION ALL
  SELECT 'gerente', 'financiero.divisas.operar', 'permitido' UNION ALL
  SELECT 'administrativo', 'financiero.divisas.operar', 'requiere_autorizacion'
) p ON p.rol = r.codigo;
