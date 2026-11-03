const crypto = require('crypto');
const pool = require('../config/db');
const Funciones = require('../funciones/servicio');
const M = require('../mensajeria/servicio');
const llamar = require('../modulos/llamar');
const { idGlobal } = require('../utils/idGlobal');

// Maestro de clientes (Clientes y CC RF01, RF02, RF18, RF19, RF21, RN01, RN02, RN22, RN43). Un documento identifica a un único cliente
// (salvo el Consumidor Final genérico); CUIT y CUIL llevan dígito verificador; las fichas unificadas quedan como alias de la resultante.
class ClienteInvalido extends Error {}
const invalida = (m, status = 400, extra = {}) => Object.assign(new ClienteInvalido(m), { status, ...extra });

const TIPOS_DOC = ['DNI', 'CUIT', 'CUIL', 'PASAPORTE'];
const CICLOS = ['a_demanda', 'semanal', 'quincenal', 'mensual'];
const DIAS = ['lun', 'mar', 'mie', 'jue', 'vie', 'sab', 'dom'];
const PREFIJOS = [20, 23, 24, 27, 30, 33, 34];

const cuitValido = (c) => {
  if (!/^\d{11}$/.test(c) || !PREFIJOS.includes(Number(c.slice(0, 2)))) return false;
  const d = c.split('').map(Number);
  const v = 11 - ([5, 4, 3, 2, 7, 6, 5, 4, 3, 2].reduce((a, p, i) => a + p * d[i], 0) % 11);
  return d[10] === (v === 11 ? 0 : v === 10 ? 9 : v);
};
const soloDigitos = (s) => String(s ?? '').replace(/\D/g, '');
const texto = (v, campo, max, obligatorio = false) => {
  const s = v === undefined || v === null ? '' : String(v).trim();
  if (!s) { if (obligatorio) throw invalida(`Falta ${campo}.`); return null; }
  if (s.length > max) throw invalida(`${campo} admite hasta ${max} caracteres.`);
  return s;
};

const documento = (tipo, nro) => {
  if (!TIPOS_DOC.includes(tipo)) throw invalida(`El tipo de documento es uno de: ${TIPOS_DOC.join(', ')}.`);
  if (tipo === 'PASAPORTE') {
    const p = String(nro ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (p.length < 5 || p.length > 20) throw invalida('El pasaporte tiene entre 5 y 20 caracteres.');
    return p;
  }
  const d = soloDigitos(nro);
  if (tipo === 'DNI') { if (!/^\d{7,8}$/.test(d)) throw invalida('El DNI tiene 7 u 8 dígitos.'); return d; }
  if (!cuitValido(d)) throw invalida(`El ${tipo} no es válido: 11 dígitos con dígito verificador.`, 400, { codigo: 'DOCUMENTO_INVALIDO' }); // RN02, EX02
  return d;
};

const completa = async (c) => {
  if (!c) return null;
  const [dom] = await pool.query("SELECT id, etiqueta, direccion, dias_entrega, franja_desde, franja_hasta FROM cliente_domicilios WHERE cliente_id = ? ORDER BY id", [c.id]);
  return { ...c, verificado_arca: !!c.verificado_arca, domicilios_entrega: dom.map((d) => ({ ...d, dias_entrega: d.dias_entrega ? d.dias_entrega.split(',') : [] })) };
};
const fila = async (id, conn = pool) => (await conn.query('SELECT * FROM clientes WHERE id = ?', [id]))[0][0] ?? null;

// RN43: una ficha unificada responde siempre con la resultante final (la cadena se resuelve hasta el final).
const resolver = async (id) => {
  let c = await fila(id);
  for (let i = 0; c && c.estado === 'unificado' && i < 20; i++) c = await fila(c.id_cliente_resultante);
  return c;
};
const obtener = async (id) => {
  const original = await fila(id);
  if (!original) throw invalida('Cliente no encontrado.', 404);
  const c = await resolver(id);
  return { ...(await completa(c)), ...(original.id !== c.id && { alias_de: original.id }) };
};

// Búsqueda por documento, nombre, teléfono o código QR del socio (RF19). Las fichas unificadas responden con la resultante.
const buscar = async (q, { limite = 20 } = {}) => {
  const t = String(q ?? '').trim();
  if (!t) return [];
  const d = soloDigitos(t);
  const ascii = /^[ -~]+$/.test(t); // el código del socio es ascii: con un texto con tildes ni se compara
  const [rows] = await pool.query(
    `SELECT * FROM clientes WHERE estado <> 'inactivo' AND (${ascii ? 'codigo_socio = ? OR ' : ''}nro_documento = ? OR nro_documento = ? OR telefono = ? OR REPLACE(REPLACE(REPLACE(telefono, '-', ''), ' ', ''), '+', '') = ? OR razon_social LIKE ?) ORDER BY razon_social LIMIT ?`,
    [...(ascii ? [t] : []), t.toUpperCase().replace(/[^A-Z0-9]/g, ''), d || '-', t, d || '-', `%${t}%`, Math.min(Number(limite) || 20, 50)]);
  const vistos = new Map();
  for (const r of rows) { const f = r.estado === 'unificado' ? await resolver(r.id) : r; if (f && f.estado === 'activo' && !vistos.has(f.id)) vistos.set(f.id, f); }
  return Promise.all([...vistos.values()].map(completa));
};

const validar = async (d, previo = null) => {
  const tipoCliente = (d.tipo_cliente ?? previo?.tipo_cliente ?? 'minorista').toString().trim().toLowerCase();
  if (!/^[a-z_ ]{3,30}$/.test(tipoCliente)) throw invalida('El tipo de cliente son letras (hasta 30).');
  const lista = d.lista_precio_id !== undefined ? d.lista_precio_id : previo?.lista_precio_id ?? null;
  let listaId = lista === null || lista === '' ? null : Number(lista);
  if (listaId !== null) {
    if (!(await Funciones.estaActiva('VEN-LISTAS'))) throw invalida('Las listas de precios necesitan la función VEN-LISTAS.', 409);
    const [[l]] = await pool.query('SELECT id, activa FROM listas_precio WHERE id = ?', [listaId]);
    if (!l || !l.activa) throw invalida('La lista de precios no existe o está desactivada.', 404);
  } else if (tipoCliente === 'mayorista' && d.lista_precio_id === undefined && !previo?.lista_precio_id && await Funciones.estaActiva('VEN-LISTAS')) {
    const [[m]] = await pool.query("SELECT id FROM listas_precio WHERE tipo = 'mayorista' AND activa = 1 ORDER BY id LIMIT 1");
    listaId = m?.id ?? null; // la lista Mayorista por defecto al marcar el tipo
  }
  const ciclo = d.ciclo_facturacion !== undefined ? d.ciclo_facturacion : previo?.ciclo_facturacion ?? null;
  if (ciclo !== null && ciclo !== undefined && ciclo !== '') {
    if (!CICLOS.includes(ciclo)) throw invalida(`El ciclo de facturación es uno de: ${CICLOS.join(', ')}.`);
    if (!(await Funciones.estaActiva('CLI-FACT-AGRUPADA'))) throw invalida('El ciclo de facturación necesita la función CLI-FACT-AGRUPADA.', 409);
  }
  const email = d.email !== undefined ? texto(d.email, 'el correo', 150) : previo?.email ?? null;
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw invalida('El correo no es válido.');
  return { tipoCliente, listaId, ciclo: ciclo || null, email };
};

const crear = async (d, { userId = null, origen = 'local' } = {}) => {
  const tipo = d.tipo_documento, nro = documento(tipo, d.nro_documento);
  const [[dup]] = await pool.query('SELECT id FROM clientes WHERE tipo_documento = ? AND nro_documento = ?', [tipo, nro]);
  if (dup) throw invalida('Ya hay un cliente con ese documento.', 409, { codigo: 'DOCUMENTO_DUPLICADO', cliente: await obtener(dup.id) }); // EX01: muestra la ficha existente
  const v = await validar(d);
  if (v.tipoCliente === 'mayorista' && tipo !== 'CUIT') throw invalida('Un cliente mayorista requiere CUIT validado.'); // RN22
  let razon = texto(d.razon_social, 'la razón social o el nombre', 150), condicion = texto(d.condicion_iva, 'la condición frente al IVA', 40), receptor = d.condicion_iva_receptor_id ?? null;
  let domicilio = texto(d.domicilio_fiscal, 'el domicilio fiscal', 200), verificado = false, verificadoEn = null, aviso = null;
  if (tipo === 'CUIT' || tipo === 'CUIL') {
    if (d.consultar_arca !== false) { // RF02: completa desde el padrón; sin conexión se carga a mano y queda «no verificado» (EX03)
      const r = await llamar(12, 'clientes', async () => require('../services/padronService').consultar(nro)).catch(() => ({ fallo: true }));
      if (!r.fallo && r.valor?.estado === 'ok') {
        razon = razon ?? r.valor.razon_social; condicion = condicion ?? r.valor.condicion_iva; receptor = receptor ?? r.valor.condicion_iva_receptor_id; domicilio = domicilio ?? r.valor.domicilio;
        verificado = true; verificadoEn = new Date();
      } else aviso = 'No se pudo consultar el padrón de ARCA: los datos fiscales quedan sin verificar.';
    }
  }
  if (!razon) throw invalida('Falta la razón social o el nombre.');
  const persona = d.tipo_persona ?? (['30', '33', '34'].includes(nro.slice(0, 2)) && tipo === 'CUIT' ? 'juridica' : 'fisica');
  if (!['fisica', 'juridica'].includes(persona)) throw invalida('El tipo de persona es fisica o juridica.');
  const [r] = await pool.query(
    `INSERT INTO clientes (id_global, tipo_documento, nro_documento, razon_social, tipo_persona, condicion_iva, condicion_iva_receptor_id, domicilio_fiscal, telefono, email, categoria, tipo_cliente, observaciones, lista_precio_id, ciclo_facturacion, verificado_arca, verificado_arca_en, origen, codigo_socio, creado_por)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [await idGlobal(), tipo, nro, razon, persona, condicion, receptor, domicilio, texto(d.telefono, 'el teléfono', 40), v.email, texto(d.categoria, 'la categoría', 40), v.tipoCliente, texto(d.observaciones, 'las observaciones', 500), v.listaId, v.ciclo,
      verificado ? 1 : 0, verificadoEn, origen, `SOC-${crypto.randomBytes(4).toString('hex').toUpperCase()}`, userId]);
  for (const dom of d.domicilios_entrega ?? []) await agregarDomicilio(r.insertId, dom);
  await publicarActualizado(r.insertId).catch(() => {});
  return { ...(await obtener(r.insertId)), ...(aviso && { aviso }) };
};

const actualizar = async (id, d) => {
  const c = await fila(id);
  if (!c) throw invalida('Cliente no encontrado.', 404);
  if (c.estado === 'unificado') throw invalida('La ficha está unificada: se edita la resultante.', 409, { resultante: c.id_cliente_resultante });
  if (c.tipo_documento === 'CF') throw invalida('El Consumidor Final genérico no se edita.', 409);
  const v = await validar(d, c);
  if (v.tipoCliente === 'mayorista' && c.tipo_documento !== 'CUIT') throw invalida('Un cliente mayorista requiere CUIT validado.'); // RN22
  const set = (campo, valor) => (valor === undefined ? c[campo] : valor);
  const razon = d.razon_social !== undefined ? texto(d.razon_social, 'la razón social', 150, true) : c.razon_social;
  await pool.query(
    `UPDATE clientes SET razon_social = ?, tipo_persona = ?, condicion_iva = ?, domicilio_fiscal = ?, telefono = ?, email = ?, categoria = ?, tipo_cliente = ?, observaciones = ?, lista_precio_id = ?, ciclo_facturacion = ? WHERE id = ?`,
    [razon, set('tipo_persona', d.tipo_persona), set('condicion_iva', d.condicion_iva === undefined ? undefined : texto(d.condicion_iva, 'la condición frente al IVA', 40)), set('domicilio_fiscal', d.domicilio_fiscal === undefined ? undefined : texto(d.domicilio_fiscal, 'el domicilio fiscal', 200)),
      set('telefono', d.telefono === undefined ? undefined : texto(d.telefono, 'el teléfono', 40)), v.email, set('categoria', d.categoria === undefined ? undefined : texto(d.categoria, 'la categoría', 40)), v.tipoCliente,
      set('observaciones', d.observaciones === undefined ? undefined : texto(d.observaciones, 'las observaciones', 500)), v.listaId, v.ciclo, id]);
  await publicarActualizado(id).catch(() => {});
  return obtener(id);
};

const cambiarEstado = async (id, activo) => {
  const c = await fila(id);
  if (!c) throw invalida('Cliente no encontrado.', 404);
  if (c.tipo_documento === 'CF') throw invalida('El Consumidor Final genérico no se desactiva.', 409);
  if (c.estado === 'unificado') throw invalida('La ficha está unificada.', 409);
  await pool.query('UPDATE clientes SET estado = ? WHERE id = ?', [activo ? 'activo' : 'inactivo', id]); // un cliente con movimientos no se elimina: se desactiva (RN15)
  return obtener(id);
};

// Verificación posterior contra el padrón cuando vuelve la conexión (EX03).
const verificarArca = async (id) => {
  const c = await fila(id);
  if (!c || !['CUIT', 'CUIL'].includes(c.tipo_documento)) throw invalida('Solo se verifica un CUIT o CUIL.', 409);
  const r = await llamar(12, 'clientes', async () => require('../services/padronService').consultar(c.nro_documento)).catch(() => ({ fallo: true }));
  if (r.fallo || r.valor?.estado !== 'ok') return { verificado: false, motivo: 'El padrón de ARCA no respondió o no encontró el CUIT.', cliente: await obtener(id) };
  await pool.query('UPDATE clientes SET verificado_arca = 1, verificado_arca_en = NOW(), razon_social = ?, condicion_iva = COALESCE(?, condicion_iva), condicion_iva_receptor_id = COALESCE(?, condicion_iva_receptor_id), domicilio_fiscal = COALESCE(?, domicilio_fiscal) WHERE id = ?',
    [r.valor.razon_social ?? c.razon_social, r.valor.condicion_iva, r.valor.condicion_iva_receptor_id, r.valor.domicilio, id]);
  return { verificado: true, cliente: await obtener(id) };
};

const agregarDomicilio = async (clienteId, d) => {
  const dias = (d.dias_entrega ?? []).map(String);
  if (dias.some((x) => !DIAS.includes(x))) throw invalida(`Los días de entrega son: ${DIAS.join(', ')}.`);
  const hora = (h, c) => { if (h === undefined || h === null || h === '') return null; if (!/^\d{2}:\d{2}$/.test(h)) throw invalida(`${c} va como HH:MM.`); return `${h}:00`; };
  const desde = hora(d.franja_desde, 'La franja desde'), hasta = hora(d.franja_hasta, 'La franja hasta');
  if (desde && hasta && desde >= hasta) throw invalida('La franja de entrega termina después de empezar.');
  const [r] = await pool.query('INSERT INTO cliente_domicilios (cliente_id, etiqueta, direccion, dias_entrega, franja_desde, franja_hasta) VALUES (?, ?, ?, ?, ?, ?)',
    [clienteId, texto(d.etiqueta, 'la etiqueta', 60), texto(d.direccion, 'la dirección', 200, true), dias.length ? dias.join(',') : null, desde, hasta]);
  return r.insertId;
};
const domicilio = async (clienteId, d) => {
  if (!(await fila(clienteId))) throw invalida('Cliente no encontrado.', 404);
  await agregarDomicilio(clienteId, d);
  return obtener(clienteId);
};
const quitarDomicilio = async (clienteId, domId) => { await pool.query('DELETE FROM cliente_domicilios WHERE id = ? AND cliente_id = ?', [domId, clienteId]); return obtener(clienteId); };

// Unificar dos fichas del mismo cliente (RF18, RN43): la absorbida queda como alias; el historial se conserva bajo la resultante.
const unificar = async ({ absorbido_id: absorbidoId, resultante_id: resultanteId, motivo }, { userId = null } = {}) => {
  if (typeof motivo !== 'string' || !motivo.trim()) throw invalida('La unificación exige el motivo.');
  if (Number(absorbidoId) === Number(resultanteId)) throw invalida('Elegí dos fichas distintas.');
  const a = await fila(absorbidoId), r0 = await fila(resultanteId);
  if (!a || !r0) throw invalida('Cliente no encontrado.', 404);
  if (a.tipo_documento === 'CF' || r0.tipo_documento === 'CF') throw invalida('El Consumidor Final genérico no se unifica.', 409);
  if (a.estado === 'unificado') throw invalida('La ficha a absorber ya está unificada.', 409);
  const r = await resolver(resultanteId); // si la resultante ya es alias de otra, se resuelve a la final (RN43.3)
  if (r.id === a.id) throw invalida('La ficha resultante ya es un alias de la absorbida.', 409);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    // El historial completo queda bajo la ficha resultante (RF18): sus cuentas pasan a ella. Con cuentas en distintas monedas siguen separadas (EX11); si las dos fichas
    // tienen cuenta en la misma moneda no se puede juntar sin perder la trazabilidad: se salda y se cierra una antes. La condición de socio también pasa.
    const [cuentasA] = await conn.query('SELECT moneda FROM cuentas_corrientes WHERE cliente_id = ?', [a.id]);
    const [cuentasR] = await conn.query('SELECT moneda FROM cuentas_corrientes WHERE cliente_id = ?', [r.id]);
    const choque = cuentasA.find((c) => cuentasR.some((x) => x.moneda === c.moneda));
    if (choque) throw invalida(`Las dos fichas tienen cuenta corriente en ${choque.moneda}: saldá y cerrá una antes de unificar.`, 409);
    await conn.query('UPDATE cuentas_corrientes SET cliente_id = ? WHERE cliente_id = ?', [r.id, a.id]);
    await conn.query("UPDATE fid_socios SET cliente_id = ? WHERE cliente_id = ? AND NOT EXISTS (SELECT 1 FROM (SELECT cliente_id FROM fid_socios WHERE cliente_id = ?) x)", [r.id, a.id, r.id]);
    await conn.query("UPDATE clientes SET estado = 'unificado', id_cliente_resultante = ? WHERE id = ?", [r.id, a.id]);
    await conn.query("UPDATE clientes SET id_cliente_resultante = ? WHERE estado = 'unificado' AND id_cliente_resultante = ?", [r.id, a.id]); // los alias de la absorbida pasan a la final
    await conn.query('INSERT INTO cliente_unificaciones (absorbido_id, resultante_id, motivo, user_id) VALUES (?, ?, ?, ?)', [a.id, r.id, motivo.trim().slice(0, 255), userId]);
    await conn.query('UPDATE cliente_domicilios SET cliente_id = ? WHERE cliente_id = ?', [r.id, a.id]);
    await M.publicar(conn, { origen: 'clientes', destino: 'ventas', tipo: 'clientes_unificados', docTipo: 'unificacion', docIdGlobal: `UNIF-${a.id_global}`, userId, contenido: { absorbido_id: a.id, resultante_id: r.id } });
    await conn.commit();
  } catch (err) { await conn.rollback(); throw err; } finally { conn.release(); }
  M.despertar();
  return obtener(r.id);
};

// "Cliente actualizado" (RN42): Ventas guarda su copia local de la lista de precios y de la condición de socio.
const publicarActualizado = async (id) => {
  const c = await fila(id);
  if (!c || c.tipo_documento === 'CF') return;
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await M.publicar(conn, { origen: 'clientes', destino: 'ventas', tipo: 'cliente_actualizado', docTipo: 'cliente', docIdGlobal: c.id_global, docVersion: Date.now(),
      contenido: { cliente_id: c.id, razon_social: c.razon_social, lista_precio_id: c.lista_precio_id, socio: false, version_ms: Date.now() } });
    await conn.commit();
  } catch (err) { await conn.rollback(); throw err; } finally { conn.release(); }
  M.despertar();
};

// La ficha resultante y todos sus alias: sus saldos de fidelización y vales se suman (RF18).
const idsDe = async (id, conn = pool) => { const c = await resolver(id); return c ? [c.id, ...(await conn.query("SELECT id FROM clientes WHERE estado = 'unificado' AND id_cliente_resultante = ?", [c.id]))[0].map((x) => x.id)] : []; };

module.exports = { idsDe, ClienteInvalido, cuitValido, resolver, obtener, buscar, crear, actualizar, cambiarEstado, verificarArca, domicilio, quitarDomicilio, unificar, fila, invalida };
