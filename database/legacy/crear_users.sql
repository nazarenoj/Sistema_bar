USE sistema_chepola;

-- Login básico. El campo "rol" no habilita todavía ningún permiso diferenciado (ambos roles
-- pueden hacer las mismas acciones); existe para no tener que migrar el esquema el día que se
-- quiera diferenciar qué puede hacer cada uno.
CREATE TABLE IF NOT EXISTS users (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  username      VARCHAR(50) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  rol           ENUM('admin', 'empleado') NOT NULL DEFAULT 'empleado',
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
