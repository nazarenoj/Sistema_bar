USE sistema_chepola;

-- El método de pago vivía solo en `facturas`: una cuenta cerrada sin facturar lo perdía. Ahora se
-- guarda en cada pedido de la cuenta (todos los de la misma mesa_id + sesion_apertura).
ALTER TABLE pedidos
  ADD COLUMN metodo_pago ENUM('efectivo', 'tarjeta_debito', 'tarjeta_credito', 'transferencia', 'otro') NULL AFTER total;

-- Cuentas ya facturadas: se copia el método que ya tenían. Las cerradas sin factura antes de esta
-- migración quedan en NULL (el dato no se guardó nunca).
UPDATE pedidos p
JOIN facturas f ON f.mesa_id = p.mesa_id AND f.sesion_apertura = p.sesion_apertura
SET p.metodo_pago = f.metodo_pago;
