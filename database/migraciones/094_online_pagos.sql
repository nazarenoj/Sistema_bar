-- I6: pagos por pasarela (Mercado Pago), webhooks y reintegros (Ventas Online RF10, RN08, RN09, RN44, EX01 a EX03, EX11, EX29). Re-ejecutable.

SET @sql = (
  SELECT IF(COUNT(*) = 0,
    "ALTER TABLE onl_tienda ADD COLUMN mp_access_token VARCHAR(255) NULL, ADD COLUMN mp_webhook_secret VARCHAR(120) NULL, ADD COLUMN horas_reintento_reintegro INT NOT NULL DEFAULT 24",
    'SELECT 1')
  FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'onl_tienda' AND column_name = 'mp_access_token'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Apertura del cobro en la pasarela: una sola por pedido y clave de solicitud (RN48).
CREATE TABLE IF NOT EXISTS onl_cobros (
  id             INT           AUTO_INCREMENT PRIMARY KEY,
  pedido_id      INT           NOT NULL,
  proveedor      VARCHAR(20)   NOT NULL,
  id_solicitud   VARCHAR(80)   CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  preferencia_id VARCHAR(80)   NULL,
  url            VARCHAR(500)  NULL,
  importe        DECIMAL(12,2) NOT NULL,
  ts_ms          BIGINT        NOT NULL,
  CONSTRAINT uq_onl_cobro_solicitud UNIQUE (id_solicitud),
  CONSTRAINT fk_onl_cobro_pedido FOREIGN KEY (pedido_id) REFERENCES onl_pedidos(id)
);
-- Pago_Online: el registro técnico de cada transacción (estado, ID_Transaccion_Externa e importe). Nunca tarjetas (RN08).
CREATE TABLE IF NOT EXISTS onl_pagos (
  id                 INT           AUTO_INCREMENT PRIMARY KEY,
  pedido_id          INT           NULL,
  proveedor          VARCHAR(20)   NOT NULL,
  id_externo         VARCHAR(80)   CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  referencia         VARCHAR(60)   NULL,
  estado             VARCHAR(20)   NOT NULL,
  importe            DECIMAL(12,2) NOT NULL,
  metodo             VARCHAR(40)   NULL,
  detalle            VARCHAR(255)  NULL,
  reintegrado        DECIMAL(12,2) NOT NULL DEFAULT 0,
  creado_ms          BIGINT        NOT NULL,
  actualizado_ms     BIGINT        NOT NULL,
  CONSTRAINT uq_onl_pago_externo UNIQUE (proveedor, id_externo),
  KEY idx_onl_pago_pedido (pedido_id)
);
CREATE TABLE IF NOT EXISTS onl_reintegros (
  id               INT           AUTO_INCREMENT PRIMARY KEY,
  pedido_id        INT           NOT NULL,
  pago_id          INT           NULL,
  importe          DECIMAL(12,2) NOT NULL,
  motivo           VARCHAR(40)   NOT NULL,
  detalle          VARCHAR(255)  NULL,
  estado           VARCHAR(20)   NOT NULL DEFAULT 'pendiente',
  id_solicitud     VARCHAR(80)   CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  id_externo       VARCHAR(80)   NULL,
  intentos         INT           NOT NULL DEFAULT 0,
  error            VARCHAR(255)  NULL,
  medio_manual     VARCHAR(60)   NULL,
  creado_ms        BIGINT        NOT NULL,
  vence_reintento_ms BIGINT      NOT NULL,
  actualizado_ms   BIGINT        NOT NULL,
  CONSTRAINT uq_onl_reintegro_solicitud UNIQUE (id_solicitud),
  KEY idx_onl_reintegro_estado (estado, pedido_id)
);

INSERT IGNORE INTO rol_permisos (rol_id, permiso, nivel)
SELECT r.id, p.permiso, p.nivel FROM roles r JOIN (
  SELECT 'gerente' rol, 'ventas_online.pagos.gestionar' permiso, 'permitido' nivel UNION ALL
  SELECT 'administrativo', 'ventas_online.pagos.gestionar', 'permitido' UNION ALL
  SELECT 'gerente', 'ventas_online.pagos.configurar', 'permitido' UNION ALL
  SELECT 'gerente', 'ventas_online.reintegros.manual', 'permitido'
) p ON p.rol = r.codigo;
