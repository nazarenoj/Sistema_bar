-- Ventas Online RF21: cada línea del pedido guarda su descuento (promociones automáticas de Ventas y parte del cupón) y las promociones que se le aplicaron. Re-ejecutable.
SET @c = (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'onl_pedido_lineas' AND column_name = 'descuento_linea');
SET @s = IF(@c = 0, 'ALTER TABLE onl_pedido_lineas ADD COLUMN descuento_linea DECIMAL(12,2) NOT NULL DEFAULT 0, ADD COLUMN promociones TEXT NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
