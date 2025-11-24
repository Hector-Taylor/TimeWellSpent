import { useEffect, useState, type FormEvent } from 'react';
import type { Budget, RendererApi } from '@shared/types';

interface BudgetsProps {
  api: RendererApi;
}

export default function Budgets({ api }: BudgetsProps) {
  const [list, setList] = useState<Budget[]>([]);
  const [period, setPeriod] = useState<'day' | 'week'>('day');
  const [category, setCategory] = useState('Social');
  const [minutes, setMinutes] = useState(60);

  useEffect(() => {
    api.budgets.list().then(setList);
  }, [api]);

  async function addBudget(event: FormEvent) {
    event.preventDefault();
    const seconds = minutes * 60;
    const record = await api.budgets.add({ period, category, secondsBudgeted: seconds });
    setList((prev) => [...prev, record]);
  }

  async function remove(id: number) {
    await api.budgets.remove(id);
    setList((prev) => prev.filter((item) => item.id !== id));
  }

  return (
    <section className="panel">
      <header className="panel-header">
        <div>
          <h1>Budgets</h1>
          <p className="subtle">Allocate intentional time for categories.</p>
        </div>
      </header>

      <form className="budget-form" onSubmit={addBudget}>
        <label>
          Period
          <select value={period} onChange={(event) => setPeriod(event.target.value as 'day' | 'week')}>
            <option value="day">Day</option>
            <option value="week">Week</option>
          </select>
        </label>
        <label>
          Category
          <input value={category} onChange={(event) => setCategory(event.target.value)} />
        </label>
        <label>
          Minutes
          <input
            type="number"
            min={10}
            value={minutes}
            onChange={(event) => setMinutes(Number(event.target.value))}
          />
        </label>
        <button className="primary" type="submit">
          Add budget
        </button>
      </form>

      <ul className="budgets-list">
        {list.map((item) => (
          <li key={item.id}>
            <div>
              <strong>{item.category}</strong>
              <span className="subtle">{item.period} • {Math.round(item.secondsBudgeted / 60)} min</span>
            </div>
            <button className="ghost" onClick={() => remove(item.id)}>
              ✕
            </button>
          </li>
        ))}
        {list.length === 0 && <li className="subtle">No budgets yet.</li>}
      </ul>
    </section>
  );
}
