-- F1: copias de seguridad y restauración (Usuarios RF11, RF12, RN13 a RN16, RN14, EX07 a EX09, EX13).
-- La copia es un archivo cifrado en el almacenamiento de la plataforma; esta tabla es su registro.
CREATE TABLE IF NOT EXISTS copias_seguridad (
  id            INT          AUTO_INCREMENT PRIMARY KEY,
  nombre        VARCHAR(120) NOT NULL,
  tipo          ENUM('manual', 'automatica', 'previa') NOT NULL DEFAULT 'manual',
  estado        ENUM('valida', 'invalida') NOT NULL DEFAULT 'valida',
  version_sistema VARCHAR(20) NOT NULL,
  modulos       VARCHAR(200) NOT NULL,
  tablas        INT          NOT NULL,
  filas         BIGINT       NOT NULL,
  bytes         BIGINT       NOT NULL,
  huella        CHAR(64)     NOT NULL,
  retenida      TINYINT(1)   NOT NULL DEFAULT 0,
  user_id       INT          NULL,
  creada_en     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_copia_nombre (nombre)
);

-- Verificador de la clave de cifrado (nunca la clave): permite avisar de una clave equivocada antes de tocar datos (EX09).
CREATE TABLE IF NOT EXISTS copias_configuracion (
  id          INT         NOT NULL PRIMARY KEY,
  salt        CHAR(32)    NOT NULL,
  verificador CHAR(64)    NOT NULL
);

INSERT IGNORE INTO parametros (clave, valor) VALUES
  ('copia_hora', '2'),
  ('copia_frecuencia_horas', '24'),
  ('copia_alerta_horas', '24'),
  ('copia_retener_diarias', '7'),
  ('copia_retener_semanales', '4'),
  ('copia_retener_mensuales', '12'),
  ('sincronizacion_fiscal_pendiente', '0');

INSERT IGNORE INTO rol_permisos (rol_id, permiso, nivel)
SELECT r.id, p.permiso, p.nivel FROM roles r JOIN (
  SELECT 'administrador' rol, 'usuarios.copias.gestionar' permiso, 'permitido' nivel
) p ON p.rol = r.codigo;
