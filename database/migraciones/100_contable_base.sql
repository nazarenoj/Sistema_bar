-- J1: Contable, instalación, inicio de la contabilidad y plan de cuentas (Contable RF01, RF13, RN01, RN03, RN09, RN18, EX10, EX11, EX12). Re-ejecutable.
-- También crea el libro (ejercicios, períodos, asientos) que usan los checkpoints siguientes.

CREATE TABLE IF NOT EXISTS con_config (
  id                          TINYINT       NOT NULL PRIMARY KEY,
  fecha_inicio                DATE          NULL,
  momento_costo_no_fiscal     VARCHAR(20)   NOT NULL DEFAULT 'movimiento',
  asiento_apertura_id         INT           NULL,
  perfil_rubro                VARCHAR(30)   NULL,
  es_casa_central             TINYINT(1)    NOT NULL DEFAULT 0,
  retencion_anios             INT           NOT NULL DEFAULT 10,
  bloquear_cierre_controles   TINYINT(1)    NOT NULL DEFAULT 0,
  iniciada_ms                 BIGINT        NULL
);
INSERT IGNORE INTO con_config (id) VALUES (1);

-- Plan de cuentas jerárquico. `clave` es el nombre semántico de la cuenta (por ejemplo «iva_debito») con el que las plantillas y las reglas por defecto la encuentran aunque cambie su código.
CREATE TABLE IF NOT EXISTS con_cuentas (
  id         INT           AUTO_INCREMENT PRIMARY KEY,
  codigo     VARCHAR(20)   CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  nombre     VARCHAR(120)  NOT NULL,
  tipo       ENUM('activo', 'pasivo', 'patrimonio', 'resultado_positivo', 'resultado_negativo') NOT NULL,
  padre_id   INT           NULL,
  imputable  TINYINT(1)    NOT NULL DEFAULT 1,
  moneda     CHAR(3)       NOT NULL DEFAULT 'ARS',
  estado     ENUM('activa', 'inactiva') NOT NULL DEFAULT 'activa',
  clave      VARCHAR(40)   NULL,
  CONSTRAINT uq_con_cuenta_codigo UNIQUE (codigo),
  CONSTRAINT fk_con_cuenta_padre FOREIGN KEY (padre_id) REFERENCES con_cuentas(id),
  KEY idx_con_cuenta_clave (clave)
);

CREATE TABLE IF NOT EXISTS con_ejercicios (
  id      INT         AUTO_INCREMENT PRIMARY KEY,
  desde   DATE        NOT NULL,
  hasta   DATE        NOT NULL,
  estado  ENUM('abierto', 'cerrado') NOT NULL DEFAULT 'abierto',
  cerrado_ms BIGINT   NULL,
  KEY idx_con_ejercicio (desde, hasta)
);
CREATE TABLE IF NOT EXISTS con_periodos (
  id            INT         AUTO_INCREMENT PRIMARY KEY,
  ejercicio_id  INT         NOT NULL,
  anio          INT         NOT NULL,
  mes           INT         NOT NULL,
  estado        ENUM('abierto', 'cerrado') NOT NULL DEFAULT 'abierto',
  cerrado_ms    BIGINT      NULL,
  cerrado_por   INT         NULL,
  CONSTRAINT uq_con_periodo UNIQUE (anio, mes),
  CONSTRAINT fk_con_periodo_ej FOREIGN KEY (ejercicio_id) REFERENCES con_ejercicios(id)
);
CREATE TABLE IF NOT EXISTS con_numeracion (
  ejercicio_id INT NOT NULL PRIMARY KEY,
  ultimo       INT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS con_asientos (
  id                 INT           AUTO_INCREMENT PRIMARY KEY,
  numero             INT           NOT NULL,
  ejercicio_id       INT           NOT NULL,
  periodo_id         INT           NOT NULL,
  fecha              DATE          NOT NULL,
  tipo               VARCHAR(20)   NOT NULL,
  leyenda            VARCHAR(255)  NOT NULL,
  estado             ENUM('registrado', 'anulado') NOT NULL DEFAULT 'registrado',
  usuario_id         INT           NULL,
  anula_id           INT           NULL,
  resumen_clave      VARCHAR(80)   NULL,
  id_solicitud       VARCHAR(80)   CHARACTER SET ascii COLLATE ascii_bin NULL,
  contenido_hash     CHAR(64)      NULL,
  config_version     INT           NULL,
  instantanea        TEXT          NULL,
  creado_ms          BIGINT        NOT NULL,
  CONSTRAINT uq_con_asiento_numero UNIQUE (ejercicio_id, numero),
  CONSTRAINT uq_con_asiento_solicitud UNIQUE (id_solicitud),
  CONSTRAINT fk_con_asiento_periodo FOREIGN KEY (periodo_id) REFERENCES con_periodos(id),
  KEY idx_con_asiento_fecha (fecha),
  KEY idx_con_asiento_resumen (resumen_clave)
);
CREATE TABLE IF NOT EXISTS con_asiento_lineas (
  id           INT           AUTO_INCREMENT PRIMARY KEY,
  asiento_id   INT           NOT NULL,
  cuenta_id    INT           NOT NULL,
  debe         DECIMAL(16,2) NOT NULL DEFAULT 0,
  haber        DECIMAL(16,2) NOT NULL DEFAULT 0,
  importe_divisa DECIMAL(16,4) NULL,
  cotizacion   DECIMAL(14,6) NULL,
  detalle      VARCHAR(160)  NULL,
  CONSTRAINT fk_con_linea_asiento FOREIGN KEY (asiento_id) REFERENCES con_asientos(id),
  CONSTRAINT fk_con_linea_cuenta FOREIGN KEY (cuenta_id) REFERENCES con_cuentas(id),
  KEY idx_con_linea_cuenta (cuenta_id)
);
-- De qué documento de qué módulo salió cada asiento; la ID_Operacion del mensaje es la clave de idempotencia (RN28).
CREATE TABLE IF NOT EXISTS con_asiento_origen (
  id              INT           AUTO_INCREMENT PRIMARY KEY,
  asiento_id      INT           NOT NULL,
  modulo          VARCHAR(30)   NOT NULL,
  tipo_documento  VARCHAR(40)   NOT NULL,
  id_documento    VARCHAR(80)   NOT NULL,
  id_operacion    VARCHAR(160)  CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  relacionado     VARCHAR(80)   NULL,
  importe         DECIMAL(16,2) NULL,
  CONSTRAINT uq_con_origen_operacion UNIQUE (id_operacion),
  CONSTRAINT fk_con_origen_asiento FOREIGN KEY (asiento_id) REFERENCES con_asientos(id),
  KEY idx_con_origen_doc (modulo, id_documento)
);
-- Movimientos con fecha anterior al inicio: no se contabilizan (EX11), quedan en este listado.
CREATE TABLE IF NOT EXISTS con_previos_inicio (
  id             INT           AUTO_INCREMENT PRIMARY KEY,
  modulo         VARCHAR(30)   NOT NULL,
  tipo_documento VARCHAR(40)   NOT NULL,
  id_documento   VARCHAR(80)   NOT NULL,
  id_operacion   VARCHAR(160)  CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  fecha          DATE          NOT NULL,
  importe        DECIMAL(16,2) NULL,
  CONSTRAINT uq_con_previo_operacion UNIQUE (id_operacion)
);

INSERT IGNORE INTO rol_permisos (rol_id, permiso, nivel)
SELECT r.id, p.permiso, p.nivel FROM roles r JOIN (
  SELECT 'gerente' rol, 'contable.ver' permiso, 'permitido' nivel UNION ALL
  SELECT 'contador', 'contable.ver', 'permitido' UNION ALL
  SELECT 'administrativo', 'contable.ver', 'permitido' UNION ALL
  SELECT 'gerente', 'contable.configurar', 'permitido' UNION ALL
  SELECT 'contador', 'contable.configurar', 'permitido' UNION ALL
  SELECT 'gerente', 'contable.plan.editar', 'permitido' UNION ALL
  SELECT 'contador', 'contable.plan.editar', 'permitido'
) p ON p.rol = r.codigo;
