-- J3: Contable, asientos automáticos, resumidos y reprocesamiento (Contable RF04, RF14, RN14, RN28, RN29, RN34, EX08, EX18). Re-ejecutable.

-- Cada origen guarda el contenido del evento que lo generó: es lo que permite reprocesar por cambio de reglas aunque la bandeja de salida ya no lo conserve (RF14).
SET @c = (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'con_asiento_origen' AND column_name = 'contenido');
SET @s = IF(@c = 0, 'ALTER TABLE con_asiento_origen ADD COLUMN contenido MEDIUMTEXT NULL, ADD COLUMN tipo_evento VARCHAR(40) NULL, ADD COLUMN fecha_documento DATE NULL, ADD COLUMN instantanea TEXT NULL, ADD COLUMN contenido_hash CHAR(64) NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- Modo de generación por formulario: individual (un asiento por documento) o resumido (uno por día y formulario).
CREATE TABLE IF NOT EXISTS con_modos (
  formulario VARCHAR(40) NOT NULL PRIMARY KEY,
  modo       ENUM('individual', 'resumido') NOT NULL DEFAULT 'individual'
);

CREATE TABLE IF NOT EXISTS con_reprocesos (
  id          INT          AUTO_INCREMENT PRIMARY KEY,
  ms          BIGINT       NOT NULL,
  usuario_id  INT          NULL,
  desde       DATE         NULL,
  hasta       DATE         NULL,
  asientos    INT          NOT NULL,
  excluidos   TEXT         NULL
);

INSERT IGNORE INTO rol_permisos (rol_id, permiso, nivel)
SELECT r.id, p.permiso, p.nivel FROM roles r JOIN (
  SELECT 'gerente' rol, 'contable.reprocesar' permiso, 'permitido' nivel UNION ALL
  SELECT 'contador', 'contable.reprocesar', 'permitido'
) p ON p.rol = r.codigo;
