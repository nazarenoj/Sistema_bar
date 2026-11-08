-- J8: Contable, cierre de períodos con pendientes, cierre y apertura de ejercicio, revaluación y exportación con plantillas (Contable RF09, RF10, RF12, RN08, RN12, EX05, EX07, EX09). Re-ejecutable.

-- Un pendiente aceptado al cerrar el período pasa al siguiente conservando su fecha original y el motivo (RN08).
SET @c = (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'con_pendientes' AND column_name = 'fecha_original');
SET @s = IF(@c = 0, 'ALTER TABLE con_pendientes ADD COLUMN fecha_original DATE NULL, ADD COLUMN aceptado_motivo VARCHAR(255) NULL, ADD COLUMN aceptado_ms BIGINT NULL, ADD COLUMN aceptado_por INT NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- Los asientos que generó el cierre de cada ejercicio.
CREATE TABLE IF NOT EXISTS con_cierres (
  id            INT         AUTO_INCREMENT PRIMARY KEY,
  ejercicio_id  INT         NOT NULL,
  ms            BIGINT      NOT NULL,
  usuario_id    INT         NULL,
  asiento_refundicion_id INT NULL,
  asiento_cierre_id      INT NULL,
  asiento_apertura_id    INT NULL,
  siguiente_ejercicio_id INT NULL,
  CONSTRAINT uq_con_cierre_ejercicio UNIQUE (ejercicio_id),
  CONSTRAINT fk_con_cierre_ejercicio FOREIGN KEY (ejercicio_id) REFERENCES con_ejercicios(id)
);

-- Una revaluación por período (la diferencia de cambio con la cotización de cierre).
CREATE TABLE IF NOT EXISTS con_revaluaciones (
  id          INT         AUTO_INCREMENT PRIMARY KEY,
  periodo_id  INT         NOT NULL,
  asiento_id  INT         NULL,
  ms          BIGINT      NOT NULL,
  usuario_id  INT         NULL,
  cotizaciones TEXT       NULL,
  CONSTRAINT uq_con_revaluacion_periodo UNIQUE (periodo_id),
  CONSTRAINT fk_con_reval_periodo FOREIGN KEY (periodo_id) REFERENCES con_periodos(id)
);

-- Plantillas de exportación a los formatos de otros sistemas contables: orden de columnas, separadores y equivalencia de códigos de cuenta.
CREATE TABLE IF NOT EXISTS con_plantillas (
  id            INT          AUTO_INCREMENT PRIMARY KEY,
  nombre        VARCHAR(80)  NOT NULL,
  separador     VARCHAR(4)   NOT NULL DEFAULT ';',
  decimal_sep   CHAR(1)      NOT NULL DEFAULT ',',
  formato_fecha VARCHAR(10)  NOT NULL DEFAULT 'dmy',
  encabezado    TINYINT(1)   NOT NULL DEFAULT 1,
  columnas      TEXT         NOT NULL,
  equivalencias MEDIUMTEXT   NOT NULL,
  activa        TINYINT(1)   NOT NULL DEFAULT 1,
  CONSTRAINT uq_con_plantilla_nombre UNIQUE (nombre)
);

INSERT IGNORE INTO rol_permisos (rol_id, permiso, nivel)
SELECT r.id, p.permiso, p.nivel FROM roles r JOIN (
  SELECT 'gerente' rol, 'contable.ejercicio.cerrar' permiso, 'permitido' nivel UNION ALL
  SELECT 'contador', 'contable.ejercicio.cerrar', 'permitido' UNION ALL
  SELECT 'gerente', 'contable.revaluacion.registrar', 'permitido' UNION ALL
  SELECT 'contador', 'contable.revaluacion.registrar', 'permitido' UNION ALL
  SELECT 'gerente', 'contable.plantillas.editar', 'permitido' UNION ALL
  SELECT 'contador', 'contable.plantillas.editar', 'permitido' UNION ALL
  SELECT 'gerente', 'contable.pendientes.aceptar', 'requiere_autorizacion' UNION ALL
  SELECT 'contador', 'contable.pendientes.aceptar', 'requiere_autorizacion'
) p ON p.rol = r.codigo;
