-- C13: etiquetas y etiqueta propia de peso (Stock RF27, RN82; Ventas RN71). Función STK-ETIQUETAS: plantillas por impresora,
-- etiquetas de góndola y de elaborado, códigos internos y de peso embebido (13 dígitos, EAN-13 módulo 10) y etiquetas desactualizadas.
-- Re-ejecutable: tablas IF NOT EXISTS, ALTER condicionado a su columna, semillas con INSERT IGNORE.

SET @sql = (
  SELECT IF(COUNT(*) = 0,
    "ALTER TABLE productos
       ADD COLUMN codigo_etiqueta CHAR(5) NULL,
       ADD CONSTRAINT uq_producto_codigo_etiqueta UNIQUE (codigo_etiqueta)",
    'SELECT 1')
  FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'productos' AND column_name = 'codigo_etiqueta'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Prefijo propio de la instancia (2 dígitos): distinto de cualquier prefijo de los códigos de barras del catálogo (RN24).
INSERT IGNORE INTO parametros (clave, valor) VALUES ('etiqueta_prefijo', '29');

CREATE TABLE IF NOT EXISTS plantillas_etiqueta (
  id         INT          AUTO_INCREMENT PRIMARY KEY,
  tipo       ENUM('gondola', 'elaborado') NOT NULL,
  impresora  VARCHAR(80)  NOT NULL,
  ancho_mm   INT          NOT NULL DEFAULT 60,
  alto_mm    INT          NOT NULL DEFAULT 40,
  contenido  TEXT         NOT NULL,
  activa     TINYINT(1)   NOT NULL DEFAULT 1,
  CONSTRAINT uq_plantilla_etiqueta UNIQUE (tipo, impresora)
);

-- Lo impreso, con el precio de ese momento: una etiqueta de góndola cuyo precio cambió en Ventas queda "desactualizada" (RN40).
CREATE TABLE IF NOT EXISTS etiquetas_impresas (
  id           BIGINT        AUTO_INCREMENT PRIMARY KEY,
  tipo         ENUM('gondola', 'elaborado', 'peso') NOT NULL,
  producto_id  INT           NOT NULL,
  lote_id      BIGINT        NULL,
  precio       DECIMAL(10,2) NULL,
  codigo       VARCHAR(40)   NULL,
  plantilla_id INT           NULL,
  user_id      INT           NULL,
  created_at   TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_etiqueta_producto FOREIGN KEY (producto_id) REFERENCES productos(id),
  KEY idx_etiqueta_producto (producto_id, tipo, id)
);

INSERT IGNORE INTO rol_permisos (rol_id, permiso, nivel)
SELECT r.id, p.permiso, p.nivel FROM roles r JOIN (
  SELECT 'gerente' rol, 'stock.etiquetas.gestionar' permiso, 'permitido' nivel UNION ALL
  SELECT 'encargado', 'stock.etiquetas.gestionar', 'permitido' UNION ALL
  SELECT 'deposito', 'stock.etiquetas.gestionar', 'permitido' UNION ALL
  SELECT 'produccion', 'stock.etiquetas.gestionar', 'permitido'
) p ON p.rol = r.codigo;
