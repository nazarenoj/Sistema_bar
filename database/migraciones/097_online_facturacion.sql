-- I9: facturación del pedido, alineación cobrado / reintegrado / facturado y pesaje real (Ventas Online RF14, RF29, RN10, RN11, RN50, RN51, RN52, EX06, EX35, EX36). Re-ejecutable.

SET @sql = (
  SELECT IF(COUNT(*) = 0,
    "ALTER TABLE onl_tienda ADD COLUMN facturar_en VARCHAR(10) NOT NULL DEFAULT 'pago', ADD COLUMN tolerancia_peso_pct DECIMAL(5,2) NOT NULL DEFAULT 5, ADD COLUMN tolerancia_peso_importe DECIMAL(12,2) NULL, ADD COLUMN aceptacion_horas INT NOT NULL DEFAULT 2, ADD COLUMN horas_alerta_comprobante INT NOT NULL DEFAULT 4",
    'SELECT 1')
  FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'onl_tienda' AND column_name = 'facturar_en'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @sql = (
  SELECT IF(COUNT(*) = 0,
    "ALTER TABLE onl_pedidos ADD COLUMN alineacion VARCHAR(24) NOT NULL DEFAULT 'pendiente_facturacion', ADD COLUMN tiene_pesables TINYINT(1) NOT NULL DEFAULT 0, ADD COLUMN pesaje_estado VARCHAR(20) NULL, ADD COLUMN total_real DECIMAL(12,2) NULL",
    'SELECT 1')
  FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'onl_pedidos' AND column_name = 'alineacion'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @sql = (
  SELECT IF(COUNT(*) = 0,
    "ALTER TABLE onl_pedido_lineas ADD COLUMN es_pesable TINYINT(1) NOT NULL DEFAULT 0, ADD COLUMN peso_min DECIMAL(12,3) NULL, ADD COLUMN peso_max DECIMAL(12,3) NULL, ADD COLUMN peso_real DECIMAL(12,3) NULL, ADD COLUMN delta DECIMAL(12,2) NULL, ADD COLUMN pesaje_estado VARCHAR(24) NULL, ADD COLUMN pesaje_manual TINYINT(1) NOT NULL DEFAULT 0, ADD COLUMN pesaje_motivo VARCHAR(160) NULL",
    'SELECT 1')
  FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'onl_pedido_lineas' AND column_name = 'es_pesable'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Comprobantes del pedido que emitió Ventas (facturas y notas de crédito).
CREATE TABLE IF NOT EXISTS onl_comprobantes (
  id               INT           AUTO_INCREMENT PRIMARY KEY,
  pedido_id        INT           NOT NULL,
  tipo             VARCHAR(10)   NOT NULL,
  tipo_comprobante INT           NULL,
  punto_venta      INT           NULL,
  numero           BIGINT        NULL,
  cae              VARCHAR(20)   NULL,
  importe          DECIMAL(12,2) NOT NULL,
  ajuste_id        INT           NULL,
  ts_ms            BIGINT        NOT NULL,
  CONSTRAINT fk_onl_comp_pedido FOREIGN KEY (pedido_id) REFERENCES onl_pedidos(id),
  KEY idx_onl_comp_pedido (pedido_id, tipo)
);
-- Ajuste posterior al cobro (pesaje real): se ejecuta en la secuencia fija de RN52.
CREATE TABLE IF NOT EXISTS onl_ajustes (
  id                 INT           AUTO_INCREMENT PRIMARY KEY,
  pedido_id          INT           NOT NULL,
  tipo               VARCHAR(20)   NOT NULL,
  estado             VARCHAR(24)   NOT NULL,
  delta_neto         DECIMAL(12,2) NOT NULL DEFAULT 0,
  adicional          DECIMAL(12,2) NOT NULL DEFAULT 0,
  reintegro          DECIMAL(12,2) NOT NULL DEFAULT 0,
  aceptacion_hash    CHAR(64)      NULL,
  aceptacion_vence_ms BIGINT       NULL,
  aceptado_ms        BIGINT        NULL,
  aceptado_medio     VARCHAR(30)   NULL,
  cobro_ref          VARCHAR(80)   NULL,
  detalle            VARCHAR(255)  NULL,
  ts_ms              BIGINT        NOT NULL,
  actualizado_ms     BIGINT        NOT NULL,
  CONSTRAINT fk_onl_ajuste_pedido FOREIGN KEY (pedido_id) REFERENCES onl_pedidos(id),
  KEY idx_onl_ajuste_estado (estado, pedido_id)
);

-- Lo que Ventas registró de cada pedido online: la base de la alineación (llamada n.º 19, Ventas RN67).
CREATE TABLE IF NOT EXISTS ventas_online_movs (
  id             BIGINT        AUTO_INCREMENT PRIMARY KEY,
  pedido_global  VARCHAR(40)   CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  tipo           VARCHAR(20)   NOT NULL,
  importe        DECIMAL(12,2) NOT NULL,
  referencia     VARCHAR(80)   NOT NULL,
  detalle        VARCHAR(255)  NULL,
  ts_ms          BIGINT        NOT NULL,
  CONSTRAINT uq_ventas_online_mov UNIQUE (pedido_global, tipo, referencia),
  KEY idx_ventas_online_mov (pedido_global)
);

INSERT IGNORE INTO rol_permisos (rol_id, permiso, nivel)
SELECT r.id, p.permiso, p.nivel FROM roles r JOIN (
  SELECT 'gerente' rol, 'ventas_online.pesaje.registrar' permiso, 'permitido' nivel UNION ALL
  SELECT 'encargado', 'ventas_online.pesaje.registrar', 'permitido' UNION ALL
  SELECT 'gerente', 'ventas_online.pesaje.manual', 'permitido' UNION ALL
  SELECT 'gerente', 'ventas_online.facturacion.gestionar', 'permitido' UNION ALL
  SELECT 'administrativo', 'ventas_online.facturacion.gestionar', 'permitido'
) p ON p.rol = r.codigo;
