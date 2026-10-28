USE sistema_chepola;

-- Cierre de cuenta: cuándo se finalizó el pedido (mismo valor para los pedidos cerrados juntos)
ALTER TABLE pedidos
  ADD COLUMN fecha_cierre TIMESTAMP NULL DEFAULT NULL AFTER fecha_creacion;

-- Posición libre de la mesa en la grilla visual (arrastrable)
ALTER TABLE mesas
  ADD COLUMN pos_x INT NOT NULL DEFAULT 0,
  ADD COLUMN pos_y INT NOT NULL DEFAULT 0;

-- Backfill: distribuye las mesas existentes en una grilla de 4 columnas para que no queden superpuestas
UPDATE mesas SET pos_x = (id % 4) * 170, pos_y = FLOOR(id / 4) * 150;
