-- G1: Financiero, instalación, cajas, cuentas y categorías (Financiero RF01, RF11, RN02, RN08, RN19).
-- Re-ejecutable: tablas IF NOT EXISTS, semillas con INSERT IGNORE y triggers recreados.

CREATE TABLE IF NOT EXISTS fin_config (
  id                             TINYINT       NOT NULL PRIMARY KEY,
  antiguedad_max_reapertura_dias INT           NOT NULL DEFAULT 7,        -- RN43
  tolerancia_diferencia          DECIMAL(12,2) NOT NULL DEFAULT 0,        -- RN05
  exigir_turno_efectivo          TINYINT(1)    NOT NULL DEFAULT 1,        -- RN04
  retencion_solicitudes_dias     INT           NOT NULL DEFAULT 90        -- RN29, RN38
);
INSERT IGNORE INTO fin_config (id) VALUES (1);

CREATE TABLE IF NOT EXISTS fin_cuentas (
  id                  INT           AUTO_INCREMENT PRIMARY KEY,
  id_global           VARCHAR(40)   CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  tipo                ENUM('caja_efectivo', 'caja_reparto', 'caja_fuerte', 'banco', 'billetera', 'procesador', 'pasarela') NOT NULL,
  nombre              VARCHAR(80)   NOT NULL,
  moneda              CHAR(3)       NOT NULL DEFAULT 'ARS',
  saldo_inicial       DECIMAL(14,2) NOT NULL DEFAULT 0,
  cbu_alias           VARCHAR(40)   NULL,
  limite_descubierto  DECIMAL(14,2) NOT NULL DEFAULT 0,
  fondo_cambio        DECIMAL(14,2) NOT NULL DEFAULT 0,       -- propuesto al abrir un turno (RF03)
  tope_efectivo       DECIMAL(14,2) NULL,                     -- aviso de retiro a caja fuerte (RF03)
  terminal_id         INT           NULL,                     -- caja por terminal (RF01)
  cierre_ciego        TINYINT(1)    NOT NULL DEFAULT 0,       -- RN06
  activa              TINYINT(1)    NOT NULL DEFAULT 1,
  created_at          TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT uq_fin_cuenta_id_global UNIQUE (id_global),
  CONSTRAINT uq_fin_cuenta_nombre UNIQUE (nombre),
  KEY idx_fin_cuenta_terminal (terminal_id)
);

-- Árbol de categorías de ingresos y egresos (RF11). El nombre es único en toda la instancia.
CREATE TABLE IF NOT EXISTS fin_categorias (
  id        INT          AUTO_INCREMENT PRIMARY KEY,
  nombre    VARCHAR(80)  NOT NULL,
  padre_id  INT          NULL,
  tipo      ENUM('ingreso', 'egreso', 'ambos') NOT NULL DEFAULT 'egreso',
  activa    TINYINT(1)   NOT NULL DEFAULT 1,
  CONSTRAINT uq_fin_categoria_nombre UNIQUE (nombre),
  CONSTRAINT fk_fin_categoria_padre FOREIGN KEY (padre_id) REFERENCES fin_categorias(id)
);
INSERT IGNORE INTO fin_categorias (nombre, tipo) VALUES
  ('Ventas', 'ingreso'), ('Otros ingresos', 'ingreso'), ('Servicios', 'egreso'), ('Insumos de limpieza', 'egreso'),
  ('Descartables y packaging', 'egreso'), ('Mantenimiento y reparaciones', 'egreso'), ('Alquiler', 'egreso'),
  ('Impuestos y tasas', 'egreso'), ('Sueldos y cargas sociales', 'egreso'), ('Comisiones de vendedores', 'egreso'),
  ('Comisiones bancarias y de tarjetas', 'egreso'), ('Comisiones de plataformas', 'egreso'), ('Faltantes y sobrantes de caja', 'ambos');
INSERT IGNORE INTO fin_categorias (nombre, padre_id, tipo)
  SELECT h.nombre, p.id, 'egreso' FROM fin_categorias p JOIN (
    SELECT 'Energía' nombre, 'Servicios' padre UNION ALL SELECT 'Gas', 'Servicios' UNION ALL SELECT 'Agua', 'Servicios' UNION ALL SELECT 'Internet y telefonía', 'Servicios'
  ) h ON h.padre = p.nombre;

-- Movimientos de fondos (RN02): cada uno afecta a una sola caja o cuenta; el importe lleva signo (entra +, sale -) y no se edita ni se borra:
-- se corrige con un contramovimiento vinculado. El saldo siempre se deriva (saldo inicial + suma de movimientos).
CREATE TABLE IF NOT EXISTS fin_movimientos (
  id                 BIGINT        AUTO_INCREMENT PRIMARY KEY,
  id_global          VARCHAR(40)   CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  cuenta_id          INT           NOT NULL,
  turno_id           INT           NULL,
  tipo               VARCHAR(30)   NOT NULL,
  importe            DECIMAL(14,2) NOT NULL,
  moneda             CHAR(3)       NOT NULL DEFAULT 'ARS',
  importe_divisa     DECIMAL(14,2) NULL,
  cotizacion         DECIMAL(14,6) NULL,
  categoria_id       INT           NULL,
  forma_pago         VARCHAR(50)   NULL,
  referencia_externa VARCHAR(100)  NULL,
  id_operacion       VARCHAR(190)  CHARACTER SET ascii COLLATE ascii_bin NULL,
  linea              INT           NOT NULL DEFAULT 0,
  doc_id_global      VARCHAR(60)   CHARACTER SET ascii COLLATE ascii_bin NULL,
  vinculo_id         BIGINT        NULL,
  motivo             VARCHAR(255)  NULL,
  marcas             VARCHAR(200)  NULL,
  en_espera          TINYINT(1)    NOT NULL DEFAULT 0,
  user_id            INT           NULL,
  fecha_ms           BIGINT        NOT NULL,
  created_at         TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_fin_mov_id_global UNIQUE (id_global),
  CONSTRAINT uq_fin_mov_operacion UNIQUE (id_operacion, linea),
  CONSTRAINT fk_fin_mov_cuenta FOREIGN KEY (cuenta_id) REFERENCES fin_cuentas(id),
  KEY idx_fin_mov_cuenta (cuenta_id, fecha_ms),
  KEY idx_fin_mov_turno (turno_id),
  KEY idx_fin_mov_doc (doc_id_global, tipo)
);

DROP TRIGGER IF EXISTS fin_mov_no_editar;
CREATE TRIGGER fin_mov_no_editar BEFORE UPDATE ON fin_movimientos FOR EACH ROW
  IF NEW.importe <> OLD.importe OR NEW.tipo <> OLD.tipo OR NEW.cuenta_id <> OLD.cuenta_id OR NOT (NEW.id_operacion <=> OLD.id_operacion) OR NOT (NEW.vinculo_id <=> OLD.vinculo_id) OR NEW.fecha_ms <> OLD.fecha_ms THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Un movimiento de fondos no se edita: se corrige con un contramovimiento';
  END IF;
DROP TRIGGER IF EXISTS fin_mov_no_borrar;
CREATE TRIGGER fin_mov_no_borrar BEFORE DELETE ON fin_movimientos FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Un movimiento de fondos no se elimina: se corrige con un contramovimiento';

-- Permisos iniciales por rol (propuesta editable).
INSERT IGNORE INTO rol_permisos (rol_id, permiso, nivel)
SELECT r.id, p.permiso, p.nivel FROM roles r JOIN (
  SELECT 'gerente' rol, 'financiero.cajas.configurar' permiso, 'permitido' nivel UNION ALL
  SELECT 'gerente', 'financiero.saldos.ver', 'permitido' UNION ALL
  SELECT 'encargado', 'financiero.saldos.ver', 'permitido' UNION ALL
  SELECT 'administrativo', 'financiero.saldos.ver', 'permitido' UNION ALL
  SELECT 'contador', 'financiero.saldos.ver', 'permitido' UNION ALL
  SELECT 'cajero', 'financiero.cajas.ver', 'permitido' UNION ALL
  SELECT 'encargado', 'financiero.cajas.ver', 'permitido' UNION ALL
  SELECT 'gerente', 'financiero.cajas.ver', 'permitido' UNION ALL
  SELECT 'administrativo', 'financiero.cajas.ver', 'permitido' UNION ALL
  SELECT 'contador', 'financiero.cajas.ver', 'permitido'
) p ON p.rol = r.codigo;
