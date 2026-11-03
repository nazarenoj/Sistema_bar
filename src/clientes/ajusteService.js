const pool = require('../config/db');
const Funciones = require('../funciones/servicio');
const Clientes = require('./clienteService');
const Cuentas = require('./cuentaService');
const { idGlobal } = require('../utils/idGlobal');

// Intereses por mora y diferencia de cambio (Clientes y CC RF10, RF11, RN11, RN12; funciones CLI-MORA y CLI-MONEDA-EXT). El sistema NO emite solo: calcula y propone la nota
// de débito o de crédito, y un usuario con permiso la revisa y la confirma (o la descarta con motivo, que es condonar). No hay anatocismo: no se calculan intereses sobre una
// nota de débito de intereses (RN12).
class AjusteInvalido extends Error {}
const invalida = (m, status = 400, extra = {}) => Object.assign(new AjusteInvalido(m), { status, ...extra });
const num = Cuentas.num;
const hoy = Cuentas.hoy;
const dias = (desde, hasta) => Math.round((new Date(`${hasta}T12:00:00`) - new Date(`${desde}T12:00:00`)) / 86400000);
const iso = (f) => { const d = new Date(f); const p = (x) => String(x).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };

// ---------- Intereses por mora (RF10) ----------
// La tasa de la cuenta es mensual (porcentaje); el interés de cada comprobante vencido es su saldo × tasa × días de atraso / 30. Los días cuentan desde el vencimiento o desde donde
// llegó la última propuesta, así un mismo período no se cobra dos veces.
const calcularMora = async ({ cuentaId = null } = {}) => {
  if (!(await Funciones.estaActiva('CLI-MORA'))) throw invalida('Los intereses por mora necesitan la función CLI-MORA.', 409);
  const [cuentas] = await pool.query("SELECT * FROM cuentas_corrientes WHERE tasa_mora > 0 AND estado <> 'cerrada' AND (? IS NULL OR id = ?)", [cuentaId, cuentaId]);
  const h = hoy();
  const creadas = [];
  for (const c of cuentas) {
    const [vencidos] = await pool.query(
      "SELECT * FROM movimientos_cc WHERE cuenta_id = ? AND naturaleza = 'debito' AND estado = 'pendiente' AND saldo_pendiente > 0 AND fecha_vencimiento < ? AND NOT (tipo = 'nd' AND motivo = 'intereses_mora') ORDER BY fecha_vencimiento, id", [c.id, h]);
    for (const m of vencidos) {
      const [[ult]] = await pool.query("SELECT MAX(periodo_hasta) AS hasta FROM propuestas_ajuste_cc WHERE movimiento_ref = ? AND tipo = 'intereses' AND estado IN ('emitida', 'descartada')", [m.id]);
      const desde = ult.hasta ? iso(ult.hasta) : iso(m.fecha_vencimiento);
      const d = dias(desde, h);
      if (d <= 0) continue;
      const interes = num(Number(m.saldo_pendiente) * (Number(c.tasa_mora) / 100) * (d / 30));
      if (!(interes > 0)) continue;
      const [[pend]] = await pool.query("SELECT id FROM propuestas_ajuste_cc WHERE movimiento_ref = ? AND tipo = 'intereses' AND estado = 'pendiente'", [m.id]);
      const detalle = `${num(m.saldo_pendiente)} al ${num(c.tasa_mora)}% mensual por ${d} días de atraso`;
      if (pend) await pool.query('UPDATE propuestas_ajuste_cc SET importe = ?, base_calculo = ?, periodo_desde = ?, periodo_hasta = ?, detalle = ? WHERE id = ?', [interes, m.saldo_pendiente, desde, h, detalle, pend.id]);
      else {
        const [r] = await pool.query("INSERT INTO propuestas_ajuste_cc (cuenta_id, tipo, naturaleza, movimiento_ref, base_calculo, periodo_desde, periodo_hasta, importe, detalle) VALUES (?, 'intereses', 'debito', ?, ?, ?, ?, ?, ?)", [c.id, m.id, m.saldo_pendiente, desde, h, interes, detalle]);
        creadas.push(r.insertId);
      }
    }
  }
  return { creadas: creadas.length, propuestas: await listar({ estado: 'pendiente', tipo: 'intereses' }) };
};

const listar = async ({ estado, tipo, cuenta_id: cuentaId } = {}) => (await pool.query(
  `SELECT p.*, m.comprobante_ref, c.cliente_id, cl.razon_social, c.moneda FROM propuestas_ajuste_cc p JOIN movimientos_cc m ON m.id = p.movimiento_ref JOIN cuentas_corrientes c ON c.id = p.cuenta_id JOIN clientes cl ON cl.id = c.cliente_id
   WHERE (? IS NULL OR p.estado = ?) AND (? IS NULL OR p.tipo = ?) AND (? IS NULL OR p.cuenta_id = ?) ORDER BY p.id DESC LIMIT 300`, [estado ?? null, estado ?? null, tipo ?? null, tipo ?? null, cuentaId ?? null, cuentaId ?? null]))[0]
  .map((p) => ({ ...p, importe: num(p.importe), base_calculo: num(p.base_calculo) }));

// ---------- Confirmar o descartar ----------
const confirmar = async (id, { importe, fiscal = false } = {}, { userId = null } = {}) => {
  const [[p]] = await pool.query('SELECT * FROM propuestas_ajuste_cc WHERE id = ?', [id]);
  if (!p) throw invalida('Propuesta no encontrada.', 404);
  if (p.estado !== 'pendiente') throw invalida(`La propuesta ya está ${p.estado}.`, 409);
  const imp = importe === undefined ? num(p.importe) : num(importe);
  if (!(imp > 0) || imp > num(p.importe)) throw invalida(`El importe a emitir es mayor que cero y no supera el propuesto (${num(p.importe)}).`);
  const nota = p.tipo === 'intereses'
    ? await Cuentas.nota(p.cuenta_id, { tipo: 'nd', importe: imp, motivo: 'intereses_mora', referencia_id: p.movimiento_ref, fiscal, detalle: p.detalle }, { userId, idSolicitud: `ajuste-${p.id}` })
    : await Cuentas.notaDeCambio(p, imp, { userId, fiscal });
  await pool.query("UPDATE propuestas_ajuste_cc SET estado = 'emitida', movimiento_nota = ?, user_id = ?, importe = ? WHERE id = ?", [nota.id, userId, imp, id]);
  return { propuesta: (await listar({})).find((x) => x.id === p.id), nota };
};
// Descartar es condonar: exige permiso y motivo (RN12).
const descartar = async (id, { motivo }, { userId = null } = {}) => {
  if (!String(motivo ?? '').trim()) throw invalida('Condonar o descartar exige el motivo.');
  const [r] = await pool.query("UPDATE propuestas_ajuste_cc SET estado = 'descartada', motivo_descarte = ?, user_id = ? WHERE id = ? AND estado = 'pendiente'", [String(motivo).trim().slice(0, 255), userId, id]);
  if (!r.affectedRows) throw invalida('La propuesta no existe o ya no está pendiente.', 409);
  return (await listar({})).find((x) => x.id === Number(id));
};

// Proceso diario: deja las propuestas de intereses al día (no emite nada).
const diario = async () => ((await Funciones.estaActiva('CLI-MORA')) ? calcularMora() : { creadas: 0 });

module.exports = { AjusteInvalido, calcularMora, listar, confirmar, descartar, diario };
