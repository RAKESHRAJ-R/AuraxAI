import { useState, useEffect, useCallback } from 'react';
import { useAuth, useToast } from '../contexts.jsx';
import { apiUrl } from '../api.js';

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

function EntryCard({ e, onEdit, onDelete, onDismiss, canEdit }) {
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
      {canEdit && (
        <div style={{ display: 'flex', gap: 8 }}>
          <button className={'btn sm' + (needs ? ' gold' : ' ghost')} onClick={() => onEdit(e)}>{needs ? '✏️ Answer' : 'Edit'}</button>
          {needs
            ? <button className="btn danger sm" onClick={() => onDismiss(e.id)}>Dismiss</button>
            : <button className="btn danger sm" onClick={() => onDelete(e.id)}>Delete</button>}
        </div>
      )}
    </div>
  );
}

function TeachTab({ draft, setDraft }) {
  const { api, can } = useAuth();
  const canEdit = can('knowledge.edit');
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
    // Diagnosis writes drafts, so only roles that can edit run it; the 30-min scheduler covers everyone else.
    (async () => {
      if (canEdit) {
        try { await api('/api/knowledge/diagnose', { method: 'POST', body: '{}' }); } catch { /* non-fatal */ }
      }
      load();
    })();
  }, [api, load, canEdit]);

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
      {canEdit
        ? <TeachForm draft={draft} setDraft={setDraft} onSave={save} />
        : <div className="view-only">👀 <strong>View only.</strong> Your role can see the bot's answers but can't change them.</div>}
      <div className="section-head">
        <strong style={{ fontSize: 15 }}>Saved answers</strong>
        <span className="count">{entries ? entries.length : '…'}</span>
      </div>
      {entries === null ? <div className="empty">Loading…</div>
        : entries.length === 0 ? <div className="empty">No answers yet. Add your first one above ☝️</div>
        : entries.map((e) => <EntryCard key={e.id} e={e} onEdit={edit} onDelete={del} onDismiss={dismiss} canEdit={canEdit} />)}
    </div>
  );
}

function fmtBytes(n) {
  if (!n) return '0 KB';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / (1024 * 1024)).toFixed(2) + ' MB';
}

/**
 * How a document sits in the Rule Book (apps/bot/src/services/rules.js). The document is split
 * into rule cards by code — no AI, nothing summarised — and the cards are managed on the
 * Rule book tab.
 */
function DocRulesPanel({ s, canManage, onChanged, onOpenBook }) {
  const { api } = useAuth();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const rb = s.ruleBook;

  const reread = async () => {
    setBusy(true);
    try {
      const r = await api(`/api/knowledge/sources/${s.id}/rules/regenerate`, { method: 'POST', body: '{}' });
      toast(ruleSummaryText(r.ruleBook));
      onChanged();
    } catch (e) { toast(e.message, true); }
    finally { setBusy(false); }
  };

  return (
    <div style={{ margin: '8px 0' }}>
      <div className="chips">
        {rb
          ? <span className="chip lang">📋 {rb.cards} rule{rb.cards === 1 ? '' : 's'} in the Rule book{s.active === false ? ' (turned off)' : ''}</span>
          : <span className="chip">📋 not in the Rule book yet</span>}
        {rb?.missing > 0 && <span className="chip need" title="Rules the previous version had and this one does not — still used until you decide">{rb.missing} to review</span>}
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button className="btn ghost sm" onClick={onOpenBook}>Open Rule book</button>
        {canManage && <button className="btn ghost sm" disabled={busy} onClick={reread}>{busy ? 'Reading…' : rb ? 'Re-read document' : 'Add to Rule book'}</button>}
      </div>
    </div>
  );
}

function ruleSummaryText(sum) {
  if (!sum) return 'Done.';
  const parts = [`${sum.cards} rules`];
  if (sum.added) parts.push(`${sum.added} new`);
  if (sum.changed) parts.push(`${sum.changed} changed`);
  if (sum.unchanged) parts.push(`${sum.unchanged} unchanged`);
  if (sum.missing) parts.push(`${sum.missing} missing from this version — check them on the Rule book tab`);
  return `Rule book updated: ${parts.join(', ')}.`;
}

const splitWords = (v) => String(v || '').split(',').map((w) => w.trim()).filter(Boolean);

function RuleCard({ c, topics, canManage, onChanged, onTeach }) {
  const { api } = useAuth();
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(c.text);
  const [tags, setTags] = useState((c.topics || []).join(', '));
  const [always, setAlways] = useState(!!c.always);
  const [showOld, setShowOld] = useState(false);
  const label = (k) => topics.find((t) => t.key === k)?.label || k;
  const missing = c.status === 'missing';

  const call = async (fn, msg) => {
    try { await fn(); if (msg) toast(msg); onChanged(); return true; }
    catch (e) { toast(e.message, true); return false; }
  };
  const put = (body, msg) => call(() => api(`/api/rulebook/cards/${c.id}`, { method: 'PUT', body: JSON.stringify(body) }), msg);
  const save = async () => {
    if (await put({ text, topics: splitWords(tags), always }, 'Rule saved — the bot uses it from the next message.')) setEditing(false);
  };
  const resolve = (action) => {
    if (action === 'remove' && !confirm('Remove this rule? The bot will stop following it.')) return;
    call(() => api(`/api/rulebook/cards/${c.id}/resolve`, { method: 'POST', body: JSON.stringify({ action }) }),
      action === 'remove' ? 'Rule removed.' : 'Kept — later versions of the document will not touch it.');
  };
  const del = () => {
    if (!confirm('Delete this rule?')) return;
    call(() => api(`/api/rulebook/cards/${c.id}`, { method: 'DELETE' }), 'Deleted.');
  };
  const cancel = () => { setEditing(false); setText(c.text); setTags((c.topics || []).join(', ')); setAlways(!!c.always); };

  return (
    <div className={'entry fade' + (missing ? ' need' : '')}>
      <h4>{c.heading}</h4>
      {missing && <div className="noanswer">⚠️ The newest version of <strong>{c.docTitle}</strong> no longer has this rule. The bot still follows it until you choose Keep or Remove.</div>}
      {editing ? (
        <div>
          <textarea value={text} rows={Math.min(14, Math.max(4, text.split('\n').length + 1))} style={{ width: '100%', fontFamily: 'inherit' }} onChange={(e) => setText(e.target.value)} />
          <label>Topics <span className="hint">— comma separated: {topics.map((t) => t.key).join(', ')}</span></label>
          <input value={tags} onChange={(e) => setTags(e.target.value)} />
          <label className="check-lbl">
            <input type="checkbox" checked={always} onChange={(e) => setAlways(e.target.checked)} />
            Use in every reply (tone, language, never-do rules) — costs a little on every message
          </label>
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button className="btn gold sm" onClick={save}>Save</button>
            <button className="btn ghost sm" onClick={cancel}>Cancel</button>
          </div>
        </div>
      ) : <div className="ans" style={{ whiteSpace: 'pre-wrap' }}>{c.text}</div>}
      {showOld && c.previousText && <div className="ans" style={{ whiteSpace: 'pre-wrap', opacity: 0.7 }}><strong>Before:</strong>{'\n'}{c.previousText}</div>}
      <div className="chips">
        <span className="chip src">{c.manual && !c.docKey ? 'added by hand' : c.docTitle}</span>
        {c.always
          ? <span className="chip lang" title="Sent with every reply">every reply</span>
          : (c.topics || []).map((t) => <span className="chip" key={t}>{label(t)}</span>)}
        {c.fresh && !missing && <span className="chip need" title="New or changed by the latest upload">{c.previousText ? 'changed' : 'new'}</span>}
        {c.manual && c.docKey && <span className="chip">kept by hand</span>}
        {c.edited && <span className="chip">edited</span>}
        {c.active === false && <span className="chip off">off</span>}
        {c.active !== false && !c.inForce && <span className="chip off">document turned off</span>}
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {c.previousText && <button className="btn ghost sm" onClick={() => setShowOld(!showOld)}>{showOld ? 'Hide old text' : 'What changed?'}</button>}
        {canManage && missing && <>
          <button className="btn gold sm" onClick={() => resolve('keep')}>Keep</button>
          <button className="btn danger sm" onClick={() => resolve('remove')}>Remove</button>
        </>}
        {canManage && !editing && <button className="btn ghost sm" onClick={() => setEditing(true)}>Edit</button>}
        {canManage && c.fresh && !missing && <button className="btn ghost sm" onClick={() => put({ reviewed: true })}>Looks right</button>}
        {canManage && <button className="btn ghost sm" onClick={() => put({ active: c.active === false }, c.active === false ? 'Rule turned on.' : 'Rule turned off.')}>{c.active === false ? 'Turn on' : 'Turn off'}</button>}
        {onTeach && <button className="btn ghost sm" title="A quick answer is sent as written, with no AI call" onClick={() => onTeach(c)}>⚡ Make a quick answer</button>}
        {canManage && c.manual && !missing && <button className="btn danger sm" onClick={del}>Delete</button>}
      </div>
    </div>
  );
}

function TopicWords({ topics, canManage, onChanged }) {
  const { api } = useAuth();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [drafts, setDrafts] = useState({});
  const [newKey, setNewKey] = useState('');
  const [newWords, setNewWords] = useState('');

  const save = async (key, words, label) => {
    try {
      await api(`/api/rulebook/topics/${encodeURIComponent(key)}`, { method: 'PUT', body: JSON.stringify({ words: splitWords(words), label }) });
      toast('Saved — messages match the new words straight away.');
      onChanged();
    } catch (e) { toast(e.message, true); }
  };

  return (
    <div className="card pad fade" style={{ marginBottom: 20 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <strong style={{ fontSize: 15 }}>🔤 Topic words</strong>
        <button className="btn ghost sm" onClick={() => setOpen(!open)}>{open ? 'Hide' : 'Show'}</button>
      </div>
      <p className="hint" style={{ margin: '4px 0 0' }}>
        How the bot knows which rules a message is about. If customers ask in their own words and the bot misses the rule, add those words here.
      </p>
      {open && <div style={{ marginTop: 12 }}>
        {topics.map((t) => (
          <div key={t.key} style={{ marginBottom: 12 }}>
            <strong>{t.label}</strong> <span className="hint">({t.key})</span>
            <div className="hint" style={{ margin: '2px 0 6px' }}>{t.words.filter((w) => !(t.extra || []).includes(w)).join(', ')}</div>
            {canManage && <div style={{ display: 'flex', gap: 8 }}>
              <input
                value={drafts[t.key] ?? (t.extra || []).join(', ')}
                placeholder="your extra words, comma separated"
                onChange={(e) => setDrafts({ ...drafts, [t.key]: e.target.value })}
              />
              <button className="btn ghost sm" onClick={() => save(t.key, drafts[t.key] ?? (t.extra || []).join(', '), t.label)}>Save</button>
            </div>}
          </div>
        ))}
        {canManage && <div className="row2" style={{ marginTop: 8 }}>
          <div><label>New topic</label><input value={newKey} placeholder="e.g. Offers" onChange={(e) => setNewKey(e.target.value)} /></div>
          <div><label>Its words</label><input value={newWords} placeholder="offer, sale, diwali" onChange={(e) => setNewWords(e.target.value)} /></div>
        </div>}
        {canManage && <button className="btn ghost sm" style={{ marginTop: 8 }} disabled={!newKey.trim()} onClick={() => { save(newKey.trim(), newWords, newKey.trim()); setNewKey(''); setNewWords(''); }}>Add topic</button>}
      </div>}
    </div>
  );
}

function RuleBookTab({ onTeach }) {
  const { api, can } = useAuth();
  const canManage = can('knowledge.sources');
  const canTeach = can('knowledge.edit');
  const toast = useToast();
  const [data, setData] = useState(null);
  const [topic, setTopic] = useState('');
  const [filter, setFilter] = useState('all');
  const [q, setQ] = useState('');
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ heading: '', text: '', topics: '', always: false });

  const load = useCallback(async () => {
    try { setData(await api('/api/rulebook')); }
    catch (e) { toast(e.message, true); setData({ cards: [], topics: [], faqOff: [], stats: {} }); }
  }, [api, toast]);
  useEffect(() => { load(); }, [load]);

  const add = async () => {
    try {
      await api('/api/rulebook/cards', { method: 'POST', body: JSON.stringify({ ...draft, topics: splitWords(draft.topics) }) });
      toast('Rule added — the bot uses it from the next message.');
      setDraft({ heading: '', text: '', topics: '', always: false });
      setAdding(false);
      load();
    } catch (e) { toast(e.message, true); }
  };

  if (!data) return <div className="empty">Loading…</div>;
  const st = data.stats || {};
  const needle = q.trim().toLowerCase();
  const shown = data.cards.filter((c) =>
    (filter === 'all' || (filter === 'review' ? (c.status === 'missing' || c.fresh) : filter === 'always' ? c.always : c.active === false))
    && (!topic || (c.topics || []).includes(topic))
    && (!needle || `${c.heading}\n${c.text}`.toLowerCase().includes(needle)));

  return (
    <div className="fade">
      <div className="card pad" style={{ marginBottom: 16 }}>
        <strong style={{ fontSize: 15 }}>📋 The Rule book</strong>
        <p className="hint" style={{ margin: '6px 0 0' }}>
          Every document you upload is split into small rules — no AI, nothing shortened, nothing lost. For each customer
          message the bot is given only the rules on that topic. Upload a new version any time: changed rules update,
          new ones are added, and a rule the new version leaves out stays in use until you choose to keep or remove it.
        </p>
        <div className="chips" style={{ marginTop: 10 }}>
          <span className="chip lang">{st.inForce || 0} rules in use</span>
          <span className="chip">{st.always || 0} used in every reply</span>
          {st.missing > 0 && <span className="chip need">{st.missing} to review</span>}
        </div>
        {st.alwaysChars > st.alwaysLimit && (
          <div className="noanswer" style={{ marginTop: 8 }}>
            ⚠️ The "every reply" rules are {st.alwaysChars} characters, over the {st.alwaysLimit} limit — the last ones are left out.
            Edit some and untick "Use in every reply" so they are used only for their topic.
          </div>
        )}
        {data.faqOff.length > 0 && (
          <div style={{ marginTop: 10 }}>
            <div className="hint">Built-in quick answers switched off because your rules say different numbers:</div>
            <div className="chips">{data.faqOff.map((f) => <span key={f.category} className="chip off" title={f.reason}>{f.category} — {f.reason}</span>)}</div>
          </div>
        )}
      </div>

      <TopicWords topics={data.topics} canManage={canManage} onChanged={load} />

      {canManage && (adding ? (
        <div className="card pad fade" style={{ marginBottom: 20 }}>
          <strong style={{ fontSize: 15 }}>Add a rule</strong>
          <label>Title</label>
          <input value={draft.heading} placeholder="e.g. Diwali offer" onChange={(e) => setDraft({ ...draft, heading: e.target.value })} />
          <label>Rule</label>
          <textarea value={draft.text} placeholder="e.g. 10% off every jersey until 5 November." onChange={(e) => setDraft({ ...draft, text: e.target.value })} />
          <label>Topics <span className="hint">— leave empty to detect automatically</span></label>
          <input value={draft.topics} placeholder={data.topics.slice(0, 5).map((t) => t.key).join(', ')} onChange={(e) => setDraft({ ...draft, topics: e.target.value })} />
          <label className="check-lbl">
            <input type="checkbox" checked={draft.always} onChange={(e) => setDraft({ ...draft, always: e.target.checked })} />
            Use in every reply
          </label>
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <button className="btn gold sm" onClick={add}>💾 Add rule</button>
            <button className="btn ghost sm" onClick={() => setAdding(false)}>Cancel</button>
          </div>
        </div>
      ) : <button className="btn gold" style={{ marginBottom: 16 }} onClick={() => setAdding(true)}>➕ Add a rule by hand</button>)}

      <div className="row2" style={{ marginBottom: 12 }}>
        <div>
          <label>Show</label>
          <select value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option value="all">All rules</option>
            <option value="review">To review (new, changed, missing)</option>
            <option value="always">Used in every reply</option>
            <option value="off">Turned off</option>
          </select>
        </div>
        <div>
          <label>Topic</label>
          <select value={topic} onChange={(e) => setTopic(e.target.value)}>
            <option value="">All topics</option>
            {data.topics.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
            <option value="general">General (no topic found)</option>
          </select>
        </div>
      </div>
      <input value={q} placeholder="Search the rules…" onChange={(e) => setQ(e.target.value)} style={{ marginBottom: 12 }} />

      <div className="section-head">
        <strong style={{ fontSize: 15 }}>Rules</strong>
        <span className="count">{shown.length}</span>
      </div>
      {data.cards.length === 0
        ? <div className="empty">No rules yet. Upload your rules document on the Knowledge sources tab.</div>
        : shown.length === 0 ? <div className="empty">Nothing matches.</div>
        : shown.map((c) => <RuleCard key={c.id} c={c} topics={data.topics} canManage={canManage} onChanged={load} onTeach={canTeach ? onTeach : null} />)}
    </div>
  );
}

function SourceCard({ s, onToggle, onDelete, canManage, onChanged, onOpenBook }) {
  const off = s.active === false;
  return (
    <div className={'entry fade' + (s.status === 'error' ? ' flag' : '')}>
      <h4>{s.type === 'website' ? '🌐' : '📄'} {s.title}</h4>
      {s.url && <div className="ans" style={{ wordBreak: 'break-all' }}>{s.url}</div>}
      <div className="chips">
        <span className="chip src">{s.type}</span>
        <span className="chip">{s.chunkCount} chunk{s.chunkCount === 1 ? '' : 's'}</span>
        <span className="chip">{fmtBytes(s.charCount)}</span>
        {s.pageCount ? <span className="chip">{s.pageCount} page{s.pageCount === 1 ? '' : 's'}</span> : null}
        {/* Semantic vs keyword-only is the difference between finding a paraphrase and
            not, so it's worth showing per-source rather than hiding the downgrade. */}
        <span className={'chip' + (s.embedded ? ' lang' : '')}>{s.embedded ? 'semantic search' : 'keyword only'}</span>
        {off && <span className="chip off">inactive</span>}
      </div>
      {s.type === 'document' && <DocRulesPanel s={s} canManage={canManage} onChanged={onChanged} onOpenBook={onOpenBook} />}
      {canManage && (
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn ghost sm" onClick={() => onToggle(s)}>{off ? 'Turn on' : 'Turn off'}</button>
          <button className="btn danger sm" onClick={() => onDelete(s.id)}>Delete</button>
        </div>
      )}
    </div>
  );
}

function SourcesTab({ onOpenBook }) {
  const { api, token, can } = useAuth();
  const canManage = can('knowledge.sources');
  const toast = useToast();
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState('');
  const [url, setUrl] = useState('');
  const [maxPages, setMaxPages] = useState(15);
  const [maxDepth, setMaxDepth] = useState(2);
  const [file, setFile] = useState(null);
  const [replaces, setReplaces] = useState('');

  const load = useCallback(async () => {
    try { setData(await api('/api/knowledge/sources')); }
    catch (e) { toast(e.message, true); setData({ sources: [], usage: {} }); }
  }, [api, toast]);

  useEffect(() => { load(); }, [load]);

  const addWebsite = async () => {
    if (!url.trim()) return toast('Enter a website URL.', true);
    setBusy('website');
    try {
      const r = await api('/api/knowledge/sources/website', {
        method: 'POST',
        body: JSON.stringify({ url: url.trim(), maxPages, maxDepth }),
      });
      toast(`Indexed ${r.pagesCrawled} page(s) — ${r.chunks} chunks.`);
      if (r.embeddingNote) toast(r.embeddingNote, true);
      setUrl('');
      load();
    } catch (e) { toast(e.message, true); }
    finally { setBusy(''); }
  };

  const addDocument = async () => {
    if (!file) return toast('Choose a file first.', true);
    setBusy('document');
    try {
      // Raw fetch, not the shared api() helper: that helper forces
      // Content-Type: application/json, which would corrupt a multipart upload.
      const form = new FormData();
      form.append('file', file);
      if (replaces) form.append('replaces', replaces);
      const res = await fetch(apiUrl('/api/knowledge/sources/document'), {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token },
        body: form,
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || 'Upload failed');
      toast(`"${body.source.title}" uploaded. ${ruleSummaryText(body.ruleBook)}`);
      if (body.embeddingNote) toast(body.embeddingNote, true);
      setFile(null);
      setReplaces('');
      document.getElementById('kb-file').value = '';
      load();
    } catch (e) { toast(e.message, true); }
    finally { setBusy(''); }
  };

  const toggle = async (s) => {
    try { await api(`/api/knowledge/sources/${s.id}/toggle`, { method: 'POST', body: '{}' }); load(); }
    catch (e) { toast(e.message, true); }
  };

  const del = async (id) => {
    if (!confirm('Delete this source? The bot will stop using its content — for a document, its rules leave the Rule book too (except ones you chose to keep).')) return;
    try { await api('/api/knowledge/sources/' + id, { method: 'DELETE' }); toast('Deleted.'); load(); }
    catch (e) { toast(e.message, true); }
  };

  const usage = data?.usage || {};
  const embeddings = data?.embeddings || {};

  return (
    <div>
      {/* The local model needs no key, so `enabled` is true by default — a genuine outage
          shows up as lastError instead. Keying the warning off `!enabled` alone would mean
          a failed model load degrades to keyword-only with nothing said. */}
      {data && (!embeddings.enabled || embeddings.lastError) && (
        <div className="card pad fade" style={{ marginBottom: 16 }}>
          <strong>⚠️ Keyword-only matching</strong>
          <p className="hint" style={{ margin: '6px 0 0' }}>
            Semantic search is unavailable, so documents are matched by keyword instead of meaning.
            The bot still finds exact terms, but will miss re-worded questions.
            {embeddings.lastError && <> Reason: <code>{embeddings.lastError}</code></>}
            {' '}Once it is working again, re-add any sources indexed in the meantime so they pick up vectors.
          </p>
        </div>
      )}

      {!canManage && (
        <div className="view-only">👀 <strong>View only.</strong> Your role can see the knowledge sources but can't add, turn off or delete them.</div>
      )}

      {canManage && <>
      <div className="card pad fade" style={{ marginBottom: 20 }}>
        <strong style={{ fontSize: 15 }}>🌐 Website</strong>
        <p className="hint" style={{ margin: '4px 0 12px' }}>
          Crawl your own site and index the text — shipping info, policies, about pages.
        </p>
        <input
          value={url}
          // Prefixed "e.g." on purpose: a bare URL placeholder reads as a filled-in
          // value, so after a crawl clears the field people press Crawl again and get
          // the "Enter a website URL" error with no idea why.
          placeholder="e.g. https://theaurax.in/shipping-policy"
          onChange={(e) => setUrl(e.target.value)}
        />
        <div className="grid-2" style={{ marginTop: 10 }}>
          <div>
            <label>Max pages <span className="hint">— stops the crawl getting huge</span></label>
            <input type="number" min="1" max="100" value={maxPages} onChange={(e) => setMaxPages(+e.target.value)} />
          </div>
          <div>
            <label>Link depth</label>
            <input type="number" min="0" max="3" value={maxDepth} onChange={(e) => setMaxDepth(+e.target.value)} />
          </div>
        </div>
        <button className="btn gold" style={{ marginTop: 14 }} disabled={busy === 'website'} onClick={addWebsite}>
          {busy === 'website' ? 'Crawling…' : '🌐 Crawl & index'}
        </button>
      </div>

      <div className="card pad fade" style={{ marginBottom: 20 }}>
        <strong style={{ fontSize: 15 }}>📄 Document</strong>
        <p className="hint" style={{ margin: '4px 0 12px' }}>
          Upload your rules or policy document — prices, delivery, what the bot must and must never say.
          It is split into small rules on the Rule book tab (free — no AI). Headings and bullet points help it
          split cleanly. Upload a newer version any time: changes update, nothing is dropped without asking you.
          PDF, DOCX, TXT, MD or HTML — max 20 MB. Scanned/photo PDFs won't work; the file needs real selectable text.
        </p>
        <input id="kb-file" type="file" accept=".pdf,.docx,.txt,.md,.html,.htm" onChange={(e) => setFile(e.target.files[0] || null)} />
        {data && data.sources.some((x) => x.type === 'document') && (
          <>
            <label>This is a new version of <span className="hint">— optional; a file with the same name is recognised anyway</span></label>
            <select value={replaces} onChange={(e) => setReplaces(e.target.value)}>
              <option value="">A new document (or recognise it by name)</option>
              {data.sources.filter((x) => x.type === 'document').map((x) => <option key={x.id} value={x.id}>{x.title}</option>)}
            </select>
          </>
        )}
        <button className="btn gold" style={{ marginTop: 14 }} disabled={busy === 'document'} onClick={addDocument}>
          {busy === 'document' ? 'Reading the document… (up to a minute)' : '📄 Upload & index'}
        </button>
      </div>
      </>}

      <div className="card pad fade" style={{ marginBottom: 20 }}>
        <div className="tok-meta">
          <span>Indexed knowledge</span>
          <span className="g">{fmtBytes(usage.chars || 0)} · {usage.sources || 0} source(s) · {usage.chunks || 0} chunks</span>
        </div>
        {/* No hard cap like Wati's 1MB — the bar is oriented against 5MB purely so the
            owner has a sense of scale as the knowledge base grows. */}
        <div className="tok-bar">
          <span style={{ width: Math.min(100, ((usage.chars || 0) / (5 * 1024 * 1024)) * 100) + '%' }} />
        </div>
      </div>

      <div className="section-head">
        <strong style={{ fontSize: 15 }}>Added sources</strong>
        <span className="count">{data ? data.sources.length : '…'}</span>
      </div>
      {data === null ? <div className="empty">Loading…</div>
        : data.sources.length === 0 ? <div className="empty">No sources yet. Add a website or upload a document above ☝️</div>
        : data.sources.map((s) => <SourceCard key={s.id} s={s} onToggle={toggle} onDelete={del} canManage={canManage} onChanged={load} onOpenBook={onOpenBook} />)}
    </div>
  );
}

function ReviewTab({ onTeach }) {
  const { api, can } = useAuth();
  const canEdit = can('knowledge.edit');
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
                {canEdit && (
                  <div style={{ marginTop: 10 }}>
                    <button className="btn gold sm" onClick={() => onTeach(lastUser ? lastUser.content : '')}>✏️ Teach the right answer</button>
                  </div>
                )}
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

  // A rule card → a Q&A draft. A Q&A answer is sent exactly as written with no AI call, so
  // the owner can turn a rule into a free, instant reply (rewriting it for the customer first).
  const teachFromRule = (c) => {
    setDraft({ ...BLANK, question: c.heading.replace(/^\d+(\.\d+)*[.)]?\s*/, ''), answer: c.text, keywords: '', _seeded: true });
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
        <button className={'subtab' + (sub === 'sources' ? ' active' : '')} onClick={() => setSub('sources')}>🗂 Knowledge sources</button>
        <button className={'subtab' + (sub === 'rulebook' ? ' active' : '')} onClick={() => setSub('rulebook')}>📋 Rule book</button>
        <button className={'subtab' + (sub === 'review' ? ' active' : '')} onClick={() => setSub('review')}>🔎 Review mistakes</button>
      </div>
      {sub === 'teach' ? <TeachTab draft={draft} setDraft={setDraft} />
        : sub === 'sources' ? <SourcesTab onOpenBook={() => setSub('rulebook')} />
        : sub === 'rulebook' ? <RuleBookTab onTeach={teachFromRule} />
        : <ReviewTab onTeach={teachFrom} />}
    </div>
  );
}
