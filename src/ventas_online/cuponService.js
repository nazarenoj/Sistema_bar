const pool = require('../config/db');
const Funciones = require('../funciones/servicio');
const { TiendaInvalida } = require('./tiendaService');

// Cupones y regla de envío gratis (Ventas Online RF07, RN23, RN24, EX10). Un cupón es porcentaje o monto, con mínimo de compra, vigencia, usos máximos (totales y por cliente) y alcance
// (artículos o categorías). Se aplica sobre el importe de los ítems alcanzados, después de las opciones y antes del envío. Desactivada ONL-CUPONES, la tienda no ofrece ni cupones ni envío
// gratis, pero los cupones ya emitidos se conservan sin uso.
const invalida = (m, status = 400, extra = {}) => Object.assign(new TiendaInvalida(m), { status, ...extra });
const r2 = (x) => Math.round(Number(x) * 100) / 100;
const fechaOk = (v) => v === null || v === undefined || /^\d{4}-\d{2}-\d{2}$/.test(String(v));

const vista = (c) => ({ id: c.id, codigo: c.codigo, descripcion: c.descripcion, tipo: c.tipo, valor: Number(c.valor), minimo_compra: Number(c.minimo_compra), vigente_desde: c.vigente_desde ? new Date(c.vigente_desde).toISOString().slice(0, 10) : null,
  vigente_hasta: c.vigente_hasta ? new Date(c.vigente_hasta).toISOString().slice(0, 10) : null, usos_max: c.usos_max, usos_por_cliente: c.usos_por_cliente, usos: c.usos, alcance_tipo: c.alcance_tipo,
  alcance: c.alcance ? JSON.parse(c.alcance) : [], acumulable: !!c.acumulable, activo: !!c.activo });
const porCodigo = async (codigo, db = pool) => (await db.query('SELECT * FROM onl_cupones WHERE codigo = ?', [String(codigo ?? '').trim()]))[0][0] ?? null;

const validar = async (d, previo) => {
  const x = { ...(previo ? vista(previo) : {}), ...d };
  const codigo = String(x.codigo ?? '').trim().toUpperCase();
  if (!/^[A-Z0-9_-]{3,40}$/.test(codigo)) throw invalida('El código del cupón tiene de 3 a 40 letras, números, guion o guion bajo.');
  if (!['porcentaje', 'monto'].includes(x.tipo)) throw invalida('El tipo es porcentaje o monto.');
  const valor = Number(x.valor);
  if (!(valor > 0) || (x.tipo === 'porcentaje' && valor > 100)) throw invalida('El valor debe ser mayor a cero (hasta 100 si es porcentaje).');
  if (!fechaOk(x.vigente_desde) || !fechaOk(x.vigente_hasta)) throw invalida('La vigencia va como AAAA-MM-DD.');
  if (x.vigente_desde && x.vigente_hasta && x.vigente_hasta < x.vigente_desde) throw invalida('La vigencia termina después de empezar.');
  for (const k of ['usos_max', 'usos_por_cliente']) if (x[k] !== null && x[k] !== undefined && (!Number.isInteger(x[k]) || x[k] < 1)) throw invalida(`${k} es un entero mayor a cero.`);
  const minimo = Number(x.minimo_compra ?? 0);
  if (!(minimo >= 0)) throw invalida('El mínimo de compra no puede ser negativo.');
  const tipoAlcance = x.alcance_tipo ?? 'todo';
  if (!['todo', 'articulos', 'categorias'].includes(tipoAlcance)) throw invalida('El alcance es todo, articulos o categorias.');
  const alcance = tipoAlcance === 'todo' ? [] : x.alcance;
  if (tipoAlcance !== 'todo' && (!Array.isArray(alcance) || !alcance.length || alcance.some((i) => !Number.isInteger(i)))) throw invalida('El alcance es una lista de ids.');
  return { codigo, tipo: x.tipo, valor, minimo, desde: x.vigente_desde ?? null, hasta: x.vigente_hasta ?? null, usosMax: x.usos_max ?? null, porCliente: x.usos_por_cliente ?? null, tipoAlcance, alcance, acumulable: x.acumulable ? 1 : 0, descripcion: x.descripcion ? String(x.descripcion).slice(0, 120) : null };
};

const crear = async (d) => {
  const v = await validar(d);
  try {
    const [r] = await pool.query('INSERT INTO onl_cupones (codigo, descripcion, tipo, valor, minimo_compra, vigente_desde, vigente_hasta, usos_max, usos_por_cliente, alcance_tipo, alcance, acumulable) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [v.codigo, v.descripcion, v.tipo, v.valor, v.minimo, v.desde, v.hasta, v.usosMax, v.porCliente, v.tipoAlcance, JSON.stringify(v.alcance), v.acumulable]);
    return vista((await pool.query('SELECT * FROM onl_cupones WHERE id = ?', [r.insertId]))[0][0]);
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') throw invalida('Ya existe un cupón con ese código.', 409, { codigo: 'CUPON_DUPLICADO' });
    throw err;
  }
};
const editar = async (id, d) => {
  const [[p]] = await pool.query('SELECT * FROM onl_cupones WHERE id = ?', [id]);
  if (!p) throw invalida('Cupón no encontrado.', 404);
  const v = await validar({ ...d, codigo: p.codigo }, p);
  await pool.query('UPDATE onl_cupones SET descripcion = ?, tipo = ?, valor = ?, minimo_compra = ?, vigente_desde = ?, vigente_hasta = ?, usos_max = ?, usos_por_cliente = ?, alcance_tipo = ?, alcance = ?, acumulable = ?, activo = ? WHERE id = ?',
    [v.descripcion, v.tipo, v.valor, v.minimo, v.desde, v.hasta, v.usosMax, v.porCliente, v.tipoAlcance, JSON.stringify(v.alcance), v.acumulable, d.activo === undefined ? p.activo : d.activo ? 1 : 0, id]);
  return vista((await pool.query('SELECT * FROM onl_cupones WHERE id = ?', [id]))[0][0]);
};
const listar = async () => (await pool.query('SELECT * FROM onl_cupones ORDER BY id DESC'))[0].map(vista);

// ---- Aplicación ----

// Valida un cupón contra un carrito. `lineas`: [{ producto_id, categoria_id, importe }] (importe = cantidad × precio con opciones). `quien`: c:ID o el correo del invitado (para el tope por cliente).
// Devuelve { valido, motivo? , descuento, alcanzadas } (EX10: ante un cupón inválido el total queda sin descuento y se muestra el motivo).
const evaluar = async (codigo, lineas, { quien = null, hoy = new Date() } = {}) => {
  if (!(await Funciones.estaActiva('ONL-CUPONES'))) return { valido: false, motivo: 'Los cupones no están habilitados.', codigo: 'CUPONES_INACTIVOS' };
  const c = await porCodigo(codigo);
  const no = (motivo, cod) => ({ valido: false, motivo, codigo: cod });
  if (!c || !c.activo) return no('El cupón no existe.', 'CUPON_NO_EXISTE');
  const dia = hoy.toISOString().slice(0, 10);
  if (c.vigente_desde && dia < new Date(c.vigente_desde).toISOString().slice(0, 10)) return no('El cupón todavía no está vigente.', 'CUPON_NO_VIGENTE');
  if (c.vigente_hasta && dia > new Date(c.vigente_hasta).toISOString().slice(0, 10)) return no('El cupón está vencido.', 'CUPON_VENCIDO');
  if (c.usos_max !== null && c.usos >= c.usos_max) return no('El cupón se agotó.', 'CUPON_AGOTADO');
  if (c.usos_por_cliente !== null && quien) {
    const [[{ n }]] = await pool.query('SELECT COUNT(*) AS n FROM onl_cupon_usos WHERE cupon_id = ? AND quien = ?', [c.id, quien]);
    if (n >= c.usos_por_cliente) return no('Ya usaste este cupón la cantidad de veces permitida.', 'CUPON_USADO');
  }
  const alcance = c.alcance ? JSON.parse(c.alcance) : [];
  const alcanzadas = lineas.filter((l) => c.alcance_tipo === 'todo' || (c.alcance_tipo === 'articulos' ? alcance.includes(l.producto_id) : alcance.includes(l.categoria_id)));
  const base = r2(alcanzadas.reduce((a, l) => a + l.importe, 0));
  if (!alcanzadas.length) return no('El cupón no aplica a ningún artículo del carrito.', 'CUPON_SIN_ALCANCE');
  const subtotal = r2(lineas.reduce((a, l) => a + l.importe, 0));
  if (subtotal < Number(c.minimo_compra)) return no(`El cupón pide una compra mínima de ${Number(c.minimo_compra)}.`, 'CUPON_MINIMO');
  const descuento = c.tipo === 'porcentaje' ? r2(base * Number(c.valor) / 100) : Math.min(r2(c.valor), base);
  return { valido: true, cupon: { id: c.id, codigo: c.codigo, tipo: c.tipo, valor: Number(c.valor), acumulable: !!c.acumulable }, descuento, alcanzadas: alcanzadas.map((l) => l.linea) };
};

// Un pedido confirmado consume un uso (lo llama el checkout, en su transacción). Idempotente por pedido.
const consumir = async (conn, cuponId, { quien, pedidoId, importe }) => {
  const [r] = await conn.query('INSERT IGNORE INTO onl_cupon_usos (cupon_id, quien, pedido_id, importe, ts_ms) VALUES (?, ?, ?, ?, ?)', [cuponId, quien, pedidoId, importe, Date.now()]);
  if (r.affectedRows) await conn.query('UPDATE onl_cupones SET usos = usos + 1 WHERE id = ?', [cuponId]);
  return r.affectedRows === 1;
};
// Cancelar el pedido repone el uso, pero el descuento ya calculado no se recalcula (RN49).
const reponer = async (conn, cuponId, pedidoId) => {
  const [r] = await conn.query('DELETE FROM onl_cupon_usos WHERE cupon_id = ? AND pedido_id = ?', [cuponId, pedidoId]);
  if (r.affectedRows) await conn.query('UPDATE onl_cupones SET usos = GREATEST(usos - 1, 0) WHERE id = ?', [cuponId]);
};

const envioGratis = async (subtotal) => {
  if (!(await Funciones.estaActiva('ONL-CUPONES'))) return { activo: false, gratis: false, minimo: null };
  const [[t]] = await pool.query('SELECT envio_gratis_desde FROM onl_tienda WHERE id = 1');
  const minimo = t.envio_gratis_desde === null ? null : Number(t.envio_gratis_desde);
  return { activo: minimo !== null, gratis: minimo !== null && subtotal >= minimo, minimo };
};
const fijarEnvioGratis = async (minimo) => {
  if (minimo !== null && !(Number(minimo) >= 0)) throw invalida('El monto mínimo no puede ser negativo.');
  await pool.query('UPDATE onl_tienda SET envio_gratis_desde = ? WHERE id = 1', [minimo === null ? null : Number(minimo)]);
  return { envio_gratis_desde: minimo === null ? null : Number(minimo) };
};

module.exports = { crear, editar, listar, porCodigo, evaluar, consumir, reponer, envioGratis, fijarEnvioGratis };
