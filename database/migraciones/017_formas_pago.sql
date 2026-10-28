-- B4: formas de pago configurables (Ventas RF09, RN16). Reemplazan al ENUM `metodo_pago` de pedidos y
-- facturas: ahora es el código de una forma de pago, o 'mixto' cuando una venta se cobró con varias.
-- Re-ejecutable: los MODIFY no cambian nada si ya están hechos y las columnas se agregan solo si faltan.

CREATE TABLE IF NOT EXISTS formas_pago (
  id                  INT          AUTO_INCREMENT PRIMARY KEY,
  codigo              VARCHAR(50)  NOT NULL,
  nombre              VARCHAR(100) NOT NULL,
  activa              TINYINT(1)   NOT NULL DEFAULT 1,
  requiere_referencia TINYINT(1)   NOT NULL DEFAULT 0,
  admite_vuelto       TINYINT(1)   NOT NULL DEFAULT 0,
  orden               INT          NOT NULL DEFAULT 0,
  CONSTRAINT uq_forma_pago_codigo UNIQUE (codigo)
);

-- Ninguna exige referencia de entrada: se activa por forma desde la configuración.
INSERT IGNORE INTO formas_pago (codigo, nombre, requiere_referencia, admite_vuelto, orden) VALUES
  ('efectivo',        'Efectivo',           0, 1, 1),
  ('tarjeta_debito',  'Tarjeta de débito',  0, 0, 2),
  ('tarjeta_credito', 'Tarjeta de crédito', 0, 0, 3),
  ('transferencia',   'Transferencia',      0, 0, 4),
  ('otro',            'Otro',               0, 0, 5);

ALTER TABLE pedidos  MODIFY metodo_pago VARCHAR(50) NULL;
ALTER TABLE facturas MODIFY metodo_pago VARCHAR(50) NOT NULL;

SET @sql = (
  SELECT IF(COUNT(*) = 0,
    "ALTER TABLE pago_venta
       ADD COLUMN referencia VARCHAR(100)  NULL,
       ADD COLUMN recibido   DECIMAL(12,2) NULL,
       ADD COLUMN vuelto     DECIMAL(12,2) NOT NULL DEFAULT 0",
    'SELECT 1')
  FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'pago_venta' AND column_name = 'referencia'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
