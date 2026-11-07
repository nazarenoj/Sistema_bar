-- G3: turnos de servicio y turnos de caja (Financiero RF03, RN03, RN04, RN39, EX01, EX02).
-- Re-ejecutable.

CREATE TABLE IF NOT EXISTS fin_turnos_servicio (
  id      INT         AUTO_INCREMENT PRIMARY KEY,
  nombre  VARCHAR(40) NOT NULL,
  desde   TIME        NOT NULL,
  hasta   TIME        NOT NULL,
  activo  TINYINT(1)  NOT NULL DEFAULT 1,
  CONSTRAINT uq_fin_turno_servicio UNIQUE (nombre)
);
INSERT IGNORE INTO fin_turnos_servicio (nombre, desde, hasta) VALUES ('Mañana', '06:00:00', '14:00:00'), ('Tarde', '14:00:00', '23:00:00');

-- Un turno de caja: una caja, un usuario, una terminal y un turno de servicio. `cuenta_abierta` repite el id de la caja mientras el turno está
-- abierto y es NULL cuando se cierra: su índice único garantiza un solo turno abierto por caja (RN03) aunque dos terminales abran a la vez.
CREATE TABLE IF NOT EXISTS fin_turnos (
  id                  INT           AUTO_INCREMENT PRIMARY KEY,
  id_global           VARCHAR(40)   CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  cuenta_id           INT           NOT NULL,
  user_id             INT           NOT NULL,
  terminal_id         INT           NULL,
  turno_servicio_id   INT           NULL,
  estado              ENUM('abierto', 'cerrado') NOT NULL DEFAULT 'abierto',
  cuenta_abierta      INT           NULL,
  fondo_apertura      DECIMAL(14,2) NOT NULL,
  fondo_propuesto     DECIMAL(14,2) NOT NULL DEFAULT 0,
  abierto_ms          BIGINT        NOT NULL,
  cerrado_ms          BIGINT        NULL,
  version_config      INT           NULL,
  funciones           VARCHAR(200)  NULL,
  reaperturas         INT           NOT NULL DEFAULT 0,
  created_at          TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_fin_turno_id_global UNIQUE (id_global),
  CONSTRAINT uq_fin_turno_abierto UNIQUE (cuenta_abierta),
  CONSTRAINT fk_fin_turno_cuenta FOREIGN KEY (cuenta_id) REFERENCES fin_cuentas(id),
  CONSTRAINT fk_fin_turno_servicio FOREIGN KEY (turno_servicio_id) REFERENCES fin_turnos_servicio(id),
  KEY idx_fin_turno_cuenta (cuenta_id, abierto_ms),
  KEY idx_fin_turno_terminal (terminal_id)
);

INSERT IGNORE INTO rol_permisos (rol_id, permiso, nivel)
SELECT r.id, p.permiso, p.nivel FROM roles r JOIN (
  SELECT 'gerente' rol, 'financiero.turnos.operar' permiso, 'permitido' nivel UNION ALL
  SELECT 'encargado', 'financiero.turnos.operar', 'permitido' UNION ALL
  SELECT 'cajero', 'financiero.turnos.operar', 'permitido' UNION ALL
  SELECT 'gerente', 'financiero.movimientos.registrar', 'permitido' UNION ALL
  SELECT 'encargado', 'financiero.movimientos.registrar', 'permitido' UNION ALL
  SELECT 'cajero', 'financiero.movimientos.registrar', 'requiere_autorizacion'
) p ON p.rol = r.codigo;
