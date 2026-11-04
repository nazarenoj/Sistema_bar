export default function Spinner({ size = 'md' }) {
  const s = { sm: 'h-4 w-4 border-2', md: 'h-8 w-8 border-4', lg: 'h-12 w-12 border-4' }[size]
  return (
    <div className={`${s} border-stone-200 border-t-cafe-700 rounded-full animate-spin`} />
  )
}
