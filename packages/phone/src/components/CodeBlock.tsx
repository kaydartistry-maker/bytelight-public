import React, { useState } from 'react';
import { Copy, Check } from 'lucide-react';
import { cn } from '../lib/utils';
import { copyToClipboard } from '../lib/clipboard';

function extractText(children: React.ReactNode): string {
  if (children == null) return '';
  if (typeof children === 'string') return children;
  if (typeof children === 'number') return String(children);
  if (Array.isArray(children)) return children.map(extractText).join('');
  if (React.isValidElement(children)) return extractText((children.props as { children?: React.ReactNode }).children);
  return '';
}

interface CodeBlockProps {
  children?: React.ReactNode;
  className?: string;
}

export function CodeBlock({ children, className }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    const text = extractText(children);
    const ok = await copyToClipboard(text);
    if (ok) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    }
  };

  return (
    <span className="group relative my-2 block">
      <pre className={cn('overflow-auto rounded bg-black/30 p-2 pr-9 font-mono text-[12px]', className)}>
        {children}
      </pre>
      <button
        type="button"
        onClick={handleCopy}
        aria-label={copied ? 'Copied' : 'Copy code'}
        title={copied ? 'Copied' : 'Copy'}
        className="absolute right-1.5 top-1.5 flex h-7 w-7 items-center justify-center rounded bg-black/40 text-white/85 opacity-60 transition hover:bg-black/60 hover:opacity-100 group-hover:opacity-100 active:scale-95"
      >
        {copied ? <Check size={14} /> : <Copy size={14} />}
      </button>
    </span>
  );
}
