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
import { Hint } from './misc';

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
    // The mark sits outside the label, or clicking it would toggle the box.
    <div className={cn('flex items-start gap-1.5 text-sm', className)}>
      <label className="flex items-start gap-2 cursor-pointer select-none min-w-0">
        <input type="checkbox" className="checkbox mt-[3px]" {...rest} />
        <span className="text-fg min-w-0">{label}</span>
      </label>
      {description && <Hint text={description} className="mt-[5px]" />}
    </div>
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
      <span className="flex items-center gap-1.5">
        <label htmlFor={id} className="text-xs font-medium text-muted">
          {label}
          {required && <span className="text-danger ml-0.5">*</span>}
        </label>
        {hint && <Hint text={hint} id={hintId} />}
      </span>
      {control}
    </div>
  );
}

interface SearchInputProps extends InputProps {
  /**
   * Text to show faintly after what has been typed, which Tab or the right
   * arrow accepts. It is an offer, never a correction: it only ever adds to
   * the end, so the letters already on screen do not move.
   */
  suggestion?: string;
  onAcceptSuggestion?: () => void;
}

/** A filter field: "/" focuses it from anywhere, Escape clears it. */
export function SearchInput({ className, suggestion, onAcceptSuggestion, ...rest }: SearchInputProps) {
  const typed = String(rest.value ?? '');
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
      {/* The ghost sits behind the field and repeats what was typed in
          transparent text, so the suggestion lands exactly where the cursor
          is whatever the font does. It must carry the same box as the input
          for that to hold. */}
      {suggestion && (
        <div aria-hidden className="absolute inset-0 pointer-events-none input input-sm pl-7 border-transparent bg-transparent overflow-hidden whitespace-pre">
          <span className="invisible">{typed}</span>
          <span className="text-faint">{suggestion}</span>
        </div>
      )}
      <input
        type="search"
        // A subject is not prose: the red underline under every filter term
        // says nothing, and the ghost has to sit on clean text.
        spellCheck={false}
        autoComplete="off"
        className={cn('input input-sm pl-7', suggestion && 'bg-transparent')}
        {...rest}
        data-filter
        onKeyDown={e => {
          rest.onKeyDown?.(e);
          if (e.defaultPrevented) return;
          const atEnd = e.currentTarget.selectionStart === e.currentTarget.value.length;
          if (suggestion && atEnd && (e.key === 'Tab' || e.key === 'ArrowRight')) {
            e.preventDefault();
            onAcceptSuggestion?.();
            return;
          }
          if (e.key === 'Escape') {
            if (e.currentTarget.value) rest.onChange?.({ ...e, target: { ...e.currentTarget, value: '' } } as unknown as React.ChangeEvent<HTMLInputElement>);
            else e.currentTarget.blur();
          }
        }}
      />
    </div>
  );
}
