-- El método de pago vivía solo en `facturas`: una cuenta cerrada sin facturar lo perdía. Ahora se
-- guarda en cada pedido de la cuenta (todos los de la misma mesa_id + sesion_apertura).
--
-- Re-ejecutable: el ADD COLUMN se arma solo si la columna no existe (una base que ya recibió
-- database/legacy/alter_pedidos_metodo_pago.sql a mano no falla). Mismo patrón para cualquier
-- ALTER de las próximas migraciones, porque el DDL de MySQL/MariaDB no es transaccional.
SET @sql = (
  SELECT IF(COUNT(*) = 0,
    "ALTER TABLE pedidos ADD COLUMN metodo_pago ENUM('efectivo', 'tarjeta_debito', 'tarjeta_credito', 'transferencia', 'otro') NULL AFTER total",
    'SELECT 1')
  FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'pedidos' AND column_name = 'metodo_pago'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Cuentas ya facturadas: se copia el método que ya tenían. Las cerradas sin factura antes de esta
-- migración quedan en NULL (el dato no se guardó nunca).
UPDATE pedidos p
JOIN facturas f ON f.mesa_id = p.mesa_id AND f.sesion_apertura = p.sesion_apertura
SET p.metodo_pago = f.metodo_pago
WHERE p.metodo_pago IS NULL;
