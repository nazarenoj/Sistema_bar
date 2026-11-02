-- D1: modificadores y opciones del producto (Ventas RF30, RN41, EX31). Función VEN-MODIF.
-- Re-ejecutable: todo IF NOT EXISTS.

-- Un grupo (tipo de leche, extras, punto de cocción…) con mínimo y máximo de opciones. Obligatorio exige al menos una.
CREATE TABLE IF NOT EXISTS grupos_modificador (
  id          INT          AUTO_INCREMENT PRIMARY KEY,
  nombre      VARCHAR(80)  NOT NULL,
  obligatorio TINYINT(1)   NOT NULL DEFAULT 0,
  minimo      INT          NOT NULL DEFAULT 0,
  maximo      INT          NULL,
  activo      TINYINT(1)   NOT NULL DEFAULT 1,
  created_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_grupo_modificador_nombre UNIQUE (nombre)
);

-- A qué artículos o categorías se aplica el grupo.
CREATE TABLE IF NOT EXISTS grupo_modificador_alcance (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  grupo_id     INT NOT NULL,
  producto_id  INT NULL,
  categoria_id INT NULL,
  KEY idx_gma_grupo (grupo_id),
  KEY idx_gma_producto (producto_id),
  KEY idx_gma_categoria (categoria_id),
  CONSTRAINT fk_gma_grupo FOREIGN KEY (grupo_id) REFERENCES grupos_modificador(id) ON DELETE CASCADE
);

-- Cada opción ajusta el precio (suma, resta o cero).
CREATE TABLE IF NOT EXISTS opciones_modificador (
  id            INT           AUTO_INCREMENT PRIMARY KEY,
  grupo_id      INT           NOT NULL,
  nombre        VARCHAR(80)   NOT NULL,
  ajuste_precio DECIMAL(12,2) NOT NULL DEFAULT 0,
  activo        TINYINT(1)    NOT NULL DEFAULT 1,
  orden         INT           NOT NULL DEFAULT 0,
  KEY idx_opcion_grupo (grupo_id),
  CONSTRAINT fk_opcion_grupo FOREIGN KEY (grupo_id) REFERENCES grupos_modificador(id) ON DELETE CASCADE
);

-- Lo elegido en un ítem del pedido, con el nombre y el ajuste congelados al agregarlo (RN41, RN17).
CREATE TABLE IF NOT EXISTS pedido_item_modificadores (
  id                    INT           AUTO_INCREMENT PRIMARY KEY,
  item_id               INT           NOT NULL,
  opcion_id             INT           NOT NULL,
  grupo_id              INT           NOT NULL,
  nombre                VARCHAR(80)   NOT NULL,
  ajuste_precio_aplicado DECIMAL(12,2) NOT NULL DEFAULT 0,
  KEY idx_pim_item (item_id)
);
