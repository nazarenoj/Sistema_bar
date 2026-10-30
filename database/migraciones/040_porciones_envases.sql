-- C15: venta por porción, envase por modalidad, modificadores que cambian el insumo y agotados automáticos
-- (Stock RF30, RF31, RF32, RF38, RN44, RN78; Ventas RN72, RN86). Re-ejecutable: ALTER condicionados a su columna centinela,
-- tablas IF NOT EXISTS, semillas con INSERT IGNORE.

-- Un lote de porciones queda vinculado al lote de la pieza de origen (RN78).
SET @sql = (
  SELECT IF(COUNT(*) = 0, 'ALTER TABLE lotes ADD COLUMN lote_origen_id BIGINT NULL', 'SELECT 1')
  FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'lotes' AND column_name = 'lote_origen_id'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Marca de agotado que pone Stock (RF32). Va aparte de la manual: informa a la cocina y nunca bloquea una venta (RN01).
SET @sql = (
  SELECT IF(COUNT(*) = 0, 'ALTER TABLE productos ADD COLUMN agotado_auto TINYINT(1) NOT NULL DEFAULT 0', 'SELECT 1')
  FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'productos' AND column_name = 'agotado_auto'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Artículo que se vende por porción de una pieza entera. Proporcional: el artículo se controla en porciones y la pieza entra como
-- N porciones. Fraccionamiento: una orden convierte piezas (otro artículo) en porciones en stock. En ambos la venta descuenta porciones.
CREATE TABLE IF NOT EXISTS porciones (
  producto_id         INT NOT NULL PRIMARY KEY,
  origen_producto_id  INT NULL,
  porciones_por_pieza INT NOT NULL,
  modalidad           ENUM('proporcional', 'fraccionamiento') NOT NULL
);

CREATE TABLE IF NOT EXISTS fraccionamientos (
  id                 INT           AUTO_INCREMENT PRIMARY KEY,
  id_global          VARCHAR(40)   CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  producto_id        INT           NOT NULL,
  origen_producto_id INT           NOT NULL,
  piezas             DECIMAL(14,3) NOT NULL,
  porciones          DECIMAL(14,3) NOT NULL,
  deposito_id        INT           NOT NULL,
  costo_porcion      DECIMAL(14,4) NULL,
  user_id            INT           NULL,
  created_at         TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_fraccionamiento_id_global UNIQUE (id_global)
);

-- Envase que se descuenta además de la receta según la modalidad del pedido (RF38). `alcance` es 'p:<producto>' o 'c:<categoría>';
-- el del artículo prevalece sobre el de la categoría. La variante es un artículo más.
CREATE TABLE IF NOT EXISTS envases_modalidad (
  id        INT           AUTO_INCREMENT PRIMARY KEY,
  alcance   VARCHAR(20)   NOT NULL,
  modalidad ENUM('salon', 'mostrador', 'para_llevar', 'delivery', 'retiro') NOT NULL,
  insumo_id INT           NOT NULL,
  cantidad  DECIMAL(12,3) NOT NULL,
  CONSTRAINT uq_envase UNIQUE (alcance, modalidad)
);

-- Qué cambia una opción de modificador de Ventas en lo que se descuenta (RF31): sustituir, agregar o quitar un insumo.
CREATE TABLE IF NOT EXISTS modificador_insumos (
  id                 INT           AUTO_INCREMENT PRIMARY KEY,
  opcion_id          VARCHAR(64)   NOT NULL,
  accion             ENUM('sustituir', 'agregar', 'quitar') NOT NULL,
  insumo_id          INT           NULL,
  cantidad           DECIMAL(12,3) NULL,
  insumo_original_id INT           NULL,
  cantidad_original  DECIMAL(12,3) NULL,
  KEY idx_modificador_opcion (opcion_id)
);

-- Artículos que Stock ya informó como agotados, para avisar solo cuando cambia (RF32).
CREATE TABLE IF NOT EXISTS item_agotado (
  producto_id INT       NOT NULL PRIMARY KEY,
  desde       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT IGNORE INTO motivos_stock (codigo, nombre, tipo, requiere_autorizacion, requiere_observacion, clase_contable, reservado) VALUES
  ('fraccionamiento',         'Fraccionamiento (pieza)',     'egreso',  0, 0, 'otra', 1),
  ('fraccionamiento_ingreso', 'Fraccionamiento (porciones)', 'ingreso', 0, 0, 'otra', 1);

INSERT IGNORE INTO parametros (clave, valor) VALUES ('agotado_umbral', '0');
