-- E9: clientes alcanzados por un retiro de lote (Clientes y CC RF30, EX32; Stock RF42). El aviso a un cliente queda en el retiro de Stock con el medio usado.
SET @sql = (
  SELECT IF(COUNT(*) = 0, 'ALTER TABLE retiro_lineas ADD COLUMN avisado_medio VARCHAR(40) NULL', 'SELECT 1')
  FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'retiro_lineas' AND column_name = 'avisado_medio'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

INSERT IGNORE INTO rol_permisos (rol_id, permiso, nivel)
SELECT r.id, p.permiso, p.nivel FROM roles r JOIN (
  SELECT 'gerente' rol, 'clientes.retiros.avisar' permiso, 'permitido' nivel UNION ALL
  SELECT 'administrativo', 'clientes.retiros.avisar', 'permitido' UNION ALL
  SELECT 'encargado', 'clientes.retiros.avisar', 'permitido'
) p ON p.rol = r.codigo;
