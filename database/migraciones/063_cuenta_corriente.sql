-- E2: cuenta corriente (Clientes y CC RF03, RF04, RF05, RF09, RN03, RN05, RN06, RN09, RN15, RN36, RN37). El saldo se deriva de los movimientos y nunca se edita.
-- Re-ejecutable: tablas IF NOT EXISTS, triggers con DROP IF EXISTS, semillas con INSERT IGNORE.

CREATE TABLE IF NOT EXISTS cuentas_corrientes (
  id                      INT           AUTO_INCREMENT PRIMARY KEY,
  cliente_id              INT           NOT NULL,
  moneda                  VARCHAR(3)    NOT NULL DEFAULT 'ARS',
  limite_credito          DECIMAL(14,2) NOT NULL DEFAULT 0,
  plazo_dias              INT           NOT NULL DEFAULT 0,
  tasa_mora               DECIMAL(6,3)  NULL,
  dias_mora_autorizacion  INT           NULL,
  dias_mora_bloqueo       INT           NULL,
  estado                  ENUM('activa', 'bloqueada', 'cerrada') NOT NULL DEFAULT 'activa',
  motivo_bloqueo          ENUM('manual', 'mora') NULL,
  bloqueo_detalle         VARCHAR(255)  NULL,
  bloqueada_en            DATETIME      NULL,
  bloqueada_por           INT           NULL,
  creada_por              INT           NULL,
  created_at              TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_cuenta_cliente_moneda UNIQUE (cliente_id, moneda),
  CONSTRAINT fk_cuenta_cliente FOREIGN KEY (cliente_id) REFERENCES clientes(id)
);

-- Movimientos: débito = venta, remito, nota de débito; crédito = nota de crédito, recibo, ajuste a favor. Solo se agregan; lo único que cambia con el
-- tiempo es el saldo pendiente de un débito y su estado (imputaciones, facturación, anulación).
CREATE TABLE IF NOT EXISTS movimientos_cc (
  id                  BIGINT        AUTO_INCREMENT PRIMARY KEY,
  id_global           VARCHAR(40)   CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  cuenta_id           INT           NOT NULL,
  tipo                ENUM('venta', 'remito', 'nd', 'nc', 'recibo', 'ajuste') NOT NULL,
  naturaleza          ENUM('debito', 'credito') NOT NULL,
  comprobante_ref     VARCHAR(60)   NULL,
  referencia_id       BIGINT        NULL,
  id_operacion        VARCHAR(160)  CHARACTER SET ascii COLLATE ascii_bin NULL,
  id_reserva_credito  VARCHAR(40)   NULL,
  en_contingencia     TINYINT(1)    NOT NULL DEFAULT 0,
  motivo              VARCHAR(40)   NULL,
  detalle             VARCHAR(255)  NULL,
  fecha               DATE          NOT NULL,
  fecha_vencimiento   DATE          NULL,
  importe             DECIMAL(14,2) NOT NULL,
  importe_moneda_cuenta DECIMAL(14,2) NULL,
  cotizacion          DECIMAL(14,4) NULL,
  saldo_pendiente     DECIMAL(14,2) NOT NULL DEFAULT 0,
  estado              ENUM('pendiente', 'cancelado', 'facturado', 'anulado', 'pendiente_emision') NOT NULL DEFAULT 'pendiente',
  fiscal              TINYINT(1)    NOT NULL DEFAULT 0,
  comprobante_fiscal  TEXT          NULL,
  user_id             INT           NULL,
  config_version      INT           NULL,
  created_at          TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_mov_cc_id_global UNIQUE (id_global),
  CONSTRAINT uq_mov_cc_operacion UNIQUE (id_operacion),
  CONSTRAINT fk_mov_cc_cuenta FOREIGN KEY (cuenta_id) REFERENCES cuentas_corrientes(id),
  KEY idx_mov_cc_cuenta (cuenta_id, fecha),
  KEY idx_mov_cc_ref (comprobante_ref),
  KEY idx_mov_cc_venc (cuenta_id, estado, fecha_vencimiento)
);

DROP TRIGGER IF EXISTS movimientos_cc_no_editar;
CREATE TRIGGER movimientos_cc_no_editar BEFORE UPDATE ON movimientos_cc FOR EACH ROW
  IF NEW.importe <> OLD.importe OR NEW.tipo <> OLD.tipo OR NEW.naturaleza <> OLD.naturaleza OR NEW.cuenta_id <> OLD.cuenta_id OR NOT (NEW.id_operacion <=> OLD.id_operacion) OR NOT (NEW.comprobante_ref <=> OLD.comprobante_ref) OR NEW.fecha <> OLD.fecha THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Un movimiento de cuenta corriente no se edita: se corrige con otro movimiento';
  END IF;
DROP TRIGGER IF EXISTS movimientos_cc_no_borrar;
CREATE TRIGGER movimientos_cc_no_borrar BEFORE DELETE ON movimientos_cc FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Un movimiento de cuenta corriente no se elimina: se corrige con otro movimiento';

-- Defaults de la instancia (RN33) y plazo de pago por defecto.
INSERT IGNORE INTO parametros (clave, valor) VALUES ('cc_dias_mora_autorizacion', '5'), ('cc_dias_mora_bloqueo', '30'), ('cc_plazo_dias', '15');

INSERT IGNORE INTO rol_permisos (rol_id, permiso, nivel)
SELECT r.id, p.permiso, p.nivel FROM roles r JOIN (
  SELECT 'gerente' rol, 'clientes.cuentas.gestionar' permiso, 'permitido' nivel UNION ALL
  SELECT 'administrativo', 'clientes.cuentas.gestionar', 'permitido' UNION ALL
  SELECT 'gerente', 'clientes.notas.emitir', 'permitido' UNION ALL
  SELECT 'administrativo', 'clientes.notas.emitir', 'permitido'
) p ON p.rol = r.codigo;
