const pool = require('../config/db');
const Funciones = require('../funciones/servicio');
const Monedas = require('../servicios/monedaService');
const { idGlobal } = require('../utils/idGlobal');
const Cuentas = require('./cuentaService');
const { invalida, r2, movimiento } = require('./comun');

// Compra y venta de moneda extranjera entre una caja en pesos y otra en divisa (Financiero RF05, RN09, RF15, EX10), con la cotización pactada. La cotización se guarda tal cual en los
// dos movimientos. Si se aparta más de X% de la vigente (parametrizable) pide autorización. El resultado por diferencia de cambio queda aparte, sin mover dinero.
const exigirFuncion = async () => {
  if (!(await Funciones.estaActiva('FIN-MONEDA-EXT'))) throw invalida('Operar con moneda extranjera necesita la función FIN-MONEDA-EXT.', 409, { codigo: 'FUNCION_INACTIVA' });
};

const operar = async (d, { userId, autorizar }) => {
  await exigirFuncion();
  if (!['compra', 'venta'].includes(d.tipo)) throw invalida('El tipo es compra o venta de divisas.');
  const divisa = Number(d.importe_divisa), cot = Number(d.cotizacion);
  if (!(divisa > 0) || !(cot > 0)) throw invalida('El importe en divisa y la cotización deben ser mayores a cero.');
  if (typeof d.motivo !== 'string' || d.motivo.trim().length < 3) throw invalida('El motivo es obligatorio.');
  const pesosId = Number(d.tipo === 'compra' ? d.origen_id : d.destino_id), divisaId = Number(d.tipo === 'compra' ? d.destino_id : d.origen_id);
  const cPesos = await Cuentas.obtenerFila(pesosId), cDivisa = await Cuentas.obtenerFila(divisaId);
  if (cPesos.moneda !== 'ARS') throw invalida(`La ${d.tipo === 'compra' ? 'cuenta que paga' : 'cuenta que recibe'} los pesos tiene que ser en ARS.`, 409);
  if (cDivisa.moneda === 'ARS') throw invalida('La otra caja o cuenta tiene que ser en moneda extranjera.', 409);
  if (!cPesos.activa || !cDivisa.activa) throw invalida('La caja o cuenta está desactivada.', 409);
  const vigente = await Monedas.vigente(cDivisa.moneda).catch(() => null);
  if (!vigente) throw invalida(`No hay una cotización de ${cDivisa.moneda} cargada.`, 409, { codigo: 'SIN_COTIZACION' });
  const cfg = await pool.query('SELECT cotizacion_vencida, divisas_tolerancia_pct FROM fin_config WHERE id = 1').then((r) => r[0][0]);
  let aviso = null;
  if (vigente.vencida) { // EX10: usa la vigente con advertencia o bloquea, según la configuración
    if (cfg.cotizacion_vencida === 'bloquear') throw invalida(`La cotización de ${cDivisa.moneda} está vencida: cargá una nueva.`, 409, { codigo: 'SIN_COTIZACION' });
    aviso = `Se usó la última cotización de ${cDivisa.moneda}, que está vencida.`;
  }
  const referencia = d.tipo === 'compra' ? vigente.vendedor : vigente.comprador; // se compra a la punta vendedora y se vende a la compradora
  const desvio = Math.abs(cot - referencia) / referencia * 100;
  let autorizante = null;
  if (desvio > Number(cfg.divisas_tolerancia_pct)) { // RN09
    const a = await autorizar();
    if (!a?.ok) throw invalida(`La cotización pactada se aparta ${desvio.toFixed(1)}% de la vigente (tope ${Number(cfg.divisas_tolerancia_pct)}%): necesita la autorización de un supervisor.`, a?.status ?? 403, { codigo: a?.codigo ?? 'REQUIERE_AUTORIZACION' });
    autorizante = a.supervisor.id;
  }
  const pesos = r2(divisa * cot);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    for (const id of [cPesos.id, cDivisa.id].sort((a, b) => a - b)) await conn.query('SELECT id FROM fin_cuentas WHERE id = ? FOR UPDATE', [id]);
    const sale = d.tipo === 'compra' ? cPesos : cDivisa, salidaImporte = d.tipo === 'compra' ? pesos : divisa;
    const saldo = await Cuentas.saldoDe(sale.id, conn);
    const piso = Cuentas.ES_CAJA(sale.tipo) ? 0 : -Number(sale.limite_descubierto);
    if (r2(saldo - salidaImporte) < piso) throw invalida(`La operación dejaría "${sale.nombre}" sin fondos: el saldo disponible es ${r2(saldo - piso)}.`, 409, { codigo: 'SALDO_INSUFICIENTE', detalle: { saldo: r2(saldo - piso) } });
    const tipoMov = d.tipo === 'compra' ? 'compra_divisa' : 'venta_divisa';
    const sig = d.tipo === 'compra' ? -1 : 1; // en pesos: la compra los saca; en divisa: la compra los suma
    const idP = await movimiento(conn, { cuentaId: cPesos.id, tipo: tipoMov, importe: sig * pesos, moneda: 'ARS', cotizacion: cot, importeDivisa: divisa, motivo: d.motivo.trim(), userId });
    const idD = await movimiento(conn, { cuentaId: cDivisa.id, tipo: tipoMov, importe: -sig * divisa, moneda: cDivisa.moneda, cotizacion: cot, importeDivisa: divisa, vinculoId: idP, motivo: d.motivo.trim(), userId });
    // Resultado por diferencia de cambio: lo que valen esas divisas a la cotización vigente contra lo pactado (compra: pagar de más es pérdida; venta: vender más caro es ganancia).
    const resultado = r2(d.tipo === 'compra' ? (referencia - cot) * divisa : (cot - referencia) * divisa);
    const [r] = await conn.query(
      `INSERT INTO fin_operaciones_divisa (id_global, tipo, origen_id, destino_id, moneda, importe_divisa, cotizacion, cotizacion_vigente, importe_pesos, resultado_cambio, mov_origen_id, mov_destino_id, autorizante_id, motivo, user_id, ts_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [await idGlobal(), d.tipo, d.tipo === 'compra' ? cPesos.id : cDivisa.id, d.tipo === 'compra' ? cDivisa.id : cPesos.id, cDivisa.moneda, divisa, cot, referencia, pesos, resultado, d.tipo === 'compra' ? idP : idD, d.tipo === 'compra' ? idD : idP, autorizante, d.motivo.trim().slice(0, 255), userId ?? null, Date.now()]);
    await conn.commit();
    return { id: r.insertId, tipo: d.tipo, moneda: cDivisa.moneda, importe_divisa: divisa, cotizacion: cot, cotizacion_vigente: referencia, importe_pesos: pesos, resultado_cambio: resultado, autorizado: !!autorizante, ...(aviso && { aviso }) };
  } catch (err) { await conn.rollback(); throw err; } finally { conn.release(); }
};

const listar = async ({ desde, hasta, limite = 100 } = {}) => {
  const w = [], p = [];
  if (desde) { w.push('ts_ms >= ?'); p.push(new Date(`${desde}T00:00:00`).getTime()); }
  if (hasta) { w.push('ts_ms <= ?'); p.push(new Date(`${hasta}T23:59:59.999`).getTime()); }
  const [filas] = await pool.query(`SELECT * FROM fin_operaciones_divisa ${w.length ? `WHERE ${w.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`, [...p, Math.min(Number(limite) || 100, 500)]);
  return filas.map((o) => ({ id: o.id, tipo: o.tipo, moneda: o.moneda, importe_divisa: Number(o.importe_divisa), cotizacion: Number(o.cotizacion), cotizacion_vigente: Number(o.cotizacion_vigente), importe_pesos: Number(o.importe_pesos), resultado_cambio: Number(o.resultado_cambio), ts_ms: Number(o.ts_ms) }));
};

module.exports = { operar, listar };
