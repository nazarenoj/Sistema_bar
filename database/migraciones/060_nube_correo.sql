-- F8: copia en destino externo (Usuarios RF23, RN16, EX06; función USU-NUBE) y notificaciones por correo (RF24; función USU-CORREO).
-- Re-ejecutable: tablas IF NOT EXISTS, ALTER condicionados a su columna centinela, semillas con INSERT IGNORE.

SET @sql = (
  SELECT IF(COUNT(*) = 0, "ALTER TABLE copias_seguridad ADD COLUMN externa_estado ENUM('no_aplica', 'pendiente', 'enviada') NOT NULL DEFAULT 'no_aplica', ADD COLUMN externa_enviada_en DATETIME NULL, ADD COLUMN externa_intentos INT NOT NULL DEFAULT 0, ADD COLUMN externa_error VARCHAR(255) NULL", 'SELECT 1')
  FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'copias_seguridad' AND column_name = 'externa_estado'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Destino externo elegido por el cliente: una carpeta (por ejemplo un disco de red o una carpeta sincronizada) o una dirección que recibe un PUT.
-- La clave de acceso de una dirección va en el entorno (COPIAS_NUBE_TOKEN), no en la base.
CREATE TABLE IF NOT EXISTS copias_destino (
  id     INT          NOT NULL PRIMARY KEY,
  tipo   ENUM('carpeta', 'http') NOT NULL DEFAULT 'carpeta',
  ruta   VARCHAR(300) NULL,
  activo TINYINT(1)   NOT NULL DEFAULT 0
);
INSERT IGNORE INTO copias_destino (id) VALUES (1);

-- Servidor de correo de salida. La contraseña va en el entorno (CORREO_PASSWORD).
CREATE TABLE IF NOT EXISTS correo_config (
  id               INT          NOT NULL PRIMARY KEY,
  host             VARCHAR(150) NULL,
  puerto           INT          NOT NULL DEFAULT 587,
  seguro           TINYINT(1)   NOT NULL DEFAULT 0,
  usuario          VARCHAR(150) NULL,
  remitente        VARCHAR(150) NULL,
  severidad_minima ENUM('baja', 'media', 'alta', 'critica') NOT NULL DEFAULT 'alta',
  activo           TINYINT(1)   NOT NULL DEFAULT 0
);
INSERT IGNORE INTO correo_config (id) VALUES (1);

-- Roles que reciben las alertas por correo (por defecto Administrador).
CREATE TABLE IF NOT EXISTS correo_roles (
  rol_codigo VARCHAR(40) NOT NULL PRIMARY KEY
);
INSERT IGNORE INTO correo_roles (rol_codigo) VALUES ('administrador');

-- Cola de envío: sin conexión queda pendiente y se reintenta.
CREATE TABLE IF NOT EXISTS correo_cola (
  id              INT          AUTO_INCREMENT PRIMARY KEY,
  para            VARCHAR(150) NOT NULL,
  asunto          VARCHAR(200) NOT NULL,
  cuerpo          TEXT         NOT NULL,
  notificacion_id INT          NULL,
  estado          ENUM('pendiente', 'enviado', 'fallido') NOT NULL DEFAULT 'pendiente',
  intentos        INT          NOT NULL DEFAULT 0,
  proximo_intento DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  error           VARCHAR(255) NULL,
  creado_en       TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  enviado_en      DATETIME     NULL,
  KEY idx_correo_estado (estado, proximo_intento)
);
