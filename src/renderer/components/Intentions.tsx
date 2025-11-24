import { useEffect, useState, type FormEvent } from 'react';
import type { Intention, RendererApi } from '@shared/types';

interface IntentionsProps {
  api: RendererApi;
}

export default function Intentions({ api }: IntentionsProps) {
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [list, setList] = useState<Intention[]>([]);
  const [draft, setDraft] = useState('');

  useEffect(() => {
    api.intentions.list(date).then(setList);
  }, [api, date]);

  async function addIntention(event: FormEvent) {
    event.preventDefault();
    if (!draft.trim()) return;
    const record = await api.intentions.add({ date, text: draft.trim() });
    setList((prev) => [...prev, record]);
    setDraft('');
  }

  async function toggle(id: number, completed: boolean) {
    await api.intentions.toggle(id, completed);
    setList((prev) => prev.map((item) => (item.id === id ? { ...item, completed } : item)));
  }

  async function remove(id: number) {
    await api.intentions.remove(id);
    setList((prev) => prev.filter((item) => item.id !== id));
  }

  return (
    <section className="panel">
      <header className="panel-header">
        <div>
          <h1>Intentions</h1>
          <p className="subtle">Set daily intentions and close them with a click.</p>
        </div>
        <input type="date" value={date} onChange={(event) => setDate(event.target.value)} />
      </header>

      <form className="intentions-form" onSubmit={addIntention}>
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Add intention"
        />
        <button className="primary" type="submit">
          Add
        </button>
      </form>

      <ul className="intentions-list">
        {list.map((item) => (
          <li key={item.id} className={item.completed ? 'completed' : ''}>
            <label>
              <input
                type="checkbox"
                checked={item.completed}
                onChange={(event) => toggle(item.id, event.target.checked)}
              />
              <span>{item.text}</span>
            </label>
            <button className="ghost" onClick={() => remove(item.id)}>
              ✕
            </button>
          </li>
        ))}
        {list.length === 0 && <li className="subtle">No intentions yet.</li>}
      </ul>
    </section>
  );
}
