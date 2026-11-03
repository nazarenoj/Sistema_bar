const pool = require('../config/db');
const Funciones = require('../funciones/servicio');
const Modulos = require('../modulos/registro');
const llamar = require('../modulos/llamar');
const Clientes = require('./clienteService');

// Clientes alcanzados por un retiro de lote (Clientes y CC RF30, EX32; requiere Stock y STK-TRAZA). Llama hacia abajo a Stock por el servicio «Alcance de un retiro de lote»
// (llamada n.º 13, 3 s) y completa el contacto de cada cliente; el aviso (Pendiente / Avisado / Recuperado) es de Stock y no se copia acá: se marca llamando a ese servicio.
class RetiroInvalido extends Error {}
const invalida = (m, status = 400, extra = {}) => Object.assign(new RetiroInvalido(m), { status, ...extra });

const disponible = async () => (await Modulos.estaInstalado('stock')) && (await Funciones.estaActiva('STK-TRAZA'));

const contacto = async (clienteId) => {
  const c = await Clientes.resolver(clienteId); // si es un alias responde con la ficha resultante (RN43)
  if (!c) return null;
  const [[dom]] = await pool.query('SELECT direccion FROM cliente_domicilios WHERE cliente_id = ? ORDER BY id LIMIT 1', [c.id]);
  return { cliente_id: c.id, cliente: c.razon_social, telefono: c.telefono, email: c.email, domicilio: dom?.direccion ?? c.domicilio_fiscal ?? null };
};

const alcance = async (retiroId) => {
  if (!(await disponible())) throw invalida('La consulta de clientes alcanzados necesita Stock con trazabilidad (STK-TRAZA).', 409, { codigo: 'OPCION_NO_DISPONIBLE' });
  const r = await llamar(13, 'clientes', async () => require('../stock/trazaService').alcance(retiroId));
  if (r.fallo) throw invalida('Alcance no disponible: Stock no respondió. Reintentá.', 503, { codigo: 'ALCANCE_NO_DISPONIBLE' }); // EX32: no se muestra un listado anterior
  if (!r.valor) throw invalida('Retiro no encontrado.', 404);
  const lineas = [];
  for (const l of r.valor.lineas) lineas.push({ ...l, contacto: l.cliente_id ? await contacto(l.cliente_id) : null }); // sin cliente identificado se muestra sin contacto
  const identificados = new Set(lineas.filter((l) => l.contacto).map((l) => l.contacto.cliente_id));
  return { ...r.valor, lineas, clientes_alcanzados: identificados.size, sin_cliente: lineas.filter((l) => !l.contacto).length };
};

// Marca la línea como «Avisado» (usuario, medio y fecha) por el servicio de Stock; si falla, la línea sigue «Pendiente de aviso» y se puede reintentar (EX32).
const marcarAvisado = async (lineaId, { medio }, { userId = null } = {}) => {
  if (!(await disponible())) throw invalida('La consulta de clientes alcanzados necesita Stock con trazabilidad (STK-TRAZA).', 409, { codigo: 'OPCION_NO_DISPONIBLE' });
  if (!String(medio ?? '').trim()) throw invalida('Indicá el medio por el que se avisó (teléfono, correo, WhatsApp, en persona…).');
  const r = await llamar(13, 'clientes', async () => require('../stock/trazaService').avisar(lineaId, { userId, medio: String(medio).trim().slice(0, 40) }));
  if (r.fallo) throw invalida(`No se pudo marcar el aviso (${r.motivo ?? 'Stock no respondió'}): la línea sigue pendiente de aviso. Reintentá.`, 503, { codigo: 'ALCANCE_NO_DISPONIBLE' });
  return r.valor;
};

module.exports = { RetiroInvalido, disponible, alcance, marcarAvisado };
