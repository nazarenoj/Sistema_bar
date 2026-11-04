-- Cliente identificado en el pedido y en la venta (Ventas RN81, RN83; Clientes RN43): permite aplicar la lista de precios del cliente al
-- abrir la cuenta y buscar las ventas por cliente. Sin clave foránea: la ficha vive en otra base de módulo (Clientes puede no estar instalado).
SET @sql = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE pedidos ADD COLUMN cliente_id INT NULL', 'SELECT 1')
  FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'pedidos' AND column_name = 'cliente_id');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE ventas ADD COLUMN cliente_id INT NULL', 'SELECT 1')
  FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'ventas' AND column_name = 'cliente_id');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE ventas ADD KEY idx_ventas_cliente (cliente_id)', 'SELECT 1')
  FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'ventas' AND index_name = 'idx_ventas_cliente');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Quitar un ítem ya enviado a producción: mismo nivel que «anular pedidos o ítems» en cada rol.
INSERT IGNORE INTO rol_permisos (rol_id, permiso, nivel)
SELECT rol_id, 'ventas.pedidos.quitar_enviado', nivel FROM rol_permisos WHERE permiso = 'ventas.pedidos.anular';
