const pool = require('../config/db');
const M = require('../mensajeria/servicio');
const llamar = require('../modulos/llamar');
const Modulos = require('../modulos/registro');
const Funciones = require('../funciones/servicio');
const Claves = require('../servicios/comprobanteTerceroService');
const Lectura = require('../servicios/lecturaComprobanteService');
const Presentacion = require('../models/presentacionModel');
const afipConfig = require('../config/afipConfig');
const { idGlobal } = require('../utils/idGlobal');
const Proveedores = require('./proveedorService');
const { invalida, r2, r4, cts, hoy, iso } = require('./comun');

// Comprobantes de compra (Compras RF03, RF18, RN03, RN04, RN08, RN12, RN35). La clave unívoca la arma el servicio de plataforma (Usuarios RF27, llamada n.º 10) antes de guardar: un
// duplicado exacto o un CAE repetido se bloquean y un casi duplicado pide confirmación con motivo y permiso. Si el servicio de claves no responde, el comprobante queda en borrador.
// Los importes tienen que cerrar con el total (EX05) y un período de IVA cerrado no admite comprobantes nuevos (RN12, EX11).
const CLASES = ['FACTURA', 'NOTA_CREDITO', 'NOTA_DEBITO', 'TICKET', 'RECIBO', 'OTRO'];
const LETRAS = ['A', 'B', 'C', 'M', 'X'];
const ALICUOTAS = [0, 2.5, 5, 10.5, 21, 27];
const ESTADOS_CLAVE = {
  duplicado_exacto: ['El comprobante ya está cargado (duplicado exacto): un comprobante se registra una sola vez.', 'DUPLICADO_EXACTO'],
  en_proceso: ['Otra carga de este comprobante está en proceso.', 'EN_PROCESO'],
  bloqueado_cae: ['Ese CAE ya pertenece a otro comprobante: corregí los datos.', 'CAE_REPETIDO'],
};

const num = (v, nombre, { min = 0 } = {}) => {
  const n = v === undefined || v === null || v === '' ? 0 : Number(v);
  if (!Number.isFinite(n) || n < min) throw invalida(`${nombre} debe ser un número${min >= 0 ? ' mayor o igual a cero' : ''}.`);
  return r2(n);
};
const fechaValida = (f, nombre) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(f ?? '')) || new Date(`${f}T00:00:00Z`).toISOString().slice(0, 10) !== f) throw invalida(`${nombre} debe tener el formato AAAA-MM-DD.`);
  return String(f);
};

// ---- Períodos de IVA (RN12) ----

const periodoDe = (fecha) => fecha.slice(0, 7);
const siguientePeriodo = (p) => { const [a, m] = p.split('-').map(Number); return m === 12 ? `${a + 1}-01` : `${a}-${String(m + 1).padStart(2, '0')}`; };
const cerradoEs = async (p, db = pool) => (await db.query("SELECT 1 FROM cmp_periodos_iva WHERE periodo = ? AND estado = 'cerrado'", [p]))[0].length > 0;
// El período al que se imputa un comprobante: el de su fecha o, si está cerrado, el primer período abierto (EX11).
const periodoImputable = async (fecha, db = pool) => {
  let p = periodoDe(fecha);
  while (await cerradoEs(p, db)) p = siguientePeriodo(p);
  return { periodo: p, desplazado: p !== periodoDe(fecha) };
};
const periodos = async () => (await pool.query(
  `SELECT p.periodo, COALESCE(x.estado, 'abierto') AS estado, p.cantidad, p.total FROM (SELECT periodo_iva AS periodo, COUNT(*) AS cantidad, SUM(CASE WHEN clase = 'NOTA_CREDITO' THEN -total ELSE total END) AS total FROM cmp_comprobantes WHERE estado <> 'anulado' GROUP BY periodo_iva) p
   LEFT JOIN cmp_periodos_iva x ON x.periodo = p.periodo ORDER BY p.periodo DESC`))[0].map((p) => ({ ...p, cantidad: Number(p.cantidad), total: r2(p.total) }));
const cerrarPeriodo = async (periodo, userId) => {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(periodo))) throw invalida('El período va como AAAA-MM.');
  if (await cerradoEs(periodo)) throw invalida('El período ya está cerrado.', 409);
  await pool.query("INSERT INTO cmp_periodos_iva (periodo, estado, cerrado_ms, cerrado_por) VALUES (?, 'cerrado', ?, ?) ON DUPLICATE KEY UPDATE estado = 'cerrado', cerrado_ms = VALUES(cerrado_ms), cerrado_por = VALUES(cerrado_por)", [periodo, Date.now(), userId ?? null]);
  return { periodo, estado: 'cerrado' };
};

// ---- Lectura ----

const vista = (c) => ({
  id: c.id, id_global: c.id_global, proveedor_id: c.proveedor_id, proveedor: c.proveedor ?? null, cuit: c.cuit ?? null, clase: c.clase, tipo: c.tipo, punto_venta: c.punto_venta, numero: c.numero, fecha: iso(c.fecha),
  cae: c.cae, cae_tipo: c.cae_tipo, cae_vencimiento: iso(c.cae_vencimiento), moneda: c.moneda, cotizacion: c.cotizacion === null ? null : Number(c.cotizacion),
  neto_gravado: Number(c.neto_gravado), no_gravado: Number(c.no_gravado), exento: Number(c.exento), iva: Number(c.iva), iva_computable: Number(c.iva_computable), percepciones_iva: Number(c.percepciones_iva),
  percepciones_iibb: Number(c.percepciones_iibb), impuestos_internos: Number(c.impuestos_internos), otros_tributos: Number(c.otros_tributos), total: Number(c.total), estado: c.estado, constatacion: c.constatacion,
  origen: c.origen, periodo_iva: c.periodo_iva, clave: c.clave, observacion: c.observacion, motivo_anulacion: c.motivo_anulacion, ts_ms: Number(c.ts_ms),
});
const fila = async (id, db = pool) => {
  const [[c]] = await db.query('SELECT c.*, p.razon_social AS proveedor, p.cuit FROM cmp_comprobantes c JOIN cmp_proveedores p ON p.id = c.proveedor_id WHERE c.id = ?', [id]);
  if (!c) throw invalida('Comprobante no encontrado.', 404);
  return c;
};
const obtener = async (id) => {
  const c = vista(await fila(id));
  const [alic] = await pool.query('SELECT alicuota, neto, iva FROM cmp_comprobante_alicuotas WHERE comprobante_id = ? ORDER BY alicuota', [id]);
  const [lin] = await pool.query('SELECT linea, tipo, item_tipo, item_id, descripcion, categoria, cantidad, unidad, presentacion_id, factor_aplicado, precio_unitario, bonificacion_pct, importe, costo_unidad_base FROM cmp_comprobante_lineas WHERE comprobante_id = ? ORDER BY linea', [id]);
  const num2 = (x) => (x === null ? null : Number(x));
  return { ...c, alicuotas: alic.map((a) => ({ alicuota: Number(a.alicuota), neto: Number(a.neto), iva: Number(a.iva) })),
    lineas: lin.map((l) => ({ ...l, cantidad: Number(l.cantidad), factor_aplicado: num2(l.factor_aplicado), precio_unitario: Number(l.precio_unitario), bonificacion_pct: Number(l.bonificacion_pct), importe: Number(l.importe), costo_unidad_base: num2(l.costo_unidad_base) })) };
};
const listar = async ({ proveedorId, desde, hasta, clase, estado, periodo, limite = 200 } = {}) => {
  const w = [], p = [];
  if (proveedorId) { w.push('c.proveedor_id = ?'); p.push(Number(proveedorId)); }
  if (desde) { w.push('c.fecha >= ?'); p.push(desde); }
  if (hasta) { w.push('c.fecha <= ?'); p.push(hasta); }
  if (clase) { w.push('c.clase = ?'); p.push(clase); }
  if (estado) { w.push('c.estado = ?'); p.push(estado); }
  if (periodo) { w.push('c.periodo_iva = ?'); p.push(periodo); }
  const [filas] = await pool.query(`SELECT c.*, p.razon_social AS proveedor, p.cuit FROM cmp_comprobantes c JOIN cmp_proveedores p ON p.id = c.proveedor_id ${w.length ? `WHERE ${w.join(' AND ')}` : ''} ORDER BY c.fecha DESC, c.id DESC LIMIT ?`, [...p, Math.min(Number(limite) || 200, 1000)]);
  return filas.map(vista);
};

// ---- Registro ----

// Las presentaciones de compra son de Stock: se elige una con uso «compra» del ítem y vigente a la fecha del documento (RF18, RN23, EX16). Sin Stock la unidad es texto.
const presentacionDe = async (l, fecha, ctx) => {
  if (!l.presentacion_id) return null;
  if (!(await Modulos.estaInstalado('stock')) || !(await Funciones.estaActiva('CMP-UNIDADES-COMPRA'))) return null; // sin Stock no hay unidades de compra
  let p;
  try { p = (await llamar(15, 'compras', async () => Presentacion.getById(Number(l.presentacion_id)))).valor; } catch (err) {
    if (err.codigo === 'LLAMADA_CERRADA') throw invalida('Stock no responde: la línea queda sin confirmar hasta poder elegir la presentación.', 409, { codigo: 'PRESENTACION_NO_CONFIRMADA' });
    throw err;
  }
  const falta = (m) => invalida(`${m} Un usuario con permiso de Stock puede crearla.`, 409, { codigo: 'PRESENTACION_NO_EXISTE', detalle: { puede_crear: !!ctx.puedeCrearPresentacion } });
  if (!p) throw falta('La presentación no existe.');
  if (!String(p.usos).split(',').includes('compra')) throw falta('La presentación no es de uso «compra».');
  if (l.item?.id && Number(p.insumo_id) !== Number(l.item.id)) throw invalida('La presentación es de otro insumo.', 409, { codigo: 'PRESENTACION_OTRO_ITEM' });
  const f = new Date(`${fecha}T23:59:59`);
  if (new Date(p.vigente_desde) > f || (p.vigente_hasta && new Date(p.vigente_hasta) <= new Date(`${fecha}T00:00:00`))) throw falta('La presentación no tiene versión vigente a la fecha del documento.');
  return p;
};

const lineas = async (d, fecha, tolerancia, ctx) => {
  if (!Array.isArray(d.lineas) || !d.lineas.length) return [];
  const out = [];
  for (const [i, l] of d.lineas.entries()) {
    const tipo = l.tipo === 'concepto' ? 'concepto' : 'mercaderia';
    const descripcion = String(l.descripcion ?? '').trim();
    if (!descripcion) throw invalida(`La línea ${i + 1} necesita una descripción.`);
    const cantidad = Number(l.cantidad);
    if (!(cantidad > 0) || (String(l.cantidad).split('.')[1] ?? '').length > 3) throw invalida(`La cantidad de la línea ${i + 1} debe ser mayor a cero y admite hasta 3 decimales.`);
    const precio = Number(l.precio_unitario);
    if (!(precio >= 0)) throw invalida(`El precio de la línea ${i + 1} no puede ser negativo.`);
    const bonif = l.bonificacion_pct === undefined ? 0 : Number(l.bonificacion_pct);
    if (!(bonif >= 0 && bonif <= 100)) throw invalida(`La bonificación de la línea ${i + 1} es un porcentaje entre 0 y 100.`);
    const p = await presentacionDe(l, fecha, ctx);
    const importe = r2(cantidad * precio * (1 - bonif / 100));
    out.push({ linea: i + 1, tipo, item_tipo: l.item?.tipo ?? null, item_id: l.item?.id ?? null, descripcion: descripcion.slice(0, 200), categoria: l.categoria ? String(l.categoria).slice(0, 80) : null, cantidad, unidad: l.unidad ? String(l.unidad).slice(0, 30) : p?.nombre ?? null,
      presentacion_id: p?.id ?? null, factor_aplicado: p ? Number(p.factor) : null, precio_unitario: precio, bonificacion_pct: bonif, importe, costo_unidad_base: p ? r4(precio * (1 - bonif / 100) / Number(p.factor)) : null });
  }
  void tolerancia;
  return out;
};

// La clave del comprobante con el servicio de plataforma (llamada n.º 10). `null` si el servicio no respondió: el comprobante queda en borrador.
const reservarClave = async (prov, d, total, ctx) => {
  let r;
  try {
    r = (await llamar(10, 'compras', () => Claves.reservar({ cuit: prov.cuit, clase: d.clase, tipo: d.tipo, punto_venta: d.punto_venta, numero: d.numero, fecha: d.fecha, importe: total, cae: d.cae, cae_tipo: d.cae_tipo },
      { modulo: 'compras', userId: ctx.userId, idSolicitud: ctx.idSolicitud, idClave: ctx.idClave, confirmar: d.confirmar_casi_duplicado ? { motivo: d.confirmar_casi_duplicado.motivo, autorizante_id: ctx.autorizanteId } : null }))).valor;
  } catch (err) {
    if (err.codigo === 'LLAMADA_CERRADA' && err.causa instanceof Claves.ClaveInvalida) throw invalida(err.causa.message, 400, { codigo: 'DATOS_INVALIDOS', detalle: { campo: err.causa.campo } });
    if (err.codigo === 'LLAMADA_CERRADA') return null;
    throw err;
  }
  if (r.estado === 'vinculable') return { ...r, id_reserva: null };
  if (ESTADOS_CLAVE[r.estado]) {
    await ctx.auditar?.(`comprobante_${r.estado}`, `${r.clave}: ${ESTADOS_CLAVE[r.estado][0]}`);
    throw invalida(ESTADOS_CLAVE[r.estado][0], 409, { codigo: ESTADOS_CLAVE[r.estado][1], detalle: { clave: r.clave, existente: r.documento ?? r.comprobante ?? null, modulo: r.modulo ?? null } });
  }
  if (r.estado === 'casi_duplicado') throw invalida('Hay un comprobante muy parecido ya cargado: revisalo y, si es distinto, confirmá con el motivo.', 409, { codigo: 'CASI_DUPLICADO', detalle: { clave: r.clave, coincidentes: r.coincidentes } });
  return r;
};

const registrar = async (d, ctx = {}) => {
  const cfg = await Proveedores.config();
  const tol = cfg.tolerancia_redondeo;
  // Proveedor (RN02): el CUIT del emisor tiene que estar dado de alta (EX02 ofrece el alta al leer una foto).
  const prov = d.proveedor_id ? await Proveedores.obtener(Number(d.proveedor_id)) : await Proveedores.porCuit(String(d.cuit ?? '').replace(/\D/g, ''));
  if (!prov) throw invalida('El CUIT del emisor no está dado de alta como proveedor.', 404, { codigo: 'PROVEEDOR_NO_EXISTE', detalle: { cuit: d.cuit ?? null } });
  if (prov.estado !== 'activo') throw invalida('El proveedor está desactivado.', 409);
  const clase = String(d.clase ?? '').toUpperCase();
  if (!CLASES.includes(clase)) throw invalida(`La clase es una de: ${CLASES.join(', ')}.`);
  const tipo = String(d.tipo ?? '').toUpperCase();
  if (!LETRAS.includes(tipo)) throw invalida('La letra del comprobante es A, B, C, M o X.');
  const fecha = fechaValida(d.fecha ?? hoy(), 'La fecha');
  if (fecha > hoy()) throw invalida('La fecha del comprobante no puede ser futura.');
  const caeVto = d.cae_vencimiento ? fechaValida(d.cae_vencimiento, 'El vencimiento del CAE') : null;
  const moneda = String(d.moneda ?? prov.moneda).toUpperCase();
  let cotizacion = null;
  if (moneda !== 'ARS') { // RN07: el costo se guarda en la moneda del comprobante; la cotización queda como dato
    const Monedas = require('../servicios/monedaService');
    const c = d.cotizacion ? { vendedor: Number(d.cotizacion) } : await Monedas.vigente(moneda).catch(() => null);
    if (!c || !(Number(c.vendedor) > 0)) throw invalida(`Indicá la cotización de ${moneda}: no hay una vigente.`, 409, { codigo: 'SIN_COTIZACION' });
    cotizacion = Number(c.vendedor);
  }
  // Importes (EX05): las alícuotas explican el neto y el IVA, y todo suma el total dentro de la tolerancia de redondeo.
  const alicuotas = (d.alicuotas ?? []).map((a) => {
    const al = Number(a.alicuota);
    if (!ALICUOTAS.includes(al)) throw invalida(`La alícuota es una de: ${ALICUOTAS.join(', ')}.`);
    return { alicuota: al, neto: num(a.neto, 'El neto de una alícuota'), iva: num(a.iva, 'El IVA de una alícuota') };
  });
  const netoGravado = d.neto_gravado !== undefined ? num(d.neto_gravado, 'El neto gravado') : r2(alicuotas.reduce((s, a) => s + a.neto, 0));
  const iva = d.iva !== undefined ? num(d.iva, 'El IVA') : r2(alicuotas.reduce((s, a) => s + a.iva, 0));
  if (alicuotas.length && (Math.abs(r2(alicuotas.reduce((s, a) => s + a.neto, 0)) - netoGravado) > tol || Math.abs(r2(alicuotas.reduce((s, a) => s + a.iva, 0)) - iva) > tol))
    throw invalida('Las alícuotas no suman el neto gravado y el IVA del comprobante.', 400, { codigo: 'IMPORTES_NO_CIERRAN' });
  if (!alicuotas.length && (netoGravado > 0 || iva > 0)) throw invalida('Indicá el neto y el IVA por alícuota.');
  const noGravado = num(d.no_gravado, 'El no gravado'), exento = num(d.exento, 'El exento'), percIva = num(d.percepciones_iva, 'Las percepciones de IVA'), internos = num(d.impuestos_internos, 'Los impuestos internos'), otros = num(d.otros_tributos, 'Los otros tributos');
  const iibb = (d.percepciones_iibb_detalle ?? []).map((x) => ({ jurisdiccion: String(x.jurisdiccion ?? '').trim().slice(0, 40), importe: num(x.importe, 'La percepción de Ingresos Brutos') }));
  if (iibb.some((x) => !x.jurisdiccion)) throw invalida('Cada percepción de Ingresos Brutos lleva su jurisdicción.');
  const percIibb = d.percepciones_iibb !== undefined ? num(d.percepciones_iibb, 'Las percepciones de Ingresos Brutos') : r2(iibb.reduce((s, x) => s + x.importe, 0));
  if (iibb.length && Math.abs(r2(iibb.reduce((s, x) => s + x.importe, 0)) - percIibb) > tol) throw invalida('Las percepciones por jurisdicción no suman las de Ingresos Brutos.', 400, { codigo: 'IMPORTES_NO_CIERRAN' });
  const suma = r2(netoGravado + noGravado + exento + iva + percIva + percIibb + internos + otros);
  const total = d.total !== undefined ? num(d.total, 'El total') : suma;
  if (!(total > 0)) throw invalida('El total debe ser mayor a cero.');
  if (Math.abs(total - suma) > tol) throw invalida(`Los componentes suman ${suma} y el total es ${total} (tolerancia ${tol}).`, 400, { codigo: 'IMPORTES_NO_CIERRAN', detalle: { suma, total, diferencia: r2(total - suma) } });
  const lins = await lineas(d, fecha, tol, ctx);
  if (lins.length) {
    const cuerpo = r2(netoGravado + noGravado + exento);
    const sumaLineas = r2(lins.reduce((s, l) => s + l.importe, 0));
    if (Math.abs(sumaLineas - cuerpo) > tol * Math.max(1, lins.length)) throw invalida(`Las líneas suman ${sumaLineas} y el neto más el no gravado y el exento es ${cuerpo}.`, 400, { codigo: 'LINEAS_NO_CIERRAN', detalle: { lineas: sumaLineas, cuerpo } });
  }
  // RN04: un Responsable Inscripto solo computa el IVA de los comprobantes A y M; en B y C el IVA integra el costo. Se advierte si la letra no corresponde.
  const ri = afipConfig.condicionIvaEmisor === 'responsable_inscripto';
  const advertencias = [];
  const ivaComputable = ri && ['A', 'M'].includes(tipo) ? iva : 0;
  if (tipo === 'A' && prov.condicion_iva && !/Responsable Inscripto/i.test(prov.condicion_iva)) advertencias.push(`Un comprobante A lo emite un Responsable Inscripto y el proveedor figura como ${prov.condicion_iva}.`);
  if (['A', 'M'].includes(tipo) && !ri) advertencias.push('La instancia no es Responsable Inscripto: el IVA de este comprobante no se computa como crédito fiscal.');
  if (iva > 0 && ['B', 'C'].includes(tipo)) advertencias.push('El IVA de un comprobante B o C no se computa: integra el costo.');
  // Período de IVA (RN12, EX11).
  const per = await periodoImputable(fecha);
  if (per.desplazado) advertencias.push(`El período ${periodoDe(fecha)} ya está cerrado: se imputa al ${per.periodo}.`);

  const reserva = await reservarClave(prov, { clase, tipo, punto_venta: d.punto_venta, numero: d.numero, fecha, cae: d.cae, cae_tipo: d.cae_tipo, confirmar_casi_duplicado: d.confirmar_casi_duplicado }, total, ctx);
  if (d.confirmar_casi_duplicado) await ctx.auditar?.('comprobante_casi_duplicado_confirmado', `${reserva?.clave ?? ''}: ${d.confirmar_casi_duplicado.motivo}`);
  const borrador = reserva === null;
  const pv = String(d.punto_venta ?? '').replace(/\D/g, '').padStart(5, '0'), nro = String(d.numero ?? '').replace(/\D/g, '').padStart(8, '0');
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const idG = await idGlobal();
    const esperaMercaderia = !borrador && lins.some((l) => l.tipo === 'mercaderia' && l.item_tipo && l.item_id) && ['FACTURA', 'TICKET', 'OTRO'].includes(clase) && (await Modulos.estaInstalado('stock'));
    const estado = borrador ? 'borrador' : (ctx.estado ?? (esperaMercaderia ? 'pendiente_recepcion' : 'registrado'));
    const [r] = await conn.query(
      `INSERT INTO cmp_comprobantes (id_global, proveedor_id, clase, tipo, punto_venta, numero, fecha, cae, cae_tipo, cae_vencimiento, moneda, cotizacion, neto_gravado, no_gravado, exento, iva, iva_computable, percepciones_iva, percepciones_iibb,
         percepciones_detalle, impuestos_internos, otros_tributos, total, estado, origen, periodo_iva, clave, id_reserva, id_solicitud, observacion, user_id, ts_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [idG, prov.id, clase, tipo, pv, nro, fecha, d.cae ? String(d.cae).replace(/\D/g, '') : null, d.cae ? (String(d.cae_tipo ?? 'CAE').toUpperCase() === 'CAEA' ? 'CAEA' : 'CAE') : null, caeVto, moneda, cotizacion, netoGravado, noGravado, exento, iva, ivaComputable, percIva, percIibb,
        iibb.length ? JSON.stringify(iibb) : null, internos, otros, total, estado, ctx.origen ?? 'manual', per.periodo, reserva?.clave ?? null, reserva?.id_reserva ?? null, ctx.idSolicitud ?? null, d.observacion ? String(d.observacion).slice(0, 255) : null, ctx.userId ?? null, Date.now()]);
    for (const a of alicuotas) await conn.query('INSERT INTO cmp_comprobante_alicuotas (comprobante_id, alicuota, neto, iva) VALUES (?, ?, ?, ?)', [r.insertId, a.alicuota, a.neto, a.iva]);
    for (const l of lins) await conn.query(
      'INSERT INTO cmp_comprobante_lineas (comprobante_id, linea, tipo, item_tipo, item_id, descripcion, categoria, cantidad, unidad, presentacion_id, factor_aplicado, precio_unitario, bonificacion_pct, importe, costo_unidad_base) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [r.insertId, l.linea, l.tipo, l.item_tipo, l.item_id, l.descripcion, l.categoria, l.cantidad, l.unidad, l.presentacion_id, l.factor_aplicado, l.precio_unitario, l.bonificacion_pct, l.importe, l.costo_unidad_base]);
    if (!borrador) for (const h of hooksRegistro) await h(conn, { id: r.insertId, id_global: idG, clase, proveedor_id: prov.id, total, fecha }, d);
    if (!borrador) {
      if (reserva.id_reserva) await Claves.publicarConfirmacion(conn, { idReserva: reserva.id_reserva, idDocumento: idG, modulo: 'compras', rol: 'registro_fiscal', userId: ctx.userId, docTipo: 'comprobante' });
      else if (reserva.estado === 'vinculable') await Claves.vincular({ id_clave: reserva.id_clave, modulo: 'compras', id_documento: idG, rol: 'registro_fiscal', userId: ctx.userId });
      // Contable (si está) se suscribe: el comprobante es un evento de la bandeja de salida (RF03, RN28).
      await M.publicar(conn, { origen: 'compras', destino: 'contable', tipo: 'comprobante_compra', docTipo: 'comprobante', docIdGlobal: idG, userId: ctx.userId,
        contenido: { comprobante_id_global: idG, proveedor: prov.razon_social, cuit: prov.cuit, clase, tipo, clave: reserva.clave, fecha, periodo_iva: per.periodo, moneda, neto_gravado: netoGravado, no_gravado: noGravado, exento, iva, iva_computable: ivaComputable, percepciones_iva: percIva, percepciones_iibb: percIibb, impuestos_internos: internos, otros_tributos: otros, total } });
    }
    await conn.commit();
    M.despertar();
    const c = await obtener(r.insertId);
    return { ...c, ...(advertencias.length && { advertencias }), ...(borrador && { aviso: 'El servicio de identificación de comprobantes no respondió: el comprobante quedó en borrador hasta confirmarlo.' }) };
  } catch (err) {
    await conn.rollback();
    if (reserva?.id_reserva) await Claves.cancelar(reserva.id_reserva); // no se guardó: la clave queda libre sin esperar el vencimiento
    throw err;
  } finally { conn.release(); }
};

// Confirma un comprobante que quedó en borrador porque el servicio de claves no respondió: se vuelve a cargar completo con su clave.
const confirmarBorrador = async (id, ctx) => {
  const c = await obtener(id);
  if (c.estado !== 'borrador') throw invalida('El comprobante no está en borrador.', 409);
  const datos = { proveedor_id: c.proveedor_id, clase: c.clase, tipo: c.tipo, punto_venta: c.punto_venta, numero: c.numero, fecha: c.fecha, cae: c.cae, cae_tipo: c.cae_tipo, cae_vencimiento: c.cae_vencimiento, moneda: c.moneda,
    cotizacion: c.cotizacion, alicuotas: c.alicuotas, no_gravado: c.no_gravado, exento: c.exento, percepciones_iva: c.percepciones_iva, percepciones_iibb: c.percepciones_iibb, impuestos_internos: c.impuestos_internos,
    otros_tributos: c.otros_tributos, total: c.total, observacion: c.observacion, lineas: c.lineas.map((l) => ({ ...l, item: l.item_tipo ? { tipo: l.item_tipo, id: l.item_id } : undefined })), ...(ctx.confirmar_casi_duplicado && { confirmar_casi_duplicado: ctx.confirmar_casi_duplicado }) };
  await pool.query("DELETE FROM cmp_comprobante_lineas WHERE comprobante_id = ?", [id]);
  await pool.query("DELETE FROM cmp_comprobante_alicuotas WHERE comprobante_id = ?", [id]);
  await pool.query("DELETE FROM cmp_comprobantes WHERE id = ? AND estado = 'borrador'", [id]);
  try { return await registrar(datos, { ...ctx, idSolicitud: ctx.idSolicitud ?? null }); } catch (err) {
    await pool.query('INSERT INTO cmp_comprobantes (id, id_global, proveedor_id, clase, tipo, punto_venta, numero, fecha, moneda, cotizacion, neto_gravado, no_gravado, exento, iva, iva_computable, percepciones_iva, percepciones_iibb, impuestos_internos, otros_tributos, total, estado, origen, periodo_iva, user_id, ts_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [c.id, c.id_global, c.proveedor_id, c.clase, c.tipo, c.punto_venta, c.numero, c.fecha, c.moneda, c.cotizacion, c.neto_gravado, c.no_gravado, c.exento, c.iva, c.iva_computable, c.percepciones_iva, c.percepciones_iibb, c.impuestos_internos, c.otros_tributos, c.total, 'borrador', c.origen, c.periodo_iva, null, c.ts_ms]);
    throw err;
  }
};

// ---- Ganchos (cada parte de Compras que cuelga de un comprobante: cuotas, pagos, ingresos) ----

const hooksRegistro = [];
const alRegistrar = (fn) => hooksRegistro.push(fn);
const hooksAnulado = [];
const alAnulado = (fn) => hooksAnulado.push(fn);

// ---- Anulación (RN08) ----

// Cada parte de Compras que ata a un comprobante (pagos, ingresos de Stock) suma su control: devuelve el motivo por el que no se puede anular, o null.
const controlesAnulacion = [];
const alAnular = (fn) => controlesAnulacion.push(fn);

const anular = async (id, { motivo }, ctx = {}) => {
  const c = await fila(id);
  if (c.estado === 'anulado') throw invalida('El comprobante ya está anulado.', 409);
  if (typeof motivo !== 'string' || motivo.trim().length < 3) throw invalida('El motivo es obligatorio.');
  if (await cerradoEs(c.periodo_iva)) throw invalida(`El período de IVA ${c.periodo_iva} está cerrado: el comprobante no se anula.`, 409, { codigo: 'PERIODO_CERRADO' });
  for (const control of controlesAnulacion) { const m = await control(c); if (m) throw invalida(m.mensaje ?? m, 409, { codigo: m.codigo ?? 'NO_SE_PUEDE_ANULAR' }); }
  // La clave se libera para que el comprobante pueda volver a cargarse: el anulado conserva la suya aparte.
  await pool.query("UPDATE cmp_comprobantes SET estado = 'anulado', motivo_anulacion = ?, clave_anterior = clave, clave = NULL WHERE id = ? AND estado <> 'anulado'", [motivo.trim().slice(0, 255), id]);
  for (const h of hooksAnulado) await h(c);
  if (c.clave) await Claves.anular({ modulo: 'compras', id_documento: c.id_global }).catch(() => {}); // la clave queda liberada: el comprobante puede volver a cargarse
  // Un contramovimiento hacia Contable con la fecha actual, nunca hacia atrás (RN28).
  const conn = await pool.getConnection();
  try {
    await M.publicar(conn, { origen: 'compras', destino: 'contable', tipo: 'comprobante_compra_anulado', docTipo: 'comprobante', docIdGlobal: c.id_global, docVersion: 2, secuencia: 2, userId: ctx.userId,
      contenido: { comprobante_id_global: c.id_global, motivo: motivo.trim(), fecha: hoy() } });
  } finally { conn.release(); }
  return obtener(id);
};

// ---- Foto y QR (CMP-FOTO) ----

const propuesta = async (r) => {
  const enc = r.encabezado ?? {};
  const prov = enc.cuit ? await Proveedores.porCuit(String(enc.cuit)) : null;
  return { estado: 'leido', comprobante: enc, lineas: r.lineas ?? [], faltan: r.faltan ?? [], verificacion: r.verificacion ?? null, proveedor: prov,
    ...(enc.cuit && !prov && { propuesta_alta_proveedor: { cuit: String(enc.cuit), razon_social: enc.proveedor ?? null } }) }; // EX02
};
const exigirFoto = async () => {
  if (!(await Funciones.estaActiva('CMP-FOTO'))) throw invalida('La carga por foto necesita la función CMP-FOTO.', 409, { codigo: 'FUNCION_INACTIVA' });
};
const leerFoto = async ({ imagen, tipo }) => {
  await exigirFoto();
  const r = await Lectura.leer({ imagen, tipo });
  if (r.estado !== 'ok') return { estado: 'manual', motivo: r.motivo ?? 'No se pudo leer la imagen: cargá el comprobante a mano.' };
  return propuesta(r);
};
// El encabezado del QR fiscal de ARCA se toma aunque no haya conexión (RF03).
const leerQr = async (texto) => {
  await exigirFoto();
  const r = await Lectura.leerQr(texto);
  if (r.estado !== 'ok') return { estado: 'manual', motivo: r.motivo ?? 'No se pudo leer el QR: cargá el comprobante a mano.' };
  return propuesta(r);
};

module.exports = { alRegistrar, alAnulado, CLASES, periodoImputable, periodos, cerrarPeriodo, cerradoEs, obtener, fila, listar, registrar, confirmarBorrador, alAnular, anular, leerFoto, leerQr, cts };
