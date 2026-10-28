-- Fase A8: funciones activables y perfiles de rubro (Usuarios RF18, RN24 a RN30, RN46, RN74 a RN78).
-- El catálogo de funciones vive en el código (src/funciones/catalogo.js); acá queda el estado de cada
-- una en la instancia, la Version_Configuracion y el historial de cambios. Re-ejecutable.

-- Versión de configuración vigente: sube de a uno con cada cambio confirmado y nunca retrocede.
SET @sql = (SELECT IF(COUNT(*) = 0,
  'ALTER TABLE configuracion_instancia ADD COLUMN version_configuracion INT NOT NULL DEFAULT 0',
  'SELECT 1') FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'configuracion_instancia' AND column_name = 'version_configuracion');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Estado deseado de cada función. Una función de un módulo no instalado conserva acá su valor y se
-- muestra Deshabilitada (RN32). Las que no tienen fila toman el valor base del catálogo.
CREATE TABLE IF NOT EXISTS estado_funcionalidades (
  funcion_id VARCHAR(40) NOT NULL PRIMARY KEY,
  activa     TINYINT(1)  NOT NULL
);

-- Cada cambio confirmado (un interruptor, una cascada, un perfil, un módulo): quién, cuándo, el origen,
-- qué funciones cambiaron (anterior y nuevo) y el estado completo resultante (RN74).
CREATE TABLE IF NOT EXISTS version_configuracion (
  version  INT         NOT NULL PRIMARY KEY,
  ts_ms    BIGINT      NOT NULL,
  user_id  INT         NULL,
  username VARCHAR(50) NULL,
  origen   ENUM('alta', 'pantalla', 'perfil', 'modulo') NOT NULL,
  cambios  TEXT        NOT NULL,
  estado   TEXT        NOT NULL
);

-- Instantánea de funciones con la que se abrió cada pedido (RN75).
SET @sql = (SELECT IF(COUNT(*) = 0,
  'ALTER TABLE pedidos ADD COLUMN config_version INT NULL, ADD COLUMN config_instantanea TEXT NULL',
  'SELECT 1') FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'pedidos' AND column_name = 'config_version');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

INSERT IGNORE INTO parametros (clave, valor) VALUES
  ('autorizacion_admin_funciones_sanitarias', '1'),
  ('restauracion_en_curso', '0');
