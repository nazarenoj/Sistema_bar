-- Fase A10: mensajería interna entre módulos (Usuarios RF25, RN48 a RN60, RN85). Todo efecto de un módulo
-- en otro viaja como mensaje: se graba en la bandeja de salida en la MISMA transacción que el documento,
-- se entrega al menos una vez y el receptor lo aplica una sola vez (por ID_Operacion).

CREATE TABLE IF NOT EXISTS mensajes_integracion (
  id                  BIGINT       NOT NULL AUTO_INCREMENT PRIMARY KEY,
  id_global           VARCHAR(40)  CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  id_operacion        VARCHAR(200) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  modulo_origen       VARCHAR(30)  NOT NULL,
  modulo_destino      VARCHAR(30)  NOT NULL,
  tipo                VARCHAR(60)  NOT NULL,
  version_esquema     SMALLINT     NOT NULL DEFAULT 1,
  doc_tipo            VARCHAR(40)  NOT NULL,
  doc_id_global       VARCHAR(40)  CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  doc_version         INT          NOT NULL DEFAULT 1,
  secuencia           INT          NOT NULL DEFAULT 1,
  ts_origen_ms        BIGINT       NOT NULL,
  user_id             INT          NULL,
  contenido           MEDIUMTEXT   NOT NULL,
  intentos            INT          NOT NULL DEFAULT 0,
  primer_intento_ms   BIGINT       NULL,
  proximo_intento_ms  BIGINT       NOT NULL,
  estado              ENUM('pendiente', 'enviado', 'confirmado', 'rechazado', 'fallido') NOT NULL DEFAULT 'pendiente',
  motivo_rechazo      VARCHAR(500) NULL,
  resultado_original  MEDIUMTEXT   NULL,
  retenido_por_orden  TINYINT(1)   NOT NULL DEFAULT 0,
  confirmado_ms       BIGINT       NULL,
  descartado          TINYINT(1)   NOT NULL DEFAULT 0,
  archivado           TINYINT(1)   NOT NULL DEFAULT 0,
  id_solicitud_origen VARCHAR(64)  NULL,
  config_version      INT          NULL,
  config_instantanea  TEXT         NULL,
  UNIQUE KEY uq_mensajes_operacion (id_operacion),
  UNIQUE KEY uq_mensajes_id_global (id_global),
  KEY idx_mensajes_despacho (estado, retenido_por_orden, proximo_intento_ms),
  KEY idx_mensajes_documento (doc_id_global, secuencia),
  KEY idx_mensajes_confirmado (estado, confirmado_ms)
);

-- Lo que cada módulo receptor ya aplicó: deduplica por ID_Operacion y por referencia externa (RN51).
CREATE TABLE IF NOT EXISTS operaciones_procesadas (
  id_operacion       VARCHAR(200) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  modulo_receptor    VARCHAR(30)  NOT NULL,
  doc_id_global      VARCHAR(40)  CHARACTER SET ascii COLLATE ascii_bin NULL,
  ts_ms              BIGINT       NOT NULL,
  resultado          MEDIUMTEXT   NULL,
  referencia_externa VARCHAR(120) NULL,
  vence_ms           BIGINT       NOT NULL,
  UNIQUE KEY uq_op_referencia (modulo_receptor, doc_id_global, referencia_externa),
  KEY idx_op_vence (vence_ms)
);

-- Bandeja de pendientes de integración (RN53, RN85): rechazados, fallidos, efectos sin origen y diferencias.
CREATE TABLE IF NOT EXISTS bandeja_pendientes (
  id                 BIGINT       NOT NULL AUTO_INCREMENT PRIMARY KEY,
  mensaje_id         BIGINT       NULL,
  causa              ENUM('rechazado', 'fallido', 'sin_origen', 'diferencia') NOT NULL,
  motivo             VARCHAR(500) NULL,
  estado             ENUM('abierto', 'reintentado', 'resuelto', 'descartado', 'aceptado') NOT NULL DEFAULT 'abierto',
  modulo_responsable VARCHAR(30)  NOT NULL,
  rol_responsable    VARCHAR(40)  NOT NULL,
  ingreso_ms         BIGINT       NOT NULL,
  limite_ms          BIGINT       NOT NULL,
  vencido            TINYINT(1)   NOT NULL DEFAULT 0,
  escalada_ms        BIGINT       NULL,
  user_accion        INT          NULL,
  accion_ms          BIGINT       NULL,
  motivo_descarte    VARCHAR(500) NULL,
  autorizante_id     INT          NULL,
  KEY idx_pendientes_estado (estado, limite_ms),
  KEY idx_pendientes_mensaje (mensaje_id)
);

-- Conciliación de integración (RN57): compara los efectos esperados con los aplicados. No corrige sola.
CREATE TABLE IF NOT EXISTS conciliaciones (
  id              BIGINT       NOT NULL AUTO_INCREMENT PRIMARY KEY,
  ts_ms           BIGINT       NOT NULL,
  tipo_ejecucion  ENUM('diaria', 'bajo_demanda') NOT NULL,
  user_id         INT          NULL,
  diferencias     INT          NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS conciliacion_diferencias (
  id               BIGINT       NOT NULL AUTO_INCREMENT PRIMARY KEY,
  conciliacion_id  BIGINT       NOT NULL,
  doc_id_global    VARCHAR(40)  CHARACTER SET ascii COLLATE ascii_bin NULL,
  modulo_efecto    VARCHAR(30)  NOT NULL,
  tipo             ENUM('efecto_faltante', 'movimiento_sin_venta', 'duplicado', 'importe_distinto', 'efecto_sin_origen') NOT NULL,
  esperado         VARCHAR(500) NULL,
  aplicado         VARCHAR(500) NULL,
  estado           ENUM('abierta', 'resuelta', 'aceptada') NOT NULL DEFAULT 'abierta',
  KEY idx_dif_conciliacion (conciliacion_id)
);

INSERT IGNORE INTO parametros (clave, valor) VALUES
  ('mensajeria_tope_horas', '24'),
  ('mensajeria_retencion_confirmados_dias', '30'),
  ('mensajeria_retencion_operaciones_dias', '90'),
  ('pendiente_plazo_horas_efectos', '24'),
  ('pendiente_plazo_horas_diferencias', '72'),
  ('conciliacion_hora', '3');

-- Permisos propios del protocolo (RF02): propuesta inicial editable.
INSERT IGNORE INTO rol_permisos (rol_id, permiso, nivel)
SELECT r.id, p.permiso, p.nivel FROM roles r JOIN (
  SELECT 'gerente' rol, 'integracion.pendientes.ver' permiso, 'permitido' nivel UNION ALL
  SELECT 'gerente', 'integracion.pendientes.reintentar', 'permitido' UNION ALL
  SELECT 'gerente', 'integracion.pendientes.descartar', 'requiere_autorizacion' UNION ALL
  SELECT 'gerente', 'integracion.conciliar', 'permitido' UNION ALL
  SELECT 'deposito', 'integracion.pendientes.ver', 'permitido' UNION ALL
  SELECT 'encargado', 'integracion.pendientes.ver', 'permitido'
) p ON p.rol = r.codigo;
