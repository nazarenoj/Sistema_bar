-- Fase A12: Centro de Notificaciones (Usuarios RF17, RN60, EX13). Alertas con severidad y destinatarios
-- por rol. Las alimentan la mensajería y la conciliación (y, más adelante, los demás módulos).
CREATE TABLE IF NOT EXISTS notificaciones (
  id                  BIGINT       NOT NULL AUTO_INCREMENT PRIMARY KEY,
  ts_ms               BIGINT       NOT NULL,
  modulo              VARCHAR(30)  NOT NULL,
  tipo                VARCHAR(60)  NOT NULL,
  severidad           ENUM('baja', 'media', 'alta', 'critica') NOT NULL,
  mensaje             VARCHAR(500) NOT NULL,
  roles_destinatarios VARCHAR(300) NOT NULL,
  estado              ENUM('nueva', 'leida', 'resuelta') NOT NULL DEFAULT 'nueva',
  clave               VARCHAR(120) CHARACTER SET ascii COLLATE ascii_bin NULL,
  resuelta_ms         BIGINT       NULL,
  resolucion          VARCHAR(200) NULL,
  KEY idx_notif_estado (estado, severidad, ts_ms),
  KEY idx_notif_clave (clave, estado)
);

INSERT IGNORE INTO parametros (clave, valor) VALUES ('disco_alerta_porcentaje', '85');
