const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { iniciarApp } = require('./ayudas');

let pool, cerrar, R, M;
before(async () => {
  ({ pool, cerrar } = await iniciarApp());
  R = require('../src/reservas/servicio');
  M = require('../src/mensajeria/servicio');
});
after(async () => { await cerrar(); });

let n = 0;
const sol = () => `solicitud-reserva-${++n}`;
const CAPACIDAD = async () => 10; // el dueño del recurso dice cuánto tiene
const pedir = (cantidad, extra = {}) => R.reservar({ tipo: 'compromiso_stock', modulo: 'stock', idSolicitud: sol(), recurso: extra.recurso || 'item-1', cantidad, capacidad: CAPACIDAD, ...extra });
const vencerYa = (id) => pool.query('UPDATE reservas SET vence_ms = 1 WHERE id_reserva = ?', [id]);
const tomado = async (recurso = 'item-1') => Number((await pool.query("SELECT COALESCE(SUM(cantidad),0) AS t FROM reservas WHERE recurso = ? AND estado = 'vigente' AND vence_ms > ?", [recurso, Date.now()]))[0][0].t);

test('Usuarios.RN83: una reserva no confirmada se libera sola al vencer, sin que nadie intervenga', async () => {
  const a = await pedir(7, { recurso: 'item-vence' });
  assert.equal(a.estado, 'vigente');
  await assert.rejects(() => pedir(7, { recurso: 'item-vence' }), (e) => e.codigo === 'SIN_DISPONIBLE' && e.disponible === 3); // EX56: informa lo que queda
  await vencerYa(a.id_reserva);
  const b = await pedir(7, { recurso: 'item-vence' }); // ya está libre, aunque el barrido no haya corrido
  assert.equal(b.estado, 'vigente');
  assert.equal(await R.vencer(), 1);
  assert.equal((await R.obtener(a.id_reserva)).estado, 'vencida');
});

test('Usuarios.RN82: el mismo intento (misma ID_Solicitud) devuelve la misma reserva', async () => {
  const s = sol();
  const a = await R.reservar({ tipo: 'credito', modulo: 'clientes', idSolicitud: s, recurso: 'cli-9', cantidad: 5, capacidad: CAPACIDAD });
  const b = await R.reservar({ tipo: 'credito', modulo: 'clientes', idSolicitud: s, recurso: 'cli-9', cantidad: 5, capacidad: CAPACIDAD });
  assert.equal(a.id_reserva, b.id_reserva);
  assert.equal(await tomado('cli-9'), 5);
});

test('Usuarios.RN82/EX56: pedir de nuevo con otra cantidad reemplaza la anterior en una sola operación', async () => {
  const a = await pedir(7, { recurso: 'item-reemplazo' });
  const b = await pedir(9, { recurso: 'item-reemplazo', reemplazaA: a.id_reserva });
  assert.equal(b.reemplaza_a, a.id_reserva);
  assert.equal((await R.obtener(a.id_reserva)).estado, 'liberada');
  assert.equal(await tomado('item-reemplazo'), 9); // nunca 16: no hay un instante con las dos tomadas

  // Si el reemplazo no entra, la anterior queda como estaba.
  await assert.rejects(() => pedir(11, { recurso: 'item-reemplazo', reemplazaA: b.id_reserva }), (e) => e.codigo === 'SIN_DISPONIBLE');
  assert.equal((await R.obtener(b.id_reserva)).estado, 'vigente');
});

test('Usuarios.RN82: con dos pedidos a la vez por lo mismo, nunca se toma más de lo que hay', async () => {
  for (let ronda = 0; ronda < 5; ronda++) {
    const recurso = `item-carrera-${ronda}`;
    const a = await pedir(6, { recurso });
    const resultados = await Promise.allSettled([
      pedir(9, { recurso, reemplazaA: a.id_reserva }), // quiere cambiar su reserva por otra mayor
      pedir(3, { recurso }), // otro cliente quiere lo que sobra
    ]);
    const total = await tomado(recurso);
    assert.ok(total <= 10, `ronda ${ronda}: se tomaron ${total}`);
    if (resultados[0].status === 'rejected') assert.equal((await R.obtener(a.id_reserva)).estado, 'vigente'); // el reemplazo falló: la anterior sigue
    assert.ok(resultados.some((r) => r.status === 'fulfilled'));
  }
});

test('Usuarios.RN82: una reserva vigente se renueva hasta 3 veces; una vencida no se renueva', async () => {
  const a = await pedir(1, { recurso: 'item-renovar' });
  for (let i = 1; i <= 3; i++) assert.equal((await R.renovar(a.id_reserva)).renovaciones, i);
  await assert.rejects(() => R.renovar(a.id_reserva), (e) => e.codigo === 'SIN_RENOVACIONES');
  const b = await pedir(1, { recurso: 'item-renovar-2' });
  await vencerYa(b.id_reserva);
  await assert.rejects(() => R.renovar(b.id_reserva), (e) => e.codigo === 'RESERVA_VENCIDA');
});

test('Usuarios.RN83/EX56: la confirmación con la reserva vencida se rechaza con el motivo "reserva vencida" y no consume nada', async () => {
  // El mensaje de confirmación cita la reserva; el receptor la consume dentro de la transacción que aplica el efecto.
  M.registrarReceptor('stock', 'confirmar_compromiso', async (conn, c) => {
    try {
      return await R.consumir(conn, c.reserva);
    } catch (e) {
      if (e instanceof R.ReservaError) throw new M.RechazoNegocio(e.message);
      throw e;
    }
  });
  const emitir = async (docId, reserva) => {
    const conn = await pool.getConnection();
    await conn.beginTransaction();
    await M.publicar(conn, { origen: 'ventas', destino: 'stock', tipo: 'confirmar_compromiso', docTipo: 'venta', docIdGlobal: docId, contenido: { reserva } });
    await conn.commit(); conn.release();
  };
  const vigente = await pedir(2, { recurso: 'item-confirma' });
  await emitir('TST01-VENTA-OK', vigente.id_reserva);
  const vencida = await pedir(2, { recurso: 'item-confirma-2' });
  await vencerYa(vencida.id_reserva);
  await emitir('TST01-VENTA-VENCIDA', vencida.id_reserva);
  await new Promise((res) => setTimeout(res, 100));
  await M.procesarPendientes();
  await new Promise((res) => setTimeout(res, 100));

  const estadoMsg = async (d) => (await pool.query('SELECT estado, motivo_rechazo FROM mensajes_integracion WHERE doc_id_global = ?', [d]))[0][0];
  assert.equal((await estadoMsg('TST01-VENTA-OK')).estado, 'confirmado');
  assert.equal((await R.obtener(vigente.id_reserva)).estado, 'consumida');
  const rechazado = await estadoMsg('TST01-VENTA-VENCIDA');
  assert.deepEqual([rechazado.estado, rechazado.motivo_rechazo], ['rechazado', 'reserva vencida']);
  assert.equal((await R.obtener(vencida.id_reserva)).estado, 'vigente'); // nada se consumió (la marca de vencida es del barrido)
});

test('Usuarios.RN83: consumir dos veces la misma reserva no descuenta dos veces; si el receptor puede retomar el recurso, lo informa', async () => {
  const conn = await pool.getConnection();
  try {
    const a = await pedir(2, { recurso: 'item-doble' });
    assert.equal((await R.consumir(conn, a.id_reserva)).yaConsumida, undefined);
    assert.equal((await R.consumir(conn, a.id_reserva)).yaConsumida, true);

    const b = await pedir(2, { recurso: 'item-retoma' });
    await vencerYa(b.id_reserva);
    const r = await R.consumir(conn, b.id_reserva, { retomar: async () => true });
    assert.equal(r.retomada, true);
    assert.equal((await R.obtener(b.id_reserva)).estado, 'consumida');
  } finally { conn.release(); }
});
