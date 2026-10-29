const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
process.env.AFIP_CONDICION_IVA_EMISOR = 'monotributista';
process.env.AFIP_PUNTO_VENTA = '1';
const { iniciarApp } = require('./ayudas');

let api, pool, cerrar, token, wsfe, Factura, LibroIva, Padron, padronClient, n = 0;
const periodo = (d = new Date()) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`;
const ahora = periodo();
const anterior = periodo(new Date(new Date().getFullYear(), new Date().getMonth() - 1, 15));

before(async () => {
  ({ api, pool, cerrar } = await iniciarApp());
  const [roles] = await pool.query("SELECT id FROM roles WHERE codigo = 'administrador'");
  const [u] = await pool.query("INSERT INTO users (username, password_hash, rol) VALUES ('adm', ?, 'admin')", [await bcrypt.hash('clave-larga-1', 4)]);
  await pool.query('INSERT INTO usuario_roles (user_id, rol_id) VALUES (?, ?)', [u.insertId, roles[0].id]);
  token = (await api('POST', '/api/auth/login', { body: { username: 'adm', password: 'clave-larga-1' } })).json.token;
  wsfe = require('../src/afip/wsfeClient');
  Factura = require('../src/models/facturaModel');
  LibroIva = require('../src/services/libroIvaService');
  Padron = require('../src/services/padronService');
  padronClient = require('../src/afip/padronClient');
});
after(async () => { await cerrar(); });

// Inserta un comprobante ya aprobado (como si ARCA lo hubiera autorizado).
const comprobante = async ({ tipo, pto = 1, numero, total, neto = 0, iva = 0, doc = [99, '0'], nombre = null, cae = '70000000000001', extra = {} }) => {
  const mesa = (await api('POST', '/api/mesas', { token, body: { numero_mesa: ++n, salon_id: 1 } })).json;
  const f = await Factura.create({
    mesa_id: mesa.id, sesion_apertura: new Date(), metodo_pago: 'efectivo', tipo_comprobante: tipo, punto_venta: pto, doc_tipo: doc[0], doc_nro: doc[1],
    condicion_iva_receptor_id: 5, receptor_nombre: nombre, importe_total: total, entorno: 'homologacion', ...extra,
  });
  await Factura.updateResultado(f.id, { estado: 'aprobada', numero, cae, caeVencimiento: '2026-12-31', importeNeto: neto, importeIva: iva, importeTotal: total });
  return f;
};

test('Ventas.RF13: el Libro IVA Digital genera los dos archivos de ancho fijo de ARCA', async () => {
  await comprobante({ tipo: 6, numero: 1, total: 121, neto: 100, iva: 21, doc: [96, '30111222'], nombre: 'José Pérez' });
  await comprobante({ tipo: 11, numero: 20, total: 50 });
  await comprobante({ tipo: 8, numero: 1, total: 60.5, neto: 50, iva: 10.5, doc: [96, '30111222'], nombre: 'José Pérez', extra: { devolucion_id: 999 } }); // nota de crédito
  const viejo = await comprobante({ tipo: 6, numero: 2, total: 999, neto: 825, iva: 174, pto: 2 });
  await pool.query('UPDATE facturas SET fecha_emision = DATE_SUB(NOW(), INTERVAL 1 MONTH) WHERE id = ?', [viejo.id]);

  const libro = await LibroIva.generar(ahora);
  assert.equal(libro.cantidad, 3); // el de otro período no entra
  assert.equal(libro.total, 110.5); // la nota de crédito resta
  const lineas = libro.comprobantes.trim().split('\r\n');
  assert.equal(lineas.length, 3);
  assert.ok(lineas.every((l) => l.length === 266));
  const b = lineas.find((l) => l.slice(8, 11) === '006');
  const campos = { fecha: b.slice(0, 8), tipo: b.slice(8, 11), pto: b.slice(11, 16), numero: b.slice(16, 36), doc: b.slice(56, 58), docNro: b.slice(58, 78), nombre: b.slice(78, 108), total: b.slice(108, 123), moneda: b.slice(228, 231), cambio: b.slice(231, 241), alicuotas: b[241], operacion: b[242] };
  assert.match(campos.fecha, /^\d{8}$/);
  assert.deepEqual([campos.tipo, campos.pto, campos.numero, campos.doc], ['006', '00001', '00000000000000000001', '96']);
  assert.equal(campos.docNro, '00000000000030111222');
  assert.equal(campos.nombre, 'JOSE PEREZ'.padEnd(30)); // sin acentos, en mayúsculas, a 30
  assert.equal(campos.total, '000000000012100'); // sin coma, dos decimales implícitos
  assert.deepEqual([campos.moneda, campos.cambio, campos.alicuotas, campos.operacion], ['PES', '0001000000', '1', ' ']);
  const c = lineas.find((l) => l.slice(8, 11) === '011');
  assert.deepEqual([c[241], c[242], c.slice(108, 123)], ['0', 'N', '000000000005000']); // la Factura C no discrimina IVA
  assert.ok(lineas.some((l) => l.slice(8, 11) === '008')); // la nota de crédito es un comprobante propio

  const al = libro.alicuotas.trim().split('\r\n');
  assert.equal(al.length, 2); // la C no tiene alícuotas
  assert.ok(al.every((l) => l.length === 62));
  const a = al.find((l) => l.slice(0, 3) === '006');
  assert.deepEqual([a.slice(3, 8), a.slice(8, 28), a.slice(28, 43), a.slice(43, 47), a.slice(47, 62)], ['00001', '00000000000000000001', '000000000010000', '0005', '000000000002100']);
});

test('Ventas.RF13: el endpoint entrega el resumen y los archivos para descargar; valida el período', async () => {
  const r = await api('GET', `/api/facturas/libro-iva?periodo=${ahora}`, { token });
  assert.deepEqual([r.status, r.json.cantidad, r.json.total], [200, 3, 110.5]);
  const f = await api('GET', `/api/facturas/libro-iva?periodo=${ahora}&archivo=alicuotas`, { token });
  assert.equal(f.status, 200);
  assert.match(f.headers.get('content-disposition'), /LIBRO_IVA_DIGITAL_VENTAS_ALICUOTAS_\d{6}\.txt/);
  assert.equal((await api('GET', `/api/facturas/libro-iva?periodo=${ahora}&archivo=otro`, { token })).status, 400);
  assert.equal((await api('GET', '/api/facturas/libro-iva?periodo=2026', { token })).status, 400);
  assert.equal((await api('GET', '/api/facturas/libro-iva?periodo=202613', { token })).status, 400);
  assert.equal((await LibroIva.generar(anterior)).cantidad, 1); // el del mes pasado
});

test('Ventas.RF13: el control contra ARCA lista las diferencias entre lo local y lo registrado', async () => {
  for (const [numero, cae] of [[5, '70000000000005'], [6, '70000000000006'], [7, '70000000000007']]) await comprobante({ tipo: 11, pto: 3, numero, total: 100, cae });
  const arca = new Map([[5, { resultado: 'A', cae: '70000000000005', importe: 100 }], [7, { resultado: 'A', cae: '70000000000007', importe: 150 }]]); // el 6 no existe
  wsfe.compConsultar = async (pto, tipo, numero) => (pto === 3 ? arca.get(numero) ?? null : { resultado: 'A', importe: undefined });
  wsfe.compUltimoAutorizado = async (pto) => (pto === 3 ? 9 : 99999);

  const r = await api('GET', `/api/facturas/control-arca?periodo=${ahora}`, { token });
  assert.equal(r.status, 200);
  const clave = r.json.claves.find((c) => c.punto_venta === 3 && c.tipo_comprobante === 11);
  assert.deepEqual(clave.diferencias.map((d) => [d.numero, d.tipo]), [[6, 'no_existe_en_arca'], [7, 'importe_distinto'], [8, 'sin_registro_local'], [9, 'sin_registro_local']]);
  assert.equal(clave.ultimo_arca, 9);
  assert.ok(r.json.diferencias >= 4);
  assert.equal((await api('GET', '/api/facturas/control-arca?periodo=hoy', { token })).status, 400);
});

test('Ventas.RF13: si todo coincide el control no informa diferencias', async () => {
  wsfe.compConsultar = async () => null; // (no se llama: sin comprobantes locales en ese período)
  const r = await LibroIva.controlar('199901');
  assert.deepEqual([r.claves.length, r.diferencias], [0, 0]);
});

// --- RF23: padrón ---

const cuitCon = (base) => { // arma un CUIT válido a partir de 10 dígitos
  const d = String(base).split('').map(Number);
  const v = 11 - ([5, 4, 3, 2, 7, 6, 5, 4, 3, 2].reduce((a, p, i) => a + p * d[i], 0) % 11);
  return `${base}${v === 11 ? 0 : v === 10 ? 9 : v}`;
};

test('Ventas.RF23: la consulta al padrón devuelve razón social, condición frente al IVA y domicilio', async () => {
  const cuit = cuitCon('3071234567');
  padronClient.consultar = async () => ({
    datosGenerales: { razonSocial: 'ACME SA', tipoPersona: 'JURIDICA', domicilioFiscal: { direccion: 'Calle 1', localidad: 'CABA', descripcionProvincia: 'CABA', codPostal: '1000' } },
    datosRegimenGeneral: { impuesto: [{ idImpuesto: 10 }, { idImpuesto: 30 }] },
  });
  const r = await api('GET', `/api/padron/${cuit}`, { token });
  assert.equal(r.status, 200);
  assert.deepEqual([r.json.estado, r.json.razon_social, r.json.condicion_iva, r.json.condicion_iva_receptor_id], ['ok', 'ACME SA', 'Responsable Inscripto', 1]);
  assert.equal(r.json.domicilio, 'Calle 1, CABA, CABA, 1000');
  assert.ok(r.json.consultado_en); // RN29: el resultado lleva fecha y hora de la consulta

  padronClient.consultar = async () => ({ datosGenerales: { apellido: 'PEREZ', nombre: 'JUAN' }, datosMonotributo: { categoriaMonotributo: { idCategoria: 'B' } } });
  const m = (await api('GET', `/api/padron/${cuitCon('2011111111')}`, { token })).json;
  assert.deepEqual([m.razon_social, m.condicion_iva, m.condicion_iva_receptor_id], ['PEREZ JUAN', 'Monotributo', 6]);
});

test('Ventas.EX19: sin respuesta, inexistente o servicio caído informa el motivo y no bloquea', async () => {
  const cuit = cuitCon('3071234567');
  const respuesta = async (consultar) => { padronClient.consultar = consultar; return (await api('GET', `/api/padron/${cuit}`, { token })); };
  const no = await respuesta(async () => { throw new Error('No existe persona con ese Id'); });
  assert.deepEqual([no.status, no.json.estado], [200, 'no_encontrado']);
  assert.equal((await respuesta(async () => { throw Object.assign(new Error('x'), { code: 'ECONNRESET' }); })).json.estado, 'sin_conexion');
  assert.equal((await respuesta(async () => { throw new Error('Internal error'); })).json.estado, 'servicio_no_disponible');
  assert.equal((await respuesta(async () => ({}))).json.estado, 'no_encontrado'); // respuesta vacía
  // Pasados los segundos configurados, deja de esperar.
  await pool.query("INSERT INTO parametros (clave, valor) VALUES ('padron_timeout_seg', '0.05') ON DUPLICATE KEY UPDATE valor = '0.05'");
  require('../src/models/parametroModel').invalidar();
  const t0 = Date.now();
  assert.equal((await respuesta(() => new Promise(() => {}))).json.estado, 'sin_conexion');
  assert.ok(Date.now() - t0 < 2000);
});

test('Ventas.RF23: un CUIT mal formado o con dígito verificador incorrecto se rechaza sin consultar a ARCA', async () => {
  let llamadas = 0;
  padronClient.consultar = async () => { llamadas++; return {}; };
  const ok = cuitCon('2011111111');
  const mal = `${ok.slice(0, 10)}${(Number(ok[10]) + 1) % 10}`;
  for (const cuit of ['123', 'abcdefghijk', mal, '99111111111']) assert.equal((await api('GET', `/api/padron/${cuit}`, { token })).status, 400, cuit);
  assert.equal(llamadas, 0);
  assert.equal(Padron.cuitValido(ok), true);
});
