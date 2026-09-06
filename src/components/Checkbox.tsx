import type { InputHTMLAttributes, ReactNode } from 'react';

type CheckboxProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & {
  label: ReactNode;
};

export function Checkbox({ label, className = '', ...props }: CheckboxProps) {
  return (
    <label className={`checkbox${className ? ` ${className}` : ''}`}>
      <span className="checkbox__box">
        <input className="checkbox__input" type="checkbox" {...props} />
      </span>
      <span className="checkbox__label">{label}</span>
    </label>
  );
}
