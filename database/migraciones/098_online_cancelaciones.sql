-- I10: cancelaciones, devoluciones y arrepentimiento (Ventas Online RF15, RN15, RN52, EX11, EX35). Re-ejecutable.

SET @sql = (
  SELECT IF(COUNT(*) = 0,
    "ALTER TABLE onl_tienda ADD COLUMN arrepentimiento_dias INT NOT NULL DEFAULT 10, ADD COLUMN arrepentimiento_reingreso VARCHAR(10) NOT NULL DEFAULT 'reingreso'",
    'SELECT 1')
  FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'onl_tienda' AND column_name = 'arrepentimiento_dias'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Cada cancelación o devolución del pedido, con su estado en la secuencia de RN52: nota de crédito primero, reintegro después.
CREATE TABLE IF NOT EXISTS onl_devoluciones (
  id                    INT           AUTO_INCREMENT PRIMARY KEY,
  pedido_id             INT           NOT NULL,
  tipo                  VARCHAR(20)   NOT NULL,
  motivo                VARCHAR(255)  NOT NULL,
  total_devuelto        DECIMAL(12,2) NOT NULL DEFAULT 0,
  reintegro_pasarela    DECIMAL(12,2) NOT NULL DEFAULT 0,
  venta_devolucion      VARCHAR(40)   NULL,
  nc_factura_id         INT           NULL,
  estado                VARCHAR(30)   NOT NULL,
  detalle               VARCHAR(255)  NULL,
  user_id               INT           NULL,
  creado_ms             BIGINT        NOT NULL,
  actualizado_ms        BIGINT        NOT NULL,
  CONSTRAINT fk_onl_dev_pedido FOREIGN KEY (pedido_id) REFERENCES onl_pedidos(id),
  KEY idx_onl_dev_estado (estado, pedido_id)
);
-- Arrepentimiento: el cliente revoca la compra dentro de los 10 días y recibe un código de trámite.
CREATE TABLE IF NOT EXISTS onl_arrepentimientos (
  id            INT           AUTO_INCREMENT PRIMARY KEY,
  pedido_id     INT           NOT NULL,
  codigo        VARCHAR(20)   CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  estado        VARCHAR(20)   NOT NULL,
  motivo        VARCHAR(255)  NULL,
  detalle       VARCHAR(255)  NULL,
  solicitado_ms BIGINT        NOT NULL,
  resuelto_ms   BIGINT        NULL,
  CONSTRAINT uq_onl_arrep_codigo UNIQUE (codigo),
  CONSTRAINT fk_onl_arrep_pedido FOREIGN KEY (pedido_id) REFERENCES onl_pedidos(id)
);

INSERT IGNORE INTO rol_permisos (rol_id, permiso, nivel)
SELECT r.id, p.permiso, p.nivel FROM roles r JOIN (
  SELECT 'gerente' rol, 'ventas_online.pedidos.cancelar' permiso, 'permitido' nivel UNION ALL
  SELECT 'encargado', 'ventas_online.pedidos.cancelar', 'permitido' UNION ALL
  SELECT 'gerente', 'ventas_online.pedidos.devolver', 'permitido'
) p ON p.rol = r.codigo;
