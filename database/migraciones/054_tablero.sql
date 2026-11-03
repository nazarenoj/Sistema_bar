-- F3: tablero de indicadores (Usuarios RF19, RN34 a RN37). Función USU-TABLERO. Lo que cada usuario elige y su período por defecto;
-- sin filas ve el tablero predeterminado de su rol (todo lo que puede ver).
CREATE TABLE IF NOT EXISTS tablero_usuario (
  user_id      INT         NOT NULL,
  indicador_id VARCHAR(60) NOT NULL,
  orden        INT         NOT NULL,
  PRIMARY KEY (user_id, indicador_id),
  CONSTRAINT fk_tablero_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS tablero_preferencias (
  user_id INT NOT NULL PRIMARY KEY,
  periodo ENUM('dia', 'semana', 'mes') NOT NULL DEFAULT 'dia',
  CONSTRAINT fk_tablero_pref_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
