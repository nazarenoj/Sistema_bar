-- B6: secuenciador de comprobantes (Ventas RF47, RN12, RN49, RN50, RN52). Una sola solicitud en vuelo
-- por clave "punto de venta : tipo : modalidad". El candado es una fila con arrendamiento (vence_ms):
-- se puede listar, y si quien lo tenía se cae, otro lo toma al vencer. Reemplaza al GET_LOCK, que es de
-- sesión, no vence solo y no se puede ver ni liberar desde la aplicación.

CREATE TABLE IF NOT EXISTS secuenciador_claves (
  clave       VARCHAR(40) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  estado      ENUM('libre', 'ocupada') NOT NULL DEFAULT 'libre',
  propietario VARCHAR(64) NULL,
  vence_ms    BIGINT      NOT NULL DEFAULT 0
);

-- Cada solicitud de emisión es un intento idempotente (id_intento = ID_Solicitud del cierre o del reintento).
-- Estados: solicitado -> autorizado | rechazado | indeterminado (se cortó después de enviar a ARCA).
CREATE TABLE IF NOT EXISTS intento_emision (
  id           INT          AUTO_INCREMENT PRIMARY KEY,
  id_intento   VARCHAR(64)  NOT NULL,
  clave        VARCHAR(40)  CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  numero       INT UNSIGNED NULL,
  estado       ENUM('solicitado', 'autorizado', 'rechazado', 'indeterminado') NOT NULL DEFAULT 'solicitado',
  resultado    MEDIUMTEXT   NULL,
  created_at   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT uq_intento UNIQUE (id_intento),
  KEY idx_intento_clave (clave, estado)
);

-- Tope de consumidor final sin identificar, en pesos (Ventas RN14). 0 = sin control: ARCA lo actualiza
-- por resolución y hay que cargar el vigente para que el sistema exija identificar al receptor.
INSERT IGNORE INTO parametros (clave, valor) VALUES ('tope_consumidor_final', '0');
