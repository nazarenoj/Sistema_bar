-- I8: gestión de pedidos, entrega a Ventas, cocina/barra y notificaciones al cliente (Ventas Online RF12, RF13, RF25, RN36, RN43, RN44, RN45). Re-ejecutable.

-- Formas de pago de los pedidos online (Ventas RF09): no se ofrecen en el cobro de la sucursal.
INSERT IGNORE INTO formas_pago (codigo, nombre, activa, requiere_referencia, admite_vuelto, orden) VALUES
  ('cobro_online', 'Cobro online (pasarela)', 0, 0, 0, 90),
  ('cobro_plataforma', 'Cobro por plataforma', 0, 0, 0, 91);

-- Qué recibió Ventas de cada pedido online (RF25 de Ventas): idempotente por el ID_Global del pedido online (RN44).
CREATE TABLE IF NOT EXISTS ventas_pedidos_online (
  pedido_global   VARCHAR(40)   CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  pedido_id       INT           NOT NULL,
  mesa_id         INT           NOT NULL,
  comanda_enviada TINYINT(1)    NOT NULL DEFAULT 0,
  venta_id_global VARCHAR(40)   CHARACTER SET ascii COLLATE ascii_bin NULL,
  transaccion     VARCHAR(80)   NULL,
  created_ms      BIGINT        NOT NULL
);

SET @sql = (
  SELECT IF(COUNT(*) = 0,
    "ALTER TABLE onl_pedidos ADD COLUMN entrega_ventas_estado VARCHAR(12) NOT NULL DEFAULT 'pendiente', ADD COLUMN venta_id_global VARCHAR(40) NULL, ADD COLUMN entrega_intentos INT NOT NULL DEFAULT 0, ADD COLUMN entrega_error VARCHAR(255) NULL",
    'SELECT 1')
  FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'onl_pedidos' AND column_name = 'entrega_ventas_estado'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Cada aviso al cliente sale una sola vez por pedido y evento.
CREATE TABLE IF NOT EXISTS onl_notificaciones (
  id         INT          AUTO_INCREMENT PRIMARY KEY,
  pedido_id  INT          NOT NULL,
  evento     VARCHAR(30)  NOT NULL,
  para       VARCHAR(120) NOT NULL,
  ts_ms      BIGINT       NOT NULL,
  CONSTRAINT uq_onl_notif UNIQUE (pedido_id, evento),
  CONSTRAINT fk_onl_notif_pedido FOREIGN KEY (pedido_id) REFERENCES onl_pedidos(id)
);
