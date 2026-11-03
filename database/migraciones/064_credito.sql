-- E3: crédito (Clientes y CC RF12, RF13, RF26, RF27, RF28, RN03, RN04, RN33, RN34, RN35, RN41, EX04, EX20 a EX27; Ventas RF16 y VEN-CC).
-- Re-ejecutable: tablas IF NOT EXISTS, ALTER condicionados a su columna centinela, semillas con INSERT IGNORE.

-- Reserva de crédito: dura 5 minutos (parametrizable), reduce el disponible de la cuenta y se convierte en deuda al registrarse el débito.
CREATE TABLE IF NOT EXISTS reservas_credito (
  id_reserva    VARCHAR(40)   CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  cuenta_id     INT           NOT NULL,
  importe       DECIMAL(14,2) NOT NULL,
  id_solicitud  VARCHAR(80)   CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  reemplaza_a   VARCHAR(40)   CHARACTER SET ascii COLLATE ascii_bin NULL,
  origen        VARCHAR(80)   NULL,
  modo          VARCHAR(30)   NOT NULL,
  autorizada_por INT          NULL,
  estado        ENUM('vigente', 'convertida', 'liberada', 'vencida') NOT NULL DEFAULT 'vigente',
  vence_ms      BIGINT        NOT NULL,
  renovaciones  INT           NOT NULL DEFAULT 0,
  created_ms    BIGINT        NOT NULL,
  CONSTRAINT uq_reserva_credito_solicitud UNIQUE (id_solicitud),
  CONSTRAINT fk_reserva_credito_cuenta FOREIGN KEY (cuenta_id) REFERENCES cuentas_corrientes(id),
  KEY idx_reserva_credito_cuenta (cuenta_id, estado, vence_ms)
);

-- Veredictos emitidos, con su motivo (Veredicto_Credito).
CREATE TABLE IF NOT EXISTS veredictos_credito (
  id          BIGINT        AUTO_INCREMENT PRIMARY KEY,
  cuenta_id   INT           NULL,
  cliente_id  INT           NULL,
  importe     DECIMAL(14,2) NOT NULL,
  veredicto   ENUM('permitida', 'requiere_autorizacion', 'bloqueada') NOT NULL,
  motivo      VARCHAR(500)  NULL,
  created_at  TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_veredicto_cuenta (cuenta_id, created_at)
);

SET @sql = (
  SELECT IF(COUNT(*) = 0, 'ALTER TABLE cuentas_corrientes ADD COLUMN mora_exenta_hasta_mov BIGINT NOT NULL DEFAULT 0', 'SELECT 1')
  FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'cuentas_corrientes' AND column_name = 'mora_exenta_hasta_mov'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql = (
  SELECT IF(COUNT(*) = 0, 'ALTER TABLE movimientos_cc ADD COLUMN excedente DECIMAL(14,2) NULL', 'SELECT 1')
  FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'movimientos_cc' AND column_name = 'excedente'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

INSERT IGNORE INTO parametros (clave, valor) VALUES ('cc_modo_credito', 'requerir_autorizacion'), ('cc_reserva_minutos', '5'), ('cc_reserva_pedido_horas', '24');

-- Forma de pago "Cuenta Corriente": solo se ofrece con VEN-CC y Clientes instalado (Ventas RF16).
INSERT IGNORE INTO formas_pago (codigo, nombre, requiere_referencia, admite_vuelto, orden) VALUES ('cuenta_corriente', 'Cuenta Corriente', 0, 0, 90);

INSERT IGNORE INTO rol_permisos (rol_id, permiso, nivel)
SELECT r.id, p.permiso, p.nivel FROM roles r JOIN (
  SELECT 'gerente' rol, 'clientes.credito.configurar' permiso, 'permitido' nivel UNION ALL
  SELECT 'gerente', 'clientes.cuentas.bloquear', 'permitido' UNION ALL
  SELECT 'administrativo', 'clientes.cuentas.bloquear', 'permitido' UNION ALL
  SELECT 'gerente', 'ventas.credito.autorizar', 'permitido' UNION ALL
  SELECT 'encargado', 'ventas.credito.autorizar', 'permitido'
) p ON p.rol = r.codigo;
