-- E5: informes de cuentas corrientes y recordatorios (Clientes y CC RF14, RF15, RF16, RF25, EX12).
-- Envíos al cliente (estado de cuenta, recordatorio): quedan en la cola de correo con reintento y se marcan «No enviado» si no se logran.
CREATE TABLE IF NOT EXISTS envios_cliente (
  id               INT          AUTO_INCREMENT PRIMARY KEY,
  cliente_id       INT          NOT NULL,
  cuenta_id        INT          NULL,
  tipo             ENUM('estado_cuenta', 'recordatorio') NOT NULL,
  destino          VARCHAR(150) NOT NULL,
  asunto           VARCHAR(200) NOT NULL,
  correo_cola_id   INT          NULL,
  user_id          INT          NULL,
  created_at       TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_envio_cliente (cliente_id, tipo, created_at)
);

-- Tramos de la antigüedad de saldos (días desde la fecha del comprobante) y reglas de los recordatorios.
INSERT IGNORE INTO parametros (clave, valor) VALUES ('cc_tramos_antiguedad', '30,60,90'), ('cc_recordatorio_dias_antes', '3'), ('cc_recordatorio_repetir_dias', '7');
