-- B1: catálogo de Ventas. Tipos de producto, categorías, sectores de comanda, IVA, SKU y código de
-- barras únicos, agotado manual, pesables (tara, mínimo, máximo), variantes y combos.
-- Re-ejecutable: cada columna se agrega solo si no existe (el DDL de MySQL no es transaccional).

CREATE TABLE IF NOT EXISTS categorias_producto (
  id     INT          AUTO_INCREMENT PRIMARY KEY,
  nombre VARCHAR(100) NOT NULL,
  activa TINYINT(1)   NOT NULL DEFAULT 1,
  CONSTRAINT uq_categoria_nombre UNIQUE (nombre)
);

CREATE TABLE IF NOT EXISTS sectores_comanda (
  id     INT          AUTO_INCREMENT PRIMARY KEY,
  nombre VARCHAR(100) NOT NULL,
  activo TINYINT(1)   NOT NULL DEFAULT 1,
  CONSTRAINT uq_sector_nombre UNIQUE (nombre)
);

-- Un combo se arma con otros productos (Ventas RN03: sin ciclos y de profundidad máxima 3, se valida en la app).
CREATE TABLE IF NOT EXISTS producto_componentes (
  id            INT           AUTO_INCREMENT PRIMARY KEY,
  combo_id      INT           NOT NULL,
  componente_id INT           NOT NULL,
  cantidad      DECIMAL(10,3) NOT NULL,
  CONSTRAINT fk_pc_combo      FOREIGN KEY (combo_id)      REFERENCES productos(id) ON DELETE CASCADE,
  CONSTRAINT fk_pc_componente FOREIGN KEY (componente_id) REFERENCES productos(id),
  CONSTRAINT uq_pc UNIQUE (combo_id, componente_id)
);

-- Un solo ALTER (atómico) que se arma solo si la columna "tipo" no existe. Los índices únicos
-- aceptan varios NULL: SKU y código de barras son opcionales.
SET @sql = (
  SELECT IF(COUNT(*) = 0,
    "ALTER TABLE productos
       ADD COLUMN tipo             ENUM('estandar','variante','pesable','fraccionable','combo','elaborado','servicio') NOT NULL DEFAULT 'estandar',
       ADD COLUMN sku              VARCHAR(50)   NULL,
       ADD COLUMN codigo_barras    VARCHAR(50)   NULL,
       ADD COLUMN categoria_id     INT           NULL,
       ADD COLUMN sector_id        INT           NULL,
       ADD COLUMN producto_base_id INT           NULL,
       ADD COLUMN alicuota_iva     DECIMAL(4,2)  NOT NULL DEFAULT 21.00,
       ADD COLUMN agotado          TINYINT(1)    NOT NULL DEFAULT 0,
       ADD COLUMN tara             DECIMAL(10,3) NULL,
       ADD COLUMN peso_minimo      DECIMAL(10,3) NULL,
       ADD COLUMN peso_maximo      DECIMAL(10,3) NULL,
       ADD CONSTRAINT uq_producto_sku           UNIQUE (sku),
       ADD CONSTRAINT uq_producto_codigo_barras UNIQUE (codigo_barras),
       ADD CONSTRAINT fk_producto_categoria     FOREIGN KEY (categoria_id)     REFERENCES categorias_producto(id),
       ADD CONSTRAINT fk_producto_sector        FOREIGN KEY (sector_id)        REFERENCES sectores_comanda(id),
       ADD CONSTRAINT fk_producto_base          FOREIGN KEY (producto_base_id) REFERENCES productos(id)",
    'SELECT 1')
  FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'productos' AND column_name = 'tipo'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
