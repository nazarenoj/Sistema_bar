-- F5: segundo factor de autenticación TOTP (Usuarios RF21, RN45, EX26, EX27). Función USU-2FA.
-- El secreto lo genera el servidor al enlazar; el código lo calcula la aplicación del usuario y lo valida el servidor, sin servicios externos.
CREATE TABLE IF NOT EXISTS usuario_2fa (
  user_id     INT         NOT NULL PRIMARY KEY,
  secreto     VARCHAR(64) NOT NULL,
  confirmado  TINYINT(1)  NOT NULL DEFAULT 0,
  ultimo_paso BIGINT      NULL,
  creado_en   TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_2fa_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Códigos de recuperación de un solo uso (se guarda solo su huella).
CREATE TABLE IF NOT EXISTS usuario_2fa_recuperacion (
  id          INT         AUTO_INCREMENT PRIMARY KEY,
  user_id     INT         NOT NULL,
  huella      CHAR(64)    NOT NULL,
  usado_en    DATETIME    NULL,
  KEY idx_2fa_rec (user_id, huella),
  CONSTRAINT fk_2fa_rec_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Roles a los que se exige el segundo factor (por defecto Administrador y Gerente).
CREATE TABLE IF NOT EXISTS segundo_factor_roles (
  rol_codigo VARCHAR(40) NOT NULL PRIMARY KEY
);
INSERT IGNORE INTO segundo_factor_roles (rol_codigo) VALUES ('administrador'), ('gerente');
