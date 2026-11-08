-- J2: Contable, ejercicios y períodos, y reglas de imputación (Contable RF02, RF03, RN05, RN06, RN34, EX03, EX04, EX13). Re-ejecutable.

-- Una regla dice qué cuenta va al debe y cuál al haber de un componente de un formulario (tipo de documento o evento). `criterio` afina por forma de pago, categoría o motivo; '*' es la regla general.
-- La vigencia permite imputar un documento con las reglas de su fecha (RN34).
CREATE TABLE IF NOT EXISTS con_reglas (
  id              INT          AUTO_INCREMENT PRIMARY KEY,
  formulario      VARCHAR(40)  NOT NULL,
  componente      VARCHAR(40)  NOT NULL,
  criterio        VARCHAR(60)  NOT NULL DEFAULT '*',
  cuenta_debe_id  INT          NULL,
  cuenta_haber_id INT          NULL,
  vigencia_desde  DATE         NOT NULL,
  activa          TINYINT(1)   NOT NULL DEFAULT 0,
  predeterminada  TINYINT(1)   NOT NULL DEFAULT 0,
  actualizada_ms  BIGINT       NOT NULL,
  CONSTRAINT uq_con_regla UNIQUE (formulario, componente, criterio, vigencia_desde),
  CONSTRAINT fk_con_regla_debe FOREIGN KEY (cuenta_debe_id) REFERENCES con_cuentas(id),
  CONSTRAINT fk_con_regla_haber FOREIGN KEY (cuenta_haber_id) REFERENCES con_cuentas(id),
  KEY idx_con_regla_form (formulario, componente)
);

-- Cierres y reaperturas de períodos, con su motivo (RN06).
CREATE TABLE IF NOT EXISTS con_periodo_log (
  id          INT          AUTO_INCREMENT PRIMARY KEY,
  periodo_id  INT          NOT NULL,
  accion      VARCHAR(12)  NOT NULL,
  motivo      VARCHAR(255) NULL,
  usuario_id  INT          NULL,
  ms          BIGINT       NOT NULL,
  CONSTRAINT fk_con_plog_periodo FOREIGN KEY (periodo_id) REFERENCES con_periodos(id)
);

INSERT IGNORE INTO rol_permisos (rol_id, permiso, nivel)
SELECT r.id, p.permiso, p.nivel FROM roles r JOIN (
  SELECT 'gerente' rol, 'contable.reglas.editar' permiso, 'permitido' nivel UNION ALL
  SELECT 'contador', 'contable.reglas.editar', 'permitido' UNION ALL
  SELECT 'gerente', 'contable.periodos.cerrar', 'permitido' UNION ALL
  SELECT 'contador', 'contable.periodos.cerrar', 'permitido' UNION ALL
  SELECT 'gerente', 'contable.periodos.reabrir', 'requiere_autorizacion' UNION ALL
  SELECT 'contador', 'contable.periodos.reabrir', 'permitido'
) p ON p.rol = r.codigo;
