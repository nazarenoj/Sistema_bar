-- G8: cartera de cheques y conciliación bancaria (Financiero RF07, RF08, RF09, RN10 a RN12, EX05 a EX09).
-- Re-ejecutable: las columnas se agregan solo si faltan.

SET @sql = (
  SELECT IF(COUNT(*) = 0,
    'ALTER TABLE fin_config ADD COLUMN plazo_presentacion_cheque_dias INT NOT NULL DEFAULT 30, ADD COLUMN conciliacion_dias INT NOT NULL DEFAULT 3',
    'SELECT 1')
  FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'fin_config' AND column_name = 'plazo_presentacion_cheque_dias'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Cheques de terceros (de clientes o cargados a mano) y propios (de órdenes de pago o a mano). `clave_unica` evita duplicados (RN10): banco + número +
-- CUIT del librador para un cheque físico, o el identificador de la red para un e-cheq.
CREATE TABLE IF NOT EXISTS fin_cheques (
  id                 INT           AUTO_INCREMENT PRIMARY KEY,
  id_global          VARCHAR(40)   CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  clave_unica        VARCHAR(190)  CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  origen             ENUM('tercero', 'propio') NOT NULL DEFAULT 'tercero',
  tipo               ENUM('fisico', 'echeq') NOT NULL DEFAULT 'fisico',
  banco              VARCHAR(80)   NULL,
  numero             VARCHAR(30)   NULL,
  cuit_librador      VARCHAR(11)   NULL,
  identificador_red  VARCHAR(80)   NULL,
  librador           VARCHAR(150)  NULL,
  importe            DECIMAL(14,2) NOT NULL,
  moneda             CHAR(3)       NOT NULL DEFAULT 'ARS',
  fecha_emision      DATE          NULL,
  fecha_pago         DATE          NOT NULL,
  estado             ENUM('en_cartera', 'depositado', 'endosado', 'acreditado', 'rechazado', 'anulado') NOT NULL DEFAULT 'en_cartera',
  origen_modulo      VARCHAR(20)   NOT NULL DEFAULT 'manual',
  origen_doc         VARCHAR(80)   NULL,
  cliente_id         INT           NULL,
  cuenta_id          INT           NULL,
  endosado_a         VARCHAR(150)  NULL,
  endoso_modulo      VARCHAR(20)   NULL,
  motivo_rechazo     VARCHAR(255)  NULL,
  gastos_bancarios   DECIMAL(14,2) NOT NULL DEFAULT 0,
  user_id            INT           NULL,
  ts_ms              BIGINT        NOT NULL,
  CONSTRAINT uq_fin_cheque_id_global UNIQUE (id_global),
  CONSTRAINT uq_fin_cheque_clave UNIQUE (clave_unica),
  KEY idx_fin_cheque_estado (estado, fecha_pago)
);
CREATE TABLE IF NOT EXISTS fin_cheque_historial (
  id          INT          AUTO_INCREMENT PRIMARY KEY,
  cheque_id   INT          NOT NULL,
  estado      VARCHAR(20)  NOT NULL,
  nota        VARCHAR(255) NULL,
  user_id     INT          NULL,
  ts_ms       BIGINT       NOT NULL,
  CONSTRAINT fk_fin_cheque_hist FOREIGN KEY (cheque_id) REFERENCES fin_cheques(id),
  KEY idx_fin_cheque_hist (cheque_id)
);

-- Conciliación bancaria (FIN-CONCILIACION): el extracto de una cuenta línea por línea; cada línea se concilia contra uno o varios movimientos (RF09). Un movimiento solo
-- se concilia una vez (RN12) y un período cerrado no admite cambios.
CREATE TABLE IF NOT EXISTS fin_conciliaciones (
  id                INT           AUTO_INCREMENT PRIMARY KEY,
  cuenta_id         INT           NOT NULL,
  desde             DATE          NOT NULL,
  hasta             DATE          NOT NULL,
  saldo_extracto    DECIMAL(14,2) NOT NULL,
  saldo_conciliado  DECIMAL(14,2) NOT NULL,
  diferencia        DECIMAL(14,2) NOT NULL,
  user_id           INT           NULL,
  cerrada_ms        BIGINT        NOT NULL,
  CONSTRAINT fk_fin_conc_cuenta FOREIGN KEY (cuenta_id) REFERENCES fin_cuentas(id),
  KEY idx_fin_conc_cuenta (cuenta_id, hasta)
);
CREATE TABLE IF NOT EXISTS fin_extracto_lineas (
  id               INT           AUTO_INCREMENT PRIMARY KEY,
  cuenta_id        INT           NOT NULL,
  clave            VARCHAR(190)  CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  fecha            DATE          NOT NULL,
  importe          DECIMAL(14,2) NOT NULL,
  referencia       VARCHAR(100)  NULL,
  descripcion      VARCHAR(255)  NULL,
  estado           ENUM('pendiente', 'conciliada', 'pendiente_de_identificar') NOT NULL DEFAULT 'pendiente',
  conciliacion_id  INT           NULL,
  origen           VARCHAR(20)   NOT NULL DEFAULT 'importacion',
  ts_ms            BIGINT        NOT NULL,
  CONSTRAINT uq_fin_extracto_clave UNIQUE (cuenta_id, clave),
  CONSTRAINT fk_fin_extracto_cuenta FOREIGN KEY (cuenta_id) REFERENCES fin_cuentas(id),
  CONSTRAINT fk_fin_extracto_conc FOREIGN KEY (conciliacion_id) REFERENCES fin_conciliaciones(id),
  KEY idx_fin_extracto_fecha (cuenta_id, fecha)
);
CREATE TABLE IF NOT EXISTS fin_conciliacion_vinculos (
  id             INT         AUTO_INCREMENT PRIMARY KEY,
  linea_id       INT         NOT NULL,
  movimiento_id  BIGINT      NOT NULL,
  modo           VARCHAR(12) NOT NULL DEFAULT 'manual',
  user_id        INT         NULL,
  ts_ms          BIGINT      NOT NULL,
  CONSTRAINT uq_fin_vinculo_movimiento UNIQUE (movimiento_id),
  CONSTRAINT fk_fin_vinculo_linea FOREIGN KEY (linea_id) REFERENCES fin_extracto_lineas(id),
  KEY idx_fin_vinculo_linea (linea_id)
);

INSERT IGNORE INTO rol_permisos (rol_id, permiso, nivel)
SELECT r.id, p.permiso, p.nivel FROM roles r JOIN (
  SELECT 'gerente' rol, 'financiero.cheques.gestionar' permiso, 'permitido' nivel UNION ALL
  SELECT 'administrativo', 'financiero.cheques.gestionar', 'permitido' UNION ALL
  SELECT 'encargado', 'financiero.cheques.gestionar', 'permitido' UNION ALL
  SELECT 'gerente', 'financiero.conciliar', 'permitido' UNION ALL
  SELECT 'administrativo', 'financiero.conciliar', 'permitido' UNION ALL
  SELECT 'contador', 'financiero.conciliar', 'permitido'
) p ON p.rol = r.codigo;
