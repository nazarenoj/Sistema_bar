-- Ventas Online RF17: visitantes únicos por día (huella de IP y navegador, sin guardar datos personales). Re-ejecutable.
CREATE TABLE IF NOT EXISTS onl_visitantes (
  dia    DATE     NOT NULL,
  huella CHAR(16) NOT NULL,
  PRIMARY KEY (dia, huella)
);
