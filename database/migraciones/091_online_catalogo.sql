-- I2: publicación del catálogo, precios online y disponibilidad (Ventas Online RF02, RF03, RF04, RF21, RN03, RN04). Re-ejecutable.

SET @sql = (
  SELECT IF(COUNT(*) = 0, "ALTER TABLE onl_tienda ADD COLUMN ajuste_pct DECIMAL(6,2) NOT NULL DEFAULT 0", 'SELECT 1')
  FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'onl_tienda' AND column_name = 'ajuste_pct'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Qué artículos de Ventas se publican y cómo se presentan.
CREATE TABLE IF NOT EXISTS onl_publicados (
  producto_id      INT            NOT NULL PRIMARY KEY,
  titulo           VARCHAR(120)   NULL,
  descripcion      TEXT           NULL,
  fotos            TEXT           NULL,
  categoria_online VARCHAR(80)    NULL,
  orden            INT            NOT NULL DEFAULT 0,
  visible_desde    DATETIME       NULL,
  visible_hasta    DATETIME       NULL,
  margen_seguridad DECIMAL(12,3)  NOT NULL DEFAULT 0,
  atributos        TEXT           NULL,
  publicado_ms     BIGINT         NOT NULL,
  CONSTRAINT fk_onl_pub_prod FOREIGN KEY (producto_id) REFERENCES productos(id)
);
-- Ajuste porcentual del precio online por categoría de Ventas (RF03).
CREATE TABLE IF NOT EXISTS onl_ajustes_categoria (
  categoria_id INT           NOT NULL PRIMARY KEY,
  pct          DECIMAL(6,2)  NOT NULL,
  CONSTRAINT fk_onl_aj_cat FOREIGN KEY (categoria_id) REFERENCES categorias_producto(id)
);
-- Disponibilidad publicada (RN03): cantidad nula = sin límite. Con Stock la calcula la sincronización; sin Stock se carga a mano.
CREATE TABLE IF NOT EXISTS onl_disponibilidad (
  producto_id    INT            NOT NULL PRIMARY KEY,
  cantidad       DECIMAL(12,3)  NULL,
  agotado        TINYINT(1)     NOT NULL DEFAULT 0,
  fuente         ENUM('stock', 'manual') NOT NULL DEFAULT 'manual',
  actualizada_ms BIGINT         NOT NULL
);
CREATE TABLE IF NOT EXISTS onl_sync (
  id             TINYINT       NOT NULL PRIMARY KEY,
  ultima_ms      BIGINT        NULL,
  publicados     INT           NOT NULL DEFAULT 0,
  detalle        VARCHAR(255)  NULL
);
INSERT IGNORE INTO onl_sync (id) VALUES (1);

INSERT IGNORE INTO rol_permisos (rol_id, permiso, nivel)
SELECT r.id, p.permiso, p.nivel FROM roles r JOIN (
  SELECT 'gerente' rol, 'ventas_online.catalogo.ver' permiso, 'permitido' nivel UNION ALL
  SELECT 'administrativo', 'ventas_online.catalogo.ver', 'permitido' UNION ALL
  SELECT 'gerente', 'ventas_online.catalogo.gestionar', 'permitido'
) p ON p.rol = r.codigo;
