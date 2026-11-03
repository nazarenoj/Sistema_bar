const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { iniciarApp, esperarMensajes } = require('./ayudas');

let api, pool, cerrar, token, tokenBarista, ana, masa, retiro, n = 0, k = 0;

before(async () => {
  ({ api, pool, cerrar } = await iniciarApp());
  const usuario = async (username, rol) => {
    const [r] = await pool.query('INSERT INTO users (username, password_hash, rol) VALUES (?, ?, ?)', [username, await bcrypt.hash('clave-larga-1', 4), rol === 'administrador' ? 'admin' : 'empleado']);
    await pool.query('INSERT INTO usuario_roles (user_id, rol_id) SELECT ?, id FROM roles WHERE codigo = ?', [r.insertId, rol]);
    return (await api('POST', '/api/auth/login', { body: { username, password: 'clave-larga-1' } })).json.token;
  };
  token = await usuario('adm', 'administrador');
  tokenBarista = await usuario('bea', 'barista');
  await api('POST', '/api/modulos/clientes/instalar', { token });
  ana = (await api('POST', '/api/clientes', { token, body: { tipo_documento: 'DNI', nro_documento: '30123456', razon_social: 'Ana Pérez', telefono: '1155551234', email: 'ana@mail.test', consultar_arca: false, domicilios_entrega: [{ direccion: 'Mitre 100' }] } })).json;
});
after(async () => { await cerrar(); });

const vender = async (cantidad, clienteId) => {
  const mesa = (await api('POST', '/api/mesas', { token, body: { numero_mesa: ++n, salon_id: 1 } })).json;
  const pedido = (await api('POST', '/api/pedidos', { token, body: { mesa_id: mesa.id } })).json;
  await api('POST', `/api/pedidos/${pedido.id}/productos`, { token, body: { productos: [{ producto_id: masa.id, cantidad }] } });
  const r = await api('POST', `/api/mesas/${mesa.id}/cerrar`, { token, headers: { 'X-ID-Solicitud': `cierre-ret-${++k}-abcdef` }, body: { metodo_pago: 'efectivo', ...(clienteId && { cliente_id: clienteId }) } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  await esperarMensajes(pool); await esperarMensajes(pool);
};
const alcance = (t = token, formato = '') => api('GET', `/api/clientes-informes/retiros/${retiro.id}/alcance${formato}`, { token: t });

test('Clientes.RF30: el alcance de un retiro de lote completa el contacto de los clientes identificados y deja sin contacto las ventas anónimas', async () => {
  const harina = (await api('POST', '/api/insumos', { token, body: { nombre: 'Harina T', unidad: 'kg' } })).json;
  await api('PUT', `/api/lotes/configuracion/insumo/${harina.id}`, { token, body: { controla_lote: true } });
  await api('POST', '/api/stock/ingresos', { token, body: { motivo: 'compra', proveedor: 'Molino SA', lineas: [{ item: { tipo: 'insumo', id: harina.id }, cantidad: 50, costo_unitario: 10, lote: { codigo: 'H1', fecha_vencimiento: new Date(Date.now() + 60 * 86400000).toISOString().slice(0, 10) } }] } });
  masa = (await api('POST', '/api/productos', { token, body: { nombre: 'Masa T', precio: 100, tipo: 'elaborado' } })).json;
  await api('PUT', `/api/recetas/${masa.id}`, { token, body: { lineas: [{ insumo_id: harina.id, cantidad_consumida: 0.5 }] } });
  await api('PUT', `/api/produccion/ficha/${masa.id}`, { token, body: { modo_produccion: 'previa' } });
  await api('PUT', `/api/lotes/configuracion/producto/${masa.id}`, { token, body: { controla_lote: true, vida_util_dias: 5 } });
  const o = (await api('POST', '/api/produccion/ordenes', { token, body: { producto_id: masa.id, cantidad: 10 } })).json;
  assert.equal((await api('POST', `/api/produccion/ordenes/${o.id}/confirmar`, { token, body: { lote_codigo: 'M1' } })).status, 200);
  await vender(2, ana.id); // venta con cliente identificado
  await vender(1); // venta de mostrador, sin cliente
  const lH = (await api('GET', `/api/lotes?item_tipo=insumo&item_id=${harina.id}`, { token })).json.find((l) => l.codigo === 'H1');
  const rr = await api('POST', `/api/trazabilidad/lotes/${lH.id}/retirar`, { token, body: { motivo: 'Aviso del proveedor', incluir_derivados: true } });
  assert.equal(rr.status, 201, JSON.stringify(rr.json));
  retiro = rr.json;
  assert.equal(retiro.lineas.length, 2);

  const a = await alcance();
  assert.equal(a.status, 200, JSON.stringify(a.json));
  assert.deepEqual([a.json.clientes_alcanzados, a.json.sin_cliente, a.json.lineas.length], [1, 1, 2]);
  const con = a.json.lineas.find((l) => l.contacto);
  assert.deepEqual([con.contacto.cliente, con.contacto.telefono, con.contacto.email, con.contacto.domicilio, con.articulo, con.estado_aviso], ['Ana Pérez', '1155551234', 'ana@mail.test', 'Mitre 100', 'Masa T', 'pendiente']);
  assert.equal(a.json.lineas.find((l) => !l.contacto).cliente_id, null); // sin cliente identificado se muestra sin contacto
  assert.equal((await alcance(tokenBarista)).status, 403); // los datos personales piden permiso
  assert.equal((await alcance(token, '?formato=csv')).status, 200);
  assert.equal((await api('GET', '/api/clientes-informes/retiros/99999/alcance', { token })).status, 404);
});

test('Clientes.RN43/RF30: si el cliente de la venta es un alias, el contacto sale de la ficha resultante', async () => {
  const otra = (await api('POST', '/api/clientes', { token, body: { tipo_documento: 'DNI', nro_documento: '28999111', razon_social: 'Ana P. de Pérez', telefono: '1166667777', email: 'ana.nueva@mail.test', consultar_arca: false } })).json;
  assert.equal((await api('POST', '/api/clientes/unificar', { token, body: { absorbido_id: ana.id, resultante_id: otra.id, motivo: 'Misma persona' } })).status, 200);
  const con = (await alcance()).json.lineas.find((l) => l.contacto);
  assert.deepEqual([con.contacto.cliente_id, con.contacto.email], [otra.id, 'ana.nueva@mail.test']);
});

test('Clientes.RF30/EX32: marcar un aviso lo registra en Stock con usuario, medio y fecha; si Stock no responde el aviso no se marca y la consulta no muestra un listado viejo', async () => {
  const linea = (await alcance()).json.lineas.find((l) => l.contacto);
  const avisar = (body, t = token) => api('POST', `/api/clientes-informes/retiros/lineas/${linea.id}/avisado`, { token: t, body });
  assert.equal((await avisar({ medio: 'teléfono' }, tokenBarista)).status, 403);
  assert.equal((await avisar({})).status, 400);
  const Traza = require('../src/stock/trazaService');
  const real = Traza.avisar, realAlcance = Traza.alcance;
  Traza.avisar = async () => { throw new Error('Stock reiniciándose'); };
  const falla = await avisar({ medio: 'teléfono' });
  assert.deepEqual([falla.status, falla.json.codigo], [503, 'ALCANCE_NO_DISPONIBLE']);
  assert.equal((await alcance()).json.lineas.find((l) => l.id === linea.id).estado_aviso, 'pendiente'); // sigue pendiente de aviso
  Traza.avisar = real;
  const ok = await avisar({ medio: 'teléfono' });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  const fila = (await pool.query('SELECT estado_aviso, avisado_medio, avisado_por FROM retiro_lineas WHERE id = ?', [linea.id]))[0][0];
  assert.deepEqual([fila.estado_aviso, fila.avisado_medio, fila.avisado_por !== null], ['avisado', 'teléfono', true]);
  assert.equal((await alcance()).json.lineas.find((l) => l.id === linea.id).avisado_medio, 'teléfono');
  Traza.alcance = async () => { throw new Error('sin respuesta'); };
  const caido = await alcance();
  assert.deepEqual([caido.status, caido.json.codigo], [503, 'ALCANCE_NO_DISPONIBLE']);
  Traza.alcance = realAlcance;
});

test('Clientes.RF30: sin STK-TRAZA la consulta se oculta y el resto del módulo no cambia', async () => {
  await pool.query("INSERT INTO estado_funcionalidades (funcion_id, activa) VALUES ('STK-TRAZA', 0) ON DUPLICATE KEY UPDATE activa = 0");
  const a = await alcance();
  assert.deepEqual([a.status, a.json.codigo], [409, 'OPCION_NO_DISPONIBLE']);
  assert.equal((await api('GET', '/api/clientes?q=Ana', { token })).status, 200);
});
