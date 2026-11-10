const pool = require('../config/db');
const Funciones = require('../funciones/servicio');
const { consultar } = require('./consultaService');
const { invalida, r2 } = require('./comun');

// Controles cruzados (Contable RF11, EX06) [CON-CONTROLES-CRUZADOS]: el saldo contable de una cuenta de control contra el saldo del módulo que la origina. Una diferencia se informa y no
// bloquea el cierre, salvo que esté configurado para hacerlo (J8). Un módulo caído se muestra como «no disponible» sin frenar la contabilidad.
const TOLERANCIA = 0.01;

// Saldo de las cuentas con esas claves, en su lado natural: positivo si es deudor para activos y acreedor para pasivos.
const saldoContable = async (claves, lado) => {
  const [[r]] = await pool.query(`SELECT COALESCE(SUM(l.debe), 0) AS d, COALESCE(SUM(l.haber), 0) AS h FROM con_asiento_lineas l JOIN con_cuentas c ON c.id = l.cuenta_id WHERE c.clave IN (?)`, [claves]);
  return r2(lado === 'deudor' ? Number(r.d) - Number(r.h) : Number(r.h) - Number(r.d));
};

// [id, nombre, módulo, consulta, claves, lado, cómo se lee el valor del módulo, requisito (función)]
const CONTROLES = [
  { id: 'deudores', nombre: 'Deudores por ventas contra Clientes y CC', modulo: 'clientes', consulta: 'deudores', claves: ['deudores'], lado: 'deudor', valor: (v) => v.total },
  { id: 'remitos', nombre: 'Remitos a facturar contra los remitos pendientes', modulo: 'ventas', consulta: 'remitos_pendientes', claves: ['remitos_a_facturar'], lado: 'acreedor', valor: (v) => v.total, funcion: 'VEN-CC' },
  { id: 'proveedores', nombre: 'Proveedores contra Compras', modulo: 'compras', consulta: 'proveedores', claves: ['proveedores'], lado: 'acreedor', valor: (v) => v.total },
  { id: 'cajas_bancos', nombre: 'Cajas y bancos contra Financiero', modulo: 'financiero', consulta: 'saldos', claves: ['caja', 'bancos'], lado: 'deudor', valor: (v) => v.total },
  { id: 'insumos', nombre: 'Mercaderías e insumos contra el inventario valorizado de Stock', modulo: 'stock', consulta: 'inventario', claves: ['insumos', 'packaging', 'productos_elaborados', 'productos_en_proceso'], lado: 'deudor', valor: (v) => v.total },
  { id: 'gift_cards', nombre: 'Gift cards a canjear contra los saldos de Clientes y CC', modulo: 'clientes', consulta: 'instrumentos', claves: ['gift_cards', 'vales'], lado: 'acreedor', valor: (v) => v.total, funcion: 'CLI-FIDEL' },
];

const ejecutar = async ({ usuarioId = null } = {}) => {
  if (!(await Funciones.estaActiva('CON-CONTROLES-CRUZADOS'))) throw invalida('La función CON-CONTROLES-CRUZADOS está desactivada: no se comparan saldos.', 409, { codigo: 'FUNCION_DESACTIVADA' });
  const salida = [];
  for (const c of CONTROLES) {
    if (c.funcion && !(await Funciones.estaActiva(c.funcion))) continue;
    const r = await consultar(c.modulo, c.consulta, {});
    if (!r.instalado) continue; // sin el módulo no hay control
    if (!r.disponible) { salida.push({ id: c.id, nombre: c.nombre, estado: 'no_disponible', motivo: r.motivo }); continue; }
    const contable = await saldoContable(c.claves, c.lado), modulo = r2(c.valor(r.valor));
    const diferencia = r2(contable - modulo);
    salida.push({ id: c.id, nombre: c.nombre, estado: Math.abs(diferencia) <= TOLERANCIA ? 'ok' : 'diferencia', saldo_contable: contable, saldo_modulo: modulo, diferencia });
  }
  const conDiferencias = salida.filter((s) => s.estado === 'diferencia').length;
  const [r] = await pool.query('INSERT INTO con_controles (ms, usuario_id, con_diferencias, resultado) VALUES (?, ?, ?, ?)', [Date.now(), usuarioId, conDiferencias, JSON.stringify(salida)]);
  return { id: r.insertId, controles: salida, con_diferencias: conDiferencias, no_disponibles: salida.filter((s) => s.estado === 'no_disponible').length, bloquea_cierre: conDiferencias > 0 && !!(await pool.query('SELECT bloquear_cierre_controles AS b FROM con_config WHERE id = 1'))[0][0].b };
};

const ultimo = async () => {
  const [[u]] = await pool.query('SELECT * FROM con_controles ORDER BY id DESC LIMIT 1');
  return u ? { id: u.id, ms: Number(u.ms), con_diferencias: u.con_diferencias, controles: JSON.parse(u.resultado) } : null;
};

const historial = async ({ limite = 50 } = {}) => (await pool.query('SELECT id, ms, usuario_id, con_diferencias FROM con_controles ORDER BY id DESC LIMIT ?', [Math.min(Number(limite) || 50, 200)]))[0].map((h) => ({ ...h, ms: Number(h.ms) }));
const ejecucion = async (id) => {
  const [[u]] = await pool.query('SELECT * FROM con_controles WHERE id = ?', [id]);
  if (!u) throw invalida('Ejecución no encontrada.', 404);
  return { id: u.id, ms: Number(u.ms), con_diferencias: u.con_diferencias, controles: JSON.parse(u.resultado) };
};

module.exports = { ejecutar, ultimo, historial, ejecucion, saldoContable, CONTROLES };
