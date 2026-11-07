-- G5: reapertura autorizada de un turno cerrado (Financiero RF18, RN07, RN43, EX14, EX32).
-- Re-ejecutable: la columna se agrega solo si falta.

SET @sql = (
  SELECT IF(COUNT(*) = 0,
    'ALTER TABLE fin_cierres ADD COLUMN compensado TINYINT(1) NOT NULL DEFAULT 0',
    'SELECT 1')
  FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'fin_cierres' AND column_name = 'compensado'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Cada reapertura con su motivo, quien la pidió y quien la autorizó. El cierre anterior no se borra: queda en fin_cierres (RF18).
CREATE TABLE IF NOT EXISTS fin_reaperturas (
  id                  INT          AUTO_INCREMENT PRIMARY KEY,
  turno_id            INT          NOT NULL,
  version_cierre      INT          NOT NULL,
  motivo              VARCHAR(255) NOT NULL,
  user_id             INT          NOT NULL,
  autorizante_id      INT          NOT NULL,
  cierre_anterior_ms  BIGINT       NOT NULL,
  ts_ms               BIGINT       NOT NULL,
  CONSTRAINT fk_fin_reapertura_turno FOREIGN KEY (turno_id) REFERENCES fin_turnos(id),
  KEY idx_fin_reapertura_turno (turno_id)
);

INSERT IGNORE INTO rol_permisos (rol_id, permiso, nivel)
SELECT r.id, p.permiso, p.nivel FROM roles r JOIN (
  SELECT 'gerente' rol, 'financiero.turnos.reabrir' permiso, 'permitido' nivel UNION ALL
  SELECT 'encargado', 'financiero.turnos.reabrir', 'permitido'
) p ON p.rol = r.codigo;
