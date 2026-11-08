-- J7: Contable, controles cruzados, asiento de apertura con saldos iniciales y navegación al origen (Contable RF11, RF13, RN13, EX06, EX12). Re-ejecutable.

-- Cada ejecución de los controles queda guardada: es el informe de diferencias y lo que mira el cierre cuando está configurado para bloquear (J8).
CREATE TABLE IF NOT EXISTS con_controles (
  id              INT         AUTO_INCREMENT PRIMARY KEY,
  ms              BIGINT      NOT NULL,
  usuario_id      INT         NULL,
  con_diferencias INT         NOT NULL DEFAULT 0,
  resultado       MEDIUMTEXT  NOT NULL
);

INSERT IGNORE INTO rol_permisos (rol_id, permiso, nivel)
SELECT r.id, p.permiso, p.nivel FROM roles r JOIN (
  SELECT 'gerente' rol, 'contable.controles.ejecutar' permiso, 'permitido' nivel UNION ALL
  SELECT 'contador', 'contable.controles.ejecutar', 'permitido' UNION ALL
  SELECT 'gerente', 'contable.apertura.registrar', 'permitido' UNION ALL
  SELECT 'contador', 'contable.apertura.registrar', 'permitido'
) p ON p.rol = r.codigo;
