-- Fase A9: idempotencia de solicitudes (Usuarios RF25, RN69 a RN73, EX47 a EX49). Cada operación con
-- efecto lleva una ID_Solicitud generada por quien la origina; acá se guarda con la huella del
-- contenido y el resultado, para devolver el original ante un reintento sin repetir el efecto.
CREATE TABLE IF NOT EXISTS solicitudes_procesadas (
  id_solicitud   VARCHAR(64)  CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  tipo_operacion VARCHAR(120) NOT NULL,
  huella         CHAR(64)     NOT NULL,
  estado         ENUM('en_proceso', 'procesada', 'rechazada') NOT NULL,
  status_http    SMALLINT     NULL,
  resultado      MEDIUMTEXT   NULL,
  user_id        INT          NULL,
  terminal_id    INT          NULL,
  creada_ms      BIGINT       NOT NULL,
  vence_ms       BIGINT       NOT NULL,
  KEY idx_solicitudes_vence (vence_ms)
);

INSERT IGNORE INTO parametros (clave, valor) VALUES ('retencion_solicitudes_dias', '90');
