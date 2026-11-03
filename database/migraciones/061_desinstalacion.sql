-- F9: desinstalación de módulos por etapas (Usuarios RN87, EX59). Instalado -> En desinstalación -> (resolver pendientes) -> desinstalado.
-- Un módulo "en desinstalación" sigue en la tabla pero ya no cuenta como instalado: no recibe llamadas ni mensajes nuevos.
SET @sql = (
  SELECT IF(COUNT(*) = 0, "ALTER TABLE modulos_instalados ADD COLUMN estado ENUM('instalado', 'en_desinstalacion') NOT NULL DEFAULT 'instalado', ADD COLUMN desinstalacion_desde DATETIME NULL, ADD COLUMN desinstalacion_user INT NULL", 'SELECT 1')
  FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'modulos_instalados' AND column_name = 'estado'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Lo que no se resuelve dentro de este plazo pasa a la Bandeja de pendientes con responsable (RN85).
INSERT IGNORE INTO parametros (clave, valor) VALUES ('desinstalacion_plazo_horas', '24');
