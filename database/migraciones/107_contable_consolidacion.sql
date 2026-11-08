-- J9: Contable, consolidación en la Casa Central (Contable RF22, RF23, RN26, EX15 a EX17). Re-ejecutable.

-- Los planes de cuentas de cada sucursal se relacionan con el de la Casa Central por una tabla de equivalencias por sucursal; la consolidación no sincroniza planes.
CREATE TABLE IF NOT EXISTS con_equivalencias_consol (
  sucursal        VARCHAR(10) NOT NULL,
  codigo_sucursal VARCHAR(20) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  codigo_central  VARCHAR(20) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  PRIMARY KEY (sucursal, codigo_sucursal)
);

INSERT IGNORE INTO rol_permisos (rol_id, permiso, nivel)
SELECT r.id, p.permiso, p.nivel FROM roles r JOIN (
  SELECT 'gerente' rol, 'contable.consolidacion.configurar' permiso, 'permitido' nivel UNION ALL
  SELECT 'contador', 'contable.consolidacion.configurar', 'permitido'
) p ON p.rol = r.codigo;
