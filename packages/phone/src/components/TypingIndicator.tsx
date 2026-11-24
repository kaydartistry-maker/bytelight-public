import { ThinkingSpark } from './ThinkingSpark';
import React from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { cn } from '../lib/utils';
import { ThemeConfig } from '../lib/theme';
import { ThemeMode } from '../types';

interface TypingIndicatorProps {
  label?: string;
  themeConfig: ThemeConfig;
  themeMode: ThemeMode;
}

export function TypingIndicator({ themeConfig, themeMode, label = 'Thinking' }: TypingIndicatorProps) {
  const colors = themeConfig[themeMode];
  const reduceMotion = useReducedMotion();

  return (
    <motion.div
      initial={reduceMotion ? false : { opacity: 0, y: 10, scale: 0.95 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, scale: 0.95 }}
      transition={{ duration: reduceMotion ? 0 : 0.2 }}
      className="flex justify-start mb-6"
    >
      <div className={cn("flex items-center px-3 py-1", colors.textMuted)} role="status" aria-label={label}>
        <ThinkingSpark />
      </div>
    </motion.div>
  );
}
