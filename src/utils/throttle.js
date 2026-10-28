// Freno de intentos fallidos de PIN o tarjeta por terminal (o por IP si no hay terminal). El PIN
// identifica al usuario sin pedir su nombre, así que no hay una cuenta a la que atribuir el fallo y
// no se puede bloquear "al usuario" como en el ingreso con contraseña.
// shortcut: queda en la memoria del proceso (se pierde al reiniciar y no se comparte entre
// procesos); pasar a una tabla cuando la app corra en más de un proceso.
const intentos = new Map(); // clave -> { n, hasta }; quien llama incluye la instancia en la clave

// Minutos que faltan para poder reintentar (0 = no está bloqueado).
const bloqueadoPor = (clave) => {
  const e = intentos.get(clave);
  return e && e.hasta > Date.now() ? Math.ceil((e.hasta - Date.now()) / 60000) : 0;
};

const registrarFallo = (clave, max, minutos) => {
  const e = intentos.get(clave) || { n: 0, hasta: 0 };
  e.n += 1;
  if (e.n >= max) { e.n = 0; e.hasta = Date.now() + minutos * 60000; }
  intentos.set(clave, e);
};

const limpiar = (clave) => intentos.delete(clave);

module.exports = { bloqueadoPor, registrarFallo, limpiar };
