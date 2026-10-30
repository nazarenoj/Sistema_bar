-- C9: alérgenos por receta (Stock RF22, RF39, RN33, RN34, RN77). Función STK-ALERGENOS: catálogo, declaración por insumo o artículo
-- ("contiene" / "trazas"), derivación por receta calculada al consultar (siempre al día) y quita auditada de un derivado.
-- Re-ejecutable: tablas IF NOT EXISTS, ALTER condicionado a su columna, semillas con INSERT IGNORE.

CREATE TABLE IF NOT EXISTS alergenos (
  id      INT          AUTO_INCREMENT PRIMARY KEY,
  codigo  VARCHAR(40)  NOT NULL,
  nombre  VARCHAR(80)  NOT NULL,
  activo  TINYINT(1)   NOT NULL DEFAULT 1,
  CONSTRAINT uq_alergeno_codigo UNIQUE (codigo)
);
-- El contenido legal es parametrizable (RF22): estos son los de uso común, la instancia agrega o desactiva.
INSERT IGNORE INTO alergenos (codigo, nombre) VALUES
  ('gluten', 'Gluten / TACC'), ('lacteos', 'Lácteos'), ('huevo', 'Huevo'), ('frutos_secos', 'Frutos secos'),
  ('soja', 'Soja'), ('mani', 'Maní'), ('pescado', 'Pescado'), ('crustaceos', 'Crustáceos'), ('sulfitos', 'Sulfitos');

-- Lo declarado a mano por ítem. Los derivados no se guardan: se calculan desde la receta.
CREATE TABLE IF NOT EXISTS item_alergenos (
  id           INT          AUTO_INCREMENT PRIMARY KEY,
  item_tipo    ENUM('insumo', 'producto') NOT NULL,
  item_id      INT          NOT NULL,
  alergeno_id  INT          NOT NULL,
  tipo         ENUM('contiene', 'trazas') NOT NULL,
  CONSTRAINT uq_item_alergeno UNIQUE (item_tipo, item_id, alergeno_id),
  CONSTRAINT fk_item_alergeno FOREIGN KEY (alergeno_id) REFERENCES alergenos(id)
);

-- Un derivado que se quita a un artículo, con su motivo y quién (RN33).
CREATE TABLE IF NOT EXISTS alergenos_quitados (
  producto_id  INT          NOT NULL,
  alergeno_id  INT          NOT NULL,
  motivo       VARCHAR(255) NOT NULL,
  user_id      INT          NULL,
  created_at   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (producto_id, alergeno_id),
  CONSTRAINT fk_quitado_alergeno FOREIGN KEY (alergeno_id) REFERENCES alergenos(id)
);

-- "Revisado": el ítem se revisó y declara estos alérgenos (aunque ninguno). Sin revisar, la receta queda "incompleta" (EX22).
SET @sql = (SELECT IF(COUNT(*) = 0, "ALTER TABLE insumos ADD COLUMN alergenos_revisado TINYINT(1) NOT NULL DEFAULT 0", 'SELECT 1')
  FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'insumos' AND column_name = 'alergenos_revisado');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @sql = (SELECT IF(COUNT(*) = 0, "ALTER TABLE productos ADD COLUMN alergenos_revisado TINYINT(1) NOT NULL DEFAULT 0", 'SELECT 1')
  FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'productos' AND column_name = 'alergenos_revisado');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

INSERT IGNORE INTO rol_permisos (rol_id, permiso, nivel)
SELECT r.id, p.permiso, p.nivel FROM roles r JOIN (
  SELECT 'gerente' rol, 'stock.alergenos.gestionar' permiso, 'permitido' nivel UNION ALL
  SELECT 'encargado', 'stock.alergenos.gestionar', 'permitido' UNION ALL
  SELECT 'produccion', 'stock.alergenos.gestionar', 'permitido' UNION ALL
  SELECT 'gerente', 'stock.alergenos.quitar', 'requiere_autorizacion'
) p ON p.rol = r.codigo;
