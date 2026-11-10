-- Contable RF20: el costo de ventas distingue insumos de packaging. Un insumo se marca como packaging (envases, vasos, bolsas) y su costo va a «Costo de ventas - packaging». Re-ejecutable.
SET @c = (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'insumos' AND column_name = 'packaging');
SET @s = IF(@c = 0, 'ALTER TABLE insumos ADD COLUMN packaging TINYINT(1) NOT NULL DEFAULT 0', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
