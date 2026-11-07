import React from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { cn } from '../lib/utils';
import { ThemeConfig } from '../lib/theme';
import { ThemeMode } from '../types';

interface TypingIndicatorProps {
  themeConfig: ThemeConfig;
  themeMode: ThemeMode;
}

export function TypingIndicator({ themeConfig, themeMode }: TypingIndicatorProps) {
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
      {/* BL's typing dots, numbers verbatim from main (+page.svelte
          .typing-dot / typingBounce): bare dots, no bubble chrome, 0.3rem,
          1.4s ease-in-out cycle, 0.2s stagger, -0.375rem lift, 0.4→1 fade. */}
      <div className={cn("flex gap-[0.35rem] items-center px-3 py-1", colors.textMuted)}>
        {[0, 1, 2].map((i) => (
          <motion.div
            key={i}
            animate={reduceMotion ? {} : {
              y: [0, -6, 0],
              opacity: [0.4, 1, 0.4]
            }}
            transition={reduceMotion ? {} : {
              duration: 1.4,
              repeat: Infinity,
              delay: i * 0.2,
              ease: "easeInOut"
            }}
            className="w-[0.3rem] h-[0.3rem] rounded-full"
            style={{ backgroundColor: 'currentColor', opacity: reduceMotion ? 0.7 : undefined }}
          />
        ))}
      </div>
    </motion.div>
  );
}
