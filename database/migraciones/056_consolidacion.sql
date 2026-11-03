-- F4: consolidación de sucursales (Usuarios RF20, RN38 a RN44, EX20 a EX25, EX35; Ventas RF46, RN48; Stock RF34). Función USU-CONSOL.
-- Cada sucursal es una instancia independiente: publica paquetes agregados y firmados (Ed25519); la Casa Central los importa de solo lectura.

-- Marca de la instancia (Sucursal, Casa Central o ambas) y su par de claves para firmar.
CREATE TABLE IF NOT EXISTS consolidacion_config (
  id             INT        NOT NULL PRIMARY KEY,
  es_sucursal    TINYINT(1) NOT NULL DEFAULT 0,
  es_casa_central TINYINT(1) NOT NULL DEFAULT 0,
  clave_publica  TEXT       NULL,
  clave_privada  TEXT       NULL,
  destino_url    VARCHAR(300) NULL
);
INSERT IGNORE INTO consolidacion_config (id) VALUES (1);

-- Paquetes que esta instancia publica. Un período corregido es una versión mayor; el envío automático reintenta hasta confirmarse.
CREATE TABLE IF NOT EXISTS paquetes_publicados (
  id          INT          AUTO_INCREMENT PRIMARY KEY,
  id_paquete  VARCHAR(120) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  modulo      VARCHAR(20)  NOT NULL,
  periodo     DATE         NOT NULL,
  version     INT          NOT NULL,
  huella      CHAR(64)     NOT NULL,
  sobre       MEDIUMTEXT   NOT NULL,
  enviado_en  DATETIME     NULL,
  intentos    INT          NOT NULL DEFAULT 0,
  ultimo_error VARCHAR(255) NULL,
  creado_en   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_paquete_publicado UNIQUE (id_paquete),
  CONSTRAINT uq_paquete_periodo UNIQUE (modulo, periodo, version)
);

-- Registro de sucursales (en la Casa Central).
CREATE TABLE IF NOT EXISTS sucursales (
  id            INT          AUTO_INCREMENT PRIMARY KEY,
  codigo        VARCHAR(10)  NOT NULL,
  nombre        VARCHAR(80)  NOT NULL,
  clave_publica TEXT         NOT NULL,
  modulos       VARCHAR(100) NOT NULL,
  activa        TINYINT(1)   NOT NULL DEFAULT 1,
  desde         DATE         NOT NULL,
  creada_en     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_sucursal_codigo UNIQUE (codigo)
);

-- Paquetes recibidos: separados de los datos operativos y sin edición del contenido (RN40). Los rechazados quedan registrados (EX20).
CREATE TABLE IF NOT EXISTS paquetes_recibidos (
  id            INT          AUTO_INCREMENT PRIMARY KEY,
  id_paquete    VARCHAR(120) CHARACTER SET ascii COLLATE ascii_bin NULL,
  sucursal      VARCHAR(10)  NULL,
  modulo        VARCHAR(20)  NULL,
  periodo       DATE         NULL,
  version       INT          NULL,
  huella        CHAR(64)     NULL,
  version_sistema VARCHAR(20) NULL,
  contenido     MEDIUMTEXT   NULL,
  sobre         MEDIUMTEXT   NULL,
  estado        ENUM('importado', 'reemplazado', 'rechazado', 'pendiente_version') NOT NULL,
  motivo        VARCHAR(255) NULL,
  sin_informe   TINYINT(1)   NOT NULL DEFAULT 0,
  recibido_en   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_recibido_clave (sucursal, modulo, periodo, estado),
  KEY idx_recibido_id (id_paquete)
);
DROP TRIGGER IF EXISTS paquetes_recibidos_no_editar;
CREATE TRIGGER paquetes_recibidos_no_editar BEFORE UPDATE ON paquetes_recibidos FOR EACH ROW
  IF NOT (NEW.contenido <=> OLD.contenido) OR NOT (NEW.huella <=> OLD.huella) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Los paquetes importados son de solo lectura'; END IF;
DROP TRIGGER IF EXISTS paquetes_recibidos_no_borrar;
CREATE TRIGGER paquetes_recibidos_no_borrar BEFORE DELETE ON paquetes_recibidos FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Los paquetes importados son de solo lectura';

-- Un paquete es faltante si no llegó dentro de estas horas posteriores al fin del período (RN42).
INSERT IGNORE INTO parametros (clave, valor) VALUES ('consolidacion_faltante_horas', '48');

INSERT IGNORE INTO rol_permisos (rol_id, permiso, nivel)
SELECT r.id, p.permiso, p.nivel FROM roles r JOIN (
  SELECT 'gerente' rol, 'usuarios.consolidacion.ver' permiso, 'permitido' nivel
) p ON p.rol = r.codigo;
