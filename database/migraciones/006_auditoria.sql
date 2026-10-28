-- Fase A6: auditoría de solo agregar y encadenada (Usuarios RF08 a RF10, RN11, RN12, RN23, EX10).
-- Cada evento guarda el hash del anterior (HMAC con una clave del servidor): alterar o borrar una
-- fila rompe la cadena y el control de integridad lo detecta. Los triggers impiden además
-- UPDATE y DELETE desde cualquier SQL. La hora es la del servidor, en milisegundos (ts_ms).
-- Nunca se guardan contraseñas ni PIN: la app los quita antes de escribir.
CREATE TABLE IF NOT EXISTS auditoria (
  id              BIGINT       NOT NULL AUTO_INCREMENT PRIMARY KEY,
  id_global       VARCHAR(40)  CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  ts_ms           BIGINT       NOT NULL,
  user_id         INT          NULL,
  username        VARCHAR(50)  NULL,
  rol             VARCHAR(30)  NULL,
  terminal_id     INT          NULL,
  ip              VARCHAR(64)  NULL,
  modulo          VARCHAR(30)  NOT NULL,
  accion          VARCHAR(60)  NOT NULL,
  resultado       ENUM('ok', 'denegado', 'error') NOT NULL DEFAULT 'ok',
  entidad         VARCHAR(40)  NULL,
  entidad_id      VARCHAR(64)  NULL,
  valor_anterior  TEXT         NULL,
  valor_nuevo     TEXT         NULL,
  detalle         VARCHAR(500) NULL,
  hash_previo     CHAR(64)     NOT NULL,
  hash            CHAR(64)     NOT NULL,
  UNIQUE KEY uq_auditoria_id_global (id_global),
  KEY idx_auditoria_ts (ts_ms),
  KEY idx_auditoria_usuario (user_id, ts_ms),
  KEY idx_auditoria_accion (modulo, accion, ts_ms),
  KEY idx_auditoria_entidad (entidad, entidad_id, ts_ms)
);

-- Último hash de la cadena. Se bloquea la fila al agregar un evento para que dos eventos
-- simultáneos no se encadenen al mismo anterior.
CREATE TABLE IF NOT EXISTS auditoria_cadena (
  id           TINYINT  NOT NULL PRIMARY KEY DEFAULT 1,
  ultimo_hash  CHAR(64) NOT NULL,
  CONSTRAINT chk_auditoria_cadena CHECK (id = 1)
);
INSERT IGNORE INTO auditoria_cadena (id, ultimo_hash) VALUES (1, REPEAT('0', 64));

DROP TRIGGER IF EXISTS auditoria_no_update;
CREATE TRIGGER auditoria_no_update BEFORE UPDATE ON auditoria FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'La auditoría es de solo agregar';
DROP TRIGGER IF EXISTS auditoria_no_delete;
CREATE TRIGGER auditoria_no_delete BEFORE DELETE ON auditoria FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'La auditoría es de solo agregar';
