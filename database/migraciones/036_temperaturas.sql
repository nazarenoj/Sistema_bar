-- C11: temperaturas e inocuidad (Stock RF25, EX26). Función STK-TEMP: puntos de control con rango y frecuencia, registros que
-- alertan fuera de rango o si se omiten, acción correctiva obligatoria y listas de verificación.
-- Re-ejecutable: tablas IF NOT EXISTS, semillas con INSERT IGNORE.

CREATE TABLE IF NOT EXISTS puntos_control (
  id              INT           AUTO_INCREMENT PRIMARY KEY,
  nombre          VARCHAR(100)  NOT NULL,
  tipo            ENUM('heladera', 'camara', 'freezer', 'vitrina', 'otro') NOT NULL DEFAULT 'heladera',
  rango_min       DECIMAL(6,2)  NOT NULL,
  rango_max       DECIMAL(6,2)  NOT NULL,
  frecuencia_horas DECIMAL(6,2) NOT NULL DEFAULT 12,
  activo          TINYINT(1)    NOT NULL DEFAULT 1,
  created_at      TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_punto_control_nombre UNIQUE (nombre)
);

CREATE TABLE IF NOT EXISTS registros_temperatura (
  id              BIGINT        AUTO_INCREMENT PRIMARY KEY,
  id_global       VARCHAR(40)   CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  punto_id        INT           NOT NULL,
  valor           DECIMAL(6,2)  NOT NULL,
  fuera_de_rango  TINYINT(1)    NOT NULL DEFAULT 0,
  origen          ENUM('terminal', 'app') NOT NULL DEFAULT 'terminal',
  user_id         INT           NULL,
  created_at      TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  accion_estado   ENUM('no_requiere', 'pendiente', 'cargada') NOT NULL DEFAULT 'no_requiere',
  accion_tipo     ENUM('mover_mercaderia', 'egreso_vencimiento', 'retiro_lote', 'otra') NULL,
  accion_detalle  VARCHAR(255)  NULL,
  accion_user_id  INT           NULL,
  accion_at       DATETIME      NULL,
  CONSTRAINT uq_registro_temp_id_global UNIQUE (id_global),
  CONSTRAINT fk_registro_punto FOREIGN KEY (punto_id) REFERENCES puntos_control(id),
  KEY idx_registro_punto (punto_id, created_at),
  KEY idx_registro_pendiente (accion_estado)
);

CREATE TABLE IF NOT EXISTS listas_verificacion (
  id      INT          AUTO_INCREMENT PRIMARY KEY,
  nombre  VARCHAR(100) NOT NULL,
  tipo    ENUM('limpieza', 'recepcion', 'otra') NOT NULL DEFAULT 'otra',
  items   TEXT         NOT NULL,
  activo  TINYINT(1)   NOT NULL DEFAULT 1,
  CONSTRAINT uq_lista_verificacion_nombre UNIQUE (nombre)
);

CREATE TABLE IF NOT EXISTS verificaciones (
  id          BIGINT       AUTO_INCREMENT PRIMARY KEY,
  lista_id    INT          NOT NULL,
  user_id     INT          NULL,
  respuestas  TEXT         NOT NULL,
  completa    TINYINT(1)   NOT NULL,
  origen      ENUM('terminal', 'app') NOT NULL DEFAULT 'terminal',
  created_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_verificacion_lista FOREIGN KEY (lista_id) REFERENCES listas_verificacion(id)
);

INSERT IGNORE INTO rol_permisos (rol_id, permiso, nivel)
SELECT r.id, p.permiso, p.nivel FROM roles r JOIN (
  SELECT 'gerente' rol, 'stock.temperaturas.registrar' permiso, 'permitido' nivel UNION ALL
  SELECT 'encargado', 'stock.temperaturas.registrar', 'permitido' UNION ALL
  SELECT 'deposito', 'stock.temperaturas.registrar', 'permitido' UNION ALL
  SELECT 'produccion', 'stock.temperaturas.registrar', 'permitido' UNION ALL
  SELECT 'gerente', 'stock.temperaturas.configurar', 'permitido' UNION ALL
  SELECT 'encargado', 'stock.temperaturas.configurar', 'permitido'
) p ON p.rol = r.codigo;
