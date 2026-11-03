-- F2: actualización automática de cotizaciones (Usuarios RF22, EX12). Función USU-COTIZ-AUTO.
-- La fuente es configurable: una dirección que devuelve JSON y la ruta (con puntos) de la cotización compradora y la vendedora.
CREATE TABLE IF NOT EXISTS cotizacion_fuentes (
  moneda        VARCHAR(3)   NOT NULL PRIMARY KEY,
  url           VARCHAR(300) NOT NULL,
  ruta_comprador VARCHAR(60) NOT NULL,
  ruta_vendedor  VARCHAR(60) NOT NULL,
  activa        TINYINT(1)   NOT NULL DEFAULT 1,
  ultimo_intento DATETIME    NULL,
  ultimo_error  VARCHAR(255) NULL,
  CONSTRAINT fk_fuente_moneda FOREIGN KEY (moneda) REFERENCES monedas(codigo)
);

-- Frecuencia de la consulta, en horas (por defecto una vez por día hábil).
INSERT IGNORE INTO parametros (clave, valor) VALUES ('cotizacion_auto_horas', '24');

INSERT IGNORE INTO rol_permisos (rol_id, permiso, nivel)
SELECT r.id, p.permiso, p.nivel FROM roles r JOIN (
  SELECT 'gerente' rol, 'usuarios.cotizaciones.fuentes' permiso, 'permitido' nivel
) p ON p.rol = r.codigo;
