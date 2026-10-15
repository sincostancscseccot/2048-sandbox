import type { Condition, RuleDefinition } from '../domain/types';
import { conditionOperators, conditionSources, describeCondition } from '../domain/editor';

export const defaultCondition = (): Condition => ({ kind: 'compare', source: 'round', reference: null, operator: 'gte', value: '1' });
export function ConditionEditor({ value, onChange, definition, label, depth = 0, nullable = true }: {
  value: Condition | null; onChange: (value: Condition | null) => void; definition: RuleDefinition; label: string; depth?: number; nullable?: boolean;
}) {
  return <div className="condition-editor"><label className="field-label">{label}条件<select value={value?.kind ?? 'always'} onChange={event => {
    const kind = event.target.value;
    onChange(kind === 'always' ? null : kind === 'compare' ? defaultCondition() : kind === 'not' ? { kind, child: value ?? defaultCondition() } : { kind: kind as 'all' | 'any', children: [value ?? defaultCondition()] });
  }}>
    {nullable && <option value="always">总是满足</option>}<option value="compare">数值比较</option>
    <option value="all" disabled={depth >= 15}>全部满足（且）</option><option value="any" disabled={depth >= 15}>任一满足（或）</option><option value="not" disabled={depth >= 15}>不满足（非）</option>
  </select></label>
    {depth === 0 && <p className="condition-summary" aria-live="polite">{describeCondition(value, definition)}</p>}
    {value?.kind === 'compare' && <div className="condition-fields">
      <label className="field-label">{label}比较字段<select value={value.source} onChange={event => { const source = event.target.value as typeof value.source; onChange({ ...value, source, reference: source === 'variable' ? Object.keys(definition.variables)[0] ?? '' : source === 'event-count' ? definition.events[0]?.id ?? '' : null }); }}>
        {Object.entries(conditionSources).map(([key, name]) => <option key={key} value={key}>{name}</option>)}
      </select></label>
      {(value.source === 'variable' || value.source === 'event-count') && <label className="field-label">{label}引用<select value={value.reference ?? ''} onChange={event => onChange({ ...value, reference: event.target.value })}>
        <option value="">请选择</option>{value.source === 'variable' ? Object.keys(definition.variables).map(key => <option key={key} value={key}>{key}</option>) : definition.events.map(event => <option key={event.id} value={event.id}>{event.name}</option>)}
      </select></label>}
      <label className="field-label">{label}比较方式<select value={value.operator} onChange={event => onChange({ ...value, operator: event.target.value as typeof value.operator })}>{Object.entries(conditionOperators).map(([key, name]) => <option key={key} value={key}>{name}</option>)}</select></label>
      <label className="field-label">{label}比较值<input value={value.value} onChange={event => onChange({ ...value, value: event.target.value })} /></label>
    </div>}
    {(value?.kind === 'all' || value?.kind === 'any') && <div className="condition-children">{value.children.map((child, index) => <div key={index}>
      <ConditionEditor label={`${label}子项${index + 1}`} value={child} onChange={next => onChange({ ...value, children: value.children.map((item, i) => i === index ? next ?? defaultCondition() : item) })} definition={definition} depth={depth + 1} nullable={false} />
      <button type="button" disabled={value.children.length <= 1} onClick={() => onChange({ ...value, children: value.children.filter((_, i) => i !== index) })}>移除此条件</button>
    </div>)}<button type="button" disabled={depth >= 15 || value.children.length >= 64} onClick={() => onChange({ ...value, children: [...value.children, defaultCondition()] })}>添加子条件</button></div>}
    {value?.kind === 'not' && <ConditionEditor label={`${label}取反`} value={value.child} onChange={next => onChange({ ...value, child: next ?? defaultCondition() })} definition={definition} depth={depth + 1} nullable={false} />}
  </div>;
}
