-- D9: comisiones de vendedores y su liquidación (Ventas RF40, RF41, RN38, EX28). Función VEN-COMISIONES.
-- Re-ejecutable: tablas IF NOT EXISTS, semillas con INSERT IGNORE.

-- Una regla por vendedor (usuario), por rol (mozo, barista…) o general. Tipos: porcentaje sobre la venta, porcentaje sobre el margen
-- realizado y metas escalonadas (porcentaje por tramo del acumulado del período).
CREATE TABLE IF NOT EXISTS comision_reglas (
  id          INT          AUTO_INCREMENT PRIMARY KEY,
  nombre      VARCHAR(100) NOT NULL,
  tipo        ENUM('porcentaje', 'margen', 'metas') NOT NULL,
  user_id     INT          NULL,
  rol         VARCHAR(50)  NULL,
  porcentaje  DECIMAL(5,2) NULL,
  activa      TINYINT(1)   NOT NULL DEFAULT 1,
  creada_por  INT          NULL,
  created_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_comision_regla_nombre UNIQUE (nombre)
);
CREATE TABLE IF NOT EXISTS comision_tramos (
  id        INT           AUTO_INCREMENT PRIMARY KEY,
  regla_id  INT           NOT NULL,
  desde     DECIMAL(14,2) NOT NULL,
  porcentaje DECIMAL(5,2) NOT NULL,
  CONSTRAINT fk_tramo_regla FOREIGN KEY (regla_id) REFERENCES comision_reglas(id) ON DELETE CASCADE
);

-- Liquidaciones: cerradas al generarse (no se modifican) y marcadas como pagadas después.
CREATE TABLE IF NOT EXISTS comision_liquidaciones (
  id           INT           AUTO_INCREMENT PRIMARY KEY,
  id_global    VARCHAR(40)   CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  tipo         ENUM('semanal', 'quincenal', 'mensual') NOT NULL,
  desde        DATE          NOT NULL,
  hasta        DATE          NOT NULL,
  estado       ENUM('cerrada', 'pagada', 'pagada_pendiente_registro') NOT NULL DEFAULT 'cerrada',
  total        DECIMAL(14,2) NOT NULL,
  medio_pago   VARCHAR(60)   NULL,
  pagada_at    DATETIME      NULL,
  creada_por   INT           NULL,
  created_at   TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_comision_liq_id_global UNIQUE (id_global)
);
CREATE TABLE IF NOT EXISTS comision_items (
  id              INT           AUTO_INCREMENT PRIMARY KEY,
  liquidacion_id  INT           NOT NULL,
  user_id         INT           NOT NULL,
  tipo            ENUM('venta', 'ajuste') NOT NULL,
  venta_id        INT           NOT NULL,
  devolucion_id   INT           NULL,
  regla_id        INT           NULL,
  base            DECIMAL(14,2) NOT NULL,
  costo           DECIMAL(14,2) NULL,
  comision        DECIMAL(14,2) NOT NULL,
  nota            VARCHAR(255)  NULL,
  KEY idx_ci_liq (liquidacion_id, user_id),
  KEY idx_ci_venta (venta_id),
  CONSTRAINT fk_ci_liq FOREIGN KEY (liquidacion_id) REFERENCES comision_liquidaciones(id)
);
-- Qué ventas y qué devoluciones ya entraron en alguna liquidación (cada una entra una sola vez).
CREATE TABLE IF NOT EXISTS comision_ventas (
  venta_id       INT NOT NULL PRIMARY KEY,
  liquidacion_id INT NOT NULL
);
CREATE TABLE IF NOT EXISTS comision_devoluciones (
  devolucion_id  INT NOT NULL PRIMARY KEY,
  liquidacion_id INT NOT NULL
);

-- Sin costo (RN38, RN62): "sin_comision" (con alerta) o "porcentaje" fijo sobre la venta.
INSERT IGNORE INTO parametros (clave, valor) VALUES ('comision_respaldo', 'sin_comision'), ('comision_respaldo_pct', '0');

INSERT IGNORE INTO rol_permisos (rol_id, permiso, nivel)
SELECT r.id, p.permiso, p.nivel FROM roles r JOIN (
  SELECT 'gerente' rol, 'ventas.comisiones.gestionar' permiso, 'permitido' nivel
) p ON p.rol = r.codigo;
