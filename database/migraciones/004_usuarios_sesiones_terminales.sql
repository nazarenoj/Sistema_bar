-- Fase A4: usuarios completos (alta/baja lógica, PIN, tarjeta, bloqueo por intentos, cambio de
-- contraseña obligatorio), sesiones en el servidor, terminales y parámetros ajustables.

-- Usuarios. El PIN y el código de tarjeta se guardan como HMAC-SHA256 (hex, 64 caracteres) con una
-- clave del servidor: es irreversible y determinista, así el PIN identifica al usuario sin pedir su
-- nombre y la restricción UNIQUE garantiza que no se repita (Usuarios RN02). Varias filas pueden
-- tener NULL.
-- Re-ejecutable: el ALTER solo corre si todavía no se agregaron las columnas (ver 002).
SET @sql = (
  SELECT IF(COUNT(*) = 0,
    'ALTER TABLE users
  ADD COLUMN nombre                VARCHAR(100) NULL,
  ADD COLUMN email                 VARCHAR(150) NULL,
  ADD COLUMN pin_hash              CHAR(64)     NULL,
  ADD COLUMN tarjeta_hash          CHAR(64)     NULL,
  ADD COLUMN activo                TINYINT(1)   NOT NULL DEFAULT 1,
  ADD COLUMN fecha_baja            DATE         NULL,
  ADD COLUMN debe_cambiar_password TINYINT(1)   NOT NULL DEFAULT 0,
  ADD COLUMN intentos_fallidos     INT          NOT NULL DEFAULT 0,
  ADD COLUMN bloqueado_hasta       DATETIME     NULL,
  ADD COLUMN ultimo_login          DATETIME     NULL,
  ADD UNIQUE KEY uq_users_pin (pin_hash),
  ADD UNIQUE KEY uq_users_tarjeta (tarjeta_hash);',
    'SELECT 1')
  FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'users' AND column_name = 'pin_hash'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Terminales (puestos de venta y equipos). `codigo` es lo que se tipea una vez en el navegador del
-- equipo para que el servidor sepa desde dónde se actúa. inactividad_min vacío = usar el del rol.
CREATE TABLE IF NOT EXISTS terminales (
  id               INT AUTO_INCREMENT PRIMARY KEY,
  nombre           VARCHAR(60)  NOT NULL UNIQUE,
  codigo           CHAR(8)      NOT NULL UNIQUE,
  tipo             ENUM('venta', 'pantalla_cocina', 'dispositivo_movil', 'inventario', 'otro') NOT NULL DEFAULT 'venta',
  activa           TINYINT(1)   NOT NULL DEFAULT 1,
  inactividad_min  INT          NULL,
  ultimo_contacto  DATETIME     NULL,
  created_at       TIMESTAMP    DEFAULT CURRENT_TIMESTAMP
);

-- Sesiones del lado del servidor: el token solo lleva el id. `ultimo_acceso` se renueva con la
-- actividad del usuario (no con los latidos de la pantalla) y define el vencimiento por inactividad.
CREATE TABLE IF NOT EXISTS sesiones (
  id            BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id       INT          NOT NULL,
  terminal_id   INT          NULL,
  inicio        DATETIME     NOT NULL,
  ultimo_acceso DATETIME     NOT NULL,
  fin           DATETIME     NULL,
  motivo_fin    ENUM('cierre', 'inactividad', 'forzado', 'cambio_usuario') NULL,
  ip            VARCHAR(45)  NULL,
  CONSTRAINT fk_sesion_user     FOREIGN KEY (user_id)     REFERENCES users(id),
  CONSTRAINT fk_sesion_terminal FOREIGN KEY (terminal_id) REFERENCES terminales(id),
  INDEX idx_sesiones_activas (fin, user_id)
);

-- Parámetros del módulo, editables sin tocar código (Usuarios RN02 a RN04 los declaran
-- "parametrizables"). El valor se lee como texto y cada uso lo convierte.
CREATE TABLE IF NOT EXISTS parametros (
  clave VARCHAR(60)  NOT NULL PRIMARY KEY,
  valor VARCHAR(100) NOT NULL
);
INSERT IGNORE INTO parametros (clave, valor) VALUES
  ('password_min_largo',      '8'),
  ('pin_min_digitos',         '4'),
  ('intentos_max',            '5'),
  ('bloqueo_minutos',         '15'),
  ('inactividad_min_admin',   '10'),
  ('inactividad_min_empleado','10'),
  ('terminal_sin_contacto_seg','90');
