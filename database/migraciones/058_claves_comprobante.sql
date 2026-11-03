-- F6: identificación de comprobantes de terceros (Usuarios RF27, RN63 a RN68, RN84, EX42 a EX46, EX57). Servicio de plataforma, siempre vigente.
-- Una clave por comprobante recibido de un tercero (emisor + clase + letra + punto de venta + número, normalizados). Entre las Reservadas y las
-- Vigentes la clave es única (columna generada con índice único), así dos reservas simultáneas de la misma clave no pasan las dos (RN64).
CREATE TABLE IF NOT EXISTS claves_comprobante (
  id_clave           INT          AUTO_INCREMENT PRIMARY KEY,
  clave              VARCHAR(160) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  cuit_emisor        CHAR(11)     NULL,
  razon_social       VARCHAR(120) NULL,
  clase              VARCHAR(20)  NOT NULL,
  tipo_letra         CHAR(1)      NOT NULL,
  punto_venta        CHAR(5)      NOT NULL,
  numero             CHAR(8)      NOT NULL,
  fecha_comprobante  DATE         NULL,
  importe            DECIMAL(14,2) NULL,
  cae                VARCHAR(14)  NULL,
  cae_tipo           ENUM('CAE', 'CAEA') NULL,
  modulo_dueno       VARCHAR(20)  NOT NULL,
  id_documento_dueno VARCHAR(60)  NULL,
  id_clave_vinculada INT          NULL,
  estado             ENUM('reservada', 'vigente', 'liberada', 'vencida') NOT NULL DEFAULT 'reservada',
  reservada_hasta    DATETIME     NULL,
  id_reserva         VARCHAR(40)  CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  reemplaza_a        INT          NULL,
  motivo_confirmacion VARCHAR(255) NULL,
  user_id            INT          NULL,
  terminal           VARCHAR(40)  NULL,
  autorizante_id     INT          NULL,
  id_solicitud       VARCHAR(64)  NULL,
  created_at         TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at         TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  clave_activa       VARCHAR(160) CHARACTER SET ascii COLLATE ascii_bin AS (IF(estado IN ('reservada', 'vigente'), clave, NULL)) STORED,
  CONSTRAINT uq_clave_activa UNIQUE (clave_activa),
  CONSTRAINT uq_clave_reserva UNIQUE (id_reserva),
  CONSTRAINT uq_clave_solicitud UNIQUE (id_solicitud),
  KEY idx_clave_numero (cuit_emisor, numero),
  KEY idx_clave_cae (cae),
  KEY idx_clave_fecha (cuit_emisor, fecha_comprobante)
);

-- Un comprobante se carga una vez aunque lo usen varios módulos: cada uno agrega su vínculo (RN84).
CREATE TABLE IF NOT EXISTS clave_vinculos (
  id_vinculo   INT         AUTO_INCREMENT PRIMARY KEY,
  id_clave     INT         NOT NULL,
  modulo       VARCHAR(20) NOT NULL,
  id_documento VARCHAR(60) NOT NULL,
  rol          ENUM('registro_fisico', 'registro_fiscal', 'pago_o_gasto') NOT NULL DEFAULT 'registro_fisico',
  estado       ENUM('vigente', 'anulado') NOT NULL DEFAULT 'vigente',
  user_id      INT         NULL,
  created_at   TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_vinculo UNIQUE (id_clave, modulo, id_documento),
  CONSTRAINT fk_vinculo_clave FOREIGN KEY (id_clave) REFERENCES claves_comprobante(id_clave)
);

-- Pares confirmados como distintos: no vuelven a advertirse (RN65).
CREATE TABLE IF NOT EXISTS clave_distintas (
  clave_a    VARCHAR(160) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  clave_b    VARCHAR(160) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  motivo     VARCHAR(255) NOT NULL,
  user_id    INT          NULL,
  autorizante_id INT      NULL,
  created_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (clave_a, clave_b)
);

-- Intentos bloqueados (duplicado exacto, CAE repetido): quedan registrados con quién y cuándo (EX42, EX44).
CREATE TABLE IF NOT EXISTS clave_intentos (
  id         INT          AUTO_INCREMENT PRIMARY KEY,
  clave      VARCHAR(160) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  resultado  VARCHAR(30)  NOT NULL,
  detalle    VARCHAR(255) NULL,
  modulo     VARCHAR(20)  NULL,
  user_id    INT          NULL,
  created_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_clave_intento (clave)
);

INSERT IGNORE INTO parametros (clave, valor) VALUES ('clave_reserva_minutos', '15');

-- Continuar con un casi duplicado exige permiso (RN65): Administrador, Gerente y Administrativo lo tienen; Depósito requiere autorización.
INSERT IGNORE INTO rol_permisos (rol_id, permiso, nivel)
SELECT r.id, p.permiso, p.nivel FROM roles r JOIN (
  SELECT 'gerente' rol, 'usuarios.comprobantes.confirmar_casi_duplicado' permiso, 'permitido' nivel UNION ALL
  SELECT 'administrativo', 'usuarios.comprobantes.confirmar_casi_duplicado', 'permitido' UNION ALL
  SELECT 'deposito', 'usuarios.comprobantes.confirmar_casi_duplicado', 'requiere_autorizacion'
) p ON p.rol = r.codigo;
