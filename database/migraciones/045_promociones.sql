-- D4: promociones automáticas (Ventas RF36, RF37, RN33, RN34, EX24). Función VEN-PROMOS. Re-ejecutable: tablas IF NOT EXISTS,
-- ALTER condicionado, semillas con INSERT IGNORE.

CREATE TABLE IF NOT EXISTS promociones (
  id              INT           AUTO_INCREMENT PRIMARY KEY,
  nombre          VARCHAR(100)  NOT NULL,
  tipo            ENUM('2x1', 'combo_precio', 'cantidad', 'forma_pago', 'horario', 'categoria') NOT NULL,
  estado          ENUM('activa', 'pausada') NOT NULL DEFAULT 'activa',
  prioridad       INT           NOT NULL DEFAULT 100,
  acumulable      TINYINT(1)    NOT NULL DEFAULT 0,
  tope            DECIMAL(12,2) NULL,
  porcentaje      DECIMAL(5,2)  NULL,
  precio_cerrado  DECIMAL(12,2) NULL,
  cantidad_minima INT           NULL,
  forma_pago      VARCHAR(40)   NULL,
  vigente_desde   DATE          NULL,
  vigente_hasta   DATE          NULL,
  dias_semana     VARCHAR(20)   NULL,
  hora_desde      TIME          NULL,
  hora_hasta      TIME          NULL,
  creada_por      INT           NULL,
  created_at      TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_promocion_nombre UNIQUE (nombre)
);

-- A qué artículos o categorías alcanza (en un combo a precio cerrado, `cantidad` es cuántas unidades de cada artículo lleva).
CREATE TABLE IF NOT EXISTS promocion_items (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  promocion_id INT NOT NULL,
  producto_id  INT NULL,
  categoria_id INT NULL,
  cantidad     INT NOT NULL DEFAULT 1,
  KEY idx_pi_promocion (promocion_id),
  CONSTRAINT fk_pi_promocion FOREIGN KEY (promocion_id) REFERENCES promociones(id) ON DELETE CASCADE
);

-- Cada promoción aplicada, prorrateada por línea (Importe_Descuento); `clave` agrupa lo aplicado en un mismo cobro.
CREATE TABLE IF NOT EXISTS promociones_aplicadas (
  id           INT           AUTO_INCREMENT PRIMARY KEY,
  clave        VARCHAR(80)   NOT NULL,
  promocion_id INT           NOT NULL,
  nombre       VARCHAR(100)  NOT NULL,
  pedido_id    INT           NOT NULL,
  item_id      INT           NOT NULL,
  importe      DECIMAL(12,2) NOT NULL,
  created_at   TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_pa_promocion (promocion_id),
  KEY idx_pa_pedido (pedido_id)
);

SET @sql = (
  SELECT IF(COUNT(*) = 0, 'ALTER TABLE pedido_productos ADD COLUMN importe_descuento DECIMAL(12,2) NOT NULL DEFAULT 0', 'SELECT 1')
  FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'pedido_productos' AND column_name = 'importe_descuento'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

INSERT IGNORE INTO rol_permisos (rol_id, permiso, nivel)
SELECT r.id, p.permiso, p.nivel FROM roles r JOIN (
  SELECT 'gerente' rol, 'ventas.promociones.gestionar' permiso, 'permitido' nivel UNION ALL
  SELECT 'gerente', 'ventas.promociones.bajo_costo', 'permitido' UNION ALL
  SELECT 'encargado', 'ventas.promociones.gestionar', 'requiere_autorizacion'
) p ON p.rol = r.codigo;
