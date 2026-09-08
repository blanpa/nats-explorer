import {
  cloneElement,
  forwardRef,
  isValidElement,
  useId,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { cn } from '../../lib/utils';

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  mono?: boolean;
  inputSize?: 'sm' | 'md';
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input({ className, mono, inputSize = 'md', ...rest }, ref) {
  return <input ref={ref} className={cn('input', inputSize === 'sm' && 'input-sm', mono && 'input-mono', className)} {...rest} />;
});

interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  mono?: boolean;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea({ className, mono = true, ...rest }, ref) {
  return <textarea ref={ref} className={cn('input', mono && 'input-mono', className)} {...rest} />;
});

interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  inputSize?: 'sm' | 'md';
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select({ className, inputSize = 'md', children, ...rest }, ref) {
  return (
    <select ref={ref} className={cn('input', inputSize === 'sm' && 'input-sm', className)} {...rest}>
      {children}
    </select>
  );
});

interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  label: ReactNode;
  description?: ReactNode;
}

export function Checkbox({ label, description, className, ...rest }: CheckboxProps) {
  return (
    <label className={cn('flex items-start gap-2 cursor-pointer select-none text-sm', className)}>
      <input type="checkbox" className="checkbox mt-[3px]" {...rest} />
      <span className="min-w-0">
        <span className="text-fg">{label}</span>
        {description && <span className="block text-xs text-muted">{description}</span>}
      </span>
    </label>
  );
}

interface FieldProps {
  label: ReactNode;
  hint?: ReactNode;
  htmlFor?: string;
  className?: string;
  children: ReactNode;
  required?: boolean;
}

/** Labelled form row. A single child control is linked to the label automatically. */
export function Field({ label, hint, htmlFor, className, children, required }: FieldProps) {
  const autoId = useId();
  const id = htmlFor ?? autoId;
  const hintId = hint ? `${id}-hint` : undefined;
  const control =
    isValidElement<{ id?: string; 'aria-describedby'?: string }>(children) && !children.props.id
      ? cloneElement(children, { id, 'aria-describedby': hintId })
      : children;
  return (
    <div className={cn('flex flex-col gap-1', className)}>
      <label htmlFor={id} className="text-xs font-medium text-muted">
        {label}
        {required && <span className="text-danger ml-0.5">*</span>}
      </label>
      {control}
      {hint && (
        <span id={hintId} className="text-xs text-faint">
          {hint}
        </span>
      )}
    </div>
  );
}

/** A filter field: "/" focuses it from anywhere, Escape clears it. */
export function SearchInput({ className, ...rest }: InputProps) {
  return (
    <div className={cn('relative', className)}>
      <svg
        aria-hidden
        className="absolute left-2.5 top-1/2 -translate-y-1/2 text-faint pointer-events-none"
        width="13"
        height="13"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx="11" cy="11" r="7" />
        <path d="m21 21-4.3-4.3" />
      </svg>
      <input
        type="search"
        className="input input-sm pl-7"
        {...rest}
        data-filter
        onKeyDown={e => {
          rest.onKeyDown?.(e);
          if (e.key === 'Escape' && !e.defaultPrevented) {
            if (e.currentTarget.value) rest.onChange?.({ ...e, target: { ...e.currentTarget, value: '' } } as unknown as React.ChangeEvent<HTMLInputElement>);
            else e.currentTarget.blur();
          }
        }}
      />
    </div>
  );
}
