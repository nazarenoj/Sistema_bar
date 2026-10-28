const { porNumero } = require('./llamadas');
const { estaInstalado } = require('./registro');

// Única forma de hacer una llamada inmediata a otro módulo (Índice B.5): `llamar(n, quien, fn)`.
// Aplica el tiempo máximo del registro y, si no hay respuesta o falla, la política de falla:
//   cerrar                 → lanza un error LLAMADA_CERRADA (la acción no se ejecuta)
//   abrir_con_autorizacion → devuelve { fallo: true, requiereAutorizacion: true }
//   degradar               → devuelve { fallo: true, degradado: true }
// Si el módulo de destino no está instalado, la llamada no se hace: se trata como una falla
// inmediata de política `degradar`, porque la función depende de un módulo que no existe.
// `opciones.esperaMs` solo puede acortar el tiempo del registro (lo usan las pruebas).
const llamar = async (n, quien, fn, opciones = {}) => {
  const l = porNumero(n);
  if (!l) throw new Error(`La llamada n.º ${n} no figura en el registro (B.5): no puede existir.`);
  if (!l.caller.includes('*') && !l.caller.includes(quien))
    throw new Error(`El módulo "${quien}" no puede hacer la llamada n.º ${n} (${l.para}).`);

  if (l.callee !== '*' && l.callee !== 'arca' && l.callee !== 'usuarios' && !(await estaInstalado(l.callee)))
    return { fallo: true, degradado: true, motivo: `módulo ${l.callee} no instalado` };

  let timer;
  try {
    const valor = await Promise.race([
      fn(),
      new Promise((_, rej) => { timer = setTimeout(() => rej(Object.assign(new Error('tiempo agotado'), { agotado: true })), Math.min(l.esperaMs, opciones.esperaMs ?? Infinity)); }),
    ]);
    return { fallo: false, valor };
  } catch (err) {
    if (l.falla === 'cerrar') throw Object.assign(new Error(`${l.para}: sin respuesta (${err.message}).`), { codigo: 'LLAMADA_CERRADA', llamada: n, causa: err });
    return { fallo: true, motivo: err.message, ...(l.falla === 'degradar' ? { degradado: true } : { requiereAutorizacion: true }) };
  } finally {
    clearTimeout(timer);
  }
};

module.exports = llamar;
