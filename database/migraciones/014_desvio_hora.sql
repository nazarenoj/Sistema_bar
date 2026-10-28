-- Fase A3: tolerancia del reloj de las terminales respecto de la hora del servidor (segundos). Pasado ese
-- desvío se alerta y se audita; la hora que se guarda es siempre la del servidor (Usuarios RN21, EX14).
INSERT IGNORE INTO parametros (clave, valor) VALUES ('desvio_hora_max_seg', '300');
