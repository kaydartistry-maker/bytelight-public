import { cn } from '../lib/utils';
import type { ThemeConfig } from '../lib/theme';

type ThemeMode = 'light' | 'dark';

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost';
  size?: 'sm' | 'md' | 'lg';
  colors: ThemeConfig[ThemeMode];
  children: React.ReactNode;
}

export function Button({
  variant = 'secondary',
  size = 'md',
  colors,
  className,
  style,
  children,
  ...props
}: ButtonProps) {
  const sizeClasses = {
    sm: 'px-2 py-1 text-xs',
    md: 'px-3 py-1.5 text-xs',
    lg: 'px-4 py-2.5 text-sm',
  };

  const baseClasses = 'rounded-xl font-semibold transition-colors disabled:opacity-50';

  if (variant === 'primary') {
    return (
      <button
        className={cn(baseClasses, sizeClasses[size], className)}
        style={{ backgroundColor: colors.accent, color: 'var(--bytelight-on-accent)', ...style }}
        {...props}
      >
        {children}
      </button>
    );
  }

  if (variant === 'ghost') {
    return (
      <button
        className={cn(baseClasses, sizeClasses[size], colors.textMuted, 'hover:opacity-80', className)}
        style={style}
        {...props}
      >
        {children}
      </button>
    );
  }

  // secondary (default)
  return (
    <button
      className={cn(baseClasses, sizeClasses[size], 'border', colors.panelBorder, colors.textMain, className)}
      style={style}
      {...props}
    >
      {children}
    </button>
  );
}
