USE sistema_chepola;

-- Cachea el Ticket de Acceso (TA) de WSAA por servicio+entorno para no re-autenticar en cada
-- factura: el TA de ARCA es válido ~12hs y ARCA rechaza pedir uno nuevo mientras el anterior siga
-- vigente. Se persiste en tabla (no en memoria) para sobrevivir reinicios del proceso Node.
CREATE TABLE IF NOT EXISTS afip_token_cache (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  servicio    VARCHAR(20) NOT NULL DEFAULT 'wsfe',
  entorno     ENUM('homologacion', 'produccion') NOT NULL,
  token       MEDIUMTEXT NOT NULL,
  sign        MEDIUMTEXT NOT NULL,
  generado_en DATETIME NOT NULL,
  expira_en   DATETIME NOT NULL,
  UNIQUE KEY uq_afip_token_cache (servicio, entorno)
);

-- Un comprobante fiscal por cuenta cerrada (mesa_id + sesion_apertura identifican la cuenta,
-- igual que pedidoModel.js usa esas dos columnas para agrupar las sillas de una misma mesa). Se
-- crea SIEMPRE al cerrar la cuenta (estado 'pendiente'), aunque ARCA todavía no haya respondido,
-- para no perder el método de pago ni la trazabilidad si el pedido a ARCA falla y hay que
-- reintentarlo después.
CREATE TABLE IF NOT EXISTS facturas (
  id                        INT AUTO_INCREMENT PRIMARY KEY,
  mesa_id                   INT NOT NULL,
  sesion_apertura           DATETIME NOT NULL,

  metodo_pago               ENUM('efectivo', 'tarjeta_debito', 'tarjeta_credito', 'transferencia', 'otro') NOT NULL,

  tipo_comprobante          TINYINT UNSIGNED NOT NULL,   -- código ARCA: 1=Factura A, 6=Factura B, 11=Factura C
  punto_venta               SMALLINT UNSIGNED NOT NULL,
  numero                    INT UNSIGNED NULL,           -- asignado tras CompUltimoAutorizado + 1; NULL hasta emitir

  doc_tipo                  TINYINT UNSIGNED NOT NULL DEFAULT 99,  -- 80=CUIT, 96=DNI, 99=Consumidor Final
  doc_nro                   VARCHAR(20) NOT NULL DEFAULT '0',
  condicion_iva_receptor_id SMALLINT UNSIGNED NOT NULL,    -- código ARCA (5=Consumidor Final, 1=RI, 6=Monotributo, etc.)
  receptor_nombre           VARCHAR(255) NULL,             -- opcional, solo para mostrar en el PDF / registro interno

  importe_neto              DECIMAL(10,2) NOT NULL DEFAULT 0,
  importe_iva               DECIMAL(10,2) NOT NULL DEFAULT 0,
  importe_total             DECIMAL(10,2) NOT NULL,
  moneda                    VARCHAR(3) NOT NULL DEFAULT 'PES',

  cae                       VARCHAR(14) NULL,
  cae_vencimiento           DATE NULL,

  estado                    ENUM('pendiente', 'aprobada', 'rechazada', 'error') NOT NULL DEFAULT 'pendiente',
  observaciones             TEXT NULL,     -- errores/observaciones crudos de ARCA, para debug
  entorno                   ENUM('homologacion', 'produccion') NOT NULL,

  creado_por                INT NULL,      -- users.id de quien cerró la cuenta
  fecha_emision              DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  fecha_cae                  DATETIME NULL,

  CONSTRAINT fk_factura_mesa    FOREIGN KEY (mesa_id)    REFERENCES mesas(id),
  CONSTRAINT fk_factura_usuario FOREIGN KEY (creado_por) REFERENCES users(id),

  -- Evita doble emisión para la misma cuenta si el usuario reintenta el cierre.
  UNIQUE KEY uq_facturas_sesion (mesa_id, sesion_apertura),
  INDEX idx_facturas_estado_fecha (estado, fecha_emision)
);
