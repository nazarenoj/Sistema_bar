-- J4: Contable, pendientes de imputar y asientos manuales (Contable RF05, RF15, RN04, RN08, RN13, RN29, RN30, RN33, EX02, EX03, EX19). Re-ejecutable.

SET @c = (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'con_config' AND column_name = 'responsable_id');
SET @s = IF(@c = 0, 'ALTER TABLE con_config ADD COLUMN responsable_id INT NULL, ADD COLUMN plazo_pendientes_dias INT NOT NULL DEFAULT 5', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- Un movimiento que no pudo contabilizarse (sin regla, o a la espera de su documento original). El mensaje de integración sigue su camino; este listado es del responsable contable.
CREATE TABLE IF NOT EXISTS con_pendientes (
  id             INT           AUTO_INCREMENT PRIMARY KEY,
  id_operacion   VARCHAR(160)  CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  modulo         VARCHAR(30)   NOT NULL,
  tipo_evento    VARCHAR(40)   NOT NULL,
  id_documento   VARCHAR(80)   NOT NULL,
  fecha          DATE          NOT NULL,
  importe        DECIMAL(16,2) NULL,
  motivo         ENUM('sin_regla', 'espera_original') NOT NULL,
  detalle        VARCHAR(255)  NULL,
  estado         ENUM('abierto', 'resuelto') NOT NULL DEFAULT 'abierto',
  responsable_id INT           NULL,
  plazo          DATE          NULL,
  asiento_id     INT           NULL,
  resolucion     VARCHAR(20)   NULL,
  creado_ms      BIGINT        NOT NULL,
  resuelto_ms    BIGINT        NULL,
  resuelto_por   INT           NULL,
  CONSTRAINT uq_con_pendiente_operacion UNIQUE (id_operacion),
  KEY idx_con_pendiente_estado (estado)
);

-- Modelos de asiento reutilizables y recurrentes (alquiler, amortizaciones).
CREATE TABLE IF NOT EXISTS con_modelos (
  id           INT          AUTO_INCREMENT PRIMARY KEY,
  nombre       VARCHAR(80)  NOT NULL,
  leyenda      VARCHAR(200) NOT NULL,
  lineas       TEXT         NOT NULL,
  recurrente   TINYINT(1)   NOT NULL DEFAULT 0,
  dia_mes      TINYINT      NULL,
  desde        DATE         NULL,
  hasta        DATE         NULL,
  activo       TINYINT(1)   NOT NULL DEFAULT 1,
  CONSTRAINT uq_con_modelo_nombre UNIQUE (nombre)
);

INSERT IGNORE INTO rol_permisos (rol_id, permiso, nivel)
SELECT r.id, p.permiso, p.nivel FROM roles r JOIN (
  SELECT 'gerente' rol, 'contable.asientos.crear' permiso, 'permitido' nivel UNION ALL
  SELECT 'contador', 'contable.asientos.crear', 'permitido' UNION ALL
  SELECT 'gerente', 'contable.asientos.anular', 'permitido' UNION ALL
  SELECT 'contador', 'contable.asientos.anular', 'permitido' UNION ALL
  SELECT 'gerente', 'contable.pendientes.resolver', 'permitido' UNION ALL
  SELECT 'contador', 'contable.pendientes.resolver', 'permitido' UNION ALL
  SELECT 'administrativo', 'contable.pendientes.resolver', 'permitido'
) p ON p.rol = r.codigo;
