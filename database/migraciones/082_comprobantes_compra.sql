-- H2: comprobantes de compra (Compras RF03, RF18, RN03, RN04, RN08, RN12, RN35, EX01, EX05, EX11, EX16).
-- Re-ejecutable.

-- Períodos de IVA: uno presentado se cierra y no admite comprobantes nuevos ni cambios (RN12).
CREATE TABLE IF NOT EXISTS cmp_periodos_iva (
  periodo     CHAR(7)    NOT NULL PRIMARY KEY,
  estado      ENUM('abierto', 'cerrado') NOT NULL DEFAULT 'abierto',
  cerrado_ms  BIGINT     NULL,
  cerrado_por INT        NULL
);

CREATE TABLE IF NOT EXISTS cmp_comprobantes (
  id                  INT           AUTO_INCREMENT PRIMARY KEY,
  id_global           VARCHAR(40)   CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  proveedor_id        INT           NOT NULL,
  clase               VARCHAR(14)   NOT NULL,
  tipo                CHAR(1)       NOT NULL,
  punto_venta         VARCHAR(5)    NOT NULL,
  numero              VARCHAR(8)    NOT NULL,
  fecha               DATE          NOT NULL,
  cae                 VARCHAR(14)   NULL,
  cae_tipo            VARCHAR(4)    NULL,
  cae_vencimiento     DATE          NULL,
  moneda              CHAR(3)       NOT NULL DEFAULT 'ARS',
  cotizacion          DECIMAL(14,6) NULL,
  neto_gravado        DECIMAL(14,2) NOT NULL DEFAULT 0,
  no_gravado          DECIMAL(14,2) NOT NULL DEFAULT 0,
  exento              DECIMAL(14,2) NOT NULL DEFAULT 0,
  iva                 DECIMAL(14,2) NOT NULL DEFAULT 0,
  iva_computable      DECIMAL(14,2) NOT NULL DEFAULT 0,
  percepciones_iva    DECIMAL(14,2) NOT NULL DEFAULT 0,
  percepciones_iibb   DECIMAL(14,2) NOT NULL DEFAULT 0,
  percepciones_detalle TEXT         NULL,
  impuestos_internos  DECIMAL(14,2) NOT NULL DEFAULT 0,
  otros_tributos      DECIMAL(14,2) NOT NULL DEFAULT 0,
  total               DECIMAL(14,2) NOT NULL,
  estado              ENUM('borrador', 'registrado', 'pendiente_recepcion', 'con_diferencias', 'anulado') NOT NULL DEFAULT 'registrado',
  constatacion        ENUM('no_constatado', 'constatado', 'cae_no_valido') NOT NULL DEFAULT 'no_constatado',
  origen              ENUM('manual', 'foto', 'stock', 'financiero') NOT NULL DEFAULT 'manual',
  periodo_iva         CHAR(7)       NOT NULL,
  clave               VARCHAR(190)  CHARACTER SET ascii COLLATE ascii_bin NULL,
  clave_anterior      VARCHAR(190)  CHARACTER SET ascii COLLATE ascii_bin NULL,
  id_reserva          VARCHAR(80)   NULL,
  id_solicitud        VARCHAR(64)   NULL,
  observacion         VARCHAR(255)  NULL,
  motivo_anulacion    VARCHAR(255)  NULL,
  user_id             INT           NULL,
  ts_ms               BIGINT        NOT NULL,
  CONSTRAINT uq_cmp_comp_id_global UNIQUE (id_global),
  CONSTRAINT uq_cmp_comp_clave UNIQUE (clave),
  CONSTRAINT uq_cmp_comp_solicitud UNIQUE (id_solicitud),
  CONSTRAINT fk_cmp_comp_proveedor FOREIGN KEY (proveedor_id) REFERENCES cmp_proveedores(id),
  KEY idx_cmp_comp_proveedor (proveedor_id, fecha),
  KEY idx_cmp_comp_periodo (periodo_iva)
);

CREATE TABLE IF NOT EXISTS cmp_comprobante_alicuotas (
  id              INT           AUTO_INCREMENT PRIMARY KEY,
  comprobante_id  INT           NOT NULL,
  alicuota        DECIMAL(5,2)  NOT NULL,
  neto            DECIMAL(14,2) NOT NULL,
  iva             DECIMAL(14,2) NOT NULL,
  CONSTRAINT fk_cmp_alic_comp FOREIGN KEY (comprobante_id) REFERENCES cmp_comprobantes(id),
  KEY idx_cmp_alic_comp (comprobante_id)
);

-- Líneas por ítem (mercadería, con la presentación de Stock y el factor aplicado) o por concepto (servicios y gastos).
CREATE TABLE IF NOT EXISTS cmp_comprobante_lineas (
  id                INT           AUTO_INCREMENT PRIMARY KEY,
  comprobante_id    INT           NOT NULL,
  linea             INT           NOT NULL,
  tipo              ENUM('mercaderia', 'concepto') NOT NULL,
  item_tipo         VARCHAR(10)   NULL,
  item_id           INT           NULL,
  descripcion       VARCHAR(200)  NOT NULL,
  categoria         VARCHAR(80)   NULL,
  cantidad          DECIMAL(14,3) NOT NULL,
  unidad            VARCHAR(30)   NULL,
  presentacion_id   INT           NULL,
  factor_aplicado   DECIMAL(18,6) NULL,
  precio_unitario   DECIMAL(14,4) NOT NULL,
  bonificacion_pct  DECIMAL(5,2)  NOT NULL DEFAULT 0,
  importe           DECIMAL(14,2) NOT NULL,
  costo_unidad_base DECIMAL(14,4) NULL,
  CONSTRAINT fk_cmp_linea_comp FOREIGN KEY (comprobante_id) REFERENCES cmp_comprobantes(id),
  KEY idx_cmp_linea_comp (comprobante_id)
);

INSERT IGNORE INTO rol_permisos (rol_id, permiso, nivel)
SELECT r.id, p.permiso, p.nivel FROM roles r JOIN (
  SELECT 'gerente' rol, 'compras.comprobantes.ver' permiso, 'permitido' nivel UNION ALL
  SELECT 'administrativo', 'compras.comprobantes.ver', 'permitido' UNION ALL
  SELECT 'contador', 'compras.comprobantes.ver', 'permitido' UNION ALL
  SELECT 'deposito', 'compras.comprobantes.ver', 'permitido' UNION ALL
  SELECT 'gerente', 'compras.comprobantes.registrar', 'permitido' UNION ALL
  SELECT 'administrativo', 'compras.comprobantes.registrar', 'permitido' UNION ALL
  SELECT 'gerente', 'compras.comprobantes.confirmar_parecido', 'permitido' UNION ALL
  SELECT 'administrativo', 'compras.comprobantes.confirmar_parecido', 'permitido' UNION ALL
  SELECT 'gerente', 'compras.comprobantes.anular', 'permitido' UNION ALL
  SELECT 'administrativo', 'compras.comprobantes.anular', 'requiere_autorizacion' UNION ALL
  SELECT 'gerente', 'compras.periodos.cerrar', 'permitido' UNION ALL
  SELECT 'contador', 'compras.periodos.cerrar', 'permitido'
) p ON p.rol = r.codigo;
