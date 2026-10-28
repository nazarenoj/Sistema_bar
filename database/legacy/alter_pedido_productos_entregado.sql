USE sistema_chepola;

-- Seguimiento de servicio: si cada producto ya se llevó a la mesa. No afecta el total ni el
-- cierre de cuenta, es información aparte para saber qué falta entregar.
ALTER TABLE pedido_productos
  ADD COLUMN entregado TINYINT(1) NOT NULL DEFAULT 0;
