import React, { useState } from 'react';

/**
 * Like a normal <input> but shows its value as plain text while focused
 * (so you can verify the API key / token / password you're pasting in)
 * and masks it as type="password" once focus leaves. No save button is
 * built in — every caller already has its own save flow (button or
 * auto-save); this component is only about reveal-while-typing.
 */
export function SecretInput(props: Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'>) {
  const [focused, setFocused] = useState(false);
  const { onFocus, onBlur, ...rest } = props;
  return (
    <input
      {...rest}
      type={focused ? 'text' : 'password'}
      autoComplete="off"
      autoCorrect="off"
      autoCapitalize="off"
      spellCheck={false}
      onFocus={(e) => {
        setFocused(true);
        onFocus?.(e);
      }}
      onBlur={(e) => {
        setFocused(false);
        onBlur?.(e);
      }}
    />
  );
}
