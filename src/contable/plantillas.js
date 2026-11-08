// Plantillas iniciales del plan de cuentas por perfil de rubro (Contable RF01). Solo pre-cargan: todo se edita después. Las cuentas de lo que depende de otro módulo o función
// (Plataformas a cobrar, Gift cards, Comisiones, Productos elaborados, Remitos a facturar) se cargan solo si ese módulo está instalado o esa función activa.
// [código, nombre, tipo, código del padre, imputable, clave, requisito, perfiles]
const T = { A: 'activo', P: 'pasivo', PN: 'patrimonio', RP: 'resultado_positivo', RN: 'resultado_negativo' };
const PRODUCCION = ['produccion', 'cafeteria_produccion'];

const CUENTAS = [
  ['1', 'ACTIVO', T.A, null, 0],
  ['1.1', 'Activo corriente', T.A, '1', 0],
  ['1.1.01', 'Cajas por turno', T.A, '1.1', 1, 'caja'],
  ['1.1.02', 'Bancos y billeteras', T.A, '1.1', 1, 'bancos'],
  ['1.1.03', 'Deudores por ventas', T.A, '1.1', 1, 'deudores'],
  ['1.1.04', 'Plataformas a cobrar', T.A, '1.1', 1, 'plataformas_a_cobrar', { funcion: 'ONL-MARKETPLACES' }],
  ['1.1.05', 'IVA crédito fiscal', T.A, '1.1', 1, 'iva_credito'],
  ['1.1.06', 'Insumos', T.A, '1.1', 1, 'insumos'],
  ['1.1.07', 'Packaging', T.A, '1.1', 1, 'packaging'],
  ['1.1.08', 'Productos elaborados', T.A, '1.1', 1, 'productos_elaborados', { modulo: 'stock' }, PRODUCCION],
  ['1.1.09', 'Productos en proceso', T.A, '1.1', 1, 'productos_en_proceso', { modulo: 'stock' }, PRODUCCION],
  ['1.1.10', 'Retenciones y percepciones sufridas', T.A, '1.1', 1, 'retenciones_sufridas'],
  ['2', 'PASIVO', T.P, null, 0],
  ['2.1', 'Pasivo corriente', T.P, '2', 0],
  ['2.1.01', 'Proveedores', T.P, '2.1', 1, 'proveedores'],
  ['2.1.02', 'IVA débito fiscal', T.P, '2.1', 1, 'iva_debito'],
  ['2.1.03', 'Gift cards a canjear', T.P, '2.1', 1, 'gift_cards', { funcion: 'CLI-FIDEL' }],
  ['2.1.04', 'Vales a canjear', T.P, '2.1', 1, 'vales', { funcion: 'CLI-FIDEL' }],
  ['2.1.05', 'Comisiones a pagar', T.P, '2.1', 1, 'comisiones_a_pagar', { funcion: 'VEN-COMISIONES' }],
  ['2.1.06', 'Remitos a facturar', T.P, '2.1', 1, 'remitos_a_facturar', { funcion: 'VEN-CC' }],
  ['2.1.07', 'Retenciones a depositar', T.P, '2.1', 1, 'retenciones_a_depositar'],
  ['3', 'PATRIMONIO NETO', T.PN, null, 0],
  ['3.1', 'Capital', T.PN, '3', 1, 'capital'],
  ['3.2', 'Resultados acumulados', T.PN, '3', 1, 'resultados_acumulados'],
  ['3.3', 'Resultado del ejercicio', T.PN, '3', 1, 'resultado_ejercicio'],
  ['4', 'INGRESOS', T.RP, null, 0],
  ['4.1', 'Ventas', T.RP, '4', 0],
  ['4.1.01', 'Ventas salón', T.RP, '4.1', 1, 'ventas_salon'],
  ['4.1.02', 'Ventas mostrador', T.RP, '4.1', 1, 'ventas_mostrador'],
  ['4.1.03', 'Ventas delivery', T.RP, '4.1', 1, 'ventas_delivery'],
  ['4.1.04', 'Ventas mayorista', T.RP, '4.1', 1, 'ventas_mayorista', null, PRODUCCION],
  ['4.1.05', 'Ventas por plataformas', T.RP, '4.1', 1, 'ventas_plataforma', { funcion: 'ONL-MARKETPLACES' }],
  ['4.2', 'Otros ingresos', T.RP, '4', 0],
  ['4.2.01', 'Diferencias de cambio positivas', T.RP, '4.2', 1, 'diferencias_cambio_pos'],
  ['5', 'COSTOS Y GASTOS', T.RN, null, 0],
  ['5.1', 'Costos', T.RN, '5', 0],
  ['5.1.01', 'Costo de ventas - insumos', T.RN, '5.1', 1, 'costo_insumos', { modulo: 'stock' }],
  ['5.1.02', 'Costo de ventas - packaging', T.RN, '5.1', 1, 'costo_packaging', { modulo: 'stock' }],
  ['5.1.03', 'Mermas de producción y de vitrina', T.RN, '5.1', 1, 'mermas', { modulo: 'stock' }],
  ['5.2', 'Gastos', T.RN, '5', 0],
  ['5.2.01', 'Compras y gastos generales', T.RN, '5.2', 1, 'compras'],
  ['5.2.02', 'Comisiones de vendedores', T.RN, '5.2', 1, 'comisiones_vendedores', { funcion: 'VEN-COMISIONES' }],
  ['5.2.03', 'Comisiones de plataformas', T.RN, '5.2', 1, 'comisiones_plataformas', { funcion: 'ONL-MARKETPLACES' }],
  ['5.2.04', 'Comisiones de tarjetas', T.RN, '5.2', 1, 'comisiones_tarjetas'],
  ['5.2.05', 'Diferencias de caja', T.RN, '5.2', 1, 'diferencias_caja'],
  ['5.2.06', 'Diferencias de cambio', T.RN, '5.2', 1, 'diferencias_cambio'],
  ['5.2.07', 'Diferencias de conciliación', T.RN, '5.2', 1, 'diferencias_conciliacion'],
  ['5.2.08', 'Vencimiento de gift cards y vales', T.RN, '5.2', 1, 'vencimiento_saldos', { funcion: 'CLI-FIDEL' }],
];

const PERFILES = ['cafeteria', 'produccion', 'cafeteria_produccion', 'personalizado'];

// Las cuentas de un perfil, filtradas por lo que está instalado o activo (`activa(requisito)` decide).
const cuentasDe = (perfil, cumple) => {
  if (!PERFILES.includes(perfil)) throw new Error(`Perfil desconocido: ${perfil}`);
  const real = perfil === 'personalizado' ? 'cafeteria' : perfil;
  return CUENTAS.filter(([, , , , , , req, perfiles]) => (!perfiles || perfiles.includes(real)) && (!req || cumple(req))).map(([codigo, nombre, tipo, padre, imputable, clave]) => ({ codigo, nombre, tipo, padre, imputable: !!imputable, clave: clave ?? null }));
};

module.exports = { PERFILES, cuentasDe, CUENTAS, T };
