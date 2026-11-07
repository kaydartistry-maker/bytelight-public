# Bytelight UI Components

Shared UI components for consistent styling across all phone apps.

## Usage

```tsx
import { Button, SegmentedControl } from '../ui';
```

## Components

### Button

Standard button with three variants.

```tsx
<Button variant="primary" size="md" colors={colors}>
  Save
</Button>

<Button variant="secondary" size="md" colors={colors}>
  Cancel
</Button>

<Button variant="ghost" size="sm" colors={colors}>
  Skip
</Button>
```

**Variants:**
- `primary` — accent background, white/black text (uses `--bytelight-on-accent`)
- `secondary` — transparent with border, theme text color
- `ghost` — no background/border, muted text

**Sizes:**
- `sm` — `px-2 py-1 text-xs`
- `md` — `px-3 py-1.5 text-xs`
- `lg` — `px-4 py-2.5 text-sm`

### SegmentedControl

Pill-style tab selector matching the pattern used in Agent, Integrations, Settings, etc.

```tsx
<SegmentedControl
  options={[
    { value: 'discord', label: 'Discord Emoji' },
    { value: 'sticker', label: 'Sticker' },
    { value: '64px', label: '64px' },
  ]}
  value={selectedSize}
  onChange={setSelectedSize}
  colors={colors}
/>
```

## Style Rules

1. **Accent text on accent background**: Always use `color: 'var(--bytelight-on-accent)'`, never hardcode `#000` or `#fff`
2. **All text on panels**: Never place text directly on `pageBg` — users have custom backgrounds. Wrap content in panels:
   ```tsx
   <div className={cn("p-4 rounded-2xl border backdrop-blur-md", colors.panelBg, colors.panelBorder)}>
     <span className={colors.textMain}>Readable text</span>
   </div>
   ```
3. **Border radius**: `rounded-lg` for inline controls, `rounded-xl` for standalone buttons, `rounded-2xl` for panels
4. **Gap spacing**: `gap-1.5` for segmented controls, `gap-2` for button groups
5. **Font weight**: `font-medium` for tabs/pills, `font-semibold` for action buttons
