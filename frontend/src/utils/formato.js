export const dinero = (n) => `$${Number(n ?? 0).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
export const fecha = (f) => (f ? new Date(f).toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' }) : '—')
export const dia = (f) => (f ? new Date(f).toLocaleDateString('es-AR') : '—')
export const numeroComprobante = (pv, n) => (n ? `${String(pv).padStart(4, '0')}-${String(n).padStart(8, '0')}` : '—')
