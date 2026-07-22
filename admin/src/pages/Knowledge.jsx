import { useState, useEffect, useCallback } from 'react';
import { useAuth, useToast } from '../contexts.jsx';

const BLANK = { id: '', question: '', answer: '', keywords: '', language: 'both', active: true };

function TeachForm({ draft, setDraft, onSave }) {
  const editing = !!draft.id;
  const seeded = draft._seeded;
  const set = (k, v) => setDraft((d) => ({ ...d, [k]: v }));
  return (
    <div className="card pad fade" style={{ marginBottom: 20 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <strong style={{ fontSize: 15 }}>{seeded ? 'Teach the bot (from a real chat)' : editing ? 'Edit answer' : 'Add a new answer'}</strong>
        {(editing || seeded) && <button className="btn ghost sm" onClick={() => setDraft({ ...BLANK })}>Cancel</button>}
      </div>
      <label>Customer question <span className="hint">— an example of what they might ask</span></label>
      <input value={draft.question} placeholder="e.g. Do you deliver to Sri Lanka?" onChange={(e) => set('question', e.target.value)} />
      <label>Correct answer <span className="hint">— exactly what the bot should reply</span></label>
      <textarea value={draft.answer} placeholder="Write the reply the bot should give…" onChange={(e) => set('answer', e.target.value)} />
      <div className="row2">
        <div>
          <label>Trigger keywords <span className="hint">— comma separated</span></label>
          <input value={draft.keywords} placeholder="sri lanka, international, abroad" onChange={(e) => set('keywords', e.target.value)} />
        </div>
        <div>
          <label>Language</label>
          <select value={draft.language} onChange={(e) => set('language', e.target.value)}>
            <option value="both">Both (English + Tanglish)</option>
            <option value="english">English only</option>
            <option value="tanglish">Tanglish only</option>
          </select>
        </div>
      </div>
      <label className="check-lbl">
        <input type="checkbox" checked={draft.active} onChange={(e) => set('active', e.target.checked)} />
        Active (bot uses this answer)
      </label>
      <button className="btn gold" style={{ marginTop: 16 }} onClick={onSave}>💾 Save answer</button>
    </div>
  );
}

function isNeedsAnswer(e) {
  return e.source === 'auto' && !(e.answer && e.answer.trim());
}

function EntryCard({ e, onEdit, onDelete, onDismiss }) {
  const needs = isNeedsAnswer(e);
  return (
    <div className={'entry fade' + (needs ? ' need' : '')}>
      <h4>{e.question || <span style={{ color: 'var(--faint)' }}>(no question text)</span>}</h4>
      {needs
        ? <div className="noanswer">⚠️ The bot couldn't answer this — click <strong>Answer</strong> to teach the right reply.</div>
        : <div className="ans">{e.answer}</div>}
      <div className="chips">
        {needs && <span className="chip need">needs answer</span>}
        {needs && e.hits > 1 && <span className="chip">asked {e.hits}×</span>}
        {(e.keywords || []).map((k, i) => <span className="chip" key={i}>{k}</span>)}
        <span className="chip lang">{e.language || 'both'}</span>
        {e.source === 'correction' && <span className="chip src">from a real chat</span>}
        {e.source === 'auto' && !needs && <span className="chip src">auto-found</span>}
        {e.active === false && !needs && <span className="chip off">inactive</span>}
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button className={'btn sm' + (needs ? ' gold' : ' ghost')} onClick={() => onEdit(e)}>{needs ? '✏️ Answer' : 'Edit'}</button>
        {needs
          ? <button className="btn danger sm" onClick={() => onDismiss(e.id)}>Dismiss</button>
          : <button className="btn danger sm" onClick={() => onDelete(e.id)}>Delete</button>}
      </div>
    </div>
  );
}

function TeachTab({ draft, setDraft }) {
  const { api } = useAuth();
  const toast = useToast();
  const [entries, setEntries] = useState(null);

  const load = useCallback(async () => {
    try {
      const list = await api('/api/knowledge');
      // Surface "needs answer" drafts at the top so the owner acts on them first.
      list.sort((a, b) => (isNeedsAnswer(b) ? 1 : 0) - (isNeedsAnswer(a) ? 1 : 0));
      setEntries(list);
    } catch (e) { toast(e.message, true); }
  }, [api, toast]);

  useEffect(() => {
    // Refresh the auto-diagnosis queue when the tab opens (no owner alert — that's the
    // scheduler's job), then load the list including any newly-queued drafts.
    (async () => {
      try { await api('/api/knowledge/diagnose', { method: 'POST', body: '{}' }); } catch { /* non-fatal */ }
      load();
    })();
  }, [api, load]);

  const save = async () => {
    if (!draft.answer.trim()) return toast('Please write an answer.', true);
    try {
      await api('/api/knowledge', {
        method: 'POST',
        body: JSON.stringify({
          id: draft.id || undefined,
          question: draft.question.trim(),
          answer: draft.answer.trim(),
          keywords: draft.keywords,
          language: draft.language,
          active: draft.active,
          source: draft.id ? undefined : 'manual',
        }),
      });
      toast('Saved! The bot will use this now.');
      setDraft({ ...BLANK });
      load();
    } catch (e) { toast(e.message, true); }
  };

  const del = async (id) => {
    if (!confirm('Delete this answer? The bot will stop using it.')) return;
    try { await api('/api/knowledge/' + id, { method: 'DELETE' }); toast('Deleted.'); load(); }
    catch (e) { toast(e.message, true); }
  };

  const dismiss = async (id) => {
    if (!confirm('Dismiss this question for good? It won\'t be suggested again.')) return;
    try { await api('/api/knowledge/' + id + '/dismiss', { method: 'POST', body: '{}' }); toast('Dismissed — it won\'t come back.'); load(); }
    catch (e) { toast(e.message, true); }
  };

  const edit = (e) => {
    // Answering an auto-draft should default to Active so it goes live once saved.
    setDraft({
      id: e.id, question: e.question || '', answer: e.answer || '',
      keywords: (e.keywords || []).join(', '), language: e.language || 'both',
      active: isNeedsAnswer(e) ? true : e.active !== false,
      _seeded: isNeedsAnswer(e),
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  return (
    <div>
      <TeachForm draft={draft} setDraft={setDraft} onSave={save} />
      <div className="section-head">
        <strong style={{ fontSize: 15 }}>Saved answers</strong>
        <span className="count">{entries ? entries.length : '…'}</span>
      </div>
      {entries === null ? <div className="empty">Loading…</div>
        : entries.length === 0 ? <div className="empty">No answers yet. Add your first one above ☝️</div>
        : entries.map((e) => <EntryCard key={e.id} e={e} onEdit={edit} onDelete={del} onDismiss={dismiss} />)}
    </div>
  );
}

function ReviewTab({ onTeach }) {
  const { api } = useAuth();
  const toast = useToast();
  const [data, setData] = useState(null);

  useEffect(() => {
    (async () => {
      try { setData(await api('/api/knowledge/review')); }
      catch (e) { toast(e.message, true); setData({ flagged: [] }); }
    })();
  }, [api, toast]);

  return (
    <div className="fade">
      <div className="card pad" style={{ marginBottom: 16 }}>
        <strong style={{ fontSize: 15 }}>Conversations that may need attention</strong>
        <p style={{ color: 'var(--muted)', margin: '6px 0 0', fontSize: 13.5 }}>
          These chats show a sign of trouble (an error reply, a repeated question, or an abandoned cart).
          Read one, then click <em>"Teach the right answer"</em> — the bot will use your answer next time.
        </p>
      </div>
      {data === null ? <div className="empty">Loading…</div>
        : data.flagged.length === 0 ? <div className="empty">✅ Nothing looks broken right now.</div>
        : data.flagged.map((f) => {
            const lastUser = [...f.lastTurns].reverse().find((t) => t.role === 'user');
            return (
              <div className="entry flag fade" key={f.id}>
                <h4>{f.name} <span style={{ color: 'var(--muted)', fontWeight: 400 }}>· {String(f.phone)}</span></h4>
                <div className="reasons">{f.reasons.map((r, i) => <span className="reason" key={i}>{r}</span>)}</div>
                {f.lastTurns.map((t, i) => (
                  <div className={'turn' + (t.role === 'user' ? '' : ' bot')} key={i}>
                    <span className="who">{t.role === 'user' ? '👤' : '🤖'}</span><span>{t.content}</span>
                  </div>
                ))}
                <div style={{ marginTop: 10 }}>
                  <button className="btn gold sm" onClick={() => onTeach(lastUser ? lastUser.content : '')}>✏️ Teach the right answer</button>
                </div>
              </div>
            );
          })}
    </div>
  );
}

export default function Knowledge() {
  const [sub, setSub] = useState('teach');
  const [draft, setDraft] = useState({ ...BLANK });

  const teachFrom = (q) => {
    const kw = (q || '')
      .toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/)
      .filter((w) => w.length > 3).slice(0, 5).join(', ');
    setDraft({ ...BLANK, question: q || '', keywords: kw, _seeded: true });
    setSub('teach');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  return (
    <div className="fade">
      <div className="section-head">
        <p>Teach the bot the right answers, or fix real mistakes. Changes go live instantly — no restart needed.</p>
      </div>
      <div className="subtabs">
        <button className={'subtab' + (sub === 'teach' ? ' active' : '')} onClick={() => setSub('teach')}>📚 Teach the bot</button>
        <button className={'subtab' + (sub === 'review' ? ' active' : '')} onClick={() => setSub('review')}>🔎 Review mistakes</button>
      </div>
      {sub === 'teach' ? <TeachTab draft={draft} setDraft={setDraft} /> : <ReviewTab onTeach={teachFrom} />}
    </div>
  );
}
