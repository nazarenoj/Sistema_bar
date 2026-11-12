-- Ventas Online RN06/RF14: el efectivo de un pedido (pago al retirar, efectivo contra entrega) se cobra en el local que entrega: la terminal cuya caja lo recibe. Re-ejecutable.
SET @c = (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'onl_tienda' AND column_name = 'terminal_cobro_id');
SET @s = IF(@c = 0, 'ALTER TABLE onl_tienda ADD COLUMN terminal_cobro_id INT NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
