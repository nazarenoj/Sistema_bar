USE sistema_chepola;

CREATE TABLE IF NOT EXISTS salones (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  nombre      VARCHAR(100) NOT NULL,
  color_fondo VARCHAR(20)  NOT NULL DEFAULT '#f9fafb',
  orden       INT          NOT NULL DEFAULT 0,
  created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO salones (nombre, orden) VALUES ('Salón Principal', 0);

-- Columnas nuevas de mesas: salón al que pertenece, tamaño del cuadrado,
-- colores propios (si son NULL se usa el color por defecto libre/ocupado) y grupo de combinación
ALTER TABLE mesas
  ADD COLUMN salon_id      INT NOT NULL DEFAULT 1,
  ADD COLUMN tamano        INT NOT NULL DEFAULT 96,
  ADD COLUMN color_libre   VARCHAR(20) NULL,
  ADD COLUMN color_ocupado VARCHAR(20) NULL,
  ADD COLUMN grupo_id      INT NULL,
  ADD CONSTRAINT fk_mesa_salon FOREIGN KEY (salon_id) REFERENCES salones(id);

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
