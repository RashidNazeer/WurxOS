/**
 * <PageHeader title subtitle actions={<…/>} breadcrumbs={<…/>} />
 * One <h1> per page; actions wrap under the title on narrow screens.
 */
export default function PageHeader({ title, subtitle, actions, breadcrumbs, as: Heading = 'h1', className = '' }) {
  return (
    <header className={`ui-page-header ${className}`.trim()}>
      {breadcrumbs && <nav className="ui-page-header__crumbs" aria-label="Breadcrumb">{breadcrumbs}</nav>}
      <div className="ui-page-header__row">
        <div className="ui-page-header__text">
          <Heading className="ui-page-header__title">{title}</Heading>
          {subtitle && <p className="ui-page-header__subtitle">{subtitle}</p>}
        </div>
        {actions && <div className="ui-page-header__actions">{actions}</div>}
      </div>
    </header>
  );
}
