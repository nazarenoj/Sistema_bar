const pool = require('../config/db');
const Consolidacion = require('../servicios/consolidacionService');
const Modulos = require('../modulos/registro');
const Funciones = require('../funciones/servicio');
const { invalida, r2, iso, fechaLocal } = require('./comun');

// Consolidación contable (Contable RF22, RF23, RN26, EX15 a EX17) [CON-CONSOL + USU-CONSOL]. Cada sucursal publica su balance de sumas y saldos del período como paquete firmado (la
// infraestructura de firma, idempotencia y reemplazo es la de Usuarios); la Casa Central lo importa con la equivalencia de cuentas de esa sucursal y emite el balance consolidado.
const finDeMes = (periodo) => { const [a, m] = periodo.split('-').map(Number); return `${periodo}-${String(new Date(a, m, 0).getDate()).padStart(2, '0')}`; };

// Balance del mes de `dia` hasta `dia`: saldo inicial, debe, haber y saldo final por cuenta, con signo deudor positivo. Es de solo lectura (RN26).
const balanceMes = async (dia) => {
  const periodo = dia.slice(0, 7), inicio = `${periodo}-01`;
  const [anio, mes] = periodo.split('-').map(Number);
  const [[per]] = await pool.query('SELECT estado FROM con_periodos WHERE anio = ? AND mes = ?', [anio, mes]);
  const [filas] = await pool.query(`SELECT c.codigo, c.nombre,
      COALESCE(SUM(CASE WHEN a.fecha < ? THEN l.debe - l.haber ELSE 0 END), 0) AS inicial,
      COALESCE(SUM(CASE WHEN a.fecha >= ? THEN l.debe ELSE 0 END), 0) AS debe, COALESCE(SUM(CASE WHEN a.fecha >= ? THEN l.haber ELSE 0 END), 0) AS haber
    FROM con_asiento_lineas l JOIN con_asientos a ON a.id = l.asiento_id JOIN con_cuentas c ON c.id = l.cuenta_id WHERE a.fecha <= ? GROUP BY c.codigo, c.nombre ORDER BY c.codigo`, [inicio, inicio, inicio, dia]);
  const lineas = filas.map((f) => ({ codigo: f.codigo, nombre: f.nombre, saldo_inicial: r2(f.inicial), debe: r2(f.debe), haber: r2(f.haber), saldo_final: r2(Number(f.inicial) + Number(f.debe) - Number(f.haber)) }))
    .filter((l) => l.saldo_inicial !== 0 || l.debe !== 0 || l.haber !== 0);
  // Un período abierto (o un paquete a mitad de mes) es provisorio; el definitivo lo reemplaza al cerrar (RF22).
  return { periodo_contable: periodo, hasta: dia, estado: per?.estado === 'cerrado' && dia >= finDeMes(periodo) ? 'definitivo' : 'provisorio', lineas };
};

const equivalenciasDe = async (sucursal) => new Map((await pool.query('SELECT codigo_sucursal, codigo_central FROM con_equivalencias_consol WHERE sucursal = ?', [sucursal]))[0].map((e) => [e.codigo_sucursal, e.codigo_central]));

Consolidacion.registrarPaquete('contable', {
  funcion: 'CON-CONSOL',
  generar: (periodo) => balanceMes(periodo),
  // EX15: formato inválido o cuentas sin equivalencia rechazan el paquete completo.
  validar: async (s) => {
    const c = s.contenido;
    if (!c || !/^\d{4}-\d{2}$/.test(c.periodo_contable ?? '') || !Array.isArray(c.lineas) || !['provisorio', 'definitivo'].includes(c.estado)) return 'el paquete contable no tiene el formato esperado (período, estado o líneas)';
    if (!(await Modulos.estaInstalado('contable'))) return 'la Casa Central no tiene Contable instalado';
    if (!(await Funciones.estaActiva('CON-CONSOL'))) return 'la función CON-CONSOL está desactivada en la Casa Central';
    const eq = await equivalenciasDe(s.sucursal);
    const sin = [...new Set(c.lineas.map((l) => l.codigo).filter((k) => !eq.has(k)))];
    return sin.length ? `cuentas sin equivalencia en el plan de la Casa Central: ${sin.slice(0, 20).join(', ')}${sin.length > 20 ? '…' : ''}` : null;
  },
});

// ---- Equivalencias ----

const equivalencias = async (sucursal) => (await pool.query('SELECT codigo_sucursal, codigo_central FROM con_equivalencias_consol WHERE sucursal = ? ORDER BY codigo_sucursal', [sucursal]))[0];
const fijarEquivalencias = async (sucursal, mapa) => {
  if (!(await Consolidacion.sucursales()).some((s) => s.codigo === sucursal)) throw invalida('La sucursal no está registrada.', 404);
  if (!mapa || typeof mapa !== 'object' || Array.isArray(mapa) || !Object.keys(mapa).length) throw invalida('Las equivalencias son un objeto código de la sucursal → código de la Casa Central.');
  const centrales = new Map((await pool.query('SELECT codigo, imputable FROM con_cuentas')).at(0).map((c) => [c.codigo, c.imputable]));
  const malas = Object.entries(mapa).filter(([, central]) => !centrales.get(String(central))).map(([suc, central]) => ({ codigo_sucursal: suc, codigo_central: central }));
  if (malas.length) throw invalida('Hay equivalencias hacia cuentas de la Casa Central que no existen o no son imputables.', 400, { codigo: 'EQUIVALENCIA_INVALIDA', cuentas: malas });
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query('DELETE FROM con_equivalencias_consol WHERE sucursal = ?', [sucursal]);
    for (const [suc, central] of Object.entries(mapa)) await conn.query('INSERT INTO con_equivalencias_consol (sucursal, codigo_sucursal, codigo_central) VALUES (?, ?, ?)', [sucursal, String(suc), String(central)]);
    await conn.commit();
  } catch (err) { await conn.rollback(); throw err; } finally { conn.release(); }
  return equivalencias(sucursal);
};

// ---- Balance consolidado ----

const consolidado = async ({ periodo } = {}) => {
  if (!/^\d{4}-\d{2}$/.test(periodo ?? '')) throw invalida('El período va como AAAA-MM.');
  const [[cc]] = await pool.query('SELECT es_casa_central FROM consolidacion_config WHERE id = 1');
  if (!cc?.es_casa_central) throw invalida('Esta instancia no está marcada como Casa Central.', 409, { codigo: 'NO_ES_CASA_CENTRAL' });
  const propia = (await pool.query('SELECT codigo_instancia AS c FROM configuracion_instancia WHERE id = 1'))[0][0].c;
  const fin = finDeMes(periodo), hoy = fechaLocal();
  const columnas = [];
  const datos = new Map(); // columna -> lineas (en códigos de la Casa Central)
  // La Casa Central aporta su propia contabilidad sin paquete (RN26: requiere Contable en la Casa Central).
  const [[cfg]] = await pool.query('SELECT fecha_inicio FROM con_config WHERE id = 1');
  const anteriorAlInicio = !cfg.fecha_inicio || fin < iso(cfg.fecha_inicio); // antes de iniciar la contabilidad no hay nada que esperar
  const propiaBal = await balanceMes(fin < hoy ? fin : hoy);
  columnas.push({ codigo: propia, nombre: 'Casa Central', estado: anteriorAlInicio || propiaBal.estado === 'definitivo' ? 'ok' : 'provisorio', hasta: propiaBal.hasta, propia: true });
  datos.set(propia, anteriorAlInicio ? [] : propiaBal.lineas);
  const [paquetes] = await pool.query("SELECT sucursal, contenido, version FROM paquetes_recibidos WHERE modulo = 'contable' AND estado = 'importado'");
  const delPeriodo = paquetes.map((p) => ({ ...p, c: JSON.parse(p.contenido) })).filter((p) => p.c.periodo_contable === periodo);
  for (const s of (await Consolidacion.sucursales()).filter((x) => x.activa)) {
    if (!s.modulos.includes('contable')) { columnas.push({ codigo: s.codigo, nombre: s.nombre, estado: 'sin_contable' }); continue; } // EX17
    const mejores = delPeriodo.filter((p) => p.sucursal === s.codigo).sort((a, b) => (b.c.hasta > a.c.hasta ? 1 : b.c.hasta < a.c.hasta ? -1 : b.version - a.version));
    const p = mejores[0];
    if (!p) { columnas.push({ codigo: s.codigo, nombre: s.nombre, estado: 'falta' }); continue; } // EX16
    const eq = await equivalenciasDe(s.codigo);
    const lineas = p.c.lineas.map((l) => ({ ...l, codigo: eq.get(l.codigo) ?? l.codigo }));
    columnas.push({ codigo: s.codigo, nombre: s.nombre, estado: p.c.estado === 'definitivo' ? 'ok' : 'provisorio', hasta: p.c.hasta });
    datos.set(s.codigo, lineas);
  }
  const plan = new Map((await pool.query('SELECT codigo, nombre FROM con_cuentas')).at(0).map((c) => [c.codigo, c.nombre]));
  const filas = new Map();
  for (const [col, lineas] of datos) for (const l of lineas) {
    const f = filas.get(l.codigo) ?? { codigo: l.codigo, nombre: plan.get(l.codigo) ?? l.nombre, saldo_inicial: 0, debe: 0, haber: 0, saldo_final: 0, sucursales: {} };
    f.saldo_inicial = r2(f.saldo_inicial + l.saldo_inicial); f.debe = r2(f.debe + l.debe); f.haber = r2(f.haber + l.haber); f.saldo_final = r2(f.saldo_final + l.saldo_final);
    f.sucursales[col] = r2((f.sucursales[col] ?? 0) + l.saldo_final);
    filas.set(l.codigo, f);
  }
  const lista = [...filas.values()].sort((a, b) => a.codigo.localeCompare(b.codigo, 'en', { numeric: true }));
  const tot = (k) => r2(lista.reduce((s, f) => s + f[k], 0));
  const faltan = columnas.filter((c) => c.estado === 'falta').map((c) => c.codigo), provisorias = columnas.filter((c) => c.estado === 'provisorio').map((c) => c.codigo);
  return {
    periodo, estado: faltan.length ? 'incompleto' : provisorias.length ? 'provisorio' : 'completo', sucursales: columnas, sucursales_faltantes: faltan, sucursales_provisorias: provisorias, sin_contable: columnas.filter((c) => c.estado === 'sin_contable').map((c) => c.codigo),
    filas: lista, totales: { saldo_inicial: tot('saldo_inicial'), debe: tot('debe'), haber: tot('haber'), saldo_final: tot('saldo_final') }, cuadra: tot('debe') === tot('haber') && tot('saldo_final') === 0, fin: iso(fin),
  };
};

const exportable = (b) => {
  const cols = b.sucursales.filter((s) => s.estado === 'ok' || s.estado === 'provisorio');
  return { titulo: 'Balance consolidado', subtitulo: `Período ${b.periodo} — ${b.estado}`, filtros: [], resumen: [{ label: 'Estado', valor: b.estado }, { label: 'Sucursales faltantes', valor: b.sucursales_faltantes.join(', ') || 'ninguna' }],
    hojas: [{ nombre: 'Consolidado', columnas: [{ key: 'codigo', label: 'Código' }, { key: 'nombre', label: 'Cuenta' }, ...cols.map((s) => ({ key: `s_${s.codigo}`, label: `${s.codigo}${s.estado === 'provisorio' ? ' (prov.)' : ''}`, tipo: 'moneda' })), { key: 'debe', label: 'Debe', tipo: 'moneda' }, { key: 'haber', label: 'Haber', tipo: 'moneda' }, { key: 'saldo_final', label: 'Saldo total', tipo: 'moneda' }],
      filas: b.filas.map((f) => ({ ...f, ...Object.fromEntries(cols.map((s) => [`s_${s.codigo}`, f.sucursales[s.codigo] ?? 0])) })) }] };
};

module.exports = { balanceMes, equivalencias, fijarEquivalencias, consolidado, exportable };
