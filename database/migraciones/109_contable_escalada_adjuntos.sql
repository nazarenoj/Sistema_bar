-- Contable: escalada de pendientes vencidos al Administrador (Usuarios RN85, Contable RN08) y adjuntos de asientos manuales (RF05). Re-ejecutable.

SET @c = (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'con_pendientes' AND column_name = 'escalado_ms');
SET @s = IF(@c = 0, 'ALTER TABLE con_pendientes ADD COLUMN escalado_ms BIGINT NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

CREATE TABLE IF NOT EXISTS con_adjuntos (
  id          INT          AUTO_INCREMENT PRIMARY KEY,
  asiento_id  INT          NOT NULL,
  nombre      VARCHAR(120) NOT NULL,
  tipo        VARCHAR(60)  NOT NULL,
  contenido   MEDIUMBLOB   NOT NULL,
  usuario_id  INT          NULL,
  ms          BIGINT       NOT NULL,
  CONSTRAINT fk_con_adjunto_asiento FOREIGN KEY (asiento_id) REFERENCES con_asientos(id),
  KEY idx_con_adjunto_asiento (asiento_id)
);

INSERT IGNORE INTO rol_permisos (rol_id, permiso, nivel)
SELECT r.id, p.permiso, p.nivel FROM roles r JOIN (
  SELECT 'gerente' rol, 'contable.plan.actualizar' permiso, 'permitido' nivel UNION ALL
  SELECT 'contador', 'contable.plan.actualizar', 'permitido'
) p ON p.rol = r.codigo;
