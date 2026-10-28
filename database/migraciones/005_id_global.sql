-- ID_Global de los documentos (A3, Usuarios RN81): <CODIGO_INSTANCIA>-<ULID>, generado por la app
-- con la hora del servidor. Único y nunca se reutiliza; el id autoincremental queda solo para
-- joins locales. NULL = documento anterior a esta migración (no se rellena: arranque limpio).
-- Re-ejecutable: cada ADD COLUMN y cada índice se arman solo si faltan.
SET @sql = (SELECT IF(COUNT(*) = 0,
  "ALTER TABLE pedidos ADD COLUMN id_global VARCHAR(40) CHARACTER SET ascii COLLATE ascii_bin NULL",
  'SELECT 1') FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'pedidos' AND column_name = 'id_global');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql = (SELECT IF(COUNT(*) = 0,
  "ALTER TABLE pedidos ADD UNIQUE KEY uq_pedidos_id_global (id_global)",
  'SELECT 1') FROM information_schema.statistics
  WHERE table_schema = DATABASE() AND table_name = 'pedidos' AND index_name = 'uq_pedidos_id_global');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql = (SELECT IF(COUNT(*) = 0,
  "ALTER TABLE facturas ADD COLUMN id_global VARCHAR(40) CHARACTER SET ascii COLLATE ascii_bin NULL",
  'SELECT 1') FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'facturas' AND column_name = 'id_global');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql = (SELECT IF(COUNT(*) = 0,
  "ALTER TABLE facturas ADD UNIQUE KEY uq_facturas_id_global (id_global)",
  'SELECT 1') FROM information_schema.statistics
  WHERE table_schema = DATABASE() AND table_name = 'facturas' AND index_name = 'uq_facturas_id_global');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
