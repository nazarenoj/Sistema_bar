const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { iniciarApp, esperarMensajes } = require('./ayudas');

let api, pool, cerrar, token, tokenBarista;
const CUIT = '30711111111', CUIT2 = '20123456786';

before(async () => {
  ({ api, pool, cerrar } = await iniciarApp());
  const usuario = async (username, rol) => {
    const [r] = await pool.query('INSERT INTO users (username, password_hash, rol) VALUES (?, ?, ?)', [username, await bcrypt.hash('clave-larga-1', 4), rol === 'administrador' ? 'admin' : 'empleado']);
    await pool.query('INSERT INTO usuario_roles (user_id, rol_id) SELECT ?, id FROM roles WHERE codigo = ?', [r.insertId, rol]);
    return (await api('POST', '/api/auth/login', { body: { username, password: 'clave-larga-1' } })).json.token;
  };
  token = await usuario('adm', 'administrador');
  tokenBarista = await usuario('bea', 'barista');
});
after(async () => { await cerrar(); });

const crear = (b, t = token) => api('POST', '/api/clientes', { token: t, body: { consultar_arca: false, ...b } });
const buscar = async (q, t = token) => (await api('GET', `/api/clientes?q=${encodeURIComponent(q)}`, { token: t })).json;

test('Clientes: el módulo se instala y sin él no hay maestro ni búsqueda por el puerto de Ventas', async () => {
  assert.equal((await api('GET', '/api/clientes?q=a', { token })).status, 409);
  assert.deepEqual((await api('GET', '/api/ventas/clientes/buscar?q=Ana', { token })).json, []); // puerto nulo
  assert.equal((await api('POST', '/api/modulos/clientes/instalar', { token })).status, 200);
  assert.equal((await api('GET', '/api/clientes?q=a', { token: tokenBarista })).status, 403); // los datos personales piden permiso (RN17)
});

test('Clientes.RN01/RN02/EX01/EX02: documento único, CUIT y CUIL con verificador y DNI de 7 u 8 dígitos', async () => {
  const ok = await crear({ tipo_documento: 'DNI', nro_documento: '30.123.456', razon_social: 'Ana Pérez', telefono: '11-5555-1234', email: 'ana@mail.test' });
  assert.equal(ok.status, 201, JSON.stringify(ok.json));
  assert.equal(ok.json.nro_documento, '30123456');
  const dup = await crear({ tipo_documento: 'DNI', nro_documento: '30123456', razon_social: 'Otra Ana' });
  assert.deepEqual([dup.status, dup.json.codigo, dup.json.cliente.id], [409, 'DOCUMENTO_DUPLICADO', ok.json.id]); // EX01: muestra la ficha existente
  const malo = await crear({ tipo_documento: 'CUIT', nro_documento: '30711111112', razon_social: 'X' });
  assert.deepEqual([malo.status, malo.json.codigo], [400, 'DOCUMENTO_INVALIDO']); // EX02
  assert.equal((await crear({ tipo_documento: 'CUIL', nro_documento: '20123456780', razon_social: 'X' })).status, 400);
  assert.equal((await crear({ tipo_documento: 'DNI', nro_documento: '123', razon_social: 'X' })).status, 400);
  assert.equal((await crear({ tipo_documento: 'CUIL', nro_documento: CUIT2, razon_social: 'Luis Gómez' })).json.tipo_persona, 'fisica');
  assert.equal((await crear({ tipo_documento: 'DNI', nro_documento: '28999111', razon_social: 'Mal', email: 'sin-arroba' })).status, 400);
  assert.equal((await crear({ tipo_documento: 'DNI', nro_documento: '28999111', razon_social: '' })).status, 400);
});

test('Clientes.RF02/EX03: el padrón completa los datos; sin conexión se carga a mano y queda "no verificado" hasta verificarlo', async () => {
  const padron = require('../src/afip/padronClient');
  const original = padron.consultar;
  padron.consultar = async () => ({ datosGenerales: { razonSocial: 'MOLINOS DEL SUR SA', tipoPersona: 'JURIDICA', domicilioFiscal: { direccion: 'Ruta 3 km 10', localidad: 'Bahía Blanca', descripcionProvincia: 'Buenos Aires', codPostal: '8000' } }, datosRegimenGeneral: { impuesto: [{ idImpuesto: 30 }] } });
  const ok = await api('POST', '/api/clientes', { token, body: { tipo_documento: 'CUIT', nro_documento: CUIT } });
  assert.equal(ok.status, 201, JSON.stringify(ok.json));
  assert.deepEqual([ok.json.razon_social, ok.json.condicion_iva, ok.json.verificado_arca, ok.json.tipo_persona], ['MOLINOS DEL SUR SA', 'Responsable Inscripto', true, 'juridica']);
  assert.match(ok.json.domicilio_fiscal, /Ruta 3/);
  padron.consultar = async () => { const e = new Error('sin red'); e.code = 'ENOTFOUND'; throw e; };
  const sin = await api('POST', '/api/clientes', { token, body: { tipo_documento: 'CUIT', nro_documento: '33693450239', razon_social: 'Panadería Sur SRL', condicion_iva: 'Responsable Inscripto' } });
  assert.equal(sin.status, 201, JSON.stringify(sin.json));
  assert.deepEqual([sin.json.verificado_arca, /sin verificar/.test(sin.json.aviso)], [false, true]); // EX03: carga manual
  assert.equal((await api('POST', '/api/clientes', { token, body: { tipo_documento: 'CUIT', nro_documento: '30500010912' } })).status, 400); // sin padrón ni nombre: falta la razón social
  padron.consultar = async () => ({ datosGenerales: { razonSocial: 'PANADERIA SUR SRL' }, datosMonotributo: {} });
  const v = await api('POST', `/api/clientes/${sin.json.id}/verificar-arca`, { token });
  assert.deepEqual([v.json.verificado, v.json.cliente.verificado_arca, v.json.cliente.razon_social], [true, true, 'PANADERIA SUR SRL']);
  padron.consultar = original;
});

test('Clientes.RF21/RN22: el mayorista exige CUIT, tiene domicilios con días y franja, ciclo de facturación y la lista Mayorista por defecto', async () => {
  const noCuit = await crear({ tipo_documento: 'DNI', nro_documento: '27111222', razon_social: 'Pedro', tipo_cliente: 'mayorista' });
  assert.equal(noCuit.status, 400);
  assert.equal((await crear({ tipo_documento: 'CUIT', nro_documento: '30711111111', razon_social: 'Dup' })).status, 409);
  await api('POST', '/api/funciones/cambiar', { token, body: { activar: ['VEN-LISTAS'], motivo: 'prueba' } });
  const lista = (await api('POST', '/api/listas-precio', { token, body: { nombre: 'Mayorista', tipo: 'mayorista' } })).json;
  const m = await crear({ tipo_documento: 'CUIT', nro_documento: '30500010912', razon_social: 'Almacén Norte SA', tipo_cliente: 'mayorista',
    domicilios_entrega: [{ etiqueta: 'Local', direccion: 'Mitre 100', dias_entrega: ['lun', 'jue'], franja_desde: '07:00', franja_hasta: '09:30' }] });
  assert.equal(m.status, 201, JSON.stringify(m.json));
  assert.equal(m.json.lista_precio_id, lista.id);
  assert.deepEqual(m.json.domicilios_entrega.map((d) => [d.direccion, d.dias_entrega, d.franja_desde]), [['Mitre 100', ['lun', 'jue'], '07:00:00']]);
  assert.equal((await api('POST', `/api/clientes/${m.json.id}/domicilios`, { token, body: { direccion: 'X', dias_entrega: ['xyz'] } })).status, 400);
  assert.equal((await api('POST', `/api/clientes/${m.json.id}/domicilios`, { token, body: { direccion: 'X', franja_desde: '10:00', franja_hasta: '09:00' } })).status, 400);
  assert.equal((await api('PUT', `/api/clientes/${m.json.id}`, { token, body: { ciclo_facturacion: 'semanal' } })).status, 409); // necesita CLI-FACT-AGRUPADA
  assert.equal((await api('PUT', `/api/clientes/${m.json.id}`, { token, body: { lista_precio_id: 9999 } })).status, 404);
  assert.equal((await api('PUT', `/api/clientes/${m.json.id}`, { token, body: { telefono: '221-444' } })).json.telefono, '221-444');
});

test('Clientes.RF19: búsqueda por documento, nombre, teléfono o QR del socio por el puerto, y Consumidor Final genérico', async () => {
  assert.deepEqual((await buscar('30123456')).map((c) => c.razon_social), ['Ana Pérez']);
  assert.deepEqual((await buscar('Pérez')).map((c) => c.razon_social), ['Ana Pérez']);
  assert.deepEqual((await buscar('1155551234')).map((c) => c.razon_social), ['Ana Pérez']); // teléfono sin guiones
  const ana = (await buscar('30123456'))[0];
  assert.deepEqual((await buscar(ana.codigo_socio)).map((c) => c.id), [ana.id]); // código QR
  assert.equal((await buscar('consumidor'))[0].tipo_documento, 'CF');
  assert.equal((await api('PUT', `/api/clientes/${(await buscar('consumidor'))[0].id}`, { token, body: { razon_social: 'X' } })).status, 409);
  const porPuerto = (await api('GET', '/api/ventas/clientes/buscar?q=30123456', { token })).json;
  assert.deepEqual(porPuerto.map((c) => c.id), [ana.id]);
});

test('Clientes.RF18/RN43: unificar deja un alias que resuelve a la ficha resultante, publica el evento y Ventas guarda el mapa', async () => {
  const a = (await crear({ tipo_documento: 'DNI', nro_documento: '20111000', razon_social: 'Juan Gomez', telefono: '1166667777' })).json;
  const b = (await crear({ tipo_documento: 'DNI', nro_documento: '20111001', razon_social: 'Juan Gómez' })).json;
  const c = (await crear({ tipo_documento: 'DNI', nro_documento: '20111002', razon_social: 'J. Gómez' })).json;
  const u = (abs, res, motivo = 'Cargado dos veces') => api('POST', '/api/clientes/unificar', { token, body: { absorbido_id: abs, resultante_id: res, motivo } });
  assert.equal((await u(a.id, b.id, '')).status, 400); // exige motivo
  assert.equal((await u(a.id, a.id)).status, 400);
  assert.equal((await api('POST', '/api/clientes/unificar', { token: tokenBarista, body: { absorbido_id: a.id, resultante_id: b.id, motivo: 'x' } })).status, 403);
  const r = await u(a.id, b.id);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.id, b.id);
  const alias = (await api('GET', `/api/clientes/${a.id}`, { token })).json;
  assert.deepEqual([alias.id, alias.alias_de], [b.id, a.id]); // un ID alias resuelve a la ficha resultante
  assert.deepEqual((await buscar('1166667777')).map((x) => x.id), [b.id]); // buscar por el dato del alias responde con la resultante
  assert.equal((await api('PUT', `/api/clientes/${a.id}`, { token, body: { razon_social: 'X' } })).status, 409);
  // Una resultante que luego se absorbe en otra: el alias se resuelve a la ficha final.
  await u(b.id, c.id, 'Tercera ficha');
  assert.equal((await api('GET', `/api/clientes/${a.id}`, { token })).json.id, c.id);
  assert.equal((await u(a.id, c.id)).status, 409); // ya está unificada
  await esperarMensajes(pool);
  assert.deepEqual((await pool.query('SELECT alias_id, resultante_id FROM ventas_cliente_alias ORDER BY alias_id'))[0], [{ alias_id: a.id, resultante_id: c.id }, { alias_id: b.id, resultante_id: c.id }]);
  assert.ok((await pool.query('SELECT COUNT(*) AS n FROM ventas_clientes_copia'))[0][0].n >= 3); // lista de precios y datos para Ventas
  assert.equal((await pool.query("SELECT COUNT(*) AS n FROM auditoria WHERE modulo = 'clientes' AND accion = 'unificar'"))[0][0].n, 2);
  assert.equal((await api('POST', `/api/clientes/${c.id}/desactivar`, { token })).json.estado, 'inactivo');
  assert.deepEqual(await buscar('J. Gómez'), []); // un cliente inactivo no aparece
});
