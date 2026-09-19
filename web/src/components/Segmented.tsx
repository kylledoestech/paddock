export function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string
  options: { value: T; label: string }[]
  value: T
  onChange: (value: T) => void
}) {
  return (
    <div className="field" role="group" aria-label={label}>
      <span className="field__label">{label}</span>
      <div className="segmented">
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            className="segmented__item"
            aria-pressed={o.value === value}
            onClick={() => onChange(o.value)}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  )
}
