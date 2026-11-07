-- H7: pedidos a proveedores y pedido sugerido (Compras RF12, RF17, RF20, RN22, RN26, EX17). Re-ejecutable.

CREATE TABLE IF NOT EXISTS cmp_pedidos (
  id                INT           AUTO_INCREMENT PRIMARY KEY,
  id_global         VARCHAR(40)   NOT NULL,
  proveedor_id      INT           NOT NULL,
  estado            ENUM('borrador', 'pendiente', 'recibido_parcial', 'recibido', 'cancelado') NOT NULL DEFAULT 'borrador',
  fecha             DATE          NOT NULL,
  entrega_prevista  DATE          NULL,
  moneda            CHAR(3)       NOT NULL DEFAULT 'ARS',
  origen            ENUM('manual', 'sugerencia') NOT NULL DEFAULT 'manual',
  sugerencia_ms     BIGINT        NULL,
  observacion       VARCHAR(255)  NULL,
  enviado_ms        BIGINT        NULL,
  enviado_a         VARCHAR(120)  NULL,
  reemplaza_id      INT           NULL,
  reemplazado_por   INT           NULL,
  motivo_cancelacion VARCHAR(255) NULL,
  user_id           INT           NULL,
  ts_ms             BIGINT        NOT NULL,
  UNIQUE KEY uq_cmp_pedido_global (id_global),
  CONSTRAINT fk_cmp_pedido_prov FOREIGN KEY (proveedor_id) REFERENCES cmp_proveedores(id),
  KEY idx_cmp_pedido_estado (estado, proveedor_id)
);
CREATE TABLE IF NOT EXISTS cmp_pedido_lineas (
  id                 INT           AUTO_INCREMENT PRIMARY KEY,
  pedido_id          INT           NOT NULL,
  linea              INT           NOT NULL,
  item_tipo          VARCHAR(10)   NULL,
  item_id            INT           NULL,
  descripcion        VARCHAR(200)  NOT NULL,
  presentacion_id    INT           NULL,
  factor_aplicado    DECIMAL(18,6) NOT NULL DEFAULT 1,
  unidad             VARCHAR(30)   NULL,
  cantidad           DECIMAL(14,3) NOT NULL,
  cantidad_sugerida  DECIMAL(14,3) NULL,
  cantidad_recibida  DECIMAL(14,3) NOT NULL DEFAULT 0,
  precio_estimado    DECIMAL(14,4) NULL,
  explicacion        TEXT          NULL,
  CONSTRAINT fk_cmp_pedido_linea FOREIGN KEY (pedido_id) REFERENCES cmp_pedidos(id),
  KEY idx_cmp_pedido_linea (pedido_id)
);
-- Cada ingreso se cuenta una sola vez contra un pedido.
CREATE TABLE IF NOT EXISTS cmp_pedido_recepciones (
  pedido_id         INT          NOT NULL,
  ingreso_id_global VARCHAR(60)  NOT NULL,
  PRIMARY KEY (pedido_id, ingreso_id_global),
  CONSTRAINT fk_cmp_pedido_recep FOREIGN KEY (pedido_id) REFERENCES cmp_pedidos(id)
);

-- Pedido en tránsito que Stock descuenta de la reposición sugerida (Compras RF12): llega por mensajes, nunca se consulta en línea.
CREATE TABLE IF NOT EXISTS stock_pedidos_transito (
  pedido_id_global VARCHAR(40)   NOT NULL,
  item_tipo        VARCHAR(10)   NOT NULL,
  item_id          INT           NOT NULL,
  cantidad         DECIMAL(14,3) NOT NULL,
  PRIMARY KEY (pedido_id_global, item_tipo, item_id)
);

INSERT IGNORE INTO rol_permisos (rol_id, permiso, nivel)
SELECT r.id, p.permiso, p.nivel FROM roles r JOIN (
  SELECT 'gerente' rol, 'compras.pedidos.ver' permiso, 'permitido' nivel UNION ALL
  SELECT 'administrativo', 'compras.pedidos.ver', 'permitido' UNION ALL
  SELECT 'contador', 'compras.pedidos.ver', 'permitido' UNION ALL
  SELECT 'deposito', 'compras.pedidos.ver', 'permitido' UNION ALL
  SELECT 'gerente', 'compras.pedidos.armar', 'permitido' UNION ALL
  SELECT 'administrativo', 'compras.pedidos.armar', 'permitido' UNION ALL
  SELECT 'deposito', 'compras.pedidos.armar', 'permitido' UNION ALL
  SELECT 'gerente', 'compras.pedidos.confirmar', 'permitido' UNION ALL
  SELECT 'administrativo', 'compras.pedidos.confirmar', 'permitido' UNION ALL
  SELECT 'gerente', 'compras.pedidos.enviar', 'permitido' UNION ALL
  SELECT 'administrativo', 'compras.pedidos.enviar', 'permitido'
) p ON p.rol = r.codigo;
