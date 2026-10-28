-- Fase A5: roles, permisos con tres niveles, excepciones por usuario y alcances de datos
-- (Usuarios RF02, RF03, RF05, RN07 a RN10). El catálogo de acciones sujetas a permiso vive en el
-- código (src/permisos/catalogo.js); acá se guardan los roles y qué nivel tiene cada permiso.
-- El Administrador no tiene filas: puede todo (RN07) y no se le puede quitar.
CREATE TABLE IF NOT EXISTS roles (
  id          INT          NOT NULL AUTO_INCREMENT PRIMARY KEY,
  codigo      VARCHAR(40)  NOT NULL,
  nombre      VARCHAR(60)  NOT NULL,
  descripcion VARCHAR(255) NULL,
  predefinido TINYINT(1)   NOT NULL DEFAULT 0,
  UNIQUE KEY uq_roles_codigo (codigo),
  UNIQUE KEY uq_roles_nombre (nombre)
);

CREATE TABLE IF NOT EXISTS rol_permisos (
  rol_id   INT         NOT NULL,
  permiso  VARCHAR(80) NOT NULL,
  nivel    ENUM('permitido', 'requiere_autorizacion', 'denegado') NOT NULL,
  PRIMARY KEY (rol_id, permiso),
  CONSTRAINT fk_rp_rol FOREIGN KEY (rol_id) REFERENCES roles(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS usuario_roles (
  user_id INT NOT NULL,
  rol_id  INT NOT NULL,
  PRIMARY KEY (user_id, rol_id),
  CONSTRAINT fk_ur_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_ur_rol  FOREIGN KEY (rol_id)  REFERENCES roles(id)
);

-- Excepciones individuales: pisan lo que digan los roles del usuario.
CREATE TABLE IF NOT EXISTS usuario_permisos (
  user_id INT         NOT NULL,
  permiso VARCHAR(80) NOT NULL,
  nivel   ENUM('permitido', 'requiere_autorizacion', 'denegado') NOT NULL,
  PRIMARY KEY (user_id, permiso),
  CONSTRAINT fk_up_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Alcances de datos (RF03): "propias", "turno", "caja", "deposito", "sector" u "otro" + valor.
CREATE TABLE IF NOT EXISTS usuario_alcances (
  user_id INT         NOT NULL,
  tipo    ENUM('propias', 'turno', 'caja', 'deposito', 'sector', 'otro') NOT NULL,
  valor   VARCHAR(60) NOT NULL DEFAULT '',
  PRIMARY KEY (user_id, tipo, valor),
  CONSTRAINT fk_ua_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Roles de referencia (RF02), editables salvo el Administrador.
INSERT IGNORE INTO roles (codigo, nombre, descripcion, predefinido) VALUES
  ('administrador', 'Administrador', 'Configuración, permisos, copias y funcionalidades. Puede todo.', 1),
  ('gerente', 'Gerente', 'Informes, precios y anulaciones.', 1),
  ('encargado', 'Encargado de turno', 'Apertura y cierre de turno, autorización de supervisor.', 1),
  ('cajero', 'Cajero', 'Cobro en su caja.', 1),
  ('barista', 'Barista', 'Preparación en barra y comandas.', 1),
  ('mozo', 'Mozo', 'Pedidos, mesas y cobro en el salón.', 1),
  ('produccion', 'Producción/Obrador', 'Recetas, tandas, lotes y temperaturas.', 1),
  ('deposito', 'Depósito', 'Recepción, conteo y mermas.', 1),
  ('administrativo', 'Administrativo', 'Compras, gastos y cuentas corrientes.', 1),
  ('contador', 'Contador', 'Consulta y exportaciones contables.', 1);

-- Permisos iniciales de cada rol (propuesta editable). Cada fila: código del rol, permiso, nivel.
INSERT IGNORE INTO rol_permisos (rol_id, permiso, nivel)
SELECT r.id, p.permiso, p.nivel FROM roles r JOIN (
  SELECT 'gerente' rol, 'ventas.pedidos.operar' permiso, 'permitido' nivel UNION ALL
  SELECT 'gerente', 'ventas.cuenta.cobrar', 'permitido' UNION ALL
  SELECT 'gerente', 'ventas.pedidos.anular', 'permitido' UNION ALL
  SELECT 'gerente', 'ventas.salon.configurar', 'permitido' UNION ALL
  SELECT 'gerente', 'ventas.catalogo.ver', 'permitido' UNION ALL
  SELECT 'gerente', 'ventas.catalogo.editar', 'permitido' UNION ALL
  SELECT 'gerente', 'stock.insumos.ver', 'permitido' UNION ALL
  SELECT 'gerente', 'stock.insumos.editar', 'permitido' UNION ALL
  SELECT 'gerente', 'ventas.historial.ver', 'permitido' UNION ALL
  SELECT 'gerente', 'ventas.historial.exportar', 'permitido' UNION ALL
  SELECT 'gerente', 'facturacion.ver', 'permitido' UNION ALL
  SELECT 'gerente', 'facturacion.reintentar', 'permitido' UNION ALL
  SELECT 'gerente', 'auditoria.ver', 'permitido' UNION ALL
  SELECT 'encargado', 'ventas.pedidos.operar', 'permitido' UNION ALL
  SELECT 'encargado', 'ventas.cuenta.cobrar', 'permitido' UNION ALL
  SELECT 'encargado', 'ventas.pedidos.anular', 'permitido' UNION ALL
  SELECT 'encargado', 'ventas.salon.configurar', 'permitido' UNION ALL
  SELECT 'encargado', 'ventas.catalogo.ver', 'permitido' UNION ALL
  SELECT 'encargado', 'ventas.catalogo.editar', 'permitido' UNION ALL
  SELECT 'encargado', 'stock.insumos.ver', 'permitido' UNION ALL
  SELECT 'encargado', 'stock.insumos.editar', 'permitido' UNION ALL
  SELECT 'encargado', 'ventas.historial.ver', 'permitido' UNION ALL
  SELECT 'encargado', 'ventas.historial.exportar', 'permitido' UNION ALL
  SELECT 'encargado', 'facturacion.ver', 'permitido' UNION ALL
  SELECT 'encargado', 'facturacion.reintentar', 'permitido' UNION ALL
  SELECT 'cajero', 'ventas.pedidos.operar', 'permitido' UNION ALL
  SELECT 'cajero', 'ventas.cuenta.cobrar', 'permitido' UNION ALL
  SELECT 'cajero', 'ventas.pedidos.anular', 'requiere_autorizacion' UNION ALL
  SELECT 'cajero', 'ventas.catalogo.ver', 'permitido' UNION ALL
  SELECT 'cajero', 'ventas.historial.ver', 'permitido' UNION ALL
  SELECT 'barista', 'ventas.pedidos.operar', 'permitido' UNION ALL
  SELECT 'barista', 'ventas.catalogo.ver', 'permitido' UNION ALL
  SELECT 'mozo', 'ventas.pedidos.operar', 'permitido' UNION ALL
  SELECT 'mozo', 'ventas.cuenta.cobrar', 'permitido' UNION ALL
  SELECT 'mozo', 'ventas.pedidos.anular', 'requiere_autorizacion' UNION ALL
  SELECT 'mozo', 'ventas.catalogo.ver', 'permitido' UNION ALL
  SELECT 'produccion', 'ventas.catalogo.ver', 'permitido' UNION ALL
  SELECT 'produccion', 'stock.insumos.ver', 'permitido' UNION ALL
  SELECT 'produccion', 'stock.insumos.editar', 'permitido' UNION ALL
  SELECT 'deposito', 'stock.insumos.ver', 'permitido' UNION ALL
  SELECT 'deposito', 'stock.insumos.editar', 'permitido' UNION ALL
  SELECT 'administrativo', 'stock.insumos.ver', 'permitido' UNION ALL
  SELECT 'administrativo', 'ventas.historial.ver', 'permitido' UNION ALL
  SELECT 'administrativo', 'ventas.historial.exportar', 'permitido' UNION ALL
  SELECT 'administrativo', 'facturacion.ver', 'permitido' UNION ALL
  SELECT 'contador', 'ventas.historial.ver', 'permitido' UNION ALL
  SELECT 'contador', 'ventas.historial.exportar', 'permitido' UNION ALL
  SELECT 'contador', 'facturacion.ver', 'permitido' UNION ALL
  SELECT 'contador', 'auditoria.ver', 'permitido'
) p ON p.rol = r.codigo;

-- Los usuarios que ya existían conservan lo que podían hacer: el admin pasa a Administrador y el
-- empleado a Encargado de turno (operaba todo menos la gestión de usuarios).
INSERT IGNORE INTO usuario_roles (user_id, rol_id)
SELECT u.id, r.id FROM users u JOIN roles r
  ON r.codigo = IF(u.rol = 'admin', 'administrador', 'encargado');
