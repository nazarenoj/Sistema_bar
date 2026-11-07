-- H5: órdenes de pago, anticipos, pagos programados y retenciones practicadas (Compras RF06 a RF09, RN09 a RN11, RN33 a RN36, EX07, EX08, EX13).
-- Re-ejecutable.

-- Numeración correlativa de las órdenes de pago.
CREATE TABLE IF NOT EXISTS cmp_numeracion (
  clave   VARCHAR(30) NOT NULL PRIMARY KEY,
  ultimo  INT         NOT NULL DEFAULT 0
);
INSERT IGNORE INTO cmp_numeracion (clave, ultimo) VALUES ('orden_pago', 0);

-- Regímenes de retención (RF09): alícuota general, mínimo no sujeto y acumulación mensual; los certificados se numeran por régimen (RN11).
CREATE TABLE IF NOT EXISTS cmp_regimenes_retencion (
  id                  INT           AUTO_INCREMENT PRIMARY KEY,
  codigo              VARCHAR(30)   NOT NULL,
  nombre              VARCHAR(100)  NOT NULL,
  impuesto            ENUM('IVA', 'GANANCIAS', 'IIBB', 'SUSS') NOT NULL,
  jurisdiccion        VARCHAR(40)   NULL,
  alicuota_general    DECIMAL(6,3)  NOT NULL,
  minimo_no_sujeto    DECIMAL(14,2) NOT NULL DEFAULT 0,
  acumulacion_mensual TINYINT(1)    NOT NULL DEFAULT 0,
  usa_padron          TINYINT(1)    NOT NULL DEFAULT 0,
  aplica_a            ENUM('mercaderia', 'servicios', 'ambos') NOT NULL DEFAULT 'ambos',
  ultimo_certificado  INT           NOT NULL DEFAULT 0,
  activo              TINYINT(1)    NOT NULL DEFAULT 1,
  CONSTRAINT uq_cmp_regimen UNIQUE (codigo)
);
-- Padrones de alícuotas por contribuyente (RF09): vigencia hasta una fecha.
CREATE TABLE IF NOT EXISTS cmp_padron_retencion (
  id            INT          AUTO_INCREMENT PRIMARY KEY,
  regimen_id    INT          NOT NULL,
  cuit          VARCHAR(11)  NOT NULL,
  alicuota      DECIMAL(6,3) NOT NULL,
  vigente_hasta DATE         NOT NULL,
  CONSTRAINT uq_cmp_padron UNIQUE (regimen_id, cuit),
  CONSTRAINT fk_cmp_padron_regimen FOREIGN KEY (regimen_id) REFERENCES cmp_regimenes_retencion(id)
);

CREATE TABLE IF NOT EXISTS cmp_ordenes_pago (
  id                 INT           AUTO_INCREMENT PRIMARY KEY,
  id_global          VARCHAR(40)   CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  numero             INT           NOT NULL,
  tipo               ENUM('pago', 'anticipo') NOT NULL DEFAULT 'pago',
  proveedor_id       INT           NOT NULL,
  moneda             CHAR(3)       NOT NULL DEFAULT 'ARS',
  fecha              DATE          NOT NULL,
  estado             ENUM('programada', 'pendiente_aprobacion', 'aprobada', 'pagada', 'anulada') NOT NULL,
  fecha_programada   DATE          NULL,
  deuda_aplicada     DECIMAL(14,2) NOT NULL DEFAULT 0,
  notas_credito      DECIMAL(14,2) NOT NULL DEFAULT 0,
  anticipos          DECIMAL(14,2) NOT NULL DEFAULT 0,
  retenciones        DECIMAL(14,2) NOT NULL DEFAULT 0,
  medios_total       DECIMAL(14,2) NOT NULL DEFAULT 0,
  instantanea        VARCHAR(400)  NULL,
  version_config     INT           NULL,
  id_solicitud       VARCHAR(64)   NULL,
  creada_por         INT           NULL,
  aprobada_por       INT           NULL,
  ejecutada_ms       BIGINT        NULL,
  pagada_ms          BIGINT        NULL,
  medio_manual       VARCHAR(40)   NULL,
  valores_entregados TINYINT(1)    NULL,
  motivo_anulacion   VARCHAR(255)  NULL,
  observacion        VARCHAR(255)  NULL,
  ts_ms              BIGINT        NOT NULL,
  CONSTRAINT uq_cmp_op_id_global UNIQUE (id_global),
  CONSTRAINT uq_cmp_op_numero UNIQUE (numero),
  CONSTRAINT uq_cmp_op_solicitud UNIQUE (id_solicitud),
  CONSTRAINT fk_cmp_op_proveedor FOREIGN KEY (proveedor_id) REFERENCES cmp_proveedores(id),
  KEY idx_cmp_op_estado (estado, fecha_programada)
);
-- Qué se aplica: cuotas de comprobantes (deuda), notas de crédito y anticipos.
CREATE TABLE IF NOT EXISTS cmp_op_aplicaciones (
  id              INT           AUTO_INCREMENT PRIMARY KEY,
  orden_id        INT           NOT NULL,
  tipo            ENUM('deuda', 'nota_credito', 'anticipo') NOT NULL,
  vencimiento_id  INT           NULL,
  comprobante_id  INT           NULL,
  anticipo_id     INT           NULL,
  importe         DECIMAL(14,2) NOT NULL,
  CONSTRAINT fk_cmp_apl_orden FOREIGN KEY (orden_id) REFERENCES cmp_ordenes_pago(id),
  KEY idx_cmp_apl_orden (orden_id),
  KEY idx_cmp_apl_comp (comprobante_id)
);
CREATE TABLE IF NOT EXISTS cmp_op_medios (
  id          INT           AUTO_INCREMENT PRIMARY KEY,
  orden_id    INT           NOT NULL,
  medio       ENUM('efectivo', 'transferencia', 'cheque_propio', 'echeq', 'cheque_tercero') NOT NULL,
  importe     DECIMAL(14,2) NOT NULL,
  cuenta_id   INT           NULL,
  cheque      TEXT          NULL,
  cheque_id   INT           NULL,
  referencia  VARCHAR(100)  NULL,
  CONSTRAINT fk_cmp_medio_orden FOREIGN KEY (orden_id) REFERENCES cmp_ordenes_pago(id),
  KEY idx_cmp_medio_orden (orden_id)
);
CREATE TABLE IF NOT EXISTS cmp_op_retenciones (
  id               INT           AUTO_INCREMENT PRIMARY KEY,
  orden_id         INT           NOT NULL,
  regimen_id       INT           NOT NULL,
  base             DECIMAL(14,2) NOT NULL,
  alicuota         DECIMAL(6,3)  NOT NULL,
  importe          DECIMAL(14,2) NOT NULL,
  calculado        DECIMAL(14,2) NOT NULL,
  certificado      INT           NOT NULL,
  anulado          TINYINT(1)    NOT NULL DEFAULT 0,
  aviso            VARCHAR(160)  NULL,
  fecha            DATE          NOT NULL,
  CONSTRAINT fk_cmp_ret_orden FOREIGN KEY (orden_id) REFERENCES cmp_ordenes_pago(id),
  CONSTRAINT fk_cmp_ret_regimen FOREIGN KEY (regimen_id) REFERENCES cmp_regimenes_retencion(id),
  CONSTRAINT uq_cmp_ret_certificado UNIQUE (regimen_id, certificado)
);
-- Pagos a cuenta sin comprobante, para imputarlos después (RF08).
CREATE TABLE IF NOT EXISTS cmp_anticipos (
  id            INT           AUTO_INCREMENT PRIMARY KEY,
  proveedor_id  INT           NOT NULL,
  orden_id      INT           NOT NULL,
  moneda        CHAR(3)       NOT NULL,
  importe       DECIMAL(14,2) NOT NULL,
  saldo         DECIMAL(14,2) NOT NULL,
  fecha         DATE          NOT NULL,
  estado        ENUM('vigente', 'anulado') NOT NULL DEFAULT 'vigente',
  CONSTRAINT fk_cmp_anticipo_prov FOREIGN KEY (proveedor_id) REFERENCES cmp_proveedores(id),
  KEY idx_cmp_anticipo_prov (proveedor_id, estado)
);

-- Categoría de Financiero para estos egresos.
INSERT IGNORE INTO fin_categorias (nombre, tipo) VALUES ('Pagos a proveedores', 'egreso');

INSERT IGNORE INTO rol_permisos (rol_id, permiso, nivel)
SELECT r.id, p.permiso, p.nivel FROM roles r JOIN (
  SELECT 'gerente' rol, 'compras.ordenes.ver' permiso, 'permitido' nivel UNION ALL
  SELECT 'administrativo', 'compras.ordenes.ver', 'permitido' UNION ALL
  SELECT 'contador', 'compras.ordenes.ver', 'permitido' UNION ALL
  SELECT 'gerente', 'compras.ordenes.crear', 'permitido' UNION ALL
  SELECT 'administrativo', 'compras.ordenes.crear', 'permitido' UNION ALL
  SELECT 'gerente', 'compras.ordenes.aprobar', 'permitido' UNION ALL
  SELECT 'gerente', 'compras.ordenes.ejecutar', 'permitido' UNION ALL
  SELECT 'administrativo', 'compras.ordenes.ejecutar', 'permitido' UNION ALL
  SELECT 'gerente', 'compras.ordenes.anular', 'permitido' UNION ALL
  SELECT 'administrativo', 'compras.ordenes.anular', 'requiere_autorizacion' UNION ALL
  SELECT 'gerente', 'compras.retenciones.configurar', 'permitido' UNION ALL
  SELECT 'contador', 'compras.retenciones.configurar', 'permitido' UNION ALL
  SELECT 'gerente', 'compras.retenciones.modificar', 'permitido'
) p ON p.rol = r.codigo;
