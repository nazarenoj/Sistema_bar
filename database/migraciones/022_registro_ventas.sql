-- B9: registro de ventas (Ventas RF19 a RF22, RN20 a RN26). Índices para listar rápido con muchas ventas y
-- reimpresiones registradas (de solo agregar: quién, cuándo, en qué formato y por qué).
-- Re-ejecutable: el índice se crea solo si falta.

SET @sql = (
  SELECT IF(COUNT(*) = 0, 'ALTER TABLE ventas ADD KEY idx_ventas_created (created_at)', 'SELECT 1')
  FROM information_schema.statistics
  WHERE table_schema = DATABASE() AND table_name = 'ventas' AND index_name = 'idx_ventas_created'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

CREATE TABLE IF NOT EXISTS reimpresiones (
  id         INT          AUTO_INCREMENT PRIMARY KEY,
  venta_id   INT          NOT NULL,
  user_id    INT          NULL,
  username   VARCHAR(50)  NULL,
  formato    VARCHAR(20)  NOT NULL,
  motivo     VARCHAR(255) NULL,
  created_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_reimpresion_venta (venta_id),
  CONSTRAINT fk_reimpresion_venta FOREIGN KEY (venta_id) REFERENCES ventas(id)
);

DROP TRIGGER IF EXISTS reimpresiones_no_update;
CREATE TRIGGER reimpresiones_no_update BEFORE UPDATE ON reimpresiones FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Las reimpresiones son de solo agregar';
DROP TRIGGER IF EXISTS reimpresiones_no_delete;
CREATE TRIGGER reimpresiones_no_delete BEFORE DELETE ON reimpresiones FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Las reimpresiones son de solo agregar';

INSERT IGNORE INTO parametros (clave, valor) VALUES
  ('reimpresion_motivo_obligatorio', '0'),
  ('exportar_max_filas', '10000');

-- La reimpresión tiene su propio permiso, independiente del de consulta (RN23).
INSERT IGNORE INTO rol_permisos (rol_id, permiso, nivel)
SELECT r.id, p.permiso, p.nivel FROM roles r JOIN (
  SELECT 'gerente' rol, 'ventas.reimprimir' permiso, 'permitido' nivel UNION ALL
  SELECT 'encargado', 'ventas.reimprimir', 'permitido' UNION ALL
  SELECT 'cajero', 'ventas.reimprimir', 'permitido'
) p ON p.rol = r.codigo;
