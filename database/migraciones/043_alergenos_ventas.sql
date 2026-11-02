-- D2: alérgenos en Ventas (RF31, RN42). Función VEN-ALERGENOS. Ventas lleva su propia lista y sus declaraciones (funciona sin Stock);
-- con Stock y STK-ALERGENOS suma los derivados por receta. Re-ejecutable: tablas IF NOT EXISTS, ALTER condicionado, semillas con INSERT IGNORE.

CREATE TABLE IF NOT EXISTS ven_alergenos (
  id      INT         AUTO_INCREMENT PRIMARY KEY,
  codigo  VARCHAR(40) NOT NULL,
  nombre  VARCHAR(80) NOT NULL,
  activo  TINYINT(1)  NOT NULL DEFAULT 1,
  CONSTRAINT uq_ven_alergeno_codigo UNIQUE (codigo)
);
-- Los de uso común; el contenido y el formato legal del rotulado los define la instancia (RF31).
INSERT IGNORE INTO ven_alergenos (codigo, nombre) VALUES
  ('gluten', 'Gluten / TACC'), ('lacteos', 'Lácteos'), ('huevo', 'Huevo'), ('frutos_secos', 'Frutos secos'),
  ('soja', 'Soja'), ('mani', 'Maní'), ('pescado', 'Pescado'), ('crustaceos', 'Crustáceos'), ('sulfitos', 'Sulfitos');

-- Declarados a mano en un artículo y en una opción de modificador (Alergenos_Declarados).
CREATE TABLE IF NOT EXISTS ven_articulo_alergenos (
  producto_id INT NOT NULL,
  alergeno_id INT NOT NULL,
  PRIMARY KEY (producto_id, alergeno_id),
  CONSTRAINT fk_vaa_alergeno FOREIGN KEY (alergeno_id) REFERENCES ven_alergenos(id)
);
CREATE TABLE IF NOT EXISTS ven_opcion_alergenos (
  opcion_id   INT NOT NULL,
  alergeno_id INT NOT NULL,
  PRIMARY KEY (opcion_id, alergeno_id),
  CONSTRAINT fk_voa_alergeno FOREIGN KEY (alergeno_id) REFERENCES ven_alergenos(id)
);

-- Lo último que calculó Stock para un artículo: si Stock no responde, la línea lo muestra con la marca de pendiente (RN42).
CREATE TABLE IF NOT EXISTS ven_alergenos_derivados (
  producto_id   INT       NOT NULL PRIMARY KEY,
  alergenos     TEXT      NOT NULL,
  calculado_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Alergenos_Linea: se guardan en la línea al agregarla.
SET @sql = (
  SELECT IF(COUNT(*) = 0, 'ALTER TABLE pedido_productos ADD COLUMN alergenos_linea TEXT NULL, ADD COLUMN alergenos_pendientes TINYINT(1) NOT NULL DEFAULT 0', 'SELECT 1')
  FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'pedido_productos' AND column_name = 'alergenos_linea'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
