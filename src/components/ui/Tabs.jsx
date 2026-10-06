import { createContext, useContext, useId, useLayoutEffect, useRef } from 'react';

const TabsContext = createContext(null);

/**
 * Preferred: wrap the tab list and its panels in <TabGroup>; ids and the
 * selected value are shared, nothing is passed twice.
 *
 *   <TabGroup value={tab} onChange={setTab}>
 *     <Tabs tabs={[{ id, label, badge?, disabled? }]} ariaLabel="Report sections" />
 *     <TabPanel id="summary">…</TabPanel>
 *   </TabGroup>
 *
 * Standalone <Tabs value onChange idPrefix /> still works (props win over
 * the group). WAI-ARIA tabs: roving tabindex, ArrowLeft/Right, Home/End,
 * automatic activation.
 */
export function TabGroup({ value, onChange, idPrefix, children }) {
  const auto = useId();
  return (
    <TabsContext.Provider value={{ value, onChange, prefix: idPrefix || auto }}>
      {children}
    </TabsContext.Provider>
  );
}

export default function Tabs({ tabs, value: valueProp, onChange: onChangeProp, ariaLabel, idPrefix, className = '' }) {
  const group = useContext(TabsContext);
  const auto = useId();
  const prefix = idPrefix || group?.prefix || auto;
  const value = valueProp !== undefined ? valueProp : group?.value;
  const onChange = onChangeProp || group?.onChange || (() => {});
  const refs = useRef({});
  const listRef = useRef(null);
  const barRef = useRef(null);
  const placed = useRef(false);
  const enabled = tabs.filter((t) => !t.disabled);
  // If value matches no enabled tab, the first enabled one stays reachable by Tab.
  const tabbableId = enabled.some((t) => t.id === value) ? value : enabled[0]?.id;

  const onKeyDown = (e) => {
    if (!enabled.length) return;
    const i = enabled.findIndex((t) => t.id === document.activeElement?.dataset?.tabId);
    let next = null;
    if (e.key === 'ArrowRight') next = enabled[(i + 1) % enabled.length];
    else if (e.key === 'ArrowLeft') next = enabled[(i - 1 + enabled.length) % enabled.length];
    else if (e.key === 'Home') next = enabled[0];
    else if (e.key === 'End') next = enabled[enabled.length - 1];
    if (!next) return;
    e.preventDefault();
    onChange(next.id);
    refs.current[next.id]?.focus();
  };

  // Slide one indicator to the active tab with transform. The first
  // placement (and resizes) jump without animating.
  useLayoutEffect(() => {
    const bar = barRef.current;
    if (!bar) return undefined;
    const place = (instant) => {
      const tab = refs.current[value];
      bar.classList.toggle('is-instant', instant);
      if (!tab) { bar.style.setProperty('--ui-tab-w', '0'); return; }
      const inset = 8;
      bar.style.setProperty('--ui-tab-x', `${tab.offsetLeft + inset}px`);
      bar.style.setProperty('--ui-tab-w', String(Math.max(0, tab.offsetWidth - inset * 2)));
    };
    place(!placed.current);
    placed.current = true;
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => place(true)) : null;
    if (ro && listRef.current) ro.observe(listRef.current);
    return () => ro?.disconnect();
  }, [value, tabs.length]);

  return (
    <div ref={listRef} className={`ui-tabs ${className}`.trim()} role="tablist" aria-label={ariaLabel} onKeyDown={onKeyDown}>
      <span ref={barRef} className="ui-tabs__indicator" aria-hidden="true" />
      {tabs.map((t) => {
        const selected = t.id === value;
        return (
          <button
            key={t.id}
            ref={(el) => { refs.current[t.id] = el; }}
            type="button"
            role="tab"
            data-tab-id={t.id}
            id={`${prefix}-tab-${t.id}`}
            aria-selected={selected}
            aria-controls={`${prefix}-panel-${t.id}`}
            tabIndex={t.id === tabbableId ? 0 : -1}
            disabled={t.disabled}
            className={`ui-tab${selected ? ' is-active' : ''}`}
            onClick={() => onChange(t.id)}
          >
            {t.label}
            {t.badge != null && <span className="ui-tab__badge">{t.badge}</span>}
          </button>
        );
      })}
    </div>
  );
}

export function TabPanel({ id, value: valueProp, idPrefix, children, className = '' }) {
  const group = useContext(TabsContext);
  const value = valueProp !== undefined ? valueProp : group?.value;
  const prefix = idPrefix || group?.prefix;
  if (id !== value) return null;
  return (
    <div
      role="tabpanel"
      id={prefix ? `${prefix}-panel-${id}` : undefined}
      aria-labelledby={prefix ? `${prefix}-tab-${id}` : undefined}
      tabIndex={0}
      className={`ui-tabpanel ${className}`.trim()}
    >
      {children}
    </div>
  );
}
