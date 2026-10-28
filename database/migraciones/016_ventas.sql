-- B5: la venta como documento propio (Ventas RF08, RN19, RN21). Se crea al cerrar la cuenta, en la misma
-- transacción que el cierre y que los mensajes de sus efectos. `detalle` es la copia fija de los ítems y
-- precios (RN21): no cambia aunque después cambie el catálogo. Es de solo lectura (RN19): los triggers
-- impiden UPDATE y DELETE; las correcciones son anulación o devolución (B10).

CREATE TABLE IF NOT EXISTS ventas (
  id               INT           AUTO_INCREMENT PRIMARY KEY,
  id_global        VARCHAR(40)   CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  mesa_id          INT           NOT NULL,
  sesion_apertura  DATETIME      NOT NULL,
  total            DECIMAL(12,2) NOT NULL,
  detalle          MEDIUMTEXT    NOT NULL,
  id_solicitud     VARCHAR(64)   NULL,
  config_version   INT           NULL,
  creado_por       INT           NULL,
  created_at       TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_venta_id_global UNIQUE (id_global),
  CONSTRAINT uq_venta_cuenta    UNIQUE (mesa_id, sesion_apertura),
  CONSTRAINT fk_venta_mesa      FOREIGN KEY (mesa_id) REFERENCES mesas(id)
);

CREATE TABLE IF NOT EXISTS pago_venta (
  id           INT           AUTO_INCREMENT PRIMARY KEY,
  venta_id     INT           NOT NULL,
  metodo_pago  VARCHAR(50)   NOT NULL,
  importe      DECIMAL(12,2) NOT NULL,
  CONSTRAINT fk_pago_venta FOREIGN KEY (venta_id) REFERENCES ventas(id)
);

DROP TRIGGER IF EXISTS ventas_no_update;
CREATE TRIGGER ventas_no_update BEFORE UPDATE ON ventas FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Las ventas son de solo lectura';
DROP TRIGGER IF EXISTS ventas_no_delete;
CREATE TRIGGER ventas_no_delete BEFORE DELETE ON ventas FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Las ventas son de solo lectura';
DROP TRIGGER IF EXISTS pago_venta_no_update;
CREATE TRIGGER pago_venta_no_update BEFORE UPDATE ON pago_venta FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Las ventas son de solo lectura';
DROP TRIGGER IF EXISTS pago_venta_no_delete;
CREATE TRIGGER pago_venta_no_delete BEFORE DELETE ON pago_venta FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Las ventas son de solo lectura';
