-- G6: transferencias, retiros a caja fuerte, acreditaciones de tarjetas y billeteras y liquidaciones (Financiero RF05, RF06, RN02, RN08, RN15, EX04, EX11).
-- Re-ejecutable.

-- Una transferencia son dos movimientos vinculados que nacen juntos o ninguno (RN02, RN38). Se guarda el par y la clase.
CREATE TABLE IF NOT EXISTS fin_transferencias (
  id                 INT           AUTO_INCREMENT PRIMARY KEY,
  id_global          VARCHAR(40)   CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  clase              ENUM('transferencia', 'retiro_fuerte', 'deposito') NOT NULL DEFAULT 'transferencia',
  origen_id          INT           NOT NULL,
  destino_id         INT           NOT NULL,
  importe            DECIMAL(14,2) NOT NULL,
  motivo             VARCHAR(255)  NOT NULL,
  mov_origen_id      BIGINT        NOT NULL,
  mov_destino_id     BIGINT        NOT NULL,
  user_id            INT           NULL,
  ts_ms              BIGINT        NOT NULL,
  CONSTRAINT uq_fin_transf_id_global UNIQUE (id_global),
  CONSTRAINT fk_fin_transf_origen FOREIGN KEY (origen_id) REFERENCES fin_cuentas(id),
  CONSTRAINT fk_fin_transf_destino FOREIGN KEY (destino_id) REFERENCES fin_cuentas(id),
  KEY idx_fin_transf_ts (ts_ms)
);

-- Crédito a acreditar: cada cobro con tarjeta o billetera genera uno con su fecha estimada (RF06). Se cierra al liquidarse (RN15).
CREATE TABLE IF NOT EXISTS fin_acreditaciones (
  id                  INT           AUTO_INCREMENT PRIMARY KEY,
  id_global           VARCHAR(40)   CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  movimiento_id       BIGINT        NOT NULL,
  cuenta_id           INT           NOT NULL,
  forma_codigo        VARCHAR(50)   NOT NULL,
  doc_id_global       VARCHAR(60)   CHARACTER SET ascii COLLATE ascii_bin NULL,
  referencia          VARCHAR(100)  NULL,
  bruto_original      DECIMAL(14,2) NOT NULL,
  bruto               DECIMAL(14,2) NOT NULL,
  comision_estimada   DECIMAL(14,2) NOT NULL DEFAULT 0,
  fecha_estimada      DATE          NOT NULL,
  estado              ENUM('pendiente', 'liquidada', 'anulada') NOT NULL DEFAULT 'pendiente',
  liquidacion_id      INT           NULL,
  CONSTRAINT uq_fin_acred_id_global UNIQUE (id_global),
  CONSTRAINT uq_fin_acred_movimiento UNIQUE (movimiento_id),
  CONSTRAINT fk_fin_acred_cuenta FOREIGN KEY (cuenta_id) REFERENCES fin_cuentas(id),
  KEY idx_fin_acred_estado (estado, fecha_estimada),
  KEY idx_fin_acred_ref (cuenta_id, referencia)
);

-- La liquidación del procesador (o de la billetera): concilia los cupones y registra comisiones, IVA, retenciones, percepciones y el neto (RF06).
CREATE TABLE IF NOT EXISTS fin_liquidaciones (
  id                 INT           AUTO_INCREMENT PRIMARY KEY,
  id_global          VARCHAR(40)   CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  cuenta_id          INT           NOT NULL,
  destino_id         INT           NOT NULL,
  referencia         VARCHAR(80)   NOT NULL,
  fecha              DATE          NOT NULL,
  bruto              DECIMAL(14,2) NOT NULL,
  comision           DECIMAL(14,2) NOT NULL DEFAULT 0,
  iva_comision       DECIMAL(14,2) NOT NULL DEFAULT 0,
  retenciones        DECIMAL(14,2) NOT NULL DEFAULT 0,
  percepciones       DECIMAL(14,2) NOT NULL DEFAULT 0,
  neto               DECIMAL(14,2) NOT NULL,
  comision_estimada  DECIMAL(14,2) NOT NULL DEFAULT 0,
  user_id            INT           NULL,
  ts_ms              BIGINT        NOT NULL,
  CONSTRAINT uq_fin_liq_id_global UNIQUE (id_global),
  CONSTRAINT uq_fin_liq_referencia UNIQUE (cuenta_id, referencia),
  CONSTRAINT fk_fin_liq_cuenta FOREIGN KEY (cuenta_id) REFERENCES fin_cuentas(id)
);
CREATE TABLE IF NOT EXISTS fin_liquidacion_cupones (
  id               INT           AUTO_INCREMENT PRIMARY KEY,
  liquidacion_id   INT           NOT NULL,
  acreditacion_id  INT           NULL,
  referencia       VARCHAR(100)  NULL,
  importe          DECIMAL(14,2) NOT NULL,
  estado           ENUM('conciliado', 'sin_cobro_asociado') NOT NULL,
  motivo           VARCHAR(255)  NULL,
  CONSTRAINT fk_fin_liqcup_liq FOREIGN KEY (liquidacion_id) REFERENCES fin_liquidaciones(id),
  KEY idx_fin_liqcup_liq (liquidacion_id)
);

INSERT IGNORE INTO rol_permisos (rol_id, permiso, nivel)
SELECT r.id, p.permiso, p.nivel FROM roles r JOIN (
  SELECT 'gerente' rol, 'financiero.transferencias.registrar' permiso, 'permitido' nivel UNION ALL
  SELECT 'encargado', 'financiero.transferencias.registrar', 'permitido' UNION ALL
  SELECT 'cajero', 'financiero.transferencias.registrar', 'requiere_autorizacion' UNION ALL
  SELECT 'gerente', 'financiero.liquidaciones.registrar', 'permitido' UNION ALL
  SELECT 'administrativo', 'financiero.liquidaciones.registrar', 'permitido'
) p ON p.rol = r.codigo;
