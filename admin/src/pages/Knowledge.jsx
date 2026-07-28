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

function fmtBytes(n) {
  if (!n) return '0 KB';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / (1024 * 1024)).toFixed(2) + ' MB';
}

function SourceCard({ s, onToggle, onDelete }) {
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
      <div style={{ display: 'flex', gap: 8 }}>
        <button className="btn ghost sm" onClick={() => onToggle(s)}>{off ? 'Turn on' : 'Turn off'}</button>
        <button className="btn danger sm" onClick={() => onDelete(s.id)}>Delete</button>
      </div>
    </div>
  );
}

function SourcesTab() {
  const { api, token } = useAuth();
  const toast = useToast();
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState('');
  const [url, setUrl] = useState('');
  const [maxPages, setMaxPages] = useState(15);
  const [maxDepth, setMaxDepth] = useState(2);
  const [file, setFile] = useState(null);

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
      const res = await fetch('/api/knowledge/sources/document', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token },
        body: form,
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || 'Upload failed');
      toast(`Indexed "${body.source.title}" — ${body.chunks} chunks.`);
      if (body.embeddingNote) toast(body.embeddingNote, true);
      setFile(null);
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
    if (!confirm('Delete this source? The bot will stop using its content.')) return;
    try { await api('/api/knowledge/sources/' + id, { method: 'DELETE' }); toast('Deleted.'); load(); }
    catch (e) { toast(e.message, true); }
  };

  const usage = data?.usage || {};
  const embeddings = data?.embeddings || {};

  return (
    <div>
      {data && !embeddings.enabled && (
        <div className="card pad fade" style={{ marginBottom: 16 }}>
          <strong>⚠️ Keyword-only matching</strong>
          <p className="hint" style={{ margin: '6px 0 0' }}>
            No embedding key is configured, so documents are searched by keyword instead of meaning.
            The bot still finds exact terms, but will miss re-worded questions. Set <code>OPENAI_API_KEY</code> to
            enable semantic search, then re-add any existing sources.
          </p>
        </div>
      )}

      <div className="card pad fade" style={{ marginBottom: 20 }}>
        <strong style={{ fontSize: 15 }}>🌐 Website</strong>
        <p className="hint" style={{ margin: '4px 0 12px' }}>
          Crawl your own site and index the text — shipping info, policies, about pages.
        </p>
        <input
          value={url}
          placeholder="https://theaurax.in/shipping-policy"
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
          Upload a size chart, price list, or policy document. PDF, DOCX, TXT, MD or HTML — max 20 MB.
          Scanned/photo PDFs won't work; the file needs real selectable text.
        </p>
        <input id="kb-file" type="file" accept=".pdf,.docx,.txt,.md,.html,.htm" onChange={(e) => setFile(e.target.files[0] || null)} />
        <button className="btn gold" style={{ marginTop: 14 }} disabled={busy === 'document'} onClick={addDocument}>
          {busy === 'document' ? 'Indexing…' : '📄 Upload & index'}
        </button>
      </div>

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
        : data.sources.map((s) => <SourceCard key={s.id} s={s} onToggle={toggle} onDelete={del} />)}
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
        <button className={'subtab' + (sub === 'sources' ? ' active' : '')} onClick={() => setSub('sources')}>🗂 Knowledge sources</button>
        <button className={'subtab' + (sub === 'review' ? ' active' : '')} onClick={() => setSub('review')}>🔎 Review mistakes</button>
      </div>
      {sub === 'teach' ? <TeachTab draft={draft} setDraft={setDraft} />
        : sub === 'sources' ? <SourcesTab />
        : <ReviewTab onTeach={teachFrom} />}
    </div>
  );
}
