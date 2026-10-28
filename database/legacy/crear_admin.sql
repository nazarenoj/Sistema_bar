USE sistema_chepola;

-- Alta de usuario admin. El valor de password_hash NO puede ser la contraseña en texto plano:
-- tiene que ser un hash bcrypt (la app valida con bcrypt.compare en authController.js).
-- Generá el hash antes de correr este script (ver instrucciones abajo) y reemplazá
-- 'REEMPLAZAR_CON_HASH_BCRYPT' por el valor generado.

INSERT INTO users (username, password_hash, rol)
VALUES ('admin', 'REEMPLAZAR_CON_HASH_BCRYPT', 'admin')
ON DUPLICATE KEY UPDATE password_hash = VALUES(password_hash), rol = VALUES(rol);
