const M = require('../mensajeria/servicio');

// Hechos de Financiero que toma Contable (Contable RF03, RF18, RF19, RN32, RN37). Cada uno sale por la bandeja de salida dentro de la transacción del hecho; si Contable no está instalado no se
// genera mensaje. Solo en pesos: la contabilidad de cuentas en divisa queda aparte. El cobro de Ventas y el pago de una orden de Compras no se informan acá (los trae su propio módulo, RN32).
const hoy = () => { const d = new Date(); const p = (x) => String(x).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };
// Caja de efectivo o cuenta bancaria, la clase con la que Contable elige la cuenta contable.
const claseDe = (tipo) => (String(tipo).startsWith('caja_') ? 'caja' : 'bancos');

const publicar = (conn, tipo, docTipo, docIdGlobal, contenido, { docVersion = 1, secuencia = 1, userId = null } = {}) =>
  M.publicar(conn, { origen: 'financiero', destino: 'contable', tipo, docTipo, docIdGlobal, docVersion, secuencia, userId, contenido: { fecha: hoy(), fecha_ms: Date.now(), ...contenido } });

module.exports = { publicar, claseDe, hoy };
