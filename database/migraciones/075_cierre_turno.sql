-- G4: arqueo y cierre de turno (Financiero RF04, RF28, RN05, RN06, RN41, EX03, EX29).
-- Re-ejecutable: la columna se agrega solo si falta.

SET @sql = (
  SELECT IF(COUNT(*) = 0,
    'ALTER TABLE fin_movimientos ADD COLUMN terminal_id INT NULL, ADD KEY idx_fin_mov_terminal (terminal_id, fecha_ms)',
    'SELECT 1')
  FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'fin_movimientos' AND column_name = 'terminal_id'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Arqueos parciales: se cuenta la caja sin cerrar el turno (RF04).
CREATE TABLE IF NOT EXISTS fin_arqueos (
  id          INT           AUTO_INCREMENT PRIMARY KEY,
  turno_id    INT           NOT NULL,
  user_id     INT           NULL,
  contado     DECIMAL(14,2) NOT NULL,
  teorico     DECIMAL(14,2) NOT NULL,
  diferencia  DECIMAL(14,2) NOT NULL,
  nota        VARCHAR(255)  NULL,
  ts_ms       BIGINT        NOT NULL,
  CONSTRAINT fk_fin_arqueo_turno FOREIGN KEY (turno_id) REFERENCES fin_turnos(id),
  KEY idx_fin_arqueo_turno (turno_id)
);

-- Un cierre por cada vez que se cierra el turno (la reapertura de G5 suma otro): el anterior se conserva en el historial (RF18).
CREATE TABLE IF NOT EXISTS fin_cierres (
  id                      INT           AUTO_INCREMENT PRIMARY KEY,
  turno_id                INT           NOT NULL,
  version                 INT           NOT NULL DEFAULT 1,
  user_id                 INT           NULL,
  ciego                   TINYINT(1)    NOT NULL DEFAULT 0,
  conteo                  TEXT          NULL,
  teorico                 DECIMAL(14,2) NOT NULL,
  contado                 DECIMAL(14,2) NOT NULL,
  diferencia              DECIMAL(14,2) NOT NULL,
  pendientes_importe      DECIMAL(14,2) NOT NULL DEFAULT 0,
  diferencia_evaluada     DECIMAL(14,2) NOT NULL DEFAULT 0,
  tolerancia              DECIMAL(12,2) NOT NULL DEFAULT 0,
  motivo                  VARCHAR(255)  NULL,
  autorizante_id          INT           NULL,
  pendientes              TEXT          NULL,
  pendientes_no_verificados TINYINT(1)  NOT NULL DEFAULT 0,
  fondo_siguiente         DECIMAL(14,2) NOT NULL DEFAULT 0,
  traslado_importe        DECIMAL(14,2) NOT NULL DEFAULT 0,
  movimiento_id           BIGINT        NULL,
  cerrado_ms              BIGINT        NOT NULL,
  CONSTRAINT uq_fin_cierre UNIQUE (turno_id, version),
  CONSTRAINT fk_fin_cierre_turno FOREIGN KEY (turno_id) REFERENCES fin_turnos(id)
);

INSERT IGNORE INTO rol_permisos (rol_id, permiso, nivel)
SELECT r.id, p.permiso, p.nivel FROM roles r JOIN (
  SELECT 'gerente' rol, 'financiero.diferencias.autorizar' permiso, 'permitido' nivel UNION ALL
  SELECT 'encargado', 'financiero.diferencias.autorizar', 'permitido'
) p ON p.rol = r.codigo;
