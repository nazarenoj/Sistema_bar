-- D7: toma de pedidos desde tablet o celular del mozo (Ventas RF39, RN37, RN66, EX26, EX50). Función VEN-MOVIL.
-- Versión del pedido y de cada ítem (Version_Pedido, Version_Item): sube con cualquier cambio, venga de donde venga, así una operación del
-- dispositivo se evalúa contra la versión que vio. Re-ejecutable: ALTER condicionados, triggers con DROP IF EXISTS, tablas IF NOT EXISTS.

SET @sql = (
  SELECT IF(COUNT(*) = 0, 'ALTER TABLE pedidos ADD COLUMN version INT NOT NULL DEFAULT 1', 'SELECT 1')
  FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'pedidos' AND column_name = 'version'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql = (
  SELECT IF(COUNT(*) = 0, 'ALTER TABLE pedido_productos ADD COLUMN version INT NOT NULL DEFAULT 1', 'SELECT 1')
  FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'pedido_productos' AND column_name = 'version'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

DROP TRIGGER IF EXISTS pedidos_version;
CREATE TRIGGER pedidos_version BEFORE UPDATE ON pedidos FOR EACH ROW SET NEW.version = OLD.version + 1;
DROP TRIGGER IF EXISTS pedido_productos_version;
CREATE TRIGGER pedido_productos_version BEFORE UPDATE ON pedido_productos FOR EACH ROW SET NEW.version = OLD.version + 1;
-- Cualquier alta, cambio o baja de un ítem es un cambio del pedido (el UPDATE sin efecto dispara el trigger de arriba).
DROP TRIGGER IF EXISTS pedido_productos_ins_version;
CREATE TRIGGER pedido_productos_ins_version AFTER INSERT ON pedido_productos FOR EACH ROW UPDATE pedidos SET mozo_id = mozo_id WHERE id = NEW.pedido_id;
DROP TRIGGER IF EXISTS pedido_productos_upd_version;
CREATE TRIGGER pedido_productos_upd_version AFTER UPDATE ON pedido_productos FOR EACH ROW UPDATE pedidos SET mozo_id = mozo_id WHERE id = NEW.pedido_id;
DROP TRIGGER IF EXISTS pedido_productos_del_version;
CREATE TRIGGER pedido_productos_del_version AFTER DELETE ON pedido_productos FOR EACH ROW UPDATE pedidos SET mozo_id = mozo_id WHERE id = OLD.pedido_id;

-- Cada operación de un dispositivo: idempotente por su ID_Operacion; las rechazadas son los "Conflictos de sincronización" (EX50).
CREATE TABLE IF NOT EXISTS movil_operaciones (
  id             INT          AUTO_INCREMENT PRIMARY KEY,
  id_operacion   VARCHAR(64)  CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  terminal_id    INT          NOT NULL,
  user_id        INT          NULL,
  tipo           VARCHAR(30)  NOT NULL,
  pedido_id      INT          NULL,
  contenido_hash CHAR(40)     NOT NULL,
  estado         ENUM('aplicada', 'rechazada') NOT NULL,
  motivo         VARCHAR(500) NULL,
  resultado      TEXT         NULL,
  created_at     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_movil_operacion UNIQUE (id_operacion),
  KEY idx_movil_rechazadas (estado, created_at),
  KEY idx_movil_pedido (pedido_id)
);

-- El cobro desde el dispositivo solo si la instancia lo habilita (RF39).
INSERT IGNORE INTO parametros (clave, valor) VALUES ('movil_cobro', 'no');

INSERT IGNORE INTO rol_permisos (rol_id, permiso, nivel)
SELECT r.id, p.permiso, p.nivel FROM roles r JOIN (
  SELECT 'gerente' rol, 'ventas.movil.supervisar' permiso, 'permitido' nivel UNION ALL
  SELECT 'encargado', 'ventas.movil.supervisar', 'permitido'
) p ON p.rol = r.codigo;
