
export function Field({ children, className = '', hint = '', label }) {
  return (
    <label className={`form-group supervisor-form-field ${className}`}>
      <span className="supervisor-field-label"><span>{label}</span>{hint ? <small>{hint}</small> : null}</span>
      {children}
    </label>
  );
}

export function TextField({ form, hint = '', label, name, placeholder = '', updateField }) {
  return (
    <Field hint={hint} label={label}>
      <input className="form-control" value={form[name]} onChange={(event) => updateField(name, event.target.value)} placeholder={placeholder} />
    </Field>
  );
}
