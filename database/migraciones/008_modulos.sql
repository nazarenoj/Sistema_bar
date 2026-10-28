-- Fase A7: módulos instalados en la instancia (Usuarios RF13, RF26). Usuarios es obligatorio.
-- Stock figura instalado porque el sistema ya trae insumos y recetas desde antes.
CREATE TABLE IF NOT EXISTS modulos_instalados (
  codigo       VARCHAR(30) NOT NULL PRIMARY KEY,
  instalado_en TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT IGNORE INTO modulos_instalados (codigo) VALUES ('usuarios'), ('ventas'), ('stock');
