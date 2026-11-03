const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { iniciarApp } = require('./ayudas');

let api, pool, cerrar, token, Reservas, n = 0;

before(async () => {
  ({ api, pool, cerrar } = await iniciarApp());
  Reservas = require('../src/services/reservaService');
  const [roles] = await pool.query("SELECT id FROM roles WHERE codigo = 'administrador'");
  const [u] = await pool.query("INSERT INTO users (username, password_hash, rol) VALUES ('adm', ?, 'admin')", [await bcrypt.hash('clave-larga-1', 4)]);
  await pool.query('INSERT INTO usuario_roles (user_id, rol_id) VALUES (?, ?)', [u.insertId, roles[0].id]);
  token = (await api('POST', '/api/auth/login', { body: { username: 'adm', password: 'clave-larga-1' } })).json.token;
});
after(async () => { await cerrar(); });

// Fecha local 'AAAA-MM-DD HH:MM' a `minutos` de ahora.
const en = (minutos) => {
  const d = new Date(Date.now() + minutos * 60000);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};
const mesa = async () => (await api('POST', '/api/mesas', { token, body: { numero_mesa: ++n, salon_id: 1 } })).json;
const reservar = (body) => api('POST', '/api/reservas', { token, body: { cliente_nombre: 'Ana', personas: 2, ...body } });
const producto = async (nombre) => (await api('POST', '/api/productos', { token, body: { nombre: `${nombre} ${++n}`, precio: 500 } })).json;

test('Ventas.RF43: sin VEN-RESERVAS no hay reservas; con ella se validan los datos', async () => {
  assert.equal((await api('GET', '/api/reservas', { token })).status, 409);
  assert.equal((await api('POST', '/api/funciones/cambiar', { token, body: { activar: ['VEN-RESERVAS'], motivo: 'prueba' } })).status, 200);
  const m = await mesa();
  assert.equal((await reservar({ cliente_nombre: '', mesa_id: m.id, fecha_hora: en(120) })).status, 400);
  assert.equal((await reservar({ personas: 0, mesa_id: m.id, fecha_hora: en(120) })).status, 400);
  assert.equal((await reservar({ mesa_id: m.id, fecha_hora: 'mañana' })).status, 400);
  assert.equal((await reservar({ mesa_id: m.id, fecha_hora: en(-120) })).status, 400); // ya pasó
  assert.equal((await reservar({ mesa_id: m.id, fecha_hora: en(120), cliente_email: 'no-es-correo' })).status, 400);
  assert.equal((await reservar({ mesa_id: 99999, fecha_hora: en(120) })).status, 404);
  const ok = await reservar({ mesa_id: m.id, fecha_hora: en(120), cliente_telefono: '1155550000' });
  assert.equal(ok.status, 201, JSON.stringify(ok.json));
  assert.deepEqual([ok.json.estado, ok.json.duracion_min, ok.json.mesa_id], ['pendiente', 90, m.id]);
});

test('Ventas.RN40/EX30: una mesa no tiene dos reservas superpuestas; el choque ofrece otra mesa o la lista de espera', async () => {
  const [m1, m2] = [await mesa(), await mesa()];
  const a = await reservar({ mesa_id: m1.id, fecha_hora: en(300) });
  assert.equal(a.status, 201, JSON.stringify(a.json));
  const choque = await reservar({ mesa_id: m1.id, fecha_hora: en(360), cliente_nombre: 'Beto' }); // 60 min después: dentro de los 90 de la primera
  assert.equal(choque.status, 409);
  assert.equal(choque.json.codigo, 'SUPERPUESTA');
  assert.equal(choque.json.lista_espera, true);
  assert.ok(choque.json.alternativas.some((x) => x.id === m2.id));
  assert.equal(choque.json.alternativas.some((x) => x.id === m1.id), false);
  assert.equal((await reservar({ mesa_id: m1.id, fecha_hora: en(390), cliente_nombre: 'Beto' })).status, 201); // justo al terminar la duración: sin choque
  assert.equal((await reservar({ mesa_id: m2.id, fecha_hora: en(360), cliente_nombre: 'Beto' })).status, 201); // otra mesa, misma hora
  // Mover una reserva a un horario que choca también se rechaza; a uno libre, no.
  const c = await reservar({ mesa_id: m2.id, fecha_hora: en(500) });
  assert.equal((await api('PUT', `/api/reservas/${c.json.id}`, { token, body: { fecha_hora: en(380) } })).status, 409);
  assert.equal((await api('PUT', `/api/reservas/${c.json.id}`, { token, body: { fecha_hora: en(700) } })).json.personas, 2);
});

test('Ventas.RF43/RN40: los estados de la reserva y el vencimiento por tolerancia que libera la mesa', async () => {
  const m = await mesa();
  const r = (await reservar({ mesa_id: m.id, fecha_hora: en(600) })).json;
  assert.equal((await api('POST', `/api/reservas/${r.id}/cancelar`, { token, body: {} })).status, 400); // motivo obligatorio
  assert.equal((await api('POST', `/api/reservas/${r.id}/confirmar`, { token })).json.estado, 'confirmada');
  assert.equal((await api('POST', `/api/reservas/${r.id}/confirmar`, { token })).status, 409);
  assert.equal((await api('POST', `/api/reservas/${r.id}/cumplir`, { token })).json.estado, 'cumplida');
  assert.equal((await api('POST', `/api/reservas/${r.id}/cancelar`, { token, body: { motivo: 'x' } })).status, 409);
  assert.equal((await api('PUT', `/api/reservas/${r.id}`, { token, body: { personas: 4 } })).status, 409);
  // La que no se presenta pasa a "No presentó" pasada la tolerancia (15 min) y libera la mesa.
  const t = (await reservar({ mesa_id: m.id, fecha_hora: en(700), cliente_nombre: 'Tarde' })).json;
  await pool.query("UPDATE reservas_mesa SET fecha_hora = DATE_SUB(NOW(), INTERVAL 20 MINUTE), fecha_fin = DATE_ADD(NOW(), INTERVAL 70 MINUTE) WHERE id = ?", [t.id]);
  assert.equal((await reservar({ mesa_id: m.id, fecha_hora: en(30), cliente_nombre: 'Nueva' })).status, 409); // todavía la ocupa
  assert.equal(await Reservas.vencer(), 1);
  assert.equal((await api('GET', `/api/reservas/${t.id}`, { token })).json.estado, 'no_presento');
  assert.equal((await reservar({ mesa_id: m.id, fecha_hora: en(30), cliente_nombre: 'Nueva' })).status, 201);
  const c = (await reservar({ mesa_id: m.id, fecha_hora: en(900) })).json;
  const can = await api('POST', `/api/reservas/${c.id}/cancelar`, { token, body: { motivo: 'cambió de planes' } });
  assert.deepEqual([can.json.estado, can.json.motivo_cancelacion], ['cancelada', 'cambió de planes']);
});

test('Ventas.RF43/EX30: lista de espera, mesa ocupada sin mover pedidos y mesa reservada en el plano', async () => {
  const [libre, ocupada] = [await mesa(), await mesa()];
  const w = await reservar({ en_espera: true, cliente_nombre: 'Sin reserva', personas: 3 });
  assert.equal(w.status, 201, JSON.stringify(w.json));
  assert.deepEqual([w.json.en_espera, w.json.mesa_id], [true, null]);
  assert.equal((await api('POST', `/api/reservas/${w.json.id}/confirmar`, { token })).status, 409); // primero se le asigna mesa
  assert.equal((await api('GET', '/api/reservas?espera=1', { token })).json.some((x) => x.id === w.json.id), true);
  // Una mesa con pedido abierto: la reserva cercana se acepta con aviso y el pedido no se toca (EX30).
  const pedido = (await api('POST', '/api/pedidos', { token, body: { mesa_id: ocupada.id } })).json;
  const aviso = await reservar({ mesa_id: ocupada.id, fecha_hora: en(30) });
  assert.equal(aviso.status, 201, JSON.stringify(aviso.json));
  assert.match(aviso.json.avisos[0], /ocupada/);
  assert.equal((await pool.query("SELECT estado, mesa_id FROM pedidos WHERE id = ?", [pedido.id]))[0][0].mesa_id, ocupada.id);
  // La de espera pasa a una mesa libre, y no a una que tiene reserva en ese horario.
  assert.equal((await api('POST', `/api/reservas/${w.json.id}/asignar`, { token, body: { mesa_id: ocupada.id, fecha_hora: en(40) } })).status, 409);
  const asig = await api('POST', `/api/reservas/${w.json.id}/asignar`, { token, body: { mesa_id: libre.id, fecha_hora: en(45) } });
  assert.equal(asig.status, 200, JSON.stringify(asig.json));
  assert.deepEqual([asig.json.en_espera, asig.json.mesa_id, asig.json.estado], [false, libre.id, 'pendiente']);
  const plano = (await api('GET', `/api/reservas/plano?desde=${encodeURIComponent(en(0))}&hasta=${encodeURIComponent(en(180))}`, { token })).json;
  assert.deepEqual(plano.filter((p) => [libre.id, ocupada.id].includes(p.mesa_id)).map((p) => p.mesa_id).sort(), [libre.id, ocupada.id].sort());
});

test('Ventas.RF43: el recordatorio por correo sale con la anticipación configurada y, sin correo o sin internet, queda pendiente', async () => {
  const m = await mesa();
  const lejos = (await reservar({ mesa_id: m.id, fecha_hora: en(60 * 72), cliente_email: 'lejos@x.com' })).json; // dentro de 3 días
  const cerca = (await reservar({ mesa_id: m.id, fecha_hora: en(60 * 5), cliente_email: 'cerca@x.com', cliente_nombre: 'Cerca' })).json; // dentro de 5 horas
  const ids = (await api('GET', '/api/reservas/recordatorios', { token })).json.map((x) => x.id);
  assert.deepEqual([ids.includes(cerca.id), ids.includes(lejos.id)], [true, false]);
  assert.equal((await Reservas.enviarRecordatorios()).enviados, 0); // sin servicio de correo
  const mandados = [];
  Reservas.usarCorreo(async (r) => { mandados.push(r.cliente_email); });
  const r1 = await Reservas.enviarRecordatorios();
  assert.equal(r1.enviados, 1);
  assert.deepEqual(mandados, ['cerca@x.com']);
  assert.equal((await Reservas.enviarRecordatorios()).enviados, 0); // no se repite
  // Sin internet el envío falla y el recordatorio sigue pendiente.
  await pool.query('UPDATE reservas_mesa SET recordatorio_enviado_at = NULL WHERE id = ?', [cerca.id]);
  Reservas.usarCorreo(async () => { throw new Error('sin internet'); });
  assert.deepEqual(await Reservas.enviarRecordatorios(), { enviados: 0, pendientes: 1 });
  Reservas.usarCorreo(null);
});

test('Ventas.RF44: los turnos respetan el cupo aun con inscripciones simultáneas', async () => {
  const t = await api('POST', '/api/reservas/turnos', { token, body: { nombre: 'Cata de café', tipo: 'cata', fecha_hora: en(2000), cupo: 4 } });
  assert.equal(t.status, 201, JSON.stringify(t.json));
  assert.equal((await api('POST', '/api/reservas/turnos', { token, body: { nombre: 'x', tipo: 'otro', fecha_hora: en(2000), cupo: 4 } })).status, 400);
  const insc = (body) => api('POST', `/api/reservas/turnos/${t.json.id}/inscripciones`, { token, body });
  assert.equal((await insc({ nombre: 'Uno', personas: 3 })).json.disponible, 1);
  const lleno = await insc({ nombre: 'Dos', personas: 2 });
  assert.equal(lleno.status, 409);
  assert.deepEqual([lleno.json.codigo, lleno.json.disponible], ['SIN_CUPO', 1]);
  const ultimo = await insc({ nombre: 'Tres', personas: 1 });
  assert.equal(ultimo.json.disponible, 0);
  await api('DELETE', `/api/reservas/turnos/${t.json.id}/inscripciones/${ultimo.json.inscriptos[1].id}`, { token });
  // Dos de a 1 lugar a la vez para el único libre: entra uno solo.
  const [a, b] = await Promise.all([insc({ nombre: 'A', personas: 1 }), insc({ nombre: 'B', personas: 1 })]);
  assert.deepEqual([a.status, b.status].sort(), [201, 409]);
  assert.equal((await api('GET', `/api/reservas/turnos/${t.json.id}`, { token })).json.ocupados, 4);
  assert.equal((await api('POST', `/api/reservas/turnos/${t.json.id}/cancelar`, { token })).json.cancelado, true);
  assert.equal((await insc({ nombre: 'C' })).status, 409);
});

test('Ventas.RF44: el pedido especial genera la comanda al obrador a su fecha, una sola vez, y se cobra al entregar', async () => {
  const torta = await producto('Torta por encargo');
  const bandeja = await producto('Bandeja');
  const e = await api('POST', '/api/reservas/especiales', { token, body: { cliente_nombre: 'Cumple de Lola', cliente_telefono: '1144443333', fecha_entrega: en(60), observaciones: 'Con velitas',
    items: [{ producto_id: torta.id, cantidad: 1, observaciones: 'Dulce de leche' }, { producto_id: bandeja.id, cantidad: 2 }] } });
  assert.equal(e.status, 201, JSON.stringify(e.json));
  assert.equal((await api('POST', '/api/reservas/especiales', { token, body: { cliente_nombre: 'x', fecha_entrega: en(60), items: [] } })).status, 400);
  const lejano = (await api('POST', '/api/reservas/especiales', { token, body: { cliente_nombre: 'Lejos', fecha_entrega: en(60 * 48), items: [{ producto_id: torta.id, cantidad: 1 }] } })).json;
  assert.equal(await Reservas.generarVencidos(), 1); // solo el que entra en la anticipación (120 min)
  const g = (await api('GET', `/api/reservas/especiales/${e.json.id}`, { token })).json;
  assert.equal(g.estado, 'comanda_generada');
  assert.equal((await api('GET', `/api/reservas/especiales/${lejano.id}`, { token })).json.estado, 'pendiente');
  const [[p]] = await pool.query('SELECT modalidad, referencia FROM pedidos WHERE id = ?', [g.pedido_id]);
  assert.deepEqual([p.modalidad, /Cumple de Lola/.test(p.referencia)], ['retiro', true]);
  const comandas = (await api('GET', `/api/comandas?mesa_id=${g.mesa_id}`, { token })).json;
  assert.equal(comandas.length, 1);
  assert.deepEqual(comandas[0].items.map((i) => Number(i.cantidad)).sort(), [1, 2]);
  // Repetirlo no duplica nada; cancelar ya no se puede; se entrega y el pedido queda para cobrar.
  await api('POST', `/api/reservas/especiales/${e.json.id}/comanda`, { token });
  assert.equal((await api('GET', `/api/comandas?mesa_id=${g.mesa_id}`, { token })).json.length, 1);
  assert.equal((await api('POST', `/api/reservas/especiales/${e.json.id}/cancelar`, { token })).status, 409);
  assert.equal((await api('POST', `/api/reservas/especiales/${lejano.id}/entregar`, { token })).status, 409); // todavía no generó su comanda
  assert.equal((await api('POST', `/api/reservas/especiales/${e.json.id}/entregar`, { token })).json.estado, 'entregado');
  assert.equal((await api('POST', `/api/reservas/especiales/${lejano.id}/cancelar`, { token })).json.estado, 'cancelado');
});
