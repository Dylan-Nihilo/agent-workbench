import { Button, Tooltip } from '@heroui/react';
import type { ComponentProps } from 'react';

/** Keeps toolbar sizing and accessible tooltips consistent across the workspace. */
export function ActionButton({
  className = '',
  title,
  variant,
  size = 'sm',
  ...props
}: ComponentProps<typeof Button> & { title?: string; tabIndex?: number }) {
  const classes = typeof className === 'string' ? className : '';
  const iconOnly = props.isIconOnly ?? /(?:icon-button|tab-close|send-button)/.test(classes);
  const button = (
    <Button
      {...props}
      className={className}
      size={size}
      isIconOnly={iconOnly}
      variant={
        variant ??
        (classes.includes('primary-button')
          ? 'primary'
          : classes.includes('secondary-button')
            ? 'secondary'
            : 'ghost')
      }
    />
  );
  const label = title || (iconOnly ? props['aria-label'] : undefined);
  return label ? (
    <Tooltip delay={500}>
      {button}
      <Tooltip.Content>{label}</Tooltip.Content>
    </Tooltip>
  ) : (
    button
  );
}
