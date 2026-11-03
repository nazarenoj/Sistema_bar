-- E6: remitos de entrega y facturación agrupada (Ventas RF12, RF17, RF27, RN31, RN73, RN74, EX36; Clientes y CC RF05, RF21, RN10).
-- Re-ejecutable: tablas IF NOT EXISTS, semillas con INSERT IGNORE.

-- Remito: comprobante no fiscal de entrega con numeración propia. Asignado a la cuenta de un cliente pide veredicto y reserva de crédito y publica «Remito emitido».
CREATE TABLE IF NOT EXISTS remitos (
  id                  INT           AUTO_INCREMENT PRIMARY KEY,
  id_global           VARCHAR(40)   CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  numero              INT           NOT NULL,
  cliente_id          INT           NULL,
  total               DECIMAL(14,2) NOT NULL,
  detalle             MEDIUMTEXT    NOT NULL,
  estado              ENUM('emitido', 'anulado') NOT NULL DEFAULT 'emitido',
  facturacion         ENUM('pendiente', 'facturado') NOT NULL DEFAULT 'pendiente',
  cuenta_asignada     TINYINT(1)    NOT NULL DEFAULT 0,
  id_reserva_credito  VARCHAR(40)   NULL,
  en_contingencia     TINYINT(1)    NOT NULL DEFAULT 0,
  factura_agrupada_id INT           NULL,
  id_solicitud        VARCHAR(80)   NULL,
  creado_por          INT           NULL,
  created_at          TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_remito_id_global UNIQUE (id_global),
  CONSTRAINT uq_remito_numero UNIQUE (numero),
  CONSTRAINT uq_remito_solicitud UNIQUE (id_solicitud),
  KEY idx_remito_cliente (cliente_id, facturacion, estado)
);

-- Comprobante fiscal que agrupa remitos de un mismo cliente (o factura individual de un remito). El CAE y el número quedan acá.
-- shortcut: no entra a `facturas` (atada a una mesa y sesión) ni al libro IVA; sacar cuando `facturas` admita comprobantes sin venta.
CREATE TABLE IF NOT EXISTS facturas_remitos (
  id               INT           AUTO_INCREMENT PRIMARY KEY,
  id_global        VARCHAR(40)   CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  cliente_id       INT           NOT NULL,
  tipo_comprobante INT           NOT NULL,
  punto_venta      INT           NOT NULL,
  numero           INT           NULL,
  cae              VARCHAR(14)   NULL,
  cae_vencimiento  VARCHAR(10)   NULL,
  importe_total    DECIMAL(14,2) NOT NULL,
  detalle          MEDIUMTEXT    NOT NULL,
  id_intento       VARCHAR(80)   NULL,
  creado_por       INT           NULL,
  created_at       TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_factura_remitos_id_global UNIQUE (id_global),
  CONSTRAINT uq_factura_remitos_intento UNIQUE (id_intento)
);

INSERT IGNORE INTO rol_permisos (rol_id, permiso, nivel)
SELECT r.id, p.permiso, p.nivel FROM roles r JOIN (
  SELECT 'gerente' rol, 'ventas.remitos.emitir' permiso, 'permitido' nivel UNION ALL
  SELECT 'encargado', 'ventas.remitos.emitir', 'permitido' UNION ALL
  SELECT 'administrativo', 'ventas.remitos.emitir', 'permitido' UNION ALL
  SELECT 'gerente', 'ventas.remitos.facturar', 'permitido' UNION ALL
  SELECT 'administrativo', 'ventas.remitos.facturar', 'permitido'
) p ON p.rol = r.codigo;
