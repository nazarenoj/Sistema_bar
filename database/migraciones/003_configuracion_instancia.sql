-- Datos de la instancia (una fila por base de datos). Los carga el alta (scripts/alta-instancia.js).
-- codigo_instancia es el prefijo de todos los ID_Global (Usuarios RN81): se fija en el alta y no se
-- cambia. perfil_rubro solo se guarda; aplicarlo a las funciones activables llega con la Fase A8.
CREATE TABLE IF NOT EXISTS configuracion_instancia (
  id               TINYINT       NOT NULL PRIMARY KEY DEFAULT 1,
  codigo_instancia VARCHAR(10)   NOT NULL,
  razon_social     VARCHAR(150)  NOT NULL,
  cuit             VARCHAR(11)   NULL,
  sucursal         VARCHAR(100)  NOT NULL,
  zona_horaria     VARCHAR(60)   NOT NULL DEFAULT 'America/Argentina/Buenos_Aires',
  moneda_local     VARCHAR(3)    NOT NULL DEFAULT 'ARS',
  perfil_rubro     ENUM('cafeteria', 'produccion_alimentos', 'cafeteria_produccion_propia', 'personalizado') NOT NULL DEFAULT 'cafeteria',
  created_at       TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT chk_config_unica CHECK (id = 1)
);
