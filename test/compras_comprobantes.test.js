process.env.AFIP_CONDICION_IVA_EMISOR = 'responsable_inscripto';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { iniciarApp, esperarMensajes } = require('./ayudas');
const { usuario } = require('./ayudas_financiero');
const Claves = require('../src/servicios/comprobanteTerceroService');
const Lectura = require('../src/servicios/lecturaComprobanteService');

let api, pool, cerrar, adm, gerente, administrativo, deposito, prov, prov2, k = 0;
const CUIT = '30711111111', CUIT2 = '20123456786';
const hoyMenos = (d) => new Date(Date.now() - d * 86400000).toISOString().slice(0, 10);

before(async () => {
  ({ api, pool, cerrar } = await iniciarApp());
  adm = await usuario(api, pool, 'adm', 'administrador');
  gerente = await usuario(api, pool, 'gero', 'gerente');
  administrativo = await usuario(api, pool, 'ana', 'administrativo');
  deposito = await usuario(api, pool, 'dani', 'deposito');
  await pool.query("INSERT INTO rol_permisos (rol_id, permiso, nivel) SELECT id, 'compras.comprobantes.registrar', 'permitido' FROM roles WHERE codigo = 'deposito'"); // registra pero no confirma parecidos
  await api('POST', '/api/modulos/compras/instalar', { token: adm.token });
  prov = (await api('POST', '/api/compras/proveedores', { token: administrativo.token, body: { cuit: CUIT, razon_social: 'Tostadores del Sur SA', condicion_iva: 'Responsable Inscripto', consultar_arca: false } })).json;
  prov2 = (await api('POST', '/api/compras/proveedores', { token: administrativo.token, body: { cuit: CUIT2, razon_social: 'Kiosco Don Luis', condicion_iva: 'Monotributo', consultar_arca: false } })).json;
});
after(async () => { await cerrar(); });

const comp = (b = {}, t = administrativo, headers = {}) => api('POST', '/api/compras/comprobantes', { token: t.token, headers, body: {
  cuit: CUIT, clase: 'FACTURA', tipo: 'A', punto_venta: 1, numero: String(++k), fecha: hoyMenos(2 + k), alicuotas: [{ alicuota: 21, neto: 1000, iva: 210 }], total: 1210, ...b } });
const auditoria = async (accion) => (await pool.query('SELECT detalle FROM auditoria WHERE accion = ?', [accion]))[0];

test('Compras.RF03/RN03: un comprobante se registra con su clave unívoca, sus importes por alícuota y su período de IVA', async () => {
  const r = await comp({ numero: '100', fecha: hoyMenos(2), cae: '70000000000001', cae_vencimiento: hoyMenos(-10) });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.deepEqual([r.json.estado, r.json.punto_venta, r.json.numero, r.json.total, r.json.iva, r.json.periodo_iva], ['registrado', '00001', '00000100', 1210, 210, hoyMenos(2).slice(0, 7)]);
  assert.match(r.json.clave, /30711111111/);
  await esperarMensajes(pool);
  assert.equal((await pool.query('SELECT estado FROM claves_comprobante WHERE clave = ?', [r.json.clave]))[0][0].estado, 'vigente'); // la confirmación viajó en la misma transacción
  assert.equal((await api('GET', `/api/compras/comprobantes/${r.json.id}`, { token: gerente.token })).json.alicuotas[0].alicuota, 21);
  assert.equal((await comp({}, gerente)).status, 201);
  assert.equal((await comp({}, { token: (await usuario(api, pool, 'cami', 'cajero')).token })).status, 403);
  assert.ok((await api('GET', '/api/compras/comprobantes?clase=FACTURA', { token: gerente.token })).json.length >= 2);
});

test('Compras.EX05/RF03: los importes tienen que cerrar con el total (tolerancia de redondeo) y los datos inválidos se rechazan', async () => {
  const mal = await comp({ total: 1300 });
  assert.equal(mal.status, 400);
  assert.deepEqual([mal.json.codigo, mal.json.detalle.suma, mal.json.detalle.diferencia], ['IMPORTES_NO_CIERRAN', 1210, 90]);
  assert.equal((await comp({ total: 1210.04 })).status, 201); // dentro de ±0,05
  assert.equal((await comp({ total: 1210.2 })).status, 400);
  assert.equal((await comp({ alicuotas: [{ alicuota: 21, neto: 1000, iva: 210 }], neto_gravado: 900 })).json.codigo, 'IMPORTES_NO_CIERRAN');
  assert.equal((await comp({ alicuotas: [{ alicuota: 18, neto: 1000, iva: 180 }], total: 1180 })).status, 400);
  assert.equal((await comp({ alicuotas: [], total: 1210 })).status, 400); // falta el neto y el IVA por alícuota
  const completo = await comp({ alicuotas: [{ alicuota: 21, neto: 1000, iva: 210 }, { alicuota: 10.5, neto: 200, iva: 21 }], no_gravado: 50, exento: 30, percepciones_iva: 12, percepciones_iibb: 25, percepciones_iibb_detalle: [{ jurisdiccion: 'CABA', importe: 10 }, { jurisdiccion: 'Buenos Aires', importe: 15 }],
    impuestos_internos: 5, otros_tributos: 3, total: 1556 });
  assert.equal(completo.status, 201, JSON.stringify(completo.json));
  assert.equal((await comp({ percepciones_iibb: 30, percepciones_iibb_detalle: [{ jurisdiccion: 'CABA', importe: 10 }], total: 1240 })).json.codigo, 'IMPORTES_NO_CIERRAN');
  assert.equal((await comp({ clase: 'REMITO' })).status, 400);
  assert.equal((await comp({ tipo: 'Z' })).status, 400);
  assert.equal((await comp({ fecha: '31/10/2026' })).status, 400);
  assert.equal((await comp({ fecha: hoyMenos(-3) })).status, 400); // no puede ser futura
  assert.equal((await comp({ cuit: '30500010912' })).json.codigo, 'PROVEEDOR_NO_EXISTE');
  assert.equal((await comp({ cuit: CUIT, numero: 'abc' })).status, 400);
});

test('Compras.EX01/RN03: el duplicado exacto y el CAE repetido se bloquean y los casi duplicados piden confirmación con motivo y permiso; un remito no es duplicado', async () => {
  const base = await comp({ numero: '5000', cae: '70000000000002' });
  assert.equal(base.status, 201);
  const dup = await comp({ numero: '5000' });
  assert.equal(dup.status, 409);
  assert.equal(dup.json.codigo, 'DUPLICADO_EXACTO');
  assert.ok((await auditoria('comprobante_duplicado_exacto')).length >= 1);
  assert.equal((await comp({ numero: '5001', cae: '70000000000002' })).json.codigo, 'CAE_REPETIDO');
  assert.equal((await comp({ numero: '5000', punto_venta: 2 })).json.codigo, 'CASI_DUPLICADO'); // mismo emisor y número, otro punto de venta
  const sinPermiso = await comp({ numero: '5000', punto_venta: 2, confirmar_casi_duplicado: { motivo: 'es de otra sucursal' } }, deposito);
  assert.equal(sinPermiso.status, 403);
  assert.equal(sinPermiso.json.codigo, 'SIN_PERMISO');
  const conf = await comp({ numero: '5000', punto_venta: 2, confirmar_casi_duplicado: { motivo: 'es de otra sucursal' } });
  assert.equal(conf.status, 201, JSON.stringify(conf.json));
  assert.ok((await auditoria('comprobante_casi_duplicado_confirmado')).some((a) => /otra sucursal/.test(a.detalle)));
  assert.equal((await comp({ numero: '5000', clase: 'OTRO', tipo: 'X' })).status, 201);
  // Mismo emisor, misma fecha e importe (±0,01) con otro número: casi duplicado.
  const f = hoyMenos(5);
  assert.equal((await comp({ numero: '6000', fecha: f, alicuotas: [{ alicuota: 21, neto: 2000, iva: 420 }], total: 2420 })).status, 201);
  assert.equal((await comp({ numero: '6001', fecha: f, alicuotas: [{ alicuota: 21, neto: 2000, iva: 420 }], total: 2420.01 })).json.codigo, 'CASI_DUPLICADO');
});

test('Compras.RN03/RN35: si el comprobante no se guarda la clave queda libre; con el servicio de claves caído queda en borrador; una solicitud repetida no lo duplica', async () => {
  const grande = await comp({ numero: '7000', moneda: 'USD', cotizacion: undefined });
  assert.equal(grande.json.codigo, 'SIN_COTIZACION'); // dólares sin cotización vigente
  assert.equal((await comp({ numero: '7000', moneda: 'USD', cotizacion: 1000 })).status, 201); // la reserva del intento anterior no quedó bloqueada
  const original = Claves.reservar;
  Claves.reservar = async () => { throw new Error('servicio caído'); };
  let borrador;
  try {
    borrador = await comp({ numero: '7100' });
    assert.equal(borrador.status, 201, JSON.stringify(borrador.json));
    assert.equal(borrador.json.estado, 'borrador');
    assert.match(borrador.json.aviso, /borrador/);
  } finally { Claves.reservar = original; }
  const conf = await api('POST', `/api/compras/comprobantes/${borrador.json.id}/confirmar`, { token: administrativo.token, body: {} });
  assert.equal(conf.status, 200, JSON.stringify(conf.json));
  assert.deepEqual([conf.json.estado, !!conf.json.clave], ['registrado', true]);
  assert.equal((await api('POST', `/api/compras/comprobantes/${conf.json.id}/confirmar`, { token: administrativo.token, body: {} })).status, 409);
  // La misma ID_Solicitud devuelve el comprobante original (EX22) en vez del aviso de duplicado.
  const a = await comp({ numero: '7200', fecha: hoyMenos(4) }, administrativo, { 'X-ID-Solicitud': 'compra-7200-0001' });
  const b = await comp({ numero: '7200', fecha: hoyMenos(4) }, administrativo, { 'X-ID-Solicitud': 'compra-7200-0001' });
  assert.equal(b.headers.get('idempotency-replayed'), 'true');
  assert.deepEqual(b.json, a.json);
  assert.equal((await comp({ numero: '7300', fecha: hoyMenos(4) }, administrativo, { 'X-ID-Solicitud': 'compra-7200-0001' })).json.codigo, 'CONFLICTO_IDEMPOTENCIA'); // misma clave, otro contenido
});

test('Compras.RN04: un Responsable Inscripto computa el IVA de los A y M; en B y C integra el costo; se advierte si la letra no corresponde', async () => {
  const a = await comp({ numero: '8000', tipo: 'A' });
  assert.equal(a.json.iva_computable, 210);
  const m = await comp({ numero: '8001', tipo: 'M' });
  assert.equal(m.json.iva_computable, 210);
  const b = await comp({ numero: '8002', tipo: 'B' });
  assert.equal(b.json.iva_computable, 0);
  assert.ok(b.json.advertencias.some((x) => /integra el costo/.test(x)));
  const raro = await comp({ cuit: CUIT2, numero: '8003', tipo: 'A' }); // un monotributista no emite A
  assert.equal(raro.status, 201);
  assert.ok(raro.json.advertencias.some((x) => /Responsable Inscripto y el proveedor figura como Monotributo/.test(x)));
  assert.equal((await comp({ cuit: CUIT2, numero: '8004', tipo: 'C', alicuotas: [], neto_gravado: 0, no_gravado: 500, total: 500 })).json.iva_computable, 0);
});

test('Compras.RF03/RF18/EX16: las líneas por ítem o por concepto cierran con el neto; la presentación es de Stock, con su factor aplicado y el costo por unidad base', async () => {
  const lineasMal = await comp({ numero: '9000', lineas: [{ tipo: 'concepto', descripcion: 'Gas', cantidad: 1, precio_unitario: 500 }] });
  assert.equal(lineasMal.json.codigo, 'LINEAS_NO_CIERRAN');
  assert.equal((await comp({ numero: '9000', lineas: [{ descripcion: '', cantidad: 1, precio_unitario: 1000 }] })).status, 400);
  assert.equal((await comp({ numero: '9000', lineas: [{ descripcion: 'x', cantidad: 0, precio_unitario: 1000 }] })).status, 400);
  assert.equal((await comp({ numero: '9000', lineas: [{ descripcion: 'x', cantidad: 1.0001, precio_unitario: 1000 }] })).status, 400); // hasta 3 decimales
  const concepto = await comp({ numero: '9000', fecha: hoyMenos(0), lineas: [{ tipo: 'concepto', descripcion: 'Gas natural', categoria: 'Servicios', cantidad: 1, precio_unitario: 1000 }] });
  assert.equal(concepto.status, 201, JSON.stringify(concepto.json));
  assert.equal(concepto.json.lineas[0].categoria, 'Servicios');

  const harina = (await api('POST', '/api/insumos', { token: adm.token, body: { nombre: 'Harina 000', unidad: 'kg' } })).json;
  const otro = (await api('POST', '/api/insumos', { token: adm.token, body: { nombre: 'Azúcar', unidad: 'kg' } })).json;
  const bolsa = (await api('POST', '/api/presentaciones', { token: adm.token, body: { insumo_id: harina.id, nombre: 'bolsa 25 kg', factor: 25, usos: ['compra'] } })).json;
  const receta = (await api('POST', '/api/presentaciones', { token: adm.token, body: { insumo_id: harina.id, nombre: 'cucharada', factor: 0.01, usos: ['receta'] } })).json;
  const linea = (extra) => ({ tipo: 'mercaderia', item: { tipo: 'insumo', id: harina.id }, descripcion: 'Harina 000', cantidad: 4, precio_unitario: 260, ...extra }); // 4 bolsas a $260 = 1.040
  const ok = await comp({ numero: '9100', fecha: hoyMenos(0), alicuotas: [{ alicuota: 21, neto: 1040, iva: 218.4 }], total: 1258.4, lineas: [linea({ presentacion_id: bolsa.id })] });
  assert.equal(ok.status, 201, JSON.stringify(ok.json));
  assert.deepEqual([ok.json.lineas[0].presentacion_id, ok.json.lineas[0].factor_aplicado, ok.json.lineas[0].costo_unidad_base, ok.json.lineas[0].unidad], [bolsa.id, 25, 10.4, 'bolsa 25 kg']); // $260 / 25 kg = $10,40 el kilo
  const noCompra = await comp({ numero: '9101', fecha: hoyMenos(0), lineas: [linea({ presentacion_id: receta.id })] });
  assert.equal(noCompra.status, 409);
  assert.equal(noCompra.json.codigo, 'PRESENTACION_NO_EXISTE'); // la presentación no es de uso compra
  assert.equal((await comp({ numero: '9102', fecha: hoyMenos(0), lineas: [linea({ presentacion_id: 999999 })] })).json.codigo, 'PRESENTACION_NO_EXISTE');
  assert.equal((await comp({ numero: '9103', fecha: hoyMenos(0), lineas: [linea({ presentacion_id: bolsa.id, item: { tipo: 'insumo', id: otro.id } })] })).json.codigo, 'PRESENTACION_OTRO_ITEM');
  // Una versión nueva del factor en Stock rige hacia adelante y no altera lo ya registrado (RN23).
  await pool.query("UPDATE presentaciones SET vigente_hasta = NOW() WHERE id = ?", [bolsa.id]);
  assert.equal((await api('GET', `/api/compras/comprobantes/${ok.json.id}`, { token: gerente.token })).json.lineas[0].factor_aplicado, 25);
});

test('Compras.RN08/RN12/EX11: un comprobante se anula con permiso y motivo, libera su clave y no se toca en un período cerrado; lo que llega a un período cerrado va al primero abierto', async () => {
  const c = (await comp({ numero: '9500', fecha: '2026-08-15' })).json;
  assert.equal(c.periodo_iva, '2026-08');
  const anular = (id, b, t = gerente) => api('POST', `/api/compras/comprobantes/${id}/anular`, { token: t.token, body: b });
  assert.equal((await anular(c.id, {}, gerente)).status, 400); // motivo
  assert.equal((await anular(c.id, { motivo: 'error de carga' }, administrativo)).status, 403); // el administrativo pide un supervisor
  const an = await anular(c.id, { motivo: 'error de carga' });
  assert.equal(an.json.estado, 'anulado');
  assert.equal((await anular(c.id, { motivo: 'otra vez' })).status, 409);
  assert.equal((await comp({ numero: '9500', fecha: '2026-08-15' })).status, 201); // la clave quedó libre: puede volver a cargarse
  // Cierre del período 2026-08.
  assert.equal((await api('POST', '/api/compras/periodos-iva/2026-8/cerrar', { token: gerente.token })).status, 400);
  assert.equal((await api('POST', '/api/compras/periodos-iva/2026-08/cerrar', { token: administrativo.token })).status, 403);
  assert.equal((await api('POST', '/api/compras/periodos-iva/2026-08/cerrar', { token: gerente.token })).json.estado, 'cerrado');
  assert.equal((await api('POST', '/api/compras/periodos-iva/2026-08/cerrar', { token: gerente.token })).status, 409);
  const nuevo = (await comp({ numero: '9501', fecha: '2026-08-20' })).json;
  assert.equal(nuevo.periodo_iva, '2026-09'); // EX11
  assert.match(nuevo.advertencias[0], /ya está cerrado: se imputa al 2026-09/);
  const viejo = (await api('GET', '/api/compras/comprobantes?periodo=2026-08', { token: gerente.token })).json.find((x) => x.estado === 'registrado');
  assert.equal((await anular(viejo.id, { motivo: 'ya presentado' })).json.codigo, 'PERIODO_CERRADO'); // RN12
  assert.ok((await api('GET', '/api/compras/periodos-iva', { token: gerente.token })).json.some((p) => p.periodo === '2026-08' && p.estado === 'cerrado'));
});

test('Compras.EX02/RF03: la lectura por foto o por QR trae una propuesta del encabezado y, si el CUIT no es proveedor, propone el alta', async () => {
  const foto = (b) => api('POST', '/api/compras/comprobantes/foto', { token: administrativo.token, headers: { 'Content-Type': 'image/jpeg' }, body: b });
  void foto; // la API de prueba envía JSON: la lectura binaria se prueba por el servicio
  const Comprobantes = require('../src/compras/comprobanteService');
  await api('POST', '/api/funciones/cambiar', { token: adm.token, body: { activar: ['USU-FOTO'], motivo: 'prueba' } });
  Lectura.usarProveedor(async () => ({ encabezado: { cuit: '30500010912', proveedor: 'Distribuidora Norte', clase: 'FACTURA', tipo: 'A', punto_venta: 2, numero: 77, importe: 1210 }, confianza: { cuit: 0.9 } }));
  const r = await Comprobantes.leerFoto({ imagen: Buffer.from('ffd8ffe0', 'hex'), tipo: 'image/jpeg' });
  assert.equal(r.estado, 'leido');
  assert.deepEqual(r.propuesta_alta_proveedor, { cuit: '30500010912', razon_social: 'Distribuidora Norte' }); // EX02
  Lectura.usarProveedor(async () => ({ encabezado: { cuit: CUIT, clase: 'FACTURA', tipo: 'A', punto_venta: 1, numero: 5 }, confianza: {} }));
  const conocido = await Comprobantes.leerFoto({ imagen: Buffer.from('ffd8ffe0', 'hex'), tipo: 'image/jpeg' });
  assert.equal(conocido.proveedor.id, prov.id);
  assert.ok(!conocido.propuesta_alta_proveedor);
  Lectura.usarProveedor(async () => { throw new Error('ilegible'); });
  assert.equal((await Comprobantes.leerFoto({ imagen: Buffer.from('ffd8ffe0', 'hex'), tipo: 'image/jpeg' })).estado, 'manual');
  // El QR fiscal se lee sin conexión.
  const p = Buffer.from(JSON.stringify({ ver: 1, fecha: '2026-11-03', cuit: 30711111111, ptoVta: 3, tipoCmp: 1, nroCmp: 321, importe: 1210, moneda: 'PES', codAut: 70000000000009 })).toString('base64');
  const qr = await Comprobantes.leerQr(`https://www.afip.gob.ar/fe/qr/?p=${p}`);
  assert.equal(qr.estado, 'leido');
  assert.deepEqual([qr.comprobante.cuit, qr.comprobante.clase, qr.comprobante.tipo, qr.comprobante.numero], ['30711111111', 'FACTURA', 'A', 321]);
  assert.equal(qr.proveedor.id, prov.id);
  await api('POST', '/api/funciones/cambiar', { token: adm.token, body: { desactivar: ['CMP-FOTO'], motivo: 'prueba' } });
  await assert.rejects(Comprobantes.leerQr(`https://www.afip.gob.ar/fe/qr/?p=${p}`), /CMP-FOTO/);
});
