-- D5: pantalla de cocina y barra (Ventas RF38, RN35, RN36, EX25, EX27). Función VEN-KDS. Re-ejecutable: ALTER condicionado,
-- tablas IF NOT EXISTS, semillas con INSERT IGNORE.

-- Avance de la comanda en la pantalla; `estado` (emitida/anulada) sigue siendo el de la comanda como documento.
SET @sql = (
  SELECT IF(COUNT(*) = 0, "ALTER TABLE comandas ADD COLUMN avance ENUM('pendiente', 'en_preparacion', 'listo', 'entregado') NOT NULL DEFAULT 'pendiente', ADD KEY idx_comanda_avance (avance, sector_id)", 'SELECT 1')
  FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'comandas' AND column_name = 'avance'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Hora de cada cambio, para calcular los tiempos de preparación; retroceder queda marcado con su motivo (RN35).
CREATE TABLE IF NOT EXISTS comanda_avances (
  id          INT          AUTO_INCREMENT PRIMARY KEY,
  comanda_id  INT          NOT NULL,
  desde       ENUM('pendiente', 'en_preparacion', 'listo', 'entregado') NOT NULL,
  hasta       ENUM('pendiente', 'en_preparacion', 'listo', 'entregado') NOT NULL,
  retroceso   TINYINT(1)   NOT NULL DEFAULT 0,
  motivo      VARCHAR(255) NULL,
  user_id     INT          NULL,
  created_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_ca_comanda (comanda_id),
  CONSTRAINT fk_ca_comanda FOREIGN KEY (comanda_id) REFERENCES comandas(id)
);

-- Demora (minutos) a partir de la cual la pantalla alerta; qué pasa al vender un agotado (bloquear o advertir); segundos sin latido
-- para dar la pantalla por caída.
INSERT IGNORE INTO parametros (clave, valor) VALUES ('kds_demora_min', '10'), ('agotado_modo', 'bloquear'), ('kds_sin_contacto_seg', '60');

INSERT IGNORE INTO rol_permisos (rol_id, permiso, nivel)
SELECT r.id, p.permiso, p.nivel FROM roles r JOIN (
  SELECT 'gerente' rol, 'ventas.cocina.retroceder' permiso, 'permitido' nivel UNION ALL
  SELECT 'encargado', 'ventas.cocina.retroceder', 'permitido' UNION ALL
  SELECT 'gerente', 'ventas.agotados.marcar', 'permitido' UNION ALL
  SELECT 'encargado', 'ventas.agotados.marcar', 'permitido' UNION ALL
  SELECT 'produccion', 'ventas.agotados.marcar', 'permitido' UNION ALL
  SELECT 'gerente', 'ventas.agotados.vender', 'permitido' UNION ALL
  SELECT 'encargado', 'ventas.agotados.vender', 'permitido'
) p ON p.rol = r.codigo;
