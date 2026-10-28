-- B7: ARCA caído o lento (Ventas RF47, RN51, RN53, RN54, RN57). Un intento indeterminado deja su clave
-- "resolviendo" hasta consultar a ARCA por número; un trabajador lo resuelve o lo libera.
-- Re-ejecutable: un solo ALTER por tabla, condicionado a que la columna nueva no exista.

ALTER TABLE secuenciador_claves MODIFY estado ENUM('libre', 'ocupada', 'resolviendo') NOT NULL DEFAULT 'libre';

SET @sql = (
  SELECT IF(COUNT(*) = 0,
    "ALTER TABLE intento_emision
       ADD COLUMN factura_id           INT    NULL,
       ADD COLUMN consultas            INT    NOT NULL DEFAULT 0,
       ADD COLUMN proxima_consulta_ms  BIGINT NULL,
       ADD COLUMN inexistente_desde_ms BIGINT NULL,
       ADD COLUMN alertado             TINYINT(1) NOT NULL DEFAULT 0,
       ADD KEY idx_intento_pendiente (estado, proxima_consulta_ms)",
    'SELECT 1')
  FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'intento_emision' AND column_name = 'factura_id'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Ver las claves en "Resolviendo" y liberarlas (con autorización de supervisor y motivo, RN57).
INSERT IGNORE INTO rol_permisos (rol_id, permiso, nivel)
SELECT r.id, p.permiso, p.nivel FROM roles r JOIN (
  SELECT 'gerente' rol, 'facturacion.claves.ver' permiso, 'permitido' nivel UNION ALL
  SELECT 'gerente', 'facturacion.claves.resolver', 'requiere_autorizacion' UNION ALL
  SELECT 'encargado', 'facturacion.claves.ver', 'permitido' UNION ALL
  SELECT 'encargado', 'facturacion.claves.resolver', 'requiere_autorizacion'
) p ON p.rol = r.codigo;
