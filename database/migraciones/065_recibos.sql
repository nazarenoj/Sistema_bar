-- E4: recibos e imputación (Clientes y CC RF06, RF07, RF17, RN07, RN08, RN36, RN39, EX05, EX09, EX28).
-- Re-ejecutable: tablas IF NOT EXISTS, semillas con INSERT IGNORE.

-- Numeración correlativa por punto de emisión, sin saltos: se asigna dentro de la transacción del recibo (un recibo que falla no consume número).
CREATE TABLE IF NOT EXISTS recibo_numeracion (
  punto_emision INT NOT NULL PRIMARY KEY,
  ultimo        INT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS recibos (
  id                 INT           AUTO_INCREMENT PRIMARY KEY,
  id_global          VARCHAR(40)   CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  id_operacion       VARCHAR(160)  CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  huella             CHAR(64)      NOT NULL,
  punto_emision      INT           NOT NULL,
  numero             INT           NOT NULL,
  cliente_id         INT           NOT NULL,
  cuenta_id          INT           NOT NULL,
  movimiento_id      BIGINT        NULL,
  fecha              DATE          NOT NULL,
  total              DECIMAL(14,2) NOT NULL,
  estado             ENUM('vigente', 'anulado') NOT NULL DEFAULT 'vigente',
  estado_integracion ENUM('completa', 'parcial') NOT NULL DEFAULT 'completa',
  user_id            INT           NULL,
  motivo_anulacion   VARCHAR(255)  NULL,
  anulado_por        INT           NULL,
  anulado_en         DATETIME      NULL,
  config_version     INT           NULL,
  instantanea        TEXT          NULL,
  created_at         TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_recibo_id_global UNIQUE (id_global),
  CONSTRAINT uq_recibo_operacion UNIQUE (id_operacion),
  CONSTRAINT uq_recibo_numero UNIQUE (punto_emision, numero),
  CONSTRAINT fk_recibo_cuenta FOREIGN KEY (cuenta_id) REFERENCES cuentas_corrientes(id),
  KEY idx_recibo_cuenta (cuenta_id, fecha)
);

-- Formas de pago del recibo; el cheque lleva sus datos propios (con Financiero pasarían a su cartera).
CREATE TABLE IF NOT EXISTS recibo_valores (
  id                   INT           AUTO_INCREMENT PRIMARY KEY,
  recibo_id            INT           NOT NULL,
  forma                VARCHAR(40)   NOT NULL,
  importe              DECIMAL(14,2) NOT NULL,
  recibido             DECIMAL(14,2) NULL,
  vuelto               DECIMAL(14,2) NOT NULL DEFAULT 0,
  moneda               VARCHAR(3)    NOT NULL DEFAULT 'ARS',
  cotizacion           DECIMAL(14,4) NULL,
  referencia           VARCHAR(100)  NULL,
  cheque_banco         VARCHAR(80)   NULL,
  cheque_numero        VARCHAR(30)   NULL,
  cheque_fecha_pago    DATE          NULL,
  cheque_cuit_librador CHAR(11)      NULL,
  CONSTRAINT fk_valor_recibo FOREIGN KEY (recibo_id) REFERENCES recibos(id),
  KEY idx_valor_recibo (recibo_id)
);

-- Imputación de un crédito (recibo o nota de crédito) a los débitos que cancela. Desimputar la marca; no se borra.
CREATE TABLE IF NOT EXISTS imputaciones (
  id                  BIGINT        AUTO_INCREMENT PRIMARY KEY,
  credito_mov_id      BIGINT        NOT NULL,
  debito_mov_id       BIGINT        NOT NULL,
  importe             DECIMAL(14,2) NOT NULL,
  fecha               DATE          NOT NULL,
  user_id             INT           NULL,
  estado              ENUM('vigente', 'desimputada') NOT NULL DEFAULT 'vigente',
  desimputada_por     INT           NULL,
  motivo_desimputacion VARCHAR(255) NULL,
  created_at          TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_imp_credito FOREIGN KEY (credito_mov_id) REFERENCES movimientos_cc(id),
  CONSTRAINT fk_imp_debito FOREIGN KEY (debito_mov_id) REFERENCES movimientos_cc(id),
  KEY idx_imp_credito (credito_mov_id, estado),
  KEY idx_imp_debito (debito_mov_id, estado)
);

INSERT IGNORE INTO parametros (clave, valor) VALUES ('recibo_punto_emision', '1');

INSERT IGNORE INTO rol_permisos (rol_id, permiso, nivel)
SELECT r.id, p.permiso, p.nivel FROM roles r JOIN (
  SELECT 'gerente' rol, 'clientes.recibos.registrar' permiso, 'permitido' nivel UNION ALL
  SELECT 'administrativo', 'clientes.recibos.registrar', 'permitido' UNION ALL
  SELECT 'encargado', 'clientes.recibos.registrar', 'permitido' UNION ALL
  SELECT 'cajero', 'clientes.recibos.registrar', 'permitido' UNION ALL
  SELECT 'gerente', 'clientes.recibos.anular', 'permitido' UNION ALL
  SELECT 'administrativo', 'clientes.recibos.anular', 'requiere_autorizacion' UNION ALL
  SELECT 'gerente', 'clientes.recibos.desimputar', 'permitido'
) p ON p.rol = r.codigo;
