import type { InputHTMLAttributes, ReactNode } from 'react';

type SwitchProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & { label: ReactNode };

/** A binary setting, visually distinct from a multi-select checkbox. */
export function Switch({ label, className = '', ...props }: SwitchProps) {
  return (
    <label className={`switch${className ? ` ${className}` : ''}`}>
      <input className="switch__input" type="checkbox" role="switch" {...props} />
      <span className="switch__track" aria-hidden><span className="switch__thumb" /></span>
      <span className="switch__label">{label}</span>
    </label>
  );
}
