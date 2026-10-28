USE sistema_chepola;

-- Sillas dibujadas alrededor de cada mesa en el mapa del salón: cantidad y posición fijas,
-- configurables a mano en modo edición (independientes de los pedidos/cuentas abiertas).
CREATE TABLE IF NOT EXISTS mesa_sillas (
  id      INT AUTO_INCREMENT PRIMARY KEY,
  mesa_id INT NOT NULL,
  pos_x   INT NOT NULL DEFAULT 0,
  pos_y   INT NOT NULL DEFAULT 0,
  CONSTRAINT fk_silla_mesa FOREIGN KEY (mesa_id) REFERENCES mesas(id) ON DELETE CASCADE
);
