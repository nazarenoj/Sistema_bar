const M = require('../mensajeria/servicio');
const F = require('./fidelizacionService');

// Clientes como receptor de los efectos de fidelización que pide Ventas (Clientes RF29, RF31, RN36, RN37, RN40): acumulación, canje, emisión de gift cards y de vales por
// devolución y sus reversiones. Cada uno se registra una sola vez por ID_Operacion; un error de negocio deja el mensaje Rechazado, sin tocar la venta.
const abierto = (ctx) => { if (!(ctx.funciones ?? []).includes('CLI-FIDEL')) throw new M.RechazoNegocio('La función CLI-FIDEL estaba desactivada cuando se emitió el documento.'); };

M.registrarReceptor('clientes', 'acumulacion_fidelizacion', (conn, c, ctx) => { abierto(ctx); return F.acumular(conn, { clienteId: c.cliente_id, ventaId: c.venta_id_global, lineas: c.lineas ?? [], importePagado: c.importe_pagado, idOperacion: ctx.idOperacion, terminal: c.terminal ?? null }); });
M.registrarReceptor('clientes', 'reversion_fidelizacion', (conn, c, ctx) => { abierto(ctx); return F.revertir(conn, { ventaId: c.venta_id_global, idOperacion: ctx.idOperacion }); }, { revierte: 'acumulacion_fidelizacion' });
M.registrarReceptor('clientes', 'canje_instrumento', (conn, c, ctx) => F.consumir(conn, c, ctx));
M.registrarReceptor('clientes', 'canje_sellos', (conn, c, ctx) => { abierto(ctx); return F.canjearSellos(conn, { clienteId: c.cliente_id, reglaId: c.regla_id, ventaId: c.venta_id_global, idOperacion: ctx.idOperacion }); });
M.registrarReceptor('clientes', 'emision_gift_card', (conn, c, ctx) => F.emitirGiftCard(conn, c, ctx));
M.registrarReceptor('clientes', 'emision_vale', (conn, c, ctx) => F.emitirVale(conn, c, ctx));
M.registrarReceptor('clientes', 'reversion_emision', (conn, c, ctx) => F.revertirEmision(conn, c, ctx), { revierte: 'emision_gift_card' });
M.registrarReceptor('clientes', 'reversion_vale', (conn, c, ctx) => F.revertirEmision(conn, c, ctx), { revierte: 'emision_vale' });
