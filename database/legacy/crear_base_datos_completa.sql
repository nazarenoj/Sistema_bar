-- Script único para crear la base de datos completa desde cero (para un servidor nuevo, ej. Hostinger,
-- o donde no se pueda dejar que el propio backend la autoprovisione al arrancar).
-- Equivale a aplicar, en orden, schema.sql + todos los migracion_*/alter_*.sql + crear_users.sql
-- de este mismo directorio, pero ya con el esquema final (sin los pasos intermedios de backfill,
-- que no aplican sobre una base vacía).
--
-- Las tablas de acá abajo (desde CREATE TABLE users en adelante) son una copia de schema.sql,
-- que es la que usa el backend para crear la base de datos solo si todavía no existe (ver
-- src/config/db.js -> ensureDatabase). Si se cambia el esquema, actualizar ambos archivos.

CREATE DATABASE IF NOT EXISTS sistema_chepola
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE sistema_chepola;

-- Login básico. El campo "rol" no habilita todavía ningún permiso diferenciado (ambos roles
-- pueden hacer las mismas acciones); existe para no tener que migrar el esquema el día que se
-- quiera diferenciar qué puede hacer cada uno.
CREATE TABLE IF NOT EXISTS users (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  username      VARCHAR(50) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  rol           ENUM('admin', 'empleado') NOT NULL DEFAULT 'empleado',
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS productos (
  id          INT            AUTO_INCREMENT PRIMARY KEY,
  nombre      VARCHAR(255)   NOT NULL,
  precio      DECIMAL(10,2)  NOT NULL,
  descripcion TEXT,
  stock       INT            NOT NULL DEFAULT 0,
  created_at  TIMESTAMP      DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP      DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS salones (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  nombre      VARCHAR(100) NOT NULL,
  color_fondo VARCHAR(20)  NOT NULL DEFAULT '#f9fafb',
  orden       INT          NOT NULL DEFAULT 0,
  created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO salones (nombre, orden) VALUES ('Salón Principal', 0);

-- mesas: numero_mesa ya no es único de forma global (borrado lógico vía "activa" permite
-- reutilizar el número); la unicidad entre mesas activas se valida en la aplicación
-- (ver mesaModel.create). grupo_id se deja nullable y su FK se agrega más abajo, una vez
-- que existe mesa_grupos (que a su vez depende de mesas).
CREATE TABLE IF NOT EXISTS mesas (
  id               INT  AUTO_INCREMENT PRIMARY KEY,
  numero_mesa      INT  NOT NULL,
  estado           ENUM('libre', 'ocupado') NOT NULL DEFAULT 'libre',
  salon_id         INT NOT NULL DEFAULT 1,
  tamano           INT NOT NULL DEFAULT 96,
  color_libre      VARCHAR(20) NULL,
  color_ocupado    VARCHAR(20) NULL,
  grupo_id         INT NULL,
  pos_x            INT NOT NULL DEFAULT 0,
  pos_y            INT NOT NULL DEFAULT 0,
  activa           TINYINT(1) NOT NULL DEFAULT 1,
  ticket_pendiente TINYINT(1) NOT NULL DEFAULT 0,
  CONSTRAINT fk_mesa_salon FOREIGN KEY (salon_id) REFERENCES salones(id)
);

-- Grupo de mesas combinadas: la mesa maestra concentra los pedidos/cuenta de todo el grupo
CREATE TABLE IF NOT EXISTS mesa_grupos (
  id             INT AUTO_INCREMENT PRIMARY KEY,
  salon_id       INT NOT NULL,
  numero_mesa    VARCHAR(20) NOT NULL,
  mesa_master_id INT NOT NULL,
  created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_grupo_salon  FOREIGN KEY (salon_id) REFERENCES salones(id),
  CONSTRAINT fk_grupo_master FOREIGN KEY (mesa_master_id) REFERENCES mesas(id)
);

ALTER TABLE mesas
  ADD CONSTRAINT fk_mesa_grupo FOREIGN KEY (grupo_id) REFERENCES mesa_grupos(id);

CREATE TABLE IF NOT EXISTS estructuras (
  id       INT AUTO_INCREMENT PRIMARY KEY,
  salon_id INT NOT NULL,
  tipo     ENUM('ventana', 'puerta', 'mostrador', 'columna') NOT NULL,
  pos_x    INT NOT NULL DEFAULT 0,
  pos_y    INT NOT NULL DEFAULT 0,
  ancho    INT NOT NULL DEFAULT 80,
  alto     INT NOT NULL DEFAULT 20,
  rotacion INT NOT NULL DEFAULT 0,
  CONSTRAINT fk_estructura_salon FOREIGN KEY (salon_id) REFERENCES salones(id)
);

-- Sillas dibujadas alrededor de cada mesa en el mapa del salón: cantidad y posición fijas,
-- configurables a mano en modo edición (independientes de los pedidos/cuentas abiertas).
CREATE TABLE IF NOT EXISTS mesa_sillas (
  id      INT AUTO_INCREMENT PRIMARY KEY,
  mesa_id INT NOT NULL,
  pos_x   INT NOT NULL DEFAULT 0,
  pos_y   INT NOT NULL DEFAULT 0,
  CONSTRAINT fk_silla_mesa FOREIGN KEY (mesa_id) REFERENCES mesas(id) ON DELETE CASCADE
);

-- sesion_apertura: momento en que la mesa pasó a ocupada para esta "sesión" de cuenta; todos los
-- pedidos (sillas) que se abren mientras la mesa sigue ocupada comparten el mismo valor. Siempre
-- la completa la aplicación al insertar (ver pedidoModel.js), por eso no lleva DEFAULT.
CREATE TABLE IF NOT EXISTS pedidos (
  id              INT           AUTO_INCREMENT PRIMARY KEY,
  mesa_id         INT           NOT NULL,
  estado          ENUM('activo', 'finalizado') NOT NULL DEFAULT 'activo',
  total           DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  metodo_pago     ENUM('efectivo', 'tarjeta_debito', 'tarjeta_credito', 'transferencia', 'otro') NULL,
  fecha_creacion  TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  fecha_cierre    TIMESTAMP     NULL DEFAULT NULL,
  sesion_apertura TIMESTAMP     NOT NULL,
  CONSTRAINT fk_pedido_mesa FOREIGN KEY (mesa_id) REFERENCES mesas(id),
  INDEX idx_pedidos_historial (estado, fecha_cierre),
  INDEX idx_pedidos_sesion (mesa_id, sesion_apertura)
);

CREATE TABLE IF NOT EXISTS pedido_productos (
  id              INT           AUTO_INCREMENT PRIMARY KEY,
  pedido_id       INT           NOT NULL,
  producto_id     INT           NOT NULL,
  cantidad        INT           NOT NULL,
  nombre          VARCHAR(255)  NOT NULL DEFAULT '',
  descripcion     TEXT,
  precio_unitario DECIMAL(10,2) NOT NULL,
  entregado       TINYINT(1)    NOT NULL DEFAULT 0,
  CONSTRAINT fk_pp_pedido   FOREIGN KEY (pedido_id)   REFERENCES pedidos(id),
  CONSTRAINT fk_pp_producto FOREIGN KEY (producto_id) REFERENCES productos(id)
);

CREATE TABLE IF NOT EXISTS insumos (
  id             INT            AUTO_INCREMENT PRIMARY KEY,
  nombre         VARCHAR(255)   NOT NULL,
  unidad         VARCHAR(50)    NOT NULL,
  costo_unitario DECIMAL(10,2),
  stock          DECIMAL(10,3)  NOT NULL DEFAULT 0,
  disponible     TINYINT(1)     NOT NULL DEFAULT 1,
  created_at     TIMESTAMP      DEFAULT CURRENT_TIMESTAMP,
  updated_at     TIMESTAMP      DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- Receta: cuánto de cada insumo consume una unidad de un producto.
-- Si se borra el producto, su receta se borra con él (le pertenece).
-- Si se intenta borrar un insumo usado en alguna receta, falla por FK (ver insumoModel.remove).
CREATE TABLE IF NOT EXISTS producto_insumos (
  id                 INT           AUTO_INCREMENT PRIMARY KEY,
  producto_id        INT           NOT NULL,
  insumo_id          INT           NOT NULL,
  cantidad_consumida DECIMAL(10,3) NOT NULL,
  CONSTRAINT fk_pi_producto FOREIGN KEY (producto_id) REFERENCES productos(id) ON DELETE CASCADE,
  CONSTRAINT fk_pi_insumo   FOREIGN KEY (insumo_id)   REFERENCES insumos(id),
  CONSTRAINT uq_pi_producto_insumo UNIQUE (producto_id, insumo_id)
);

-- Cachea el Ticket de Acceso (TA) de WSAA por servicio+entorno para no re-autenticar en cada
-- factura: el TA de ARCA es válido ~12hs y ARCA rechaza pedir uno nuevo mientras el anterior siga
-- vigente. Se persiste en tabla (no en memoria) para sobrevivir reinicios del proceso Node.
CREATE TABLE IF NOT EXISTS afip_token_cache (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  servicio    VARCHAR(20) NOT NULL DEFAULT 'wsfe',
  entorno     ENUM('homologacion', 'produccion') NOT NULL,
  token       MEDIUMTEXT NOT NULL,
  sign        MEDIUMTEXT NOT NULL,
  generado_en DATETIME NOT NULL,
  expira_en   DATETIME NOT NULL,
  UNIQUE KEY uq_afip_token_cache (servicio, entorno)
);

-- Un comprobante fiscal por cuenta cerrada (mesa_id + sesion_apertura identifican la cuenta,
-- igual que pedidoModel.js usa esas dos columnas para agrupar las sillas de una misma mesa). Se
-- crea SIEMPRE al cerrar la cuenta (estado 'pendiente'), aunque ARCA todavía no haya respondido,
-- para no perder el método de pago ni la trazabilidad si el pedido a ARCA falla y hay que
-- reintentarlo después.
CREATE TABLE IF NOT EXISTS facturas (
  id                        INT AUTO_INCREMENT PRIMARY KEY,
  mesa_id                   INT NOT NULL,
  sesion_apertura           DATETIME NOT NULL,

  metodo_pago               ENUM('efectivo', 'tarjeta_debito', 'tarjeta_credito', 'transferencia', 'otro') NOT NULL,

  tipo_comprobante          TINYINT UNSIGNED NOT NULL,   -- código ARCA: 1=Factura A, 6=Factura B, 11=Factura C
  punto_venta               SMALLINT UNSIGNED NOT NULL,
  numero                    INT UNSIGNED NULL,           -- asignado tras CompUltimoAutorizado + 1; NULL hasta emitir

  doc_tipo                  TINYINT UNSIGNED NOT NULL DEFAULT 99,  -- 80=CUIT, 96=DNI, 99=Consumidor Final
  doc_nro                   VARCHAR(20) NOT NULL DEFAULT '0',
  condicion_iva_receptor_id SMALLINT UNSIGNED NOT NULL,    -- código ARCA (5=Consumidor Final, 1=RI, 6=Monotributo, etc.)
  receptor_nombre           VARCHAR(255) NULL,             -- opcional, solo para mostrar en el PDF / registro interno
  domicilio_receptor        VARCHAR(255) NULL,             -- opcional, idem receptor_nombre

  importe_neto              DECIMAL(10,2) NOT NULL DEFAULT 0,
  importe_iva               DECIMAL(10,2) NOT NULL DEFAULT 0,
  importe_total             DECIMAL(10,2) NOT NULL,
  moneda                    VARCHAR(3) NOT NULL DEFAULT 'PES',

  cae                       VARCHAR(14) NULL,
  cae_vencimiento           DATE NULL,

  estado                    ENUM('pendiente', 'aprobada', 'rechazada', 'error') NOT NULL DEFAULT 'pendiente',
  observaciones             TEXT NULL,     -- errores/observaciones crudos de ARCA, para debug
  entorno                   ENUM('homologacion', 'produccion') NOT NULL,

  creado_por                INT NULL,      -- users.id de quien cerró la cuenta
  fecha_emision             DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  fecha_cae                 DATETIME NULL,

  CONSTRAINT fk_factura_mesa    FOREIGN KEY (mesa_id)    REFERENCES mesas(id),
  CONSTRAINT fk_factura_usuario FOREIGN KEY (creado_por) REFERENCES users(id),

  -- Evita doble emisión para la misma cuenta si el usuario reintenta el cierre.
  UNIQUE KEY uq_facturas_sesion (mesa_id, sesion_apertura),
  INDEX idx_facturas_estado_fecha (estado, fecha_emision)
);
