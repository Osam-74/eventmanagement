'use client';

/**
 * Picks which events an administrator may open in Guest moments.
 * `options` is the list of events the CURRENT admin can grant (server
 * enforces the same limit), so a delegate never sees events they lack.
 */
export function MomentsAccessPicker({
  options, value, onChange, disabled,
}: {
  options: { id: string; name: string }[];
  value: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
}) {
  const toggle = (id: string) => onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id]);
  const allOn = options.length > 0 && options.every((o) => value.includes(o.id));

  if (options.length === 0) return <p className="text-xs text-brand-navy-700/60">No events available to grant.</p>;
  return (
    <fieldset className="rounded-lg border border-brand-ice-200 p-3" disabled={disabled}>
      <legend className="px-1 text-xs font-medium text-brand-navy-800">Events this admin can open in Guest moments</legend>
      <div className="mb-2 flex items-center gap-3 text-xs">
        <button type="button" onClick={() => onChange(allOn ? value.filter((id) => !options.some((o) => o.id === id)) : Array.from(new Set([...value, ...options.map((o) => o.id)])))}
          className="text-brand-blue-600 hover:underline">{allOn ? 'Clear all' : 'Select all'}</button>
        <span className="text-brand-navy-700/60">{value.filter((id) => options.some((o) => o.id === id)).length} of {options.length} selected</span>
      </div>
      <div className="grid gap-1 sm:grid-cols-2">
        {options.map((o) => (
          <label key={o.id} className="flex items-center gap-2 text-sm text-brand-navy-800">
            <input type="checkbox" checked={value.includes(o.id)} onChange={() => toggle(o.id)} className="accent-brand-blue-500" />
            <span className="truncate">{o.name}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
