USE sistema_chepola;

CREATE TABLE IF NOT EXISTS mesas (
  id          INT  AUTO_INCREMENT PRIMARY KEY,
  numero_mesa INT  NOT NULL UNIQUE,
  estado      ENUM('libre', 'ocupado') NOT NULL DEFAULT 'libre'
);

CREATE TABLE IF NOT EXISTS pedidos (
  id             INT           AUTO_INCREMENT PRIMARY KEY,
  mesa_id        INT           NOT NULL,
  estado         ENUM('activo', 'finalizado') NOT NULL DEFAULT 'activo',
  total          DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  fecha_creacion TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_pedido_mesa FOREIGN KEY (mesa_id) REFERENCES mesas(id)
);

CREATE TABLE IF NOT EXISTS pedido_productos (
  id              INT           AUTO_INCREMENT PRIMARY KEY,
  pedido_id       INT           NOT NULL,
  producto_id     INT           NOT NULL,
  cantidad        INT           NOT NULL,
  precio_unitario DECIMAL(10,2) NOT NULL,
  CONSTRAINT fk_pp_pedido   FOREIGN KEY (pedido_id)   REFERENCES pedidos(id),
  CONSTRAINT fk_pp_producto FOREIGN KEY (producto_id) REFERENCES productos(id)
);
