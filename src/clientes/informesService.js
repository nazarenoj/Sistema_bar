const pool = require('../config/db');
const Funciones = require('../funciones/servicio');
const Notificacion = require('../models/notificacionModel');
const Correo = require('../servicios/correoService');
const Clientes = require('./clienteService');
const Cuentas = require('./cuentaService');

// Estado de cuenta e informes (Clientes y CC RF14, RF15, RF16, RF25): el estado de cuenta cuadra con el saldo; la antigüedad usa los tramos configurados;
// cobranzas, deudores y proyección admiten filtros combinables. Los envíos por correo quedan en cola con reintento y se marcan «No enviado» si fallan (EX12).
class InformeInvalido extends Error {}
const invalida = (m, status = 400) => Object.assign(new InformeInvalido(m), { status });
const num = Cuentas.num;
const esFecha = (f) => /^\d{4}-\d{2}-\d{2}$/.test(f ?? '');
const iso = (d) => { const f = new Date(d); const p = (x) => String(x).padStart(2, '0'); return `${f.getFullYear()}-${p(f.getMonth() + 1)}-${p(f.getDate())}`; };
const contado = "estado NOT IN ('facturado', 'pendiente_emision')"; // lo que suma al saldo (igual que Cuentas.saldoDe)

// ---------- Estado de cuenta (RF14) ----------
const estadoDeCuenta = async (cuentaId, { desde, hasta } = {}) => {
  const c = await Cuentas.cuentaDe(cuentaId);
  if (!c) throw invalida('Cuenta no encontrada.', 404);
  if (desde && !esFecha(desde)) throw invalida('"desde" va como AAAA-MM-DD.');
  if (hasta && !esFecha(hasta)) throw invalida('"hasta" va como AAAA-MM-DD.');
  const d = desde || '1900-01-01', h = hasta || '2999-12-31';
  const [[{ ini }]] = await pool.query(`SELECT COALESCE(SUM(IF(naturaleza = 'debito', importe, -importe)), 0) AS ini FROM movimientos_cc WHERE cuenta_id = ? AND ${contado} AND fecha < ?`, [cuentaId, d]);
  const [movs] = await pool.query(`SELECT id, fecha, tipo, naturaleza, comprobante_ref, motivo, detalle, importe FROM movimientos_cc WHERE cuenta_id = ? AND ${contado} AND fecha >= ? AND fecha <= ? ORDER BY fecha, id`, [cuentaId, d, h]);
  let acumulado = num(ini);
  const movimientos = movs.map((m) => { acumulado = num(acumulado + (m.naturaleza === 'debito' ? Number(m.importe) : -Number(m.importe))); return { ...m, fecha: iso(m.fecha), importe: num(m.importe), debe: m.naturaleza === 'debito' ? num(m.importe) : 0, haber: m.naturaleza === 'credito' ? num(m.importe) : 0, saldo: acumulado }; });
  const cli = await Clientes.fila(c.cliente_id);
  return { cuenta_id: cuentaId, cliente: { id: cli.id, razon_social: cli.razon_social, documento: `${cli.tipo_documento} ${cli.nro_documento}` }, moneda: c.moneda,
    desde: desde ?? null, hasta: hasta ?? null, saldo_inicial: num(ini), movimientos, saldo_final: acumulado, composicion: await Cuentas.pendientes(cuentaId) };
};

// ---------- Antigüedad de saldos (RF15) ----------
const tramos = async () => {
  const t = (await pool.query("SELECT valor FROM parametros WHERE clave = 'cc_tramos_antiguedad'"))[0][0]?.valor ?? '30,60,90';
  const l = t.split(',').map((x) => Number(x.trim())).filter((x) => Number.isInteger(x) && x > 0).sort((a, b) => a - b);
  return l.length ? l : [30, 60, 90];
};
const configurarTramos = async (lista) => {
  if (!Array.isArray(lista) || !lista.length || lista.some((x, i) => !Number.isInteger(x) || x < 1 || (i > 0 && x <= lista[i - 1]))) throw invalida('Los tramos son enteros positivos y crecientes (por ejemplo 30, 60, 90).');
  await pool.query("INSERT INTO parametros (clave, valor) VALUES ('cc_tramos_antiguedad', ?) ON DUPLICATE KEY UPDATE valor = VALUES(valor)", [lista.join(',')]);
  return lista;
};
const etiquetas = (t) => [...t.map((x, i) => `${i === 0 ? 0 : t[i - 1] + 1}-${x}`), `más de ${t[t.length - 1]}`];

const filtrosCliente = (q, donde, p) => {
  if (q.cliente_id) { donde.push('cc.cliente_id = ?'); p.push(Number(q.cliente_id)); }
  if (q.tipo_cliente) { donde.push('cl.tipo_cliente = ?'); p.push(String(q.tipo_cliente)); }
  if (q.moneda) { donde.push('cc.moneda = ?'); p.push(String(q.moneda).toUpperCase()); }
};
const BASE_DEUDA = `FROM movimientos_cc m JOIN cuentas_corrientes cc ON cc.id = m.cuenta_id JOIN clientes cl ON cl.id = cc.cliente_id
  WHERE m.naturaleza = 'debito' AND m.estado = 'pendiente' AND m.saldo_pendiente > 0`;

const antiguedad = async (q = {}) => {
  const t = await tramos();
  const donde = [], p = [];
  filtrosCliente(q, donde, p);
  const [filas] = await pool.query(`SELECT cc.cliente_id, cl.razon_social, cc.moneda, m.saldo_pendiente, DATEDIFF(CURDATE(), m.fecha) AS edad ${BASE_DEUDA} ${donde.length ? `AND ${donde.join(' AND ')}` : ''}`, p);
  const [creditos] = await pool.query(`SELECT cc.cliente_id, SUM(m.saldo_pendiente) AS favor FROM movimientos_cc m JOIN cuentas_corrientes cc ON cc.id = m.cuenta_id JOIN clientes cl ON cl.id = cc.cliente_id WHERE m.naturaleza = 'credito' AND m.estado <> 'anulado' AND m.saldo_pendiente > 0 ${donde.length ? `AND ${donde.join(' AND ')}` : ''} GROUP BY cc.cliente_id`, p);
  const favor = new Map(creditos.map((c) => [c.cliente_id, num(c.favor)]));
  const porCliente = new Map();
  for (const f of filas) {
    const idx = t.findIndex((x) => f.edad <= x);
    const i = idx === -1 ? t.length : idx;
    const k = `${f.cliente_id}|${f.moneda}`;
    const r = porCliente.get(k) ?? { cliente_id: f.cliente_id, cliente: f.razon_social, moneda: f.moneda, tramos: Array(t.length + 1).fill(0), total: 0, saldo_a_favor: favor.get(f.cliente_id) ?? 0 };
    r.tramos[i] = num(r.tramos[i] + Number(f.saldo_pendiente));
    r.total = num(r.total + Number(f.saldo_pendiente));
    porCliente.set(k, r);
  }
  const rotulos = etiquetas(t);
  const clientes = [...porCliente.values()].sort((a, b) => b.total - a.total).map((r) => ({ ...r, ...Object.fromEntries(rotulos.map((l, i) => [`t${i}`, r.tramos[i]])) }));
  const totales = rotulos.map((l, i) => ({ tramo: l, importe: num(clientes.reduce((a, r) => a + r.tramos[i], 0)) }));
  return { tramos: rotulos, clientes, totales, total: num(clientes.reduce((a, r) => a + r.total, 0)) };
};

// ---------- Deudores con comprobantes vencidos (RF15) ----------
const deudores = async (q = {}) => {
  const donde = [], p = [];
  filtrosCliente(q, donde, p);
  const minimo = Number(q.dias_mora_min ?? 1);
  const [filas] = await pool.query(
    `SELECT cc.cliente_id, cl.razon_social, cc.moneda, cl.telefono, cl.email, COUNT(*) AS comprobantes, SUM(m.saldo_pendiente) AS vencido, MAX(DATEDIFF(CURDATE(), m.fecha_vencimiento)) AS dias_mora
     ${BASE_DEUDA} AND m.fecha_vencimiento < CURDATE() ${donde.length ? `AND ${donde.join(' AND ')}` : ''} GROUP BY cc.cliente_id, cc.moneda, cl.razon_social, cl.telefono, cl.email HAVING dias_mora >= ? ORDER BY vencido DESC`, [...p, minimo]);
  const deudores_ = [];
  for (const f of filas) {
    const [[cuenta]] = await pool.query('SELECT id FROM cuentas_corrientes WHERE cliente_id = ? AND moneda = ?', [f.cliente_id, f.moneda]);
    deudores_.push({ cliente_id: f.cliente_id, cliente: f.razon_social, moneda: f.moneda, telefono: f.telefono, email: f.email, comprobantes_vencidos: Number(f.comprobantes), importe_vencido: num(f.vencido), dias_mora: Number(f.dias_mora), saldo: await Cuentas.saldoDe(cuenta.id) });
  }
  return { deudores: deudores_, total_vencido: num(deudores_.reduce((a, d) => a + d.importe_vencido, 0)) };
};

// ---------- Cobranzas por período y forma de pago (RF15) ----------
const cobranzas = async (q = {}) => {
  for (const f of [q.desde, q.hasta]) if (f && !esFecha(f)) throw invalida('Las fechas van como AAAA-MM-DD.');
  const donde = ["r.estado = 'vigente'"], p = [];
  if (q.desde) { donde.push('r.fecha >= ?'); p.push(q.desde); }
  if (q.hasta) { donde.push('r.fecha <= ?'); p.push(q.hasta); }
  if (q.cliente_id) { donde.push('r.cliente_id = ?'); p.push(Number(q.cliente_id)); }
  if (q.forma) { donde.push('v.forma = ?'); p.push(q.forma); }
  const [porForma] = await pool.query(`SELECT v.forma, COUNT(DISTINCT r.id) AS recibos, SUM(v.importe) AS importe FROM recibos r JOIN recibo_valores v ON v.recibo_id = r.id WHERE ${donde.join(' AND ')} GROUP BY v.forma ORDER BY importe DESC`, p);
  const [porDia] = await pool.query(`SELECT r.fecha, SUM(v.importe) AS importe FROM recibos r JOIN recibo_valores v ON v.recibo_id = r.id WHERE ${donde.join(' AND ')} GROUP BY r.fecha ORDER BY r.fecha`, p);
  return { por_forma: porForma.map((f) => ({ forma: f.forma, recibos: Number(f.recibos), importe: num(f.importe) })), por_dia: porDia.map((d) => ({ fecha: iso(d.fecha), importe: num(d.importe) })),
    total: num(porForma.reduce((a, f) => a + Number(f.importe), 0)) };
};

// ---------- Proyección de cobros por fecha de vencimiento (RF15) ----------
const proyeccion = async (q = {}) => {
  for (const f of [q.desde, q.hasta]) if (f && !esFecha(f)) throw invalida('Las fechas van como AAAA-MM-DD.');
  const donde = [], p = [];
  filtrosCliente(q, donde, p);
  if (q.desde) { donde.push('m.fecha_vencimiento >= ?'); p.push(q.desde); }
  if (q.hasta) { donde.push('m.fecha_vencimiento <= ?'); p.push(q.hasta); }
  const [filas] = await pool.query(`SELECT m.fecha_vencimiento AS fecha, SUM(m.saldo_pendiente) AS importe, COUNT(*) AS comprobantes ${BASE_DEUDA} ${donde.length ? `AND ${donde.join(' AND ')}` : ''} GROUP BY m.fecha_vencimiento ORDER BY m.fecha_vencimiento`, p);
  let acumulado = 0;
  return { dias: filas.map((f) => { acumulado = num(acumulado + Number(f.importe)); return { fecha: iso(f.fecha), comprobantes: Number(f.comprobantes), importe: num(f.importe), acumulado, vencido: iso(f.fecha) < iso(new Date()) }; }), total: acumulado };
};

// ---------- Envíos por correo (RF14, RF16, EX12) ----------
const correoListo = async (cliente) => {
  if (!(await Funciones.estaActiva('USU-CORREO'))) throw invalida('El envío por correo necesita la función USU-CORREO.', 409);
  if (!cliente.email) throw invalida('El cliente no tiene correo cargado.', 409);
};
const texto = (e) => {
  const lineas = [`Estado de cuenta de ${e.cliente.razon_social} (${e.moneda})`, e.desde || e.hasta ? `Período: ${e.desde ?? 'inicio'} a ${e.hasta ?? 'hoy'}` : '', `Saldo inicial: ${e.saldo_inicial}`, ''];
  for (const m of e.movimientos) lineas.push(`${m.fecha}  ${m.tipo.padEnd(7)} ${m.comprobante_ref ?? ''}  debe ${m.debe}  haber ${m.haber}  saldo ${m.saldo}`);
  lineas.push('', `Saldo final: ${e.saldo_final}`, '', 'Comprobantes pendientes:');
  for (const c of e.composicion) lineas.push(`  ${c.comprobante_ref}  vence ${iso(c.fecha_vencimiento)}  ${c.saldo_pendiente}`);
  return lineas.join('\n');
};
const enviarEstado = async (cuentaId, q = {}, { userId = null } = {}) => {
  const e = await estadoDeCuenta(cuentaId, q);
  const cli = await Clientes.fila(e.cliente.id);
  await correoListo(cli);
  const asunto = `Estado de cuenta ${e.moneda}`;
  const cola = await Correo.encolar({ para: cli.email, asunto, cuerpo: texto(e) });
  const [r] = await pool.query("INSERT INTO envios_cliente (cliente_id, cuenta_id, tipo, destino, asunto, correo_cola_id, user_id) VALUES (?, ?, 'estado_cuenta', ?, ?, ?, ?)", [cli.id, cuentaId, cli.email, asunto, cola, userId]);
  await Correo.enviarCola().catch(() => {});
  return (await envios({ id: r.insertId }))[0];
};
// Estado del envío = el de la cola de correo: Enviado, o No enviado si falló o sigue pendiente de reintento (EX12).
const envios = async ({ id, cliente_id: clienteId } = {}) => (await pool.query(
  `SELECT e.id, e.cliente_id, e.cuenta_id, e.tipo, e.destino, e.asunto, e.created_at, c.estado AS estado_cola, c.intentos, c.error FROM envios_cliente e LEFT JOIN correo_cola c ON c.id = e.correo_cola_id
   WHERE (? IS NULL OR e.id = ?) AND (? IS NULL OR e.cliente_id = ?) ORDER BY e.id DESC LIMIT 200`, [id ?? null, id ?? null, clienteId ?? null, clienteId ?? null]))[0]
  .map((e) => ({ ...e, estado: e.estado_cola === 'enviado' ? 'enviado' : 'no_enviado', ...(e.estado_cola !== 'enviado' && { reintentando: e.estado_cola === 'pendiente' }) }));

// ---------- Recordatorios de vencimiento (RF16) ----------
// Alerta interna a los roles con permiso sobre Clientes y, si está configurado, aviso por correo al cliente: vencimientos próximos o vencidos. No repite
// el aviso dentro de `cc_recordatorio_repetir_dias`.
const recordatorios = async () => {
  const p = async (k, d) => Number((await pool.query('SELECT valor FROM parametros WHERE clave = ?', [k]))[0][0]?.valor ?? d);
  const antes = await p('cc_recordatorio_dias_antes', 3), repetir = await p('cc_recordatorio_repetir_dias', 7);
  const [filas] = await pool.query(
    `SELECT cc.id AS cuenta_id, cc.cliente_id, cc.moneda, cl.razon_social, cl.email, SUM(m.saldo_pendiente) AS importe, SUM(m.fecha_vencimiento < CURDATE()) AS vencidos, COUNT(*) AS comprobantes, MIN(m.fecha_vencimiento) AS primero
     ${BASE_DEUDA} AND m.fecha_vencimiento <= DATE_ADD(CURDATE(), INTERVAL ? DAY) GROUP BY cc.id, cc.cliente_id, cc.moneda, cl.razon_social, cl.email`, [antes]);
  const hechos = [];
  const correo = (await Funciones.estaActiva('USU-CORREO')).valueOf();
  for (const f of filas) {
    const [[ult]] = await pool.query("SELECT MAX(created_at) AS f FROM envios_cliente WHERE cliente_id = ? AND tipo = 'recordatorio'", [f.cliente_id]);
    const reciente = ult.f && (Date.now() - new Date(ult.f).getTime()) / 86400000 < repetir;
    const estado = Number(f.vencidos) > 0 ? `${f.vencidos} comprobante(s) vencido(s)` : `${f.comprobantes} comprobante(s) por vencer`;
    await Notificacion.crear({ modulo: 'clientes', tipo: 'recordatorio_vencimiento', severidad: Number(f.vencidos) > 0 ? 'media' : 'baja', roles: ['administrador', 'gerente', 'administrativo'], clave: `recordatorio-${f.cuenta_id}`, mensaje: `${f.razon_social}: ${estado} por ${num(f.importe)} ${f.moneda}.` });
    let enviado = false;
    if (correo && f.email && !reciente) {
      const asunto = Number(f.vencidos) > 0 ? 'Aviso de comprobantes vencidos' : 'Aviso de vencimientos próximos';
      const cola = await Correo.encolar({ para: f.email, asunto, cuerpo: `Hola ${f.razon_social}, te avisamos que tenés ${estado} por ${num(f.importe)} ${f.moneda} en tu cuenta corriente. Ante cualquier duda, comunicate con nosotros.` });
      await pool.query("INSERT INTO envios_cliente (cliente_id, cuenta_id, tipo, destino, asunto, correo_cola_id) VALUES (?, ?, 'recordatorio', ?, ?, ?)", [f.cliente_id, f.cuenta_id, f.email, asunto, cola]);
      enviado = true;
    }
    hechos.push({ cuenta_id: f.cuenta_id, cliente: f.razon_social, alerta: true, correo: enviado });
  }
  if (correo) await Correo.enviarCola().catch(() => {});
  return hechos;
};

// ---------- Informe de retenciones sufridas (RF08) ----------
const retenciones = async (q = {}) => {
  for (const f of [q.desde, q.hasta]) if (f && !esFecha(f)) throw invalida('Las fechas van como AAAA-MM-DD.');
  const donde = ["r.estado = 'vigente'"], p = [];
  if (q.desde) { donde.push('x.fecha >= ?'); p.push(q.desde); }
  if (q.hasta) { donde.push('x.fecha <= ?'); p.push(q.hasta); }
  if (q.cliente_id) { donde.push('r.cliente_id = ?'); p.push(Number(q.cliente_id)); }
  if (q.impuesto) { donde.push('x.impuesto = ?'); p.push(q.impuesto); }
  const [filas] = await pool.query(`SELECT x.fecha, cl.razon_social AS cliente, x.impuesto, x.regimen, x.jurisdiccion, x.nro_certificado, x.importe, r.punto_emision, r.numero FROM recibo_retenciones x JOIN recibos r ON r.id = x.recibo_id JOIN clientes cl ON cl.id = r.cliente_id WHERE ${donde.join(' AND ')} ORDER BY x.fecha, x.id`, p);
  const porImpuesto = {};
  for (const f of filas) porImpuesto[f.impuesto] = num((porImpuesto[f.impuesto] ?? 0) + Number(f.importe));
  return { retenciones: filas.map((f) => ({ ...f, fecha: iso(f.fecha), importe: num(f.importe), recibo: `${String(f.punto_emision).padStart(4, '0')}-${String(f.numero).padStart(8, '0')}` })), por_impuesto: porImpuesto, total: num(filas.reduce((a, f) => a + Number(f.importe), 0)) };
};

// ---------- Ciclo de facturación del mayorista (RF21) ----------
// Con CLI-FACT-AGRUPADA, al llegar la fecha del ciclo del cliente (semanal, quincenal, mensual) con remitos pendientes de facturar, alerta interna con
// la lista de trabajo. «A demanda» no genera alerta.
const DIAS_CICLO = { semanal: 7, quincenal: 15, mensual: 30 };
const alertasCiclo = async () => {
  if (!(await Funciones.estaActiva('CLI-FACT-AGRUPADA'))) return [];
  const [filas] = await pool.query("SELECT id, razon_social, ciclo_facturacion FROM clientes WHERE estado = 'activo' AND ciclo_facturacion IN ('semanal', 'quincenal', 'mensual')");
  const hechas = [];
  for (const c of filas) {
    const pend = await Cuentas.remitosPendientes(c.id);
    if (!pend.length) { await Notificacion.resolverPorClave(`ciclo-facturacion-${c.id}`, 'No quedan remitos por facturar'); continue; }
    const dias = Math.floor((Date.now() - new Date(pend[0].fecha).getTime()) / 86400000);
    if (dias < DIAS_CICLO[c.ciclo_facturacion]) continue;
    await Notificacion.crear({ modulo: 'clientes', tipo: 'ciclo_facturacion', severidad: 'media', roles: ['administrador', 'gerente', 'administrativo'], clave: `ciclo-facturacion-${c.id}`,
      mensaje: `Llegó la fecha de facturación (${c.ciclo_facturacion}) de ${c.razon_social}: ${pend.length} remito(s) por ${num(pend.reduce((a, r) => a + r.importe, 0))}.` });
    hechas.push({ cliente_id: c.id, remitos: pend.length });
  }
  return hechas;
};

// ---------- Indicador de deuda para el tablero (RF25) ----------
const indicadorDeuda = async () => {
  const Monedas = require('../servicios/monedaService');
  const [filas] = await pool.query(`SELECT cl.id, cl.razon_social, cc.moneda, SUM(m.saldo_pendiente) AS total, SUM(IF(m.fecha_vencimiento < CURDATE(), m.saldo_pendiente, 0)) AS vencida ${BASE_DEUDA} GROUP BY cl.id, cl.razon_social, cc.moneda`);
  const tasa = new Map();
  for (const m of new Set(filas.map((f) => f.moneda))) tasa.set(m, m === 'ARS' ? 1 : (await Monedas.vigente(m).catch(() => null))?.vendedor ?? 0);
  const porCliente = new Map();
  let total = 0, vencida = 0;
  for (const f of filas) {
    const k = tasa.get(f.moneda);
    total += Number(f.total) * k; vencida += Number(f.vencida) * k;
    porCliente.set(f.razon_social, (porCliente.get(f.razon_social) ?? 0) + Number(f.total) * k);
  }
  const top = [...porCliente].map(([clave, valor]) => ({ clave, valor })).sort((a, b) => b.valor - a.valor).slice(0, 5);
  total = num(total); vencida = num(vencida);
  return { valor: total, detalle: { deuda_vencida: vencida, porcentaje_vencido: total ? num(vencida / total * 100) : 0 }, serie: top.map((x) => ({ clave: x.clave, valor: num(x.valor) })) };
};

module.exports = { retenciones, alertasCiclo, InformeInvalido, estadoDeCuenta, antiguedad, tramos, configurarTramos, deudores, cobranzas, proyeccion, enviarEstado, envios, recordatorios, indicadorDeuda };
