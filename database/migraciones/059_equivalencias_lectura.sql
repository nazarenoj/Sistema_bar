-- F7: lectura de comprobantes por foto (Usuarios RF15, RN18, RN19, EX11; función USU-FOTO) y diccionario de equivalencias de terceros
-- (RF16, RN20). El diccionario relaciona un código o descripción de un tercero (por CUIT del emisor) con un destino único y, para un ítem
-- de stock, con una presentación de Stock: nunca guarda unidad ni factor, usa los de Stock.
CREATE TABLE IF NOT EXISTS equivalencias_terceros (
  id              INT          AUTO_INCREMENT PRIMARY KEY,
  cuit_emisor     CHAR(11)     NOT NULL,
  texto_clave     VARCHAR(200) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  descripcion     VARCHAR(200) NOT NULL,
  tipo_destino    ENUM('item_stock', 'articulo', 'categoria_gasto') NOT NULL,
  id_destino      INT          NOT NULL,
  presentacion_id INT          NULL,
  estado          ENUM('vigente', 'revisar') NOT NULL DEFAULT 'vigente',
  user_id         INT          NULL,
  created_at      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT uq_equivalencia_tercero UNIQUE (cuit_emisor, texto_clave)
);

-- Servicio de lectura: dirección del proveedor (siempre https: las imágenes viajan cifradas, RN19). La clave de acceso va en el entorno.
CREATE TABLE IF NOT EXISTS lectura_comprobantes_config (
  id        INT          NOT NULL PRIMARY KEY,
  url       VARCHAR(300) NULL,
  timeout_s INT          NOT NULL DEFAULT 20
);
INSERT IGNORE INTO lectura_comprobantes_config (id) VALUES (1);

INSERT IGNORE INTO rol_permisos (rol_id, permiso, nivel)
SELECT r.id, p.permiso, p.nivel FROM roles r JOIN (
  SELECT 'gerente' rol, 'usuarios.equivalencias.gestionar' permiso, 'permitido' nivel UNION ALL
  SELECT 'administrativo', 'usuarios.equivalencias.gestionar', 'permitido' UNION ALL
  SELECT 'deposito', 'usuarios.equivalencias.gestionar', 'permitido'
) p ON p.rol = r.codigo;
