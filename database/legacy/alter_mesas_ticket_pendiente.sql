USE sistema_chepola;

-- Indica que la mesa ya finalizó su cuenta (todos los pedidos cerrados) pero todavía no se
-- imprimió ni descargó el ticket correspondiente. Mientras esté en 1, la mesa sigue figurando
-- "ocupada": no se pueden abrir nuevos pedidos en ella ni volver a cerrar la cuenta.
ALTER TABLE mesas
  ADD COLUMN ticket_pendiente TINYINT(1) NOT NULL DEFAULT 0;
