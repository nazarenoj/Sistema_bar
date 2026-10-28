USE sistema_chepola;

-- Domicilio del cliente/receptor, capturado opcionalmente al cerrar la cuenta para completar el
-- encabezado del comprobante impreso (no lo exige ARCA para Consumidor Final, pero se muestra en
-- el PDF si el mostrador lo cargó).
ALTER TABLE facturas
  ADD COLUMN domicilio_receptor VARCHAR(255) NULL AFTER receptor_nombre;
