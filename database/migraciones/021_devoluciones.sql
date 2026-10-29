-- B10: anulación y devolución (Ventas RF15, RF49, RN34, RN76). La venta original nunca se toca (RN19): cada
-- devolución es un documento propio que la referencia. Anular = devolver todo lo que quede. La nota de
-- crédito fiscal es una fila más de `facturas` ligada a la devolución y a la factura que corrige.
-- Re-ejecutable: cada ALTER se arma solo si su columna centinela no existe.

CREATE TABLE IF NOT EXISTS devoluciones (
  id             INT           AUTO_INCREMENT PRIMARY KEY,
  id_global      VARCHAR(40)   CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  venta_id       INT           NOT NULL,
  tipo           ENUM('parcial', 'total') NOT NULL,
  total          DECIMAL(12,2) NOT NULL,
  motivo         VARCHAR(255)  NOT NULL,
  reingreso      ENUM('reingreso', 'merma') NOT NULL DEFAULT 'reingreso',
  id_solicitud   VARCHAR(64)   NULL,
  creado_por     INT           NULL,
  autorizado_por INT           NULL,
  created_at     TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_devolucion_id_global   UNIQUE (id_global),
  CONSTRAINT uq_devolucion_solicitud   UNIQUE (id_solicitud),
  CONSTRAINT fk_devolucion_venta       FOREIGN KEY (venta_id) REFERENCES ventas(id)
);

-- `linea` es la posición del ítem en el detalle congelado de la venta.
CREATE TABLE IF NOT EXISTS devolucion_items (
  id              INT           AUTO_INCREMENT PRIMARY KEY,
  devolucion_id   INT           NOT NULL,
  linea           INT           NOT NULL,
  producto_id     INT           NOT NULL,
  nombre          VARCHAR(255)  NOT NULL,
  cantidad        INT           NOT NULL,
  precio_unitario DECIMAL(10,2) NOT NULL,
  CONSTRAINT fk_devitem_devolucion FOREIGN KEY (devolucion_id) REFERENCES devoluciones(id)
);

CREATE TABLE IF NOT EXISTS devolucion_reintegros (
  id            INT           AUTO_INCREMENT PRIMARY KEY,
  devolucion_id INT           NOT NULL,
  metodo_pago   VARCHAR(50)   NOT NULL,
  importe       DECIMAL(12,2) NOT NULL,
  CONSTRAINT fk_devreint_devolucion FOREIGN KEY (devolucion_id) REFERENCES devoluciones(id)
);

DROP TRIGGER IF EXISTS devoluciones_no_update;
CREATE TRIGGER devoluciones_no_update BEFORE UPDATE ON devoluciones FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Las devoluciones son de solo lectura';
DROP TRIGGER IF EXISTS devoluciones_no_delete;
CREATE TRIGGER devoluciones_no_delete BEFORE DELETE ON devoluciones FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Las devoluciones son de solo lectura';
DROP TRIGGER IF EXISTS devolucion_items_no_update;
CREATE TRIGGER devolucion_items_no_update BEFORE UPDATE ON devolucion_items FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Las devoluciones son de solo lectura';
DROP TRIGGER IF EXISTS devolucion_items_no_delete;
CREATE TRIGGER devolucion_items_no_delete BEFORE DELETE ON devolucion_items FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Las devoluciones son de solo lectura';
DROP TRIGGER IF EXISTS devolucion_reintegros_no_update;
CREATE TRIGGER devolucion_reintegros_no_update BEFORE UPDATE ON devolucion_reintegros FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Las devoluciones son de solo lectura';
DROP TRIGGER IF EXISTS devolucion_reintegros_no_delete;
CREATE TRIGGER devolucion_reintegros_no_delete BEFORE DELETE ON devolucion_reintegros FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Las devoluciones son de solo lectura';

-- Una nota de crédito es una fila de `facturas` ligada a su devolución y al comprobante que corrige. La
-- clave única por cuenta pasa a incluir la devolución (0 = el comprobante original), así una cuenta puede
-- tener su factura y varias notas de crédito, pero sigue sin poder tener dos facturas originales.
SET @sql = (
  SELECT IF(COUNT(*) = 0,
    "ALTER TABLE facturas
       ADD COLUMN devolucion_id        INT NULL,
       ADD COLUMN comprobante_origen_id INT NULL,
       ADD COLUMN devolucion_key       INT AS (COALESCE(devolucion_id, 0)) STORED,
       DROP INDEX uq_facturas_sesion,
       ADD UNIQUE KEY uq_facturas_cuenta (mesa_id, sesion_apertura, devolucion_key)",
    'SELECT 1')
  FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'facturas' AND column_name = 'devolucion_id'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

INSERT IGNORE INTO parametros (clave, valor) VALUES ('reintegro_otra_forma_requiere_supervisor', '1');

INSERT IGNORE INTO rol_permisos (rol_id, permiso, nivel)
SELECT r.id, p.permiso, p.nivel FROM roles r JOIN (
  SELECT 'gerente' rol, 'ventas.devoluciones.crear' permiso, 'permitido' nivel UNION ALL
  SELECT 'encargado', 'ventas.devoluciones.crear', 'permitido' UNION ALL
  SELECT 'cajero', 'ventas.devoluciones.crear', 'requiere_autorizacion'
) p ON p.rol = r.codigo;
