import { forwardRef } from 'react';

/**
 * <Button variant="primary|secondary|ghost|danger" size="sm|md|lg"
 *         loading icon={<Icon/>} iconOnly aria-label="…">
 * iconOnly buttons MUST carry aria-label (warned in dev).
 * `as` renders another element (e.g. a router <Link>) with the same look.
 */
const Button = forwardRef(function Button(
  {
    variant = 'primary',
    size = 'md',
    loading = false,
    iconOnly = false,
    icon = null,
    block = false,
    as: Comp = 'button',
    type = 'button',
    disabled = false,
    className = '',
    children,
    ...rest
  },
  ref,
) {
  if (import.meta.env.DEV && iconOnly && !rest['aria-label'] && !rest['aria-labelledby']) {
    console.warn('[ui/Button] icon-only buttons need an aria-label.');
  }
  const cls = [
    'ui-btn',
    `ui-btn--${variant}`,
    `ui-btn--${size}`,
    iconOnly && 'ui-btn--icon',
    block && 'ui-btn--block',
    loading && 'is-loading',
    className,
  ].filter(Boolean).join(' ');

  const inactive = disabled || loading;
  // Non-button elements (e.g. as={Link}) can't be natively disabled: block
  // the click so a disabled link never navigates, and take it out of Tab order.
  const nativeProps = Comp === 'button'
    ? { type, disabled: inactive }
    : {
        'aria-disabled': inactive || undefined,
        tabIndex: inactive ? -1 : rest.tabIndex,
        onClick: inactive
          ? (e) => { e.preventDefault(); e.stopPropagation(); }
          : rest.onClick,
      };

  return (
    <Comp ref={ref} className={cls} aria-busy={loading || undefined} {...rest} {...nativeProps}>
      {loading && <span className="ui-btn__spinner" aria-hidden="true" />}
      {!loading && icon && <span className="ui-btn__icon" aria-hidden="true">{icon}</span>}
      {iconOnly
        ? (!loading && <span className="ui-btn__icon" aria-hidden="true">{children}</span>)
        : children}
    </Comp>
  );
});

export default Button;
