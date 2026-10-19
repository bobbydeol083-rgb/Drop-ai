// Drop AI launcher renderer — DOM only, no Node access.
// Copyright by Dork Industry.

(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);

  const DOT_CLASS = { ok: 'dot-ok', starting: 'dot-starting', error: 'dot-error', stopped: 'dot-stopped' };
  const PILL_CLASS = { ok: 'pill-ok', starting: 'pill-starting', error: 'pill-error', stopped: 'pill-stopped' };

  let logLines = [];
  let revealTimer = null;

  // Refresh handles set by screen init functions; showScreen() calls them
  // when their screen becomes visible so data never goes stale.
  let refreshHomeBanner = null;
  let refreshPlansScreen = null;
  let refreshSettingsScreen = null;

  function setDot(id, state) {
    const el = $(id);
    el.className = `dot ${DOT_CLASS[state] ?? DOT_CLASS.stopped}`;
  }

  // Premiere status label from the relay's panel state machine:
  // ready → Ready, busy → Busy — exporting, stale → Not responding,
  // dead/absent → Disconnected. Falls back to busy/connected when an older
  // main process does not send panelState.
  function panelStateLabel(p) {
    const s =
      p.panelState ?? (p.connected ? (p.busy ? 'busy' : 'ready') : 'dead');
    const label =
      s === 'ready' ? 'Ready' :
      s === 'busy' ? 'Busy — exporting' :
      s === 'stale' ? 'Not responding' :
      'Disconnected';
    return p.version ? `${label} · ${p.version}` : label;
  }

  function applyStatus(status) {
    if (!status) return;

    setDot('dot-relay', status.relay.state);
    setDot('dot-premiere', status.premiere.state);
    setDot('dot-mcp', status.mcp.state);

    $('detail-relay').textContent = status.relay.detail;
    $('detail-premiere').textContent = panelStateLabel(status.premiere);
    $('detail-mcp').textContent = status.mcp.detail;

    // Per-plugin host sections, rendered dynamically from dropai:listPlugins.
    // Premiere keeps its static section above; this only touches host cards.
    const hosts = status.hosts || {};
    for (const hostId of Object.keys(hosts)) {
      const dot = $(`dot-host-${hostId}`);
      const det = $(`detail-host-${hostId}`);
      if (dot) dot.className = `dot ${DOT_CLASS[hosts[hostId].state] ?? DOT_CLASS.stopped}`;
      if (det) det.textContent = panelStateLabel(hosts[hostId]);
    }
    $('relay-port').textContent = `port ${status.manager.relayPort}`;

    // Global pill + READY banner
    const states = [status.relay.state, status.premiere.state, status.mcp.state];
    const pill = $('global-pill');
    const pillText = $('global-pill-text');
    let overall;
    if (states.every((s) => s === 'ok')) overall = 'ok';
    else if (states.includes('error')) overall = 'error';
    else if (status.running) overall = 'starting';
    else overall = 'stopped';
    pill.className = `pill ${PILL_CLASS[overall]}`;
    pillText.textContent =
      overall === 'ok' ? 'Ready' :
      overall === 'error' ? 'Error' :
      overall === 'starting' ? 'Starting…' : 'Stopped';

    $('ready-banner').classList.toggle('hidden', overall !== 'ok');

    // Phase D: simple connected/disconnected status (logs hidden behind Details).
    const ssDot = $('ss-dot');
    const ssText = $('ss-text');
    const ssSub = $('ss-sub');
    if (ssDot && ssText && ssSub) {
      const dotClass = overall === 'ok' ? 'dot-ok' : overall === 'error' ? 'dot-error' : overall === 'starting' ? 'dot-starting' : 'dot-stopped';
      ssDot.className = `dot ${dotClass}`;
      if (overall === 'ok') {
        ssText.textContent = 'Connected';
        ssSub.textContent = 'Relay, Premiere Pro panel, and MCP server are all running. Your AI client can use the Drop AI tools.';
      } else if (overall === 'error') {
        ssText.textContent = 'Connection error';
        ssSub.textContent = 'Something failed — open Details below or press Retry.';
      } else if (overall === 'starting') {
        ssText.textContent = 'Connecting…';
        ssSub.textContent = 'Starting the relay, Premiere Pro panel, and MCP server.';
      } else {
        ssText.textContent = 'Disconnected';
        ssSub.textContent = 'Press Start to connect the relay, Premiere Pro panel, and MCP server.';
      }
    }

    // Premiere install line
    const installEl = $('premiere-install');
    const inst = status.premiereInstall;
    if (inst && inst.found) {
      installEl.className = 'install-line found';
      installEl.textContent = `Premiere Pro ${inst.version} found at ${inst.path}`;
    } else {
      installEl.className = 'install-line missing';
      installEl.textContent = 'Premiere Pro not found — install Premiere Pro and the Drop AI CEP panel.';
    }

    // Buttons
    $('btn-start').disabled = status.running;
    $('btn-stop').disabled = !status.running;
    $('btn-retry').disabled = status.running && overall !== 'error';
  }

  // ---- logs ----

  function renderLogs(autotail) {
    const view = $('log-view');
    const nearBottom = view.scrollHeight - view.scrollTop - view.clientHeight < 40;
    view.textContent = logLines.join('\n');
    if (autotail || nearBottom) view.scrollTop = view.scrollHeight;
  }

  function appendLog(entry) {
    logLines.push(String(entry));
    if (logLines.length > 500) logLines = logLines.slice(logLines.length - 500);
    renderLogs(true);
  }

  // ---- token ----

  function stopReveal() {
    if (revealTimer) {
      clearTimeout(revealTimer);
      revealTimer = null;
    }
  }

  async function refreshMasked() {
    stopReveal();
    $('token-value').textContent = await window.dropai.token.getMasked();
    $('token-note').textContent = 'Masked by default. Reveal hides itself again after 10 s.';
  }

  // ---- HTTP remote server ----

  async function refreshHttpStatus(updateNote = true) {
    let status = null;
    try {
      status = await window.dropai.http.status();
    } catch {
      return; // launcher busy; leave the current UI alone
    }
    if (!status || status.error) return;
    const running = Boolean(status.running);
    const btn = $('btn-http-toggle');
    btn.dataset.running = running ? '1' : '';
    btn.textContent = running ? 'Stop remote server' : 'Start remote server';
    $('http-dot').className = `dot ${running ? 'dot-ok' : 'dot-stopped'}`;
    $('http-url').textContent = status.url || '—';
    // Restore the public tunnel URL box if a tunnel is already running.
    try {
      const tstate = await window.dropai.tunnel.state().catch(() => ({}));
      if (tstate && tstate.status === 'running' && tstate.url) {
        $('tunnel-public-url').textContent = tstate.url + '/mcp';
        $('tunnel-url-box').classList.remove('hidden');
      } else if (!running) {
        $('tunnel-url-box').classList.add('hidden');
      }
    } catch { /* tunnel state unavailable */ }
    if (updateNote) {
      $('http-note').textContent = running
        ? 'Running — remote clients connect with the API token above. Bound to 127.0.0.1 only; use a tunnel for access from another machine.'
        : 'Stopped. Serves every MCP tool over Streamable HTTP with bearer auth.';
    }
  }

  // ---- screens ----

  function showScreen(name) {
    for (const btn of document.querySelectorAll('.dock-item')) {
      btn.classList.toggle('dock-active', btn.dataset.screen === name);
    }
    for (const panel of document.querySelectorAll('.screen')) {
      panel.classList.toggle('hidden', panel.dataset.screenPanel !== name);
    }
    if (name === 'knowledge') refreshKnowledge();
    if (name === 'assets') refreshAssets();
    if (name === 'reference') refreshReferences();
    if (name === 'library') refreshLibrary();
    if (name === 'overview' && typeof refreshHomeBanner === 'function') refreshHomeBanner();
    if (name === 'upgrade' && typeof refreshPlansScreen === 'function') refreshPlansScreen();
    if (name === 'settings' && typeof refreshSettingsScreen === 'function') refreshSettingsScreen();
  }

  function setNote(id, msg, kind) {
    const el = $(id);
    el.textContent = msg || '';
    el.classList.toggle('note-error', kind === 'error');
    el.classList.toggle('note-ok', kind === 'ok');
  }

  function errorResult(res) {
    return res && typeof res === 'object' && !Array.isArray(res) && typeof res.error === 'string'
      ? res.error
      : null;
  }

  // ---- knowledge ----

  // Tracks live background-ingestion progress events (source -> event).
  // Module-level so refreshKnowledge can check for active ingestions.
  const ingestProgress = {};

  function kbSourceRow(s) {
    const tr = document.createElement('tr');
    const id = s.source ?? s.id ?? s.sourceId ?? '';
    const tdSource = document.createElement('td');
    tdSource.textContent = s.source ?? s.kind ?? 'upload';
    const tdTitle = document.createElement('td');
    tdTitle.textContent = s.title ?? s.name ?? String(id);
    // Status badge: pending / processing / ready / failed
    const status = s.status || 'ready';
    if (status !== 'ready') {
      const badge = document.createElement('span');
      badge.className = `kb-status kb-status-${status}`;
      badge.textContent = status === 'processing' ? 'Processing…' : status === 'pending' ? 'Queued' : 'Failed';
      badge.title = s.error || status;
      tdTitle.appendChild(document.createTextNode(' '));
      tdTitle.appendChild(badge);
    }
    const tdChunks = document.createElement('td');
    tdChunks.textContent = s.chunks ?? s.chunkCount ?? '—';
    const tdActions = document.createElement('td');
    tdActions.className = 'td-actions';
    // Retry button for stuck/failed ingestions
    if (status === 'pending' || status === 'failed' || status === 'processing') {
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'btn btn-small';
      retry.textContent = 'Retry';
      retry.title = s.error ? `Last error: ${s.error}` : 'Re-queue for background ingestion';
      retry.addEventListener('click', async () => {
        retry.disabled = true;
        retry.textContent = 'Queued…';
        const res = await window.dropai.knowledge.retry(id);
        const errMsg = errorResult(res);
        if (errMsg) setNote('kb-note', errMsg, 'error');
        else setNote('kb-note', 'Re-queued for ingestion.', 'ok');
        refreshKnowledge();
      });
      tdActions.appendChild(retry);
    }
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'btn btn-small btn-danger-ghost';
    del.textContent = 'Delete';
    del.addEventListener('click', async () => {
      if (!window.confirm(`Remove "${tdTitle.textContent}" from the knowledge base?`)) return;
      const res = await window.dropai.knowledge.remove(id);
      const errMsg = errorResult(res);
      if (errMsg) setNote('kb-note', errMsg, 'error');
      else {
        setNote('kb-note', 'Source removed.', 'ok');
        refreshKnowledge();
      }
    });
    tdActions.appendChild(del);
    tr.append(tdSource, tdTitle, tdChunks, tdActions);
    return tr;
  }

  async function refreshKnowledge() {
    const tbody = $('kb-tbody');
    try {
      const res = await window.dropai.knowledge.list();
      const errMsg = errorResult(res);
      if (errMsg) throw new Error(errMsg);
      const sources = Array.isArray(res) ? res : [];
      tbody.innerHTML = '';
      if (sources.length === 0) {
        const tr = document.createElement('tr');
        const td = document.createElement('td');
        td.colSpan = 4;
        td.className = 'table-empty';
        td.textContent = 'No sources yet — upload a rulebook or run Reindex for the seed knowledge.';
        tr.appendChild(td);
        tbody.appendChild(tr);
        return;
      }
      for (const s of sources) tbody.appendChild(kbSourceRow(s));
      // If any source is pending/processing but no live progress events are
      // flowing, show an indeterminate indicator so the user knows it's alive.
      const stuck = sources.filter((s) => s.status === 'pending' || s.status === 'processing');
      const wrap = $('kb-ingest-progress-wrap');
      const label = $('kb-ingest-progress-label');
      if (stuck.length > 0 && Object.keys(ingestProgress).length === 0) {
        wrap.classList.remove('hidden');
        label.textContent = `${stuck.length} file(s) waiting for background ingestion… (retrying automatically)`;
        $('kb-ingest-progress-fill').style.width = '15%';
      }
    } catch (err) {
      tbody.innerHTML = '';
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 4;
      td.className = 'table-empty';
      td.textContent = `Could not load sources: ${err.message}`;
      tr.appendChild(td);
      tbody.appendChild(tr);
    }
  }

  async function kbUpload(paths) {
    setNote('kb-note', paths ? `Queueing ${paths.length} file(s) for background ingestion…` : 'Choose .md or .pdf files…');
    try {
      const res = await window.dropai.knowledge.upload(paths);
      const errMsg = errorResult(res);
      if (errMsg) {
        setNote('kb-note', errMsg, 'error');
        return;
      }
      if (res && res.canceled) {
        setNote('kb-note', '');
        return;
      }
      const results = (res && res.results) || [];
      const ok = results.filter((r) => !r.error).length;
      const failed = results.filter((r) => r.error);
      if (res && res.background) {
        // Background ingestion: show queued message, progress comes via events
        setNote(
          'kb-note',
          `Queued ${ok} file(s) — processing in the background. Watch the progress below.`,
          'ok',
        );
      } else {
        setNote(
          'kb-note',
          `Imported ${ok} file(s).` + (failed.length ? ` ${failed.length} failed: ${failed[0].error}` : ''),
          failed.length ? 'error' : 'ok',
        );
      }
      refreshKnowledge();
    } catch (err) {
      setNote('kb-note', err.message, 'error');
    }
  }

  function kbResultItem(r) {
    const li = document.createElement('li');
    li.className = 'result';
    const head = document.createElement('div');
    head.className = 'result-head';
    const title = document.createElement('span');
    title.className = 'result-title';
    title.textContent = r.title ?? 'Untitled';
    head.appendChild(title);
    if (r.section) {
      const section = document.createElement('span');
      section.className = 'result-section';
      section.textContent = r.section;
      head.appendChild(section);
    }
    if (typeof r.score === 'number') {
      const score = document.createElement('span');
      score.className = 'result-score';
      score.textContent = r.score.toFixed(3);
      head.appendChild(score);
    }
    const text = document.createElement('p');
    text.className = 'result-text';
    const snippet = String(r.text ?? r.snippet ?? '');
    text.textContent = snippet.length > 280 ? `${snippet.slice(0, 280)}…` : snippet;
    li.append(head, text);
    return li;
  }

  async function kbSearch() {
    const q = $('kb-search-input').value.trim();
    const ul = $('kb-results');
    ul.innerHTML = '';
    if (!q) return;
    try {
      const res = await window.dropai.knowledge.search(q);
      const errMsg = errorResult(res);
      if (errMsg) throw new Error(errMsg);
      const results = (res && res.results) || [];
      if (results.length === 0) {
        const li = document.createElement('li');
        li.className = 'result';
        li.textContent = 'No matches.';
        ul.appendChild(li);
        return;
      }
      for (const r of results) ul.appendChild(kbResultItem(r));
    } catch (err) {
      const li = document.createElement('li');
      li.className = 'result';
      li.textContent = `Search failed: ${err.message}`;
      ul.appendChild(li);
    }
  }

  // ---- assets ----

  let assetSearchTimer = null;
  let placeTarget = null;

  function assetCard(a) {
    const id = a.id ?? a.assetId ?? '';
    const card = document.createElement('article');
    card.className = 'asset-card';
    const top = document.createElement('div');
    top.className = 'asset-top';
    const name = document.createElement('p');
    name.className = 'asset-name';
    name.textContent = a.name ?? a.title ?? String(id);
    name.title = name.textContent;
    const badge = document.createElement('span');
    const type = String(a.type ?? 'other').toLowerCase();
    badge.className = `badge badge-${['mogrt', 'lut', 'broll'].includes(type) ? type : 'other'}`;
    badge.textContent = type;
    top.append(name, badge);
    card.appendChild(top);

    const tags = Array.isArray(a.tags) ? a.tags : [];
    if (tags.length > 0) {
      const pills = document.createElement('div');
      pills.className = 'tag-pills';
      for (const t of tags.slice(0, 8)) {
        const pill = document.createElement('span');
        pill.className = 'tag-pill';
        pill.textContent = String(t);
        pills.appendChild(pill);
      }
      card.appendChild(pills);
    }

    if (a.description) {
      const desc = document.createElement('p');
      desc.className = 'asset-desc';
      desc.textContent = String(a.description);
      card.appendChild(desc);
    }

    const meta = document.createElement('p');
    meta.className = 'asset-meta';
    const added = a.addedAt ?? a.createdAt ?? null;
    let addedText = '';
    if (added) {
      const d = new Date(added);
      if (!Number.isNaN(d.getTime())) addedText = d.toLocaleDateString();
    }
    meta.textContent = addedText ? `Added ${addedText}` : `id ${id}`;
    card.appendChild(meta);

    const actions = document.createElement('div');
    actions.className = 'asset-actions';
    const place = document.createElement('button');
    place.type = 'button';
    place.className = 'btn btn-small btn-primary';
    place.textContent = 'Place';
    place.addEventListener('click', () => openPlaceModal(a));
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'btn btn-small btn-danger-ghost';
    del.textContent = 'Delete';
    del.addEventListener('click', async () => {
      if (!window.confirm(`Delete asset "${name.textContent}"?`)) return;
      const res = await window.dropai.assets.remove(id);
      const errMsg = errorResult(res);
      if (errMsg) setNote('asset-note', errMsg, 'error');
      else {
        setNote('asset-note', 'Asset deleted.', 'ok');
        refreshAssets();
      }
    });
    actions.append(place, del);
    card.appendChild(actions);
    return card;
  }

  async function refreshAssets() {
    const grid = $('asset-grid');
    const q = $('asset-search-input').value.trim();
    try {
      const res = q ? await window.dropai.assets.search(q) : await window.dropai.assets.list();
      const errMsg = errorResult(res);
      if (errMsg) throw new Error(errMsg);
      const assets = Array.isArray(res) ? res : (res && res.results) || [];
      grid.innerHTML = '';
      if (assets.length === 0) {
        setNote('asset-note', q ? 'No assets match that search.' : 'No assets yet — add a .mogrt, .cube or b-roll file.');
        return;
      }
      setNote('asset-note', '');
      for (const a of assets) grid.appendChild(assetCard(a));
    } catch (err) {
      grid.innerHTML = '';
      setNote('asset-note', `Could not load assets: ${err.message}`, 'error');
    }
  }

  function openModal(id) {
    $(id).classList.remove('hidden');
  }

  // ---- reference video ----

  function fmtDur(sec) {
    const s = Math.max(0, Number(sec) || 0);
    const m = Math.floor(s / 60);
    return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  }

  async function refreshReferences() {
    const list = $('ref-bundles');
    try {
      const res = await window.dropai.reference.list();
      const errMsg = errorResult(res);
      if (errMsg) throw new Error(errMsg);
      const refs = (res && res.references) || [];
      list.innerHTML = '';
      if (refs.length === 0) {
        const p = document.createElement('p');
        p.className = 'table-empty';
        p.textContent = 'No references yet — select a video above to deconstruct one.';
        list.appendChild(p);
        return;
      }
      for (const r of refs) {
        list.appendChild(renderBundleCard(r));
      }
    } catch (err) {
      list.innerHTML = '';
      const p = document.createElement('p');
      p.className = 'table-empty';
      p.textContent = `Could not load references: ${err.message}`;
      list.appendChild(p);
    }
  }

  // Packed bundle card: one card per reference, expandable to reveal components.
  function renderBundleCard(r) {
    const card = document.createElement('div');
    card.className = 'bundle-card';
    card.dataset.slug = r.slug;

    const head = document.createElement('button');
    head.className = 'bundle-head';
    head.type = 'button';
    head.setAttribute('aria-expanded', 'false');

    const title = document.createElement('span');
    title.className = 'bundle-title';
    title.textContent = r.name || r.slug;

    const meta = document.createElement('span');
    meta.className = 'bundle-meta';
    const fmtBadge = document.createElement('span');
    fmtBadge.className = 'pill';
    fmtBadge.textContent = r.format === 'drop' ? '.drop' : 'legacy';
    meta.append(fmtBadge, document.createTextNode(` ${fmtDur(r.duration)} · ${r.shots ?? '?'} shots`));

    const chev = document.createElement('span');
    chev.className = 'bundle-chev';
    chev.textContent = '▸';

    head.append(title, meta, chev);

    const body = document.createElement('div');
    body.className = 'bundle-body hidden';

    const actions = document.createElement('div');
    actions.className = 'row';
    const delBtn = document.createElement('button');
    delBtn.className = 'btn btn-small btn-danger-ghost';
    delBtn.type = 'button';
    delBtn.textContent = 'Delete bundle';
    delBtn.addEventListener('click', (e) => { e.stopPropagation(); deleteReference(r.slug, r.name); });
    actions.appendChild(delBtn);
    body.appendChild(actions);

    const detail = document.createElement('div');
    detail.className = 'bundle-detail';
    detail.innerHTML = '<p class="dropzone-sub">Loading…</p>';
    body.appendChild(detail);

    let loaded = false;
    head.addEventListener('click', async () => {
      const open = body.classList.toggle('hidden');
      head.setAttribute('aria-expanded', String(!open));
      chev.textContent = open ? '▸' : '▾';
      if (!open && !loaded) {
        loaded = true;
        await renderBundleDetail(r.slug, detail);
      }
    });

    card.append(head, body);
    return card;
  }

  // Divided components inside the bundle, for inspection and per-piece use.
  async function renderBundleDetail(slug, box) {
    try {
      const res = await window.dropai.reference.get(slug);
      const errMsg = errorResult(res);
      if (errMsg) throw new Error(errMsg);
      const dna = res.dna;
      box.innerHTML = '';

      const section = (label) => {
        const h = document.createElement('h4');
        h.className = 'bundle-section';
        h.textContent = label;
        box.appendChild(h);
      };
      const line = (label, value) => {
        const p = document.createElement('p');
        p.className = 'dropzone-sub';
        const b = document.createElement('strong');
        b.textContent = `${label}: `;
        p.append(b, document.createTextNode(String(value)));
        box.appendChild(p);
      };

      section('Look');
      const stats = dna.look?.stats;
      line('Color character', stats
        ? `black ${JSON.stringify(stats.blackPoint)}, mid ${JSON.stringify(stats.midPoint)}, white ${JSON.stringify(stats.whitePoint)}, sat ${stats.meanSaturation}`
        : 'unknown');
      if (dna.format === 'drop') {
        const lutBtn = document.createElement('button');
        lutBtn.className = 'btn btn-small';
        lutBtn.type = 'button';
        lutBtn.textContent = 'Save .cube LUT';
        lutBtn.addEventListener('click', async () => {
          lutBtn.disabled = true;
          try {
            const mres = await window.dropai.reference.materializeLut(slug);
            const merr = errorResult(mres);
            if (merr) throw new Error(merr);
            setNote('ref-note', `LUT saved: ${mres.path}`, 'ok');
          } catch (err) {
            setNote('ref-note', `Could not save LUT: ${err.message}`, 'error');
          } finally {
            lutBtn.disabled = false;
          }
        });
        box.appendChild(lutBtn);
      } else {
        line('LUT file', dna.look?.cubeFile || 'unknown');
      }

      section('Pacing & cuts');
      line('Shots', `${dna.shots.length} shots, avg ${dna.pacing?.avgShotSec ?? '?'}s, ${dna.pacing?.cutsPerMinute ?? '?'} cuts/min`);

      section('Transitions');
      const trans = (dna.transitions || [])
        .map((t) => `${t.type}${t.durationFrames ? ` (${t.durationFrames}f)` : ''}${t.premiereEquivalent ? ` → ${t.premiereEquivalent}` : ''}`)
        .join(', ') || 'none — all hard cuts';
      line('Detected', trans);

      section('Audio');
      line('Analysis', dna.audio ? `${dna.audio.segments?.length ?? 0} speech segments, ${dna.audio.silenceSpans?.length ?? 0} pauses` : 'no audio track');

      if ((dna.applyGuide || []).length) {
        section('Apply guide');
        const ol = document.createElement('ol');
        ol.className = 'dropzone-sub';
        for (const step of dna.applyGuide) {
          const li = document.createElement('li');
          li.textContent = step;
          ol.appendChild(li);
        }
        box.appendChild(ol);
      }
      setNote('ref-note', `Bundle "${dna.name}" — components divided above; the AI sees each piece individually.`, 'ok');
    } catch (err) {
      box.innerHTML = '';
      const p = document.createElement('p');
      p.className = 'dropzone-sub';
      p.textContent = `Could not load bundle: ${err.message}`;
      box.appendChild(p);
    }
  }

  async function deleteReference(slug, name) {
    const label = name || slug;
    if (!window.confirm(`Delete reference "${label}" and its tagged assets? This cannot be undone.`)) return;
    try {
      const res = await window.dropai.reference.remove(slug);
      const errMsg = errorResult(res);
      if (errMsg) throw new Error(errMsg);
      setNote('ref-note', `Deleted "${label}".`, 'ok');
      $('ref-result').classList.add('hidden');
      refreshReferences();
    } catch (err) {
      setNote('ref-note', `Could not delete reference: ${err.message}`, 'error');
    }
  }

  // ---- Preset library ----

  const libState = { filters: [], grouped: [], activeParent: '', activeFilter: '', q: '', page: 1, hostId: '' };

  async function refreshLibrary() {
    const statusEl = $('lib-status');
    try {
      const st = await window.dropai.library.status();
      if (st.connected) {
        statusEl.textContent = 'connected';
        statusEl.className = 'pill ok';
      } else {
        statusEl.textContent = 'offline';
        statusEl.className = 'pill';
        setNote('lib-note', `Library backend not reachable: ${st.error || st.base}. Start it with "npm run dev" in backend/.`, 'error');
        return;
      }
    } catch (err) {
      statusEl.textContent = 'offline';
      statusEl.className = 'pill';
      setNote('lib-note', `Library backend not reachable: ${err.message}`, 'error');
      return;
    }
    await loadLibraryFilters();
    await loadLibraryPresets();
  }

  async function loadLibraryFilters() {
    const row = $('lib-filters');
    try {
      const res = await window.dropai.library.filters(libState.hostId || undefined);
      const errMsg = errorResult(res);
      if (errMsg) throw new Error(errMsg);
      libState.filters = res.filters || [];
      // Hierarchical groups: [{ key, label, children: [{ key, label }] }]
      // Fall back to flat filters if grouped not available.
      libState.grouped = res.grouped || [];
      row.innerHTML = '';

      // --- Parent tabs row: ALL + parent categories ---
      const parentRow = document.createElement('div');
      parentRow.className = 'lib-parent-tabs';
      const mkTab = (key, label, isActive, onClick) => {
        const b = document.createElement('button');
        b.className = 'chip' + (isActive ? ' chip-active' : '');
        b.type = 'button';
        b.textContent = label;
        b.setAttribute('role', 'tab');
        b.addEventListener('click', onClick);
        return b;
      };
      parentRow.appendChild(mkTab('', 'All', libState.activeParent === '' && libState.activeFilter === '', () => {
        libState.activeParent = ''; libState.activeFilter = ''; libState.page = 1;
        loadLibraryFilters(); loadLibraryPresets();
      }));
      for (const g of libState.grouped) {
        parentRow.appendChild(mkTab(g.key, g.label, libState.activeParent === g.key, () => {
          libState.activeParent = g.key; libState.activeFilter = ''; libState.page = 1;
          loadLibraryFilters(); loadLibraryPresets();
        }));
      }
      row.appendChild(parentRow);

      // --- Child sub-tabs row: only when a parent is selected ---
      if (libState.activeParent) {
        const g = libState.grouped.find(x => x.key === libState.activeParent);
        if (g && g.children && g.children.length) {
          const childRow = document.createElement('div');
          childRow.className = 'lib-child-tabs';
          // "All <Parent>" option to show everything under this parent
          childRow.appendChild(mkTab('', `All ${g.label}`, libState.activeFilter === '', () => {
            libState.activeFilter = ''; libState.page = 1;
            loadLibraryFilters(); loadLibraryPresets();
          }));
          for (const c of g.children) {
            childRow.appendChild(mkTab(c.key, c.label, libState.activeFilter === c.key, () => {
              libState.activeFilter = c.key; libState.page = 1;
              loadLibraryFilters(); loadLibraryPresets();
            }));
          }
          row.appendChild(childRow);
        }
      }
    } catch (err) {
      row.innerHTML = '';
      setNote('lib-note', `Could not load filters: ${err.message}`, 'error');
    }
  }

  async function loadLibraryPresets() {
    const grid = $('lib-grid');
    grid.innerHTML = '<p class="table-empty">Loading presets…</p>';
    try {
      const res = await window.dropai.library.presets({
        filter: libState.activeFilter || libState.activeParent || undefined,
        q: libState.q || undefined,
        page: libState.page,
      });
      const errMsg = errorResult(res);
      if (errMsg) throw new Error(errMsg);
      const items = (res.items || []).filter((p) =>
        !libState.hostId ||
        (Array.isArray(p.hosts) ? p.hosts : ['premiere']).includes(libState.hostId));
      const total = res.total || items.length;
      const totalPages = Math.max(1, Math.ceil(total / 24));
      grid.innerHTML = '';
      // Count header ABOVE the grid (not in card row)
      const countHeader = document.getElementById('lib-count-header');
      if (countHeader) {
        countHeader.innerHTML = `<span class="lib-count">${total} preset${total === 1 ? '' : 's'}</span>`;
      }
      if (items.length === 0) {
        const p = document.createElement('p');
        p.className = 'table-empty';
        p.textContent = 'No presets found. Push some from the backend admin panel.';
        grid.appendChild(p);
        return;
      }
      for (const p of items) grid.appendChild(renderPresetCard(p));
      // Pagination controls (compact, right-aligned)
      if (totalPages > 1) {
        const pager = document.createElement('div');
        pager.className = 'lib-pagination';
        const btnRow = document.createElement('div');
        btnRow.className = 'lib-pager-btns';
        const prev = document.createElement('button');
        prev.className = 'btn btn-xs';
        prev.textContent = '← Prev';
        prev.disabled = libState.page <= 1;
        prev.addEventListener('click', () => { libState.page--; loadLibraryPresets(); });
        const next = document.createElement('button');
        next.className = 'btn btn-xs';
        next.textContent = 'Next →';
        next.disabled = libState.page >= totalPages;
        next.addEventListener('click', () => { libState.page++; loadLibraryPresets(); });
        btnRow.appendChild(prev);
        btnRow.appendChild(next);
        const pageInfo = document.createElement('div');
        pageInfo.className = 'lib-page-info';
        pageInfo.textContent = `Page ${libState.page} of ${totalPages}`;
        pager.appendChild(btnRow);
        pager.appendChild(pageInfo);
        grid.appendChild(pager);
      }
    } catch (err) {
      grid.innerHTML = '';
      const p = document.createElement('p');
      p.className = 'table-empty';
      p.textContent = `Could not load presets: ${err.message}`;
      grid.appendChild(p);
    }
  }

  function renderPresetCard(p) {
    const card = document.createElement('div');
    card.className = 'preset-card';

    // Preview on top (Cortex-style) — GIF animates on hover via CSS scale.
    const preview = document.createElement('div');
    preview.className = 'preset-preview';
    if (p.previewUrl) {
      const img = document.createElement('img');
      img.src = p.previewUrl;
      img.alt = '';
      img.loading = 'lazy';
      img.addEventListener('error', () => {
        preview.innerHTML = '';
        const ph = document.createElement('div');
        ph.className = 'preset-preview-empty';
        ph.textContent = '⬡';
        preview.appendChild(ph);
        preview.appendChild(typeBadge(p));
      });
      preview.appendChild(img);
    } else {
      const ph = document.createElement('div');
      ph.className = 'preset-preview-empty';
      ph.textContent = '⬡';
      preview.appendChild(ph);
    }
    preview.appendChild(typeBadge(p));

    const body = document.createElement('div');
    body.className = 'preset-body';

    const name = document.createElement('div');
    name.className = 'preset-name';
    name.textContent = p.name;

    const meta = document.createElement('div');
    meta.className = 'preset-meta';
    meta.append(
      document.createTextNode(`v${p.version || '1.0.0'}`),
      sep(),
      document.createTextNode(`${(p.files || []).length} file${(p.files || []).length === 1 ? '' : 's'}`),
      sep(),
      document.createTextNode(`${p.downloadCount || 0} downloads`)
    );

    const desc = document.createElement('p');
    desc.className = 'preset-desc';
    desc.textContent = p.description || '';

    const foot = document.createElement('div');
    foot.className = 'preset-foot';
    if (p.installed) {
      const tag = document.createElement('span');
      tag.className = 'preset-installed-tag';
      tag.textContent = '✓ Installed';
      foot.appendChild(tag);
      // Reinstall: the files may be missing or corrupt even though the
      // preset is marked installed.
      const reBtn = document.createElement('button');
      reBtn.className = 'btn btn-small';
      reBtn.type = 'button';
      reBtn.textContent = 'Reinstall';
      reBtn.style.marginLeft = '8px';
      reBtn.addEventListener('click', () => downloadPreset(p, reBtn, true));
      foot.appendChild(reBtn);
    } else {
      const btn = document.createElement('button');
      btn.className = 'btn btn-small btn-primary';
      btn.type = 'button';
      btn.textContent = 'Download';
      btn.addEventListener('click', () => downloadPreset(p, btn));
      foot.appendChild(btn);
    }

    body.append(name, meta, desc, foot);
    card.append(preview, body);
    return card;
  }

  function typeBadge(p) {
    const b = document.createElement('span');
    b.className = 'preset-type-badge';
    b.textContent = p.type || 'preset';
    return b;
  }

  function sep() {
    const s = document.createElement('span');
    s.className = 'dot-sep';
    s.textContent = '·';
    return s;
  }

  async function downloadPreset(p, btn, isReinstall) {
    btn.disabled = true;
    btn.textContent = isReinstall ? 'Reinstalling…' : 'Downloading…';
    setNote('lib-note', '');
    try {
      const off = window.dropai.library.onProgress((prog) => {
        if (prog.slug === p.slug) btn.textContent = `Downloading… ${prog.done}/${prog.total}`;
      });
      const res = await window.dropai.library.download(p.id);
      off();
      const errMsg = errorResult(res);
      if (errMsg) throw new Error(errMsg);
      if (res.canceled) { btn.disabled = false; btn.textContent = 'Download'; return; }
      setNote('lib-note', `Installed "${p.name}" (${res.files.length} files${res.assetsRegistered ? `, ${res.assetsRegistered} registered as assets` : ''}).`, 'ok');
      btn.textContent = 'Installed ✓';
    } catch (err) {
      btn.disabled = false;
      btn.textContent = 'Download';
      setNote('lib-note', `Download failed: ${err.message}`, 'error');
    }
  }

  function initLibraryTab() {
    $('btn-lib-refresh').addEventListener('click', refreshLibrary);
    const hostSel = $('lib-host-filter');
    if (hostSel) {
      hostSel.addEventListener('change', () => {
        libState.hostId = hostSel.value;
        libState.page = 1;
        libState.activeParent = '';
        libState.activeFilter = '';
        loadLibraryFilters();
        loadLibraryPresets();
      });
    }
    let deb = null;
    $('lib-search').addEventListener('input', (e) => {
      clearTimeout(deb);
      deb = setTimeout(() => { libState.q = e.target.value.trim(); libState.page = 1; loadLibraryPresets(); }, 350);
    });
  }

  async function showReferenceDna(slug) {
    const box = $('ref-result');
    box.classList.remove('hidden');
    box.innerHTML = '<p class="dropzone-sub">Loading DNA…</p>';
    try {
      const res = await window.dropai.reference.get(slug);
      const errMsg = errorResult(res);
      if (errMsg) throw new Error(errMsg);
      renderReferenceSummary(res.dna);
    } catch (err) {
      box.innerHTML = '';
      setNote('ref-note', `Could not load DNA: ${err.message}`, 'error');
    }
  }

  function renderReferenceSummary(dna) {
    const box = $('ref-result');
    box.classList.remove('hidden');
    const s = dna;
    const trans = (s.transitions || [])
      .map((t) => `${t.type}${t.durationFrames ? ` (${t.durationFrames}f)` : ''}${t.premiereEquivalent ? ` → ${t.premiereEquivalent}` : ''}`)
      .join(', ') || 'none — all hard cuts';
    const assetIds = s.assets ? Object.entries(s.assets).map(([k, v]) => `${k}: ${v}`).join(', ') : 'none';
    box.innerHTML = '';
    const add = (label, value) => {
      const p = document.createElement('p');
      p.className = 'dropzone-sub';
      const b = document.createElement('strong');
      b.textContent = `${label}: `;
      p.appendChild(b);
      p.appendChild(document.createTextNode(String(value)));
      box.appendChild(p);
    };
    add('Reference', `${s.name} (${fmtDur(s.duration)}, ${s.fps} fps)`);
    add('Pacing', `${s.shots.length} shots, avg ${(s.pacing && s.pacing.avgShotSec) ?? '?'}s, ${(s.pacing && s.pacing.cutsPerMinute) ?? '?'} cuts/min`);
    add('Transitions', trans);
    add('Look', `synthesized .cube LUT (black ${JSON.stringify((s.look && s.look.stats && s.look.stats.blackPoint) || '?')})`);
    add('Audio', s.audio ? `${s.audio.segments.length} segments extracted` : 'no audio track');
    add('Assets', assetIds);
    const guide = document.createElement('ol');
    guide.className = 'dropzone-sub';
    for (const step of s.applyGuide || []) {
      const li = document.createElement('li');
      li.textContent = step;
      guide.appendChild(li);
    }
    box.appendChild(guide);
    setNote('ref-note', 'Assets are tagged reference:' + s.slug + ' — find them under the Assets tab.', 'ok');
  }

  function closeModal(id) {
    $(id).classList.add('hidden');
  }

  function parseTagsInput(value) {
    const seen = new Set();
    const out = [];
    for (const part of String(value ?? '').split(',')) {
      const tag = part.trim();
      if (tag && !seen.has(tag)) {
        seen.add(tag);
        out.push(tag);
      }
    }
    return out;
  }

  function openPlaceModal(asset) {
    placeTarget = asset;
    const type = String(asset.type ?? '').toLowerCase();
    $('place-asset-name').textContent = `Placing “${asset.name ?? asset.title ?? asset.id}” (${type || 'other'})`;
    $('place-clip-hint').textContent = type === 'lut' ? 'required for LUT assets' : 'optional';
    $('place-track-type').value = 'video';
    $('place-track-index').value = '0';
    $('place-timecode').value = '';
    $('place-clip-name').value = '';
    setNote('place-note', '');
    $('btn-place-confirm').disabled = false;
    openModal('place-modal');
  }

  // ---- wire up ----

  // ---- connect center ----
  //
  // Per-client MCP configs with the real installed paths (no placeholders).
  // Claude Desktop + Antigravity use local stdio; ChatGPT needs the remote
  // HTTP transport over a public URL.
  // ---- connect center (Phase D: one-click) ----
  //
  // Auto-detects installed AI clients. One click writes the Drop AI MCP config
  // into the client's own config file — no copy/paste. ChatGPT gets a
  // one-click tunnel instead (it connects from OpenAI's servers).
  function initConnectCenter() {
    const listEl = $('connect-client-list');
    const noteEl = $('connect-note');
    const tunnelBox = $('tunnel-box');
    const tunnelUrlEl = $('tunnel-url');
    const tunnelStatusEl = $('tunnel-status');
    let clients = [];

    function setNote(msg, kind) {
      noteEl.textContent = msg || '';
      noteEl.className = 'note' + (kind === 'error' ? ' note-error' : kind === 'ok' ? ' note-ok' : '');
    }

    function render() {
      listEl.innerHTML = '';
      // Diagnostics toggle — shows exactly what was checked, for troubleshooting.
      const diagBtn = document.createElement('button');
      diagBtn.type = 'button';
      diagBtn.className = 'btn btn-small btn-ghost';
      diagBtn.textContent = 'Show detection details';
      diagBtn.style.marginBottom = '10px';
      const diagPre = document.createElement('pre');
      diagPre.className = 'hidden';
      diagPre.style.cssText = 'font-size:11px;background:var(--bg-soft);padding:10px;border-radius:8px;overflow-x:auto;white-space:pre-wrap;';
      diagBtn.addEventListener('click', () => {
        const show = diagPre.classList.contains('hidden');
        diagPre.classList.toggle('hidden');
        diagBtn.textContent = show ? 'Hide detection details' : 'Show detection details';
        if (show) {
          diagPre.textContent = clients.map((c) =>
            `${c.name}: installed=${c.installed} via=${c.foundVia || 'none'}\n` +
            (c.diagnostics || []).map((d) => `  ${d}`).join('\n')
          ).join('\n\n');
        }
      });
      listEl.appendChild(diagBtn);
      listEl.appendChild(diagPre);
      const detected = clients.filter((c) => c.installed);
      if (!detected.length) {
        const box = document.createElement('div');
        box.className = 'connect-empty';
        const t = document.createElement('p');
        t.innerHTML = '<strong>No LLM app found.</strong><br>Download <strong>Claude Desktop</strong> (recommended) or ChatGPT Desktop, then press Refresh.';
        const link = document.createElement('a');
        link.href = 'https://claude.ai/download';
        link.target = '_blank';
        link.rel = 'noopener';
        link.className = 'btn btn-small btn-primary';
        link.textContent = 'Download Claude Desktop';
        link.style.marginTop = '10px';
        box.append(t, link);
        listEl.appendChild(box);
      }
      for (const c of detected) listEl.appendChild(renderClientCard(c));
      if (!detected.some((c) => c.id === 'chatgpt')) {
        const cg = clients.find((c) => c.id === 'chatgpt');
        if (cg) listEl.appendChild(renderClientCard(cg));
      }
    }

    function renderClientCard(c) {
      const card = document.createElement('div');
      card.className = 'connect-client-card';
      const info = document.createElement('div');
      info.className = 'connect-client-info';
      const name = document.createElement('div');
      name.className = 'connect-client-name';
      name.textContent = c.name;
      const status = document.createElement('div');
      status.className = 'connect-client-status';
      const badge = document.createElement('span');
      if (c.configured) { badge.className = 'badge badge-ok'; badge.textContent = 'Connected ✓'; }
      else if (c.installed) { badge.className = 'badge'; badge.textContent = 'Detected'; }
      else { badge.className = 'badge badge-other'; badge.textContent = 'Not installed'; }
      status.appendChild(badge);
      info.append(name, status);
      const actions = document.createElement('div');
      actions.className = 'connect-client-actions';
      const btn = document.createElement('button');
      btn.type = 'button';
      if (c.id === 'chatgpt') {
        btn.className = 'btn btn-small btn-primary';
        btn.textContent = 'Start tunnel';
        btn.addEventListener('click', () => toggleTunnel(btn));
      } else {
        btn.className = 'btn btn-small' + (c.configured ? '' : ' btn-primary');
        btn.textContent = c.configured ? 'Reconnect' : 'Connect';
        btn.disabled = !c.installed;
        btn.addEventListener('click', () => autoConnect(c, btn));
      }
      actions.appendChild(btn);
      card.append(info, actions);
      return card;
    }

    async function autoConnect(c, btn) {
      btn.disabled = true;
      btn.textContent = 'Connecting…';
      setNote('');
      try {
        const res = await window.dropai.connect.auto(c.id);
        if (res && res.error) throw new Error(res.error);
        setNote('✓ ' + c.name + ' connected! Open your LLM and automate your task.', 'ok');
        refresh();
      } catch (err) {
        setNote('Could not connect ' + c.name + ': ' + err.message, 'error');
        btn.disabled = false;
        btn.textContent = 'Connect';
      }
    }

    async function toggleTunnel(btn) {
      const state = await window.dropai.tunnel.state().catch(() => ({}));
      if (state && state.status === 'running' && state.url) {
        await window.dropai.tunnel.stop();
        renderTunnel({ status: 'stopped' });
        btn.textContent = 'Start tunnel';
        setNote('Tunnel stopped.');
        return;
      }
      btn.disabled = true;
      btn.textContent = 'Starting…';
      setNote('');
      try {
        window.dropai.tunnel.onProgress((msg) => setNote(msg));
        const res = await window.dropai.tunnel.start();
        if (res && res.error) throw new Error(res.error);
        setNote('Tunnel live. In ChatGPT: Settings → Connectors → add this URL as a custom MCP connector.', 'ok');
        renderTunnel({ status: 'running', url: res.url });
        btn.textContent = 'Stop tunnel';
        btn.disabled = false;
      } catch (err) {
        const msg = err.message || String(err);
        setNote('Tunnel failed: ' + msg, 'error');
        btn.disabled = false;
        btn.textContent = 'Start tunnel';
        // Offer a one-click repair for corrupted tunnel binaries.
        if (/BAD_DECRYPT|decrypt|cipher/i.test(msg)) {
          const repairBtn = document.createElement('button');
          repairBtn.type = 'button';
          repairBtn.className = 'btn btn-small';
          repairBtn.textContent = 'Repair tunnel';
          repairBtn.style.marginLeft = '8px';
          repairBtn.addEventListener('click', async () => {
            repairBtn.disabled = true;
            repairBtn.textContent = 'Repairing…';
            await window.dropai.tunnel.repair().catch(() => ({}));
            setNote('Tunnel helper cleared — press Start tunnel to re-download it.', 'ok');
            repairBtn.remove();
          });
          noteEl.appendChild(repairBtn);
        }
      }
    }

    function renderTunnel(state) {
      if (!tunnelBox) return;
      if (state.status === 'running' && state.url) {
        tunnelBox.classList.remove('hidden');
        tunnelStatusEl.innerHTML = '';
        const b = document.createElement('span');
        b.className = 'badge badge-ok';
        b.textContent = 'Tunnel live ✓';
        tunnelStatusEl.appendChild(b);
        tunnelUrlEl.textContent = state.url + '/mcp';
      } else {
        tunnelBox.classList.add('hidden');
      }
    }

    async function refresh() {
      try {
        const res = await window.dropai.connect.detect();
        if (res && res.error) throw new Error(res.error);
        clients = res;
        render();
        const tstate = await window.dropai.tunnel.state().catch(() => ({}));
        renderTunnel(tstate || {});
      } catch (err) {
        setNote('Could not detect clients: ' + err.message, 'error');
      }
    }

    const refreshBtn = $('btn-connect-refresh');
    if (refreshBtn) refreshBtn.addEventListener('click', refresh);
    refresh();
  }

  // ---- Home banner slider (backend-managed, permanent — no dismiss button) ----
  // Banner slider with auto-refresh: re-fetches every 5 minutes and whenever
  // the dashboard becomes visible, so banners added in the admin panel while
  // the app is open appear without a restart.
  async function initHomeBanner() {
    const box = $('home-banner');
    const track = $('home-banner-slides');
    const dotsEl = $('home-banner-dots');
    const prevBtn = $('home-banner-prev');
    const nextBtn = $('home-banner-next');
    if (!box || !track || !dotsEl || !prevBtn || !nextBtn) return;
    const base = 'https://mcpagent.cloud';
    let list = [];
    let dots = [];
    let idx = 0;
    let timer = null;
    let lastSig = '';

    const resolveUrl = (u) => {
      if (!u) return '';
      return String(u).startsWith('http') ? u : base + u;
    };
    function go(i) {
      if (!list.length) return;
      idx = (i + list.length) % list.length;
      track.style.transform = `translateX(-${idx * 100}%)`;
      dots.forEach((d, j) => d.classList.toggle('active', j === idx));
      const cur = list[idx] || {};
      box.classList.toggle('banner-img-active', !!resolveUrl(cur.imageUrl || cur.image));
    }
    function restart() {
      if (timer) clearInterval(timer);
      timer = null;
      if (list.length > 1) timer = setInterval(() => go(idx + 1), 6000);
    }
    function buildSlides(newList) {
      list = newList;
      idx = 0;
      track.innerHTML = '';
      dotsEl.innerHTML = '';
      dots = [];
      newList.forEach((b, i) => {
        const slide = document.createElement('div');
        slide.className = 'home-banner-slide';
        slide.setAttribute('role', 'group');
        slide.setAttribute('aria-label', `Announcement ${i + 1} of ${newList.length}`);
        const imgUrl = resolveUrl(b.imageUrl || b.image);
        if (imgUrl) {
          const img = document.createElement('img');
          img.src = imgUrl;
          img.alt = b.title || 'Announcement';
          slide.appendChild(img);
          slide.classList.add('has-image');
        } else {
          slide.classList.add('no-image');
        }
        const text = document.createElement('div');
        text.className = 'home-banner-text';
        const title = document.createElement('strong');
        title.textContent = b.title || '';
        text.appendChild(title);
        if (b.subtitle) {
          const sub = document.createElement('span');
          sub.textContent = b.subtitle;
          text.appendChild(sub);
        }
        if (b.linkUrl && b.linkLabel) {
          const a = document.createElement('a');
          a.className = 'btn btn-small';
          a.href = b.linkUrl;
          a.target = '_blank';
          a.rel = 'noopener';
          a.textContent = b.linkLabel;
          text.appendChild(a);
        }
        slide.appendChild(text);
        track.appendChild(slide);
        const dot = document.createElement('button');
        dot.type = 'button';
        dot.className = 'home-banner-dot' + (i === 0 ? ' active' : '');
        dot.setAttribute('aria-label', `Go to announcement ${i + 1}`);
        dot.addEventListener('click', () => { go(i); restart(); });
        dotsEl.appendChild(dot);
        dots.push(dot);
      });
      const multi = newList.length > 1;
      prevBtn.classList.toggle('hidden', !multi);
      nextBtn.classList.toggle('hidden', !multi);
      dotsEl.style.display = multi ? '' : 'none';
      box.classList.remove('hidden');
      go(0);
      restart();
    }
    async function load() {
      try {
        const res = await fetch(base + '/api/banner').then((r) => r.json()).catch(() => ({}));
        const newList = Array.isArray(res.banners) && res.banners.length
          ? res.banners
          : (res.banner ? [res.banner] : []);
        if (!newList.length) return; // keep whatever is already showing
        const sig = JSON.stringify(newList.map((b) => b._id || b.id || b.title || ''));
        if (sig === lastSig) return; // nothing changed
        lastSig = sig;
        buildSlides(newList);
      } catch { /* banner is optional — never break the home page */ }
    }
    prevBtn.addEventListener('click', () => { go(idx - 1); restart(); });
    nextBtn.addEventListener('click', () => { go(idx + 1); restart(); });
    box.addEventListener('mouseenter', () => { if (timer) clearInterval(timer); });
    box.addEventListener('mouseleave', restart);
    refreshHomeBanner = load;
    await load();
    // Pick up banners added in the admin panel while the app is open.
    setInterval(load, 5 * 60 * 1000);
  }

  // ---- Phase E: AI chatbox (Pro only, lives in Dashboard) ----
  // ---- AI Chat screen (opened from the sidebar "New chat" button) ----
  function initNewChatScreen() {
    const welcome = $('aichat-welcome');
    const msgs = $('aichat-messages');
    const input = $('aichat-input');
    const sendBtn = $('btn-aichat-send');
    const note = $('aichat-note');
    const count = $('aichat-count');
    const projectsEl = $('aichat-projects');
    const projectsTitle = $('aichat-projects-title');
    const chipsEl = $('aichat-attach-chips');
    if (!input || !sendBtn || !msgs) return;
    const base = 'https://mcpagent.cloud';
    const history = [];
    let attachments = [];
    let projects = [];
    let activeProjectId = null;

    function setNote(msg, kind) {
      if (!note) return;
      note.textContent = msg || '';
      note.className = 'note' + (kind === 'error' ? ' note-error' : '');
    }
    function addMsg(role, text) {
      if (welcome) welcome.classList.add('hidden');
      msgs.classList.remove('hidden');
      const div = document.createElement('div');
      div.className = 'aichat-msg aichat-msg-' + role;
      div.textContent = text;
      msgs.appendChild(div);
      msgs.scrollTop = msgs.scrollHeight;
      return div;
    }
    function updateCount() {
      if (count) count.textContent = `${input.value.length.toLocaleString('en-IN')} / 3,000`;
    }
    async function authedHeaders() {
      const token = await window.dropai.auth.userToken().catch(() => null);
      return { 'Content-Type': 'application/json', 'x-user-token': token || '' };
    }
    // Friendly, readable error text for the chat — never a silent failure.
    function chatErrorText(data, status) {
      const code = data && data.code;
      if (status === 401 || code === 'LOGIN_REQUIRED') {
        return 'Please log in to use AI Chat — your session may have expired.';
      }
      if (status === 403 || code === 'ACCOUNT_BLOCKED') {
        return 'Your account has been blocked — contact support.';
      }
      if (status === 402 || code === 'SUBSCRIPTION_REQUIRED' || (data && data.error === 'chatbox_requires_pro')) {
        return 'AI Chat unlocks after your plan is approved — upgrade and our team will review your account.';
      }
      if (status === 503 || (data && data.error === 'chatbox_not_configured')) {
        return 'AI Chat is not set up on the server yet — try again later.';
      }
      if (status === 429) {
        return 'Too many requests — please wait a moment and try again.';
      }
      return (data && (data.message || data.error)) || 'Something went wrong — please try again.';
    }

    // ---- per-project conversation history (local) ----
    function historyKey() {
      return 'dropai-chat-history-' + (activeProjectId || 'default');
    }
    function persistHistory() {
      try { localStorage.setItem(historyKey(), JSON.stringify(history.slice(-40))); } catch { /* ignore */ }
    }
    function restoreHistory() {
      history.length = 0;
      msgs.innerHTML = '';
      let saved = [];
      try { saved = JSON.parse(localStorage.getItem(historyKey()) || '[]'); } catch { /* ignore */ }
      if (Array.isArray(saved) && saved.length) {
        if (welcome) welcome.classList.add('hidden');
        msgs.classList.remove('hidden');
        for (const m of saved) {
          if (m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string') {
            history.push({ role: m.role, content: m.content });
            addMsg(m.role === 'user' ? 'user' : 'ai', m.content);
          }
        }
      } else {
        msgs.classList.add('hidden');
        if (welcome) welcome.classList.remove('hidden');
      }
    }

    async function send(text) {
      text = (text || input.value).trim();
      if (!text && !attachments.length) return;
      const names = attachments.map((a) => a.name);
      const fullText = text + (names.length ? `\n\n[Attached files: ${names.join(', ')}]` : '');
      input.value = '';
      updateCount();
      addMsg('user', fullText);
      history.push({ role: 'user', content: fullText });
      persistHistory();
      attachments = [];
      renderChips();
      sendBtn.disabled = true;
      const typing = addMsg('ai', 'Thinking…');
      typing.classList.add('aichat-msg-typing');
      setNote('');
      try {
        const res = await fetch(base + '/api/chat', {
          method: 'POST',
          headers: await authedHeaders(),
          body: JSON.stringify({ message: fullText, history: history.slice(-10) }),
        });
        let data = {};
        try { data = await res.json(); } catch { /* non-JSON body */ }
        typing.remove();
        if (!res.ok || data.error) {
          addMsg('ai', chatErrorText(data, res.status));
          return;
        }
        addMsg('ai', data.reply || '(no reply)');
        history.push({ role: 'assistant', content: data.reply || '' });
        persistHistory();
      } catch (err) {
        typing.remove();
        addMsg('ai', 'Could not reach the chat service — check your connection and try again.');
      } finally {
        sendBtn.disabled = false;
        input.focus();
      }
    }

    function reset() {
      history.length = 0;
      persistHistory();
      msgs.innerHTML = '';
      msgs.classList.add('hidden');
      if (welcome) welcome.classList.remove('hidden');
      setNote('');
      input.value = '';
      attachments = [];
      renderChips();
      updateCount();
      input.focus();
    }

    // ---- attachments (file picker lives in the main process) ----
    function renderChips() {
      if (!chipsEl) return;
      chipsEl.innerHTML = '';
      attachments.forEach((a, i) => {
        const chip = document.createElement('span');
        chip.className = 'aichat-chip';
        const label = document.createElement('span');
        label.textContent = a.name;
        label.title = a.path || a.name;
        const x = document.createElement('button');
        x.type = 'button';
        x.textContent = '✕';
        x.setAttribute('aria-label', `Remove ${a.name}`);
        x.addEventListener('click', () => { attachments.splice(i, 1); renderChips(); });
        chip.append(label, x);
        chipsEl.appendChild(chip);
      });
    }

    // ---- projects: backend first, localStorage fallback (never dummy data) ----
    function readLocalProjects() {
      try {
        const p = JSON.parse(localStorage.getItem('dropai-chat-projects') || '[]');
        return Array.isArray(p) ? p : [];
      } catch { return []; }
    }
    function saveLocalProjects(list) {
      try { localStorage.setItem('dropai-chat-projects', JSON.stringify(list)); } catch { /* ignore */ }
    }
    async function loadProjects() {
      let backendList = null;
      try {
        const res = await fetch(base + '/api/chat/projects', { headers: await authedHeaders() });
        if (res.ok) {
          const data = await res.json();
          if (data && Array.isArray(data.projects)) backendList = data.projects;
        }
      } catch { /* offline or endpoint missing — fall back to local */ }
      const localOnly = readLocalProjects().filter((l) => l.local);
      projects = backendList
        ? [...backendList, ...localOnly.filter((l) => !backendList.some((b) => b.id === l.id))]
        : readLocalProjects();
      saveLocalProjects(projects);
      if (!projects.some((p) => p.id === activeProjectId)) {
        activeProjectId = projects.length ? projects[0].id : null;
      }
      renderProjects();
      restoreHistory();
    }
    function renderProjects() {
      if (!projectsEl) return;
      projectsEl.innerHTML = '';
      if (projectsTitle) projectsTitle.textContent = `Projects (${projects.length})`;
      if (!projects.length) {
        const p = document.createElement('p');
        p.className = 'table-empty';
        p.textContent = 'No projects yet — create one to organise your chats.';
        projectsEl.appendChild(p);
        return;
      }
      for (const pr of projects) {
        const row = document.createElement('div');
        row.className = 'aichat-project' + (pr.id === activeProjectId ? ' aichat-project-active' : '');
        const sel = document.createElement('button');
        sel.type = 'button';
        sel.className = 'aichat-project-select';
        const strong = document.createElement('strong');
        strong.textContent = pr.name || 'Untitled';
        const small = document.createElement('small');
        const when = pr.createdAt ? new Date(pr.createdAt) : null;
        small.textContent = when && !isNaN(when) ? when.toLocaleDateString() : '';
        sel.append(strong, small);
        sel.setAttribute('aria-label', `Open project ${pr.name || 'Untitled'}`);
        sel.addEventListener('click', () => {
          activeProjectId = pr.id;
          renderProjects();
          restoreHistory();
          input.focus();
        });
        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'aichat-project-del';
        del.textContent = '✕';
        del.title = 'Delete project';
        del.setAttribute('aria-label', `Delete project ${pr.name || 'Untitled'}`);
        del.addEventListener('click', (e) => {
          e.stopPropagation();
          deleteProject(pr);
        });
        row.append(sel, del);
        projectsEl.appendChild(row);
      }
    }
    async function createProject() {
      const name = prompt('Project name:');
      if (!name || !name.trim()) return;
      const clean = name.trim().slice(0, 80);
      let created = null;
      try {
        const res = await fetch(base + '/api/chat/projects', {
          method: 'POST',
          headers: await authedHeaders(),
          body: JSON.stringify({ name: clean }),
        });
        if (res.ok) {
          const data = await res.json();
          if (data && data.project && data.project.id) created = data.project;
        }
      } catch { /* fall back to local */ }
      if (created) {
        await loadProjects();
        activeProjectId = created.id;
      } else {
        const pr = { id: 'local-' + Date.now(), name: clean, createdAt: new Date().toISOString(), local: true };
        projects = [...readLocalProjects(), pr];
        saveLocalProjects(projects);
        activeProjectId = pr.id;
      }
      renderProjects();
      restoreHistory();
      input.focus();
    }
    async function deleteProject(pr) {
      if (!confirm(`Delete project "${pr.name || 'Untitled'}"?`)) return;
      let backendOk = false;
      if (!String(pr.id).startsWith('local-')) {
        try {
          const res = await fetch(base + '/api/chat/projects/' + encodeURIComponent(pr.id), {
            method: 'DELETE',
            headers: await authedHeaders(),
          });
          backendOk = res.ok;
        } catch { /* fall through to local removal */ }
      }
      const remaining = readLocalProjects().filter((p) => p.id !== pr.id);
      saveLocalProjects(remaining);
      try { localStorage.removeItem('dropai-chat-history-' + pr.id); } catch { /* ignore */ }
      if (backendOk) {
        await loadProjects();
      } else {
        projects = remaining;
        if (activeProjectId === pr.id) activeProjectId = projects.length ? projects[0].id : null;
        renderProjects();
        restoreHistory();
      }
    }

    sendBtn.addEventListener('click', () => send());
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });
    input.addEventListener('input', updateCount);

    // "Generate video with AI" — inserts a /video prompt prefix; the chat
    // backend treats it as a normal message (no separate video endpoint yet).
    const videoBtn = $('btn-aichat-video');
    if (videoBtn) videoBtn.addEventListener('click', () => {
      const prefix = '/video ';
      if (!input.value.startsWith(prefix)) input.value = prefix + input.value;
      updateCount();
      input.focus();
      try { input.setSelectionRange(input.value.length, input.value.length); } catch { /* ignore */ }
    });

    const attachBtn = $('btn-aichat-attach');
    if (attachBtn) attachBtn.addEventListener('click', async () => {
      attachBtn.disabled = true;
      try {
        const res = await window.dropai.chat.attach().catch(() => ({ error: 'Attachments unavailable.' }));
        if (!res || res.canceled) return;
        if (res.error) { setNote(res.error, 'error'); return; }
        for (const f of res.files || []) {
          if (f && f.name && !attachments.some((a) => a.path === f.path)) {
            attachments.push({ name: f.name, path: f.path });
          }
        }
        renderChips();
      } finally {
        attachBtn.disabled = false;
      }
    });
    const voiceBtn = $('btn-aichat-voice');
    if (voiceBtn) voiceBtn.addEventListener('click', () => setNote('Voice messages are coming soon.'));
    const promptsBtn = $('btn-aichat-prompts');
    if (promptsBtn) promptsBtn.addEventListener('click', () => setNote('The prompt library is coming soon.'));

    const newProjBtn = $('btn-aichat-newproject');
    if (newProjBtn) newProjBtn.addEventListener('click', createProject);
    const fabBtn = $('btn-aichat-fab');
    if (fabBtn) fabBtn.addEventListener('click', reset);
    const upBtn = $('btn-chat-upgrade');
    if (upBtn) upBtn.addEventListener('click', () => {
      showScreen('upgrade');
      if (typeof refreshPlansScreen === 'function') refreshPlansScreen();
    });
    // Sidebar "New chat" calls this to start a fresh thread.
    window.dropaiNewChat = reset;
    loadProjects();
    updateCount();
  }


  // ---- Phase E: OTA updates (blue "Restart to update" button) ----
  // ---- Robust OTA: check manifest, download with progress, verify, stage ----
  async function initOtaUpdater() {
    const btn = $('btn-update');
    if (!btn) return;
    let current = '0.0.0';
    // Once an update is staged, the button means "restart" — a later check()
    // must never rebind it back to "download".
    let staged = false;
    try {
      if (window.dropai && typeof window.dropai.appVersion === 'function') {
        current = await window.dropai.appVersion();
      } else {
        const meta = document.querySelector('meta[name="app-version"]');
        if (meta) current = meta.content || current;
      }
    } catch { /* use fallback */ }

    async function check() {
      if (staged) return;
      try {
        const manifest = await window.dropai.ota.check(current);
        if (!manifest || !manifest.version) return;
        btn.classList.remove('hidden');
        btn.textContent = `Update to v${manifest.version} →`;
        btn.title = (manifest.notes || 'A new version is available.') + ' (v' + manifest.version + ')';
        btn.onclick = () => downloadAndStage(manifest, btn);
      } catch { /* updater is optional */ }
    }

    async function downloadAndStage(manifest, btn) {
      btn.disabled = true;
      btn.textContent = 'Downloading… 0%';
      const finishStaged = () => {
        staged = true;
        btn.textContent = 'Restart to update →';
        btn.disabled = false;
        btn.onclick = () => window.dropai.ota.restart();
      };
      try {
        const onProgress = (received, total) => {
          const pct = total > 0 ? Math.round((received / total) * 100) : 0;
          btn.textContent = `Downloading… ${pct}%`;
        };
        // Prefer a delta patch when the server offers one for our version:
        // typically 10-30MB instead of ~900MB.
        if (manifest.patchUrl && manifest.patchSha256 && window.dropai.ota.patch) {
          try {
            btn.textContent = 'Downloading update… 0%';
            const patchPath = await window.dropai.ota.patch.download(manifest, onProgress);
            btn.textContent = 'Verifying…';
            const ok = await window.dropai.ota.verify(patchPath, manifest.patchSha256);
            if (!ok) throw new Error('Patch file corrupted (hash mismatch).');
            btn.textContent = 'Installing…';
            await window.dropai.ota.patch.apply(patchPath);
            finishStaged();
            return;
          } catch (patchErr) {
            // Patch failed — fall back to the full download below.
            console.warn('Patch update failed, falling back to full download:', patchErr);
          }
        }
        // Full download path (fallback, or when no patch is offered).
        // If a previous attempt already downloaded the full file, reuse it
        // instead of starting from 0 — the downloader resumes partial files.
        let zipPath = await window.dropai.ota.existing(manifest).catch(() => null);
        if (zipPath) {
          btn.textContent = 'Verifying…';
          const ok = await window.dropai.ota.verify(zipPath, manifest.sha256);
          if (ok) {
            btn.textContent = 'Installing…';
            await window.dropai.ota.stage(zipPath);
            finishStaged();
            return;
          }
          // Existing file is corrupt — fall through to re-download.
        }
        zipPath = await window.dropai.ota.download(manifest, onProgress);
        btn.textContent = 'Verifying…';
        const ok = await window.dropai.ota.verify(zipPath, manifest.sha256);
        if (!ok) throw new Error('Update file corrupted (hash mismatch). Please try again.');
        btn.textContent = 'Installing…';
        await window.dropai.ota.stage(zipPath);
        finishStaged();
      } catch (err) {
        const msg = err && err.message ? err.message : String(err);
        btn.textContent = 'Update failed — retry';
        btn.disabled = false;
        btn.title = msg;
        btn.onclick = () => downloadAndStage(manifest, btn);
        // Surface the real error so it can be reported (not just a tooltip).
        try {
          if (window.dropai && window.dropai.ota && window.dropai.ota.showUpdateError) {
            window.dropai.ota.showUpdateError(msg);
          } else {
            alert('Update failed: ' + msg);
          }
        } catch { /* never break the retry flow */ }
      }
    }

    check();
    // Re-check every 6 hours.
    setInterval(check, 6 * 60 * 60 * 1000);
  }

  // ---- Subscription: view plan, purchase/upgrade via Razorpay ----
  // ---- Plans modal: view plans, purchase/upgrade via Razorpay ----
  // (The old dashboard subscription card was removed; everything lives here.)
  function initPlansScreen() {
    const plansEl = $('upgrade-plans');
    const noteEl = $('upgrade-note');
    if (!plansEl) return;

    function setNoteMsg(msg, kind) {
      if (!noteEl) return;
      noteEl.textContent = msg || '';
      noteEl.className = 'note' + (kind === 'error' ? ' note-error' : kind === 'ok' ? ' note-ok' : '');
    }

    function priceText(p) {
      if (!p.pricePaise || p.pricePaise <= 0) return 'Free';
      if (p.priceDisplay) return p.priceDisplay;
      return '₹' + (p.pricePaise / 100);
    }

    async function purchase(plan, btn) {
      btn.disabled = true;
      btn.textContent = 'Creating order…';
      setNoteMsg('');
      try {
        const order = await window.dropai.billing.order(plan.slug);
        if (order.error) throw new Error(order.error);
        // Open Razorpay checkout in the system browser.
        const checkoutUrl = order.checkoutUrl || order.url;
        if (checkoutUrl) {
          window.open(checkoutUrl, '_blank', 'noopener');
          setNoteMsg('Complete the payment in your browser, then press Refresh below.', 'ok');
          const refresh = document.createElement('button');
          refresh.type = 'button';
          refresh.className = 'btn btn-small btn-refresh-status';
          refresh.textContent = 'Refresh status';
          refresh.addEventListener('click', async () => {
            const st = await window.dropai.auth.status().catch(() => ({}));
            if (st.user) {
              window.dropaiAuthUser = st.user;
              setProfileAvatar();
              initTrialBadge();
            }
            load();
            refresh.remove();
          });
          noteEl.appendChild(refresh);
        } else {
          setNoteMsg('Order created. Complete payment to activate.', 'ok');
        }
      } catch (err) {
        setNoteMsg('Could not start checkout: ' + err.message, 'error');
      } finally {
        btn.disabled = false;
        btn.textContent = 'Choose ' + plan.name;
      }
    }

    async function load() {
      plansEl.innerHTML = '<p class="muted">Loading plans…</p>';
      setNoteMsg('');
      try {
        // The backend returns { gateway, plans: [...] } — not a bare array.
        const resp = await window.dropai.billing.plans().catch(() => ({}));
        const list = resp && Array.isArray(resp.plans) ? resp.plans : [];
        if (resp && resp.error) setNoteMsg('Could not load plans: ' + resp.error, 'error');
        const user = window.dropaiAuthUser;
        plansEl.innerHTML = '';
        // Always show Free first.
        const free = { slug: 'free', name: 'Free', pricePaise: 0, description: 'Try the basics.' };
        const all = [free, ...list.filter((p) => p && p.slug && p.slug !== 'free')];
        for (const p of all) {
          const card = document.createElement('div');
          const isCurrent = !!(user && user.plan === p.slug);
          card.className = 'sub-plan' + (isCurrent ? ' sub-plan-current' : '');
          const h = document.createElement('h4');
          h.textContent = p.name;
          const price = document.createElement('div');
          price.className = 'sub-price';
          price.textContent = priceText(p);
          const per = document.createElement('small');
          per.textContent = p.pricePaise > 0 ? ' /' + (p.interval || 'month') : '';
          price.appendChild(per);
          const desc = document.createElement('p');
          desc.textContent = p.description || '';
          card.append(h, price, desc);
          if (isCurrent) {
            const cur = document.createElement('span');
            cur.className = 'badge badge-ok';
            cur.textContent = 'Current plan';
            card.appendChild(cur);
          } else if (p.pricePaise > 0) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'btn btn-small btn-primary';
            btn.textContent = 'Choose ' + p.name;
            btn.addEventListener('click', () => purchase(p, btn));
            card.appendChild(btn);
          } else {
            const inc = document.createElement('span');
            inc.className = 'muted';
            inc.textContent = 'Included';
            card.appendChild(inc);
          }
          plansEl.appendChild(card);
        }
      } catch {
        plansEl.innerHTML = '<p class="muted">Could not load plans.</p>';
      }
    }

    // Reload plans every time the Plans screen becomes visible.
    refreshPlansScreen = load;
    load();
  }


  // ---- Sidebar: new chat, settings, upgrade, logout ----
  // Global modal guard: only one modal visible at a time, ever.
  function closeAllModals() {
    for (const id of ['legal-modal']) {
      document.getElementById(id)?.classList.add('hidden');
    }
  }
  function openAppModal(id) {
    closeAllModals();
    document.getElementById(id)?.classList.remove('hidden');
  }

  function initSidebar() {
    const newChatBtn = $('btn-new-chat');
    const settingsBtn = $('btn-open-settings');
    const upgradeBtn = $('btn-upgrade-top');
    if (!newChatBtn) return;

    // New chat: open the AI Chat screen with a fresh thread.
    newChatBtn.addEventListener('click', () => {
      showScreen('chat');
      if (typeof window.dropaiNewChat === 'function') window.dropaiNewChat();
    });

    // Settings is a full screen now (not a popup).
    settingsBtn.addEventListener('click', () => {
      showScreen('settings');
      if (typeof refreshSettingsScreen === 'function') refreshSettingsScreen();
    });

    // Logout.
    $('btn-logout').addEventListener('click', async () => {
      if (!confirm('Sign out of Drop AI?')) return;
      await window.dropai.auth.logout().catch(() => ({}));
      location.reload();
    });

    // Privacy / terms: in-app legal screens (no external browser, no admin login).
    $('btn-privacy').addEventListener('click', () => openLegal('privacy'));
    $('btn-terms').addEventListener('click', () => openLegal('terms'));

    // Upgrade → Plans screen (plans + checkout live on the screen now).
    upgradeBtn.addEventListener('click', () => {
      showScreen('upgrade');
      if (typeof refreshPlansScreen === 'function') refreshPlansScreen();
    });
    const legalModal = $('legal-modal');
    const closeLegal = () => legalModal?.classList.add('hidden');
    $('btn-legal-close')?.addEventListener('click', closeLegal);
    legalModal?.addEventListener('click', (e) => { if (e.target === legalModal) closeLegal(); });

    // Escape closes any open modal — never get stuck.
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        document.getElementById('legal-modal')?.classList.add('hidden');
      }
    });

    initSidebarDrawer();
    initTrialBadge();
    checkPaywallOnStartup();
  }

  // ---- Sidebar drawer: hamburger collapses / expands the sidebar ----
  function initSidebarDrawer() {
    const sidebar = document.querySelector('.sidebar');
    const btn = $('btn-sidebar-toggle');
    if (!sidebar || !btn) return;
    const apply = (collapsed) => {
      sidebar.classList.toggle('sidebar-collapsed', collapsed);
      btn.setAttribute('aria-expanded', String(!collapsed));
      try { localStorage.setItem('dropai-sidebar-collapsed', collapsed ? '1' : '0'); } catch { /* ignore */ }
    };
    let saved = false;
    try { saved = localStorage.getItem('dropai-sidebar-collapsed') === '1'; } catch { /* ignore */ }
    apply(saved);
    btn.addEventListener('click', () => {
      apply(!sidebar.classList.contains('sidebar-collapsed'));
    });
  }

  // ---- Paywall: lock the app when trial expires ----
  function isTrialExpired() {
    const user = window.dropaiAuthUser || {};
    const plan = String(user.plan || 'trial').toLowerCase();
    if (plan !== 'trial') return false; // paid plans never lock
    if (!user.trialEndsAt) return false; // no trial date = no lock
    return new Date(user.trialEndsAt) <= new Date();
  }

  function showPaywall() {
    const overlay = $('paywall-overlay');
    if (!overlay) return;
    overlay.classList.remove('hidden');
    loadPaywallPlans();
  }

  function hidePaywall() {
    const overlay = $('paywall-overlay');
    if (overlay) overlay.classList.add('hidden');
  }

  async function loadPaywallPlans() {
    const plansEl = $('paywall-plans');
    const noteEl = $('paywall-note');
    if (!plansEl) return;
    try {
      const res = await window.dropai.billing.plans().catch(() => ({}));
      const plans = res.plans || res.items || [];
      if (!plans.length) {
        plansEl.innerHTML = '<p class="muted">No plans available. Contact support.</p>';
        return;
      }
      plansEl.innerHTML = '';
      for (const plan of plans) {
        if (String(plan.slug).toLowerCase() === 'trial') continue; // don't show trial
        const card = document.createElement('div');
        card.className = 'plan-card';
        const price = plan.pricePaise > 0 ? '₹' + (plan.pricePaise / 100) : 'Free';
        card.innerHTML = '<h3>' + plan.name + '</h3>' +
          '<div class="plan-price">' + price + '<span>/' + (plan.interval || 'month') + '</span></div>' +
          '<p class="muted">' + (plan.description || '') + '</p>';
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn btn-primary';
        btn.textContent = 'Choose ' + plan.name;
        btn.addEventListener('click', () => purchasePaywallPlan(plan, btn));
        card.appendChild(btn);
        plansEl.appendChild(card);
      }
    } catch (err) {
      if (noteEl) noteEl.textContent = 'Could not load plans: ' + err.message;
    }
  }

  async function purchasePaywallPlan(plan, btn) {
    const noteEl = $('paywall-note');
    btn.disabled = true;
    btn.textContent = 'Creating order…';
    try {
      const order = await window.dropai.billing.order(plan.slug);
      if (order.error) throw new Error(order.error);
      const checkoutUrl = order.checkoutUrl || order.url;
      if (checkoutUrl) {
        window.open(checkoutUrl, '_blank', 'noopener');
        if (noteEl) {
          noteEl.innerHTML = 'Complete the payment in your browser, then ';
          const refresh = document.createElement('button');
          refresh.type = 'button';
          refresh.className = 'btn btn-small';
          refresh.textContent = 'I\'ve paid — unlock';
          refresh.addEventListener('click', checkPaywallUnlock);
          noteEl.appendChild(refresh);
        }
      }
    } catch (err) {
      if (noteEl) noteEl.textContent = 'Could not start checkout: ' + err.message;
      btn.disabled = false;
      btn.textContent = 'Choose ' + plan.name;
    }
  }

  async function checkPaywallUnlock() {
    const noteEl = $('paywall-note');
    try {
      const st = await window.dropai.auth.status().catch(() => ({}));
      if (st.user) {
        window.dropaiAuthUser = st.user;
        if (!isTrialExpired()) {
          hidePaywall();
          initTrialBadge();
          if (noteEl) noteEl.textContent = '';
        } else {
          if (noteEl) noteEl.textContent = 'Payment not detected yet. Complete the payment and try again.';
        }
      }
    } catch (err) {
      if (noteEl) noteEl.textContent = 'Could not check status: ' + err.message;
    }
  }

  // Check paywall on startup (after auth loads).
  function checkPaywallOnStartup() {
    if (isTrialExpired()) showPaywall();
  }

  // ---- Trial / plan badge: animated Lottie badge pinned to the sidebar bottom ----
  function initTrialBadge() {
    const wrap = $('plan-badge-wrap');
    if (!wrap) return;
    const user = window.dropaiAuthUser || {};
    const plan = String(user.plan || 'trial').toLowerCase();
    const label = $('plan-badge-label');
    if (plan === 'trial' && user.trialEndsAt) {
      const days = Math.max(0, Math.ceil((new Date(user.trialEndsAt) - Date.now()) / 86400000));
      if (label) label.textContent = `TRIAL \u00B7 ${days} day${days === 1 ? '' : 's'} left`;
    } else if (label) {
      label.textContent = plan.toUpperCase();
    }
    wrap.classList.remove('hidden');
    // Render the animated badge once (lottie-web ships locally in vendor/).
    if (wrap.dataset.lottieDone || typeof window.lottie === 'undefined') return;
    wrap.dataset.lottieDone = '1';
    const animEl = $('plan-badge-anim');
    if (!animEl) return;
    try {
      window.lottie.loadAnimation({
        container: animEl,
        renderer: 'svg',
        loop: true,
        autoplay: true,
        path: '../assets/premium-badge.json',
      });
    } catch { /* badge stays static */ }
  }

  // ---- In-app legal screens (Privacy policy / Terms of service) ----
  const LEGAL_TEXT = {
    privacy: {
      title: 'Privacy Policy',
      body: `Drop AI is built by Dork Industry. This policy explains what data the app handles.

1. Account data. When you sign in with email OTP we store your email address, display name and subscription status on our backend (mcpagent.cloud) so the app can verify your plan.

2. Local-first processing. Your Premiere Pro projects, media files, reference videos and knowledgebase documents stay on your computer. They are never uploaded to our servers unless you explicitly use a cloud feature (preset library downloads, Drive storage).

3. Preset library. Downloading presets contacts mcpagent.cloud; downloads are counted per user for licensing. No project content is sent.

4. AI chatbox. Chat messages are sent to our backend, which forwards them to the configured LLM provider to generate a reply. Messages are not sold or used for advertising.

5. Device check. On startup the app sends a device identifier to mcpagent.cloud to enforce blocks for abuse. Blocked devices are refused service.

6. Payments. Subscriptions are processed by Razorpay. We never see or store your card details.

7. Your rights. Email support@dorkindustry.com to request export or deletion of your account data.

Last updated: October 2026.`,
    },
    terms: {
      title: 'Terms of Service',
      body: `Drop AI is a desktop product by Dork Industry. By using the app you agree to these terms.

1. License. Your subscription grants you a personal, non-transferable license to use Drop AI on your own machines. Sharing accounts or reselling access is not allowed.

2. Free trial. New accounts get a 14-day free trial. After the trial ends, paid plans are required for continued use except where a free plan is offered.

3. Subscriptions & refunds. Plans bill monthly via Razorpay. Refunds are handled case-by-case within 7 days of purchase \u2014 contact support@dorkindustry.com.

4. Acceptable use. You may not use Drop AI to infringe copyrights, generate unlawful content, or attack our backend services. We may block devices or accounts that abuse the service.

5. AI output. The AI chatbox and reference-video analysis are assistive tools; outputs may be inaccurate. You are responsible for reviewing edits before publishing.

6. Availability. We aim for high availability of mcpagent.cloud but do not guarantee uninterrupted service. Local editing features keep working offline.

7. Changes. We may update these terms; continued use after changes means acceptance.

Contact: support@dorkindustry.com \u2014 Dork Industry.

Last updated: October 2026.`,
    },
  };

  function openLegal(which) {
    const doc = LEGAL_TEXT[which] || LEGAL_TEXT.privacy;
    const modal = $('legal-modal');
    if (!modal) return;
    $('legal-title').textContent = doc.title;
    $('legal-body').textContent = doc.body;
    openAppModal('legal-modal');
  }

  // ---- CEP panel one-click install ----
  //
  // Copies the bundled panel into Adobe's CEP extensions folder and enables
  // Multi-app CEP panel installer — one row per available panel
  // (Premiere Pro, Animate, After Effects…). Each installs independently.
  function initCepInstall() {
    const listEl = $('cep-panels-list');
    if (!listEl || !window.dropai.cepPanel) return;

    // App display names for known plugin IDs.
    const appNames = {
      'premiere': 'Premiere Pro',
      'animate': 'Animate',
      'after-effects': 'After Effects',
      'aftereffects': 'After Effects',
    };
    const appNameFor = (pluginId) => {
      const id = String(pluginId || '').toLowerCase();
      for (const [key, name] of Object.entries(appNames)) {
        if (id.includes(key)) return name;
      }
      return pluginId;
    };

    async function renderPanels() {
      listEl.innerHTML = '';
      let panels = [];
      try {
        const res = await window.dropai.cepPanel.list();
        panels = (res && res.panels) || [];
      } catch { /* show empty */ }

      if (panels.length === 0) {
        const p = document.createElement('p');
        p.className = 'cep-install-status';
        p.textContent = 'No CEP panels available.';
        listEl.appendChild(p);
        return;
      }

      for (const panel of panels) {
        const row = document.createElement('div');
        row.className = 'cep-panel-row';

        const info = document.createElement('div');
        info.className = 'cep-panel-info';
        const appName = appNameFor(panel.pluginId);
        info.innerHTML = `<strong>${escapeHtml(panel.name)}</strong><span class="cep-panel-app">${escapeHtml(appName)}</span>`;

        const btn = document.createElement('button');
        btn.className = 'btn btn-small';
        btn.type = 'button';
        btn.textContent = 'Install panel';

        const status = document.createElement('p');
        status.className = 'cep-install-status';
        status.setAttribute('aria-live', 'polite');

        // Check current status.
        try {
          const s = await window.dropai.cepPanel.statusFor(panel.pluginId);
          if (s && s.installed) {
            status.textContent = `${appName} panel is installed.`;
            status.classList.add('ok');
            btn.textContent = 'Reinstall panel';
          }
        } catch { /* ignore */ }

        btn.addEventListener('click', async () => {
          btn.disabled = true;
          status.textContent = 'Installing panel…';
          status.className = 'cep-install-status';
          try {
            const res = await window.dropai.cepPanel.installFor(panel.pluginId);
            if (res && res.ok) {
              status.textContent = `Installed. Restart ${appName}, then open Window > Extensions > Drop AI.`;
              status.classList.add('ok');
              btn.textContent = 'Reinstall panel';
            } else {
              const failed = (res && res.steps || []).filter((st) => !st.ok).map((st) => st.error || st.name).join('; ');
              status.textContent = `Install had a problem: ${failed || 'unknown error'}.`;
              status.classList.add('error');
            }
          } catch (err) {
            status.textContent = 'Install failed unexpectedly — retry.';
            status.classList.add('error');
          } finally {
            btn.disabled = false;
          }
        });

        row.appendChild(info);
        row.appendChild(btn);
        listEl.appendChild(row);
        listEl.appendChild(status);
      }
    }

    renderPanels();
  }

  function escapeHtml(str) {
    return String(str || '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  // ---- plugins ----
  //
  // One status section per installed plugin (Premiere's section stays static
  // in the HTML so it renders even before the plugin list arrives), plus the
  // Plugins manager table and the Library tab's host filter.

  let pluginList = [];

  function renderPluginSections() {
    const grid = document.querySelector('.status-grid');
    if (!grid) return;
    grid.querySelectorAll('[data-plugin-host]').forEach((el) => el.remove());
    for (const p of pluginList) {
      if (!p || p.id === 'premiere' || !p.hostId) continue;
      const card = document.createElement('article');
      card.className = 'card status-card';
      card.dataset.pluginHost = p.hostId;
      const head = document.createElement('div');
      head.className = 'status-head';
      const dot = document.createElement('span');
      dot.id = `dot-host-${p.hostId}`;
      dot.className = 'dot dot-stopped';
      const h2 = document.createElement('h2');
      h2.textContent = p.name || p.id;
      head.append(dot, h2);
      const detail = document.createElement('p');
      detail.id = `detail-host-${p.hostId}`;
      detail.className = 'detail';
      detail.textContent = 'not running';
      const meta = document.createElement('p');
      meta.className = 'meta';
      meta.textContent = `via the Drop AI ${p.name || p.id} panel`;
      card.append(head, detail, meta);
      grid.appendChild(card);
    }
  }

  function pluginRow(p) {
    const tr = document.createElement('tr');
    const tdName = document.createElement('td');
    tdName.textContent = p.name || p.id;
    if (p.builtin) {
      const badge = document.createElement('span');
      badge.className = 'pill';
      badge.textContent = 'built-in';
      tdName.appendChild(document.createTextNode(' '));
      tdName.appendChild(badge);
    }
    const tdVer = document.createElement('td');
    tdVer.textContent = p.version || '—';
    const tdHost = document.createElement('td');
    tdHost.textContent = p.hostId || '—';
    const tdActions = document.createElement('td');
    tdActions.className = 'td-actions';
    if (!p.builtin) {
      const un = document.createElement('button');
      un.type = 'button';
      un.className = 'btn btn-small btn-danger-ghost';
      un.textContent = 'Uninstall';
      un.addEventListener('click', async () => {
        if (!window.confirm(`Uninstall the "${p.name || p.id}" plugin?`)) return;
        const res = await window.dropai.plugins.uninstall(p.id);
        const errMsg = errorResult(res);
        if (errMsg || (res && res.ok === false)) {
          setNote('plugin-note', errMsg || (res && res.error) || 'Uninstall failed.', 'error');
        } else {
          setNote('plugin-note', `Uninstalled "${p.name || p.id}".`, 'ok');
          await refreshPlugins();
        }
      });
      tdActions.appendChild(un);
    }
    tr.append(tdName, tdVer, tdHost, tdActions);
    return tr;
  }

  function renderPluginManager() {
    const tbody = $('plugin-tbody');
    if (!tbody) return;
    tbody.innerHTML = '';
    if (pluginList.length === 0) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 4;
      td.className = 'table-empty';
      td.textContent = 'No plugins found.';
      tr.appendChild(td);
      tbody.appendChild(tr);
      return;
    }
    for (const p of pluginList) tbody.appendChild(pluginRow(p));
  }

  function renderLibHostFilter() {
    const sel = $('lib-host-filter');
    if (!sel) return;
    const cur = sel.value;
    sel.innerHTML = '';
    const all = document.createElement('option');
    all.value = '';
    all.textContent = 'All hosts';
    sel.appendChild(all);
    for (const p of pluginList) {
      if (!p.hostId) continue;
      const o = document.createElement('option');
      o.value = p.hostId;
      o.textContent = p.name || p.id;
      sel.appendChild(o);
    }
    const stillThere = [...sel.options].some((o) => o.value === cur);
    sel.value = stillThere ? cur : '';
    libState.hostId = sel.value;
  }

  async function refreshPlugins() {
    try {
      const res = await window.dropai.plugins.list();
      pluginList = Array.isArray(res) ? res : [];
    } catch {
      pluginList = [];
    }
    renderPluginSections();
    renderPluginManager();
    renderLibHostFilter();
  }

  function initPlugins() {
    if (!window.dropai.plugins) return;
    const installBtn = $('btn-plugin-install');
    const refreshBtn = $('btn-plugin-refresh');
    if (installBtn) {
      installBtn.addEventListener('click', async () => {
        installBtn.disabled = true;
        setNote('plugin-note', 'Choose a .dropai-plugin file…');
        try {
          const res = await window.dropai.plugins.install();
          const errMsg = errorResult(res);
          if (errMsg || (res && res.ok === false)) {
            setNote('plugin-note', errMsg || (res && res.error) || 'Install failed.', 'error');
          } else if (res && res.canceled) {
            setNote('plugin-note', '');
          } else {
            setNote(
              'plugin-note',
              `Installed "${(res && res.manifest && res.manifest.name) || 'plugin'}".`,
              'ok',
            );
            await refreshPlugins();
          }
        } catch (err) {
          setNote('plugin-note', `Install failed: ${err.message}`, 'error');
        } finally {
          installBtn.disabled = false;
        }
      });
    }
    if (refreshBtn) {
      refreshBtn.addEventListener('click', () => {
        setNote('plugin-note', '');
        refreshPlugins();
      });
    }
    refreshPlugins();
  }

  function init() {
    if (!window.dropai) {
      document.body.innerHTML = '<p style="padding:40px">Launcher bridge unavailable.</p>';
      return;
    }

    // ---- theme (Phase C): dark / light toggle, persisted ----
    initTheme();

    // ---- auth gate (Phase A: subscriptions) ----
    // Block the UI behind login until the user is authenticated with an
    // active subscription. Runs before any other init.
    initAuthGate(() => {
      initMain();
    });
  }

  /* ---------------- theme ---------------- */
  function initTheme() {
    const root = document.documentElement;
    const btn = document.getElementById('theme-toggle');
    const apply = (theme) => {
      root.setAttribute('data-theme', theme);
      try { localStorage.setItem('dropai-theme', theme); } catch { /* ignore */ }
      if (btn) btn.textContent = theme === 'dark' ? '☀' : '◐';
    };
    let saved = 'light';
    try { saved = localStorage.getItem('dropai-theme') || 'light'; } catch { /* ignore */ }
    apply(saved === 'dark' ? 'dark' : 'light');
    if (btn) {
      btn.addEventListener('click', () => {
        const next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
        apply(next);
      });
    }
  }

  /* ---------------- auth gate ---------------- */
  // Local profile (display name + picture), persisted via the main process.
  // The backend has no profile-update endpoint, so this is the source of
  // truth for what the user sees; the account name/email still come from
  // the signed-in user.
  let localProfile = {};

  async function loadLocalProfile() {
    try {
      localProfile = (await window.dropai.profile.get().catch(() => ({}))) || {};
    } catch { localProfile = {}; }
  }

  function setProfileAvatar() {
    const user = window.dropaiAuthUser || {};
    const name = (localProfile.name || user.name || '').trim();
    const initial = (name || user.email || '?').trim().charAt(0).toUpperCase() || '?';
    // Topbar avatar.
    const avatar = $('profile-avatar');
    if (avatar) {
      avatar.innerHTML = '';
      if (localProfile.avatar) {
        const img = document.createElement('img');
        img.src = localProfile.avatar;
        img.alt = 'Profile';
        img.className = 'profile-avatar-img';
        avatar.appendChild(img);
      } else {
        const sp = document.createElement('span');
        sp.id = 'profile-initial';
        sp.textContent = initial;
        avatar.appendChild(sp);
      }
      avatar.title = user.email || 'Profile';
    }
    // Settings screen avatar + name field.
    const sAvatar = $('settings-avatar');
    if (sAvatar) {
      sAvatar.innerHTML = '';
      if (localProfile.avatar) {
        const img = document.createElement('img');
        img.src = localProfile.avatar;
        img.alt = 'Profile picture';
        sAvatar.appendChild(img);
      } else {
        const sp = document.createElement('span');
        sp.id = 'settings-avatar-initial';
        sp.textContent = initial;
        sAvatar.appendChild(sp);
      }
    }
    const nameInput = $('settings-name');
    if (nameInput && document.activeElement !== nameInput) {
      nameInput.value = localProfile.name || user.name || '';
    }
  }

  // ---- Settings screen (full screen, not a popup) ----
  function initSettingsScreen() {
    const saveBtn = $('btn-save-profile');
    if (saveBtn) saveBtn.addEventListener('click', async () => {
      const input = $('settings-name');
      const v = (input ? input.value : '').trim().slice(0, 120);
      saveBtn.disabled = true;
      try {
        const res = await window.dropai.profile.set({ name: v }).catch(() => ({ error: 'Could not save.' }));
        if (res && res.error) {
          setNote('settings-profile-note', res.error, 'error');
          return;
        }
        localProfile = res || {};
        setProfileAvatar();
        setNote('settings-profile-note', 'Profile saved.', 'ok');
      } finally {
        saveBtn.disabled = false;
      }
    });
    const picBtn = $('btn-edit-avatar');
    if (picBtn) picBtn.addEventListener('click', async () => {
      picBtn.disabled = true;
      try {
        const picked = await window.dropai.profile.pickAvatar().catch(() => ({ error: 'Could not open the picker.' }));
        if (!picked || picked.canceled) return;
        if (picked.error) {
          setNote('settings-profile-note', picked.error, 'error');
          return;
        }
        const saved = await window.dropai.profile.set({ avatar: picked.dataUrl }).catch(() => ({ error: 'Could not save.' }));
        if (saved && saved.error) {
          setNote('settings-profile-note', saved.error, 'error');
          return;
        }
        localProfile = saved || {};
        setProfileAvatar();
        setNote('settings-profile-note', 'Profile picture updated.', 'ok');
      } finally {
        picBtn.disabled = false;
      }
    });
    refreshSettingsScreen = async () => {
      try {
        const v = await window.dropai.appVersion().catch(() => null);
        const el = $('settings-version');
        if (el) el.textContent = v || 'unknown';
      } catch {
        const el = $('settings-version');
        if (el) el.textContent = 'unknown';
      }
      await loadLocalProfile();
      setProfileAvatar();
    };
    loadLocalProfile().then(setProfileAvatar);
  }

  function initAuthGate(onAuthed) {
    const overlay = document.createElement('div');
    overlay.id = 'auth-gate';
    overlay.className = 'auth-gate';
    document.body.appendChild(overlay);

    const show = (html) => { overlay.innerHTML = html; overlay.style.display = 'flex'; };
    const hide = () => { overlay.style.display = 'none'; };

    // Playful mascot illustration (pure SVG, no assets): four blobs whose
    // pupils track the cursor and who blink periodically. Matches the
    // reference login animation the user picked.
    const blobsSvg = `
      <svg class="blob-svg" viewBox="0 25 320 240" aria-hidden="true">
        <ellipse cx="162" cy="248" rx="118" ry="13" fill="rgba(30,20,60,0.10)"/>
        <g class="sparkle" transform="translate(58,58)">
          <path d="M0,-9 V9 M-9,0 H9" stroke="#a78bfa" stroke-width="3.5" stroke-linecap="round"/>
        </g>
        <g class="sparkle sparkle-s2" transform="translate(266,46)">
          <path d="M0,-7 V7 M-7,0 H7" stroke="#f0abfc" stroke-width="3" stroke-linecap="round"/>
        </g>
        <g class="blob">
          <rect x="98" y="58" width="70" height="182" rx="26" fill="#7c3aed"/>
          <g class="eye"><ellipse cx="116" cy="98" rx="8.5" ry="10.5" fill="#fff"/><circle class="pupil" cx="116" cy="99" r="4.2" fill="#1e1b2e"/></g>
          <g class="eye eye-d1"><ellipse cx="150" cy="98" rx="8.5" ry="10.5" fill="#fff"/><circle class="pupil" cx="150" cy="99" r="4.2" fill="#1e1b2e"/></g>
        </g>
        <g class="blob blob-b">
          <rect x="174" y="106" width="54" height="134" rx="20" fill="#ec4899"/>
          <g class="eye eye-d2"><ellipse cx="188" cy="140" rx="8" ry="10" fill="#fff"/><circle class="pupil" cx="188" cy="141" r="4" fill="#1e1b2e"/></g>
          <g class="eye eye-d2"><ellipse cx="212" cy="140" rx="8" ry="10" fill="#fff"/><circle class="pupil" cx="212" cy="141" r="4" fill="#1e1b2e"/></g>
        </g>
        <g class="blob blob-c">
          <path d="M50,240 A50,50 0 0 1 150,240 Z" fill="#fb923c"/>
          <g class="eye"><ellipse cx="82" cy="214" rx="8" ry="10" fill="#fff"/><circle class="pupil" cx="82" cy="215" r="4" fill="#1e1b2e"/></g>
          <g class="eye eye-d3"><ellipse cx="118" cy="214" rx="8" ry="10" fill="#fff"/><circle class="pupil" cx="118" cy="215" r="4" fill="#1e1b2e"/></g>
          <path d="M88,226 Q100,234 112,226" stroke="#7c2d12" stroke-width="3" fill="none" stroke-linecap="round"/>
        </g>
        <g class="blob blob-d">
          <rect x="186" y="172" width="60" height="68" rx="22" fill="#facc15"/>
          <g class="eye eye-d1"><ellipse cx="216" cy="200" rx="9" ry="11" fill="#fff"/><circle class="pupil" cx="216" cy="201" r="4.5" fill="#1e1b2e"/></g>
        </g>
      </svg>`;

    const authShell = (formHtml) => `
      <div class="auth-split">
        <div class="auth-visual">${blobsSvg}</div>
        <div class="auth-form">${formHtml}</div>
      </div>`;

    const loginHtml = (msg = '') => authShell(`
        <img src="../assets/logo.png" class="auth-logo-img" alt="Drop AI" />
        <h2>Welcome back!</h2>
        <p class="auth-sub">Sign in with your email to continue.</p>
        ${msg ? `<p class="auth-msg">${msg}</p>` : ''}
        <form id="auth-email-form">
          <input id="auth-email" class="auth-input" type="email" placeholder="you@example.com" required autocomplete="email" />
          <button class="btn-primary auth-btn" type="submit">Send login code</button>
        </form>
        <p class="auth-hint">New here? A 14-day free trial starts on your first login.</p>`);

    const otpHtml = (email, msg = '') => authShell(`
        <img src="../assets/logo.png" class="auth-logo-img" alt="Drop AI" />
        <h2>Check your email</h2>
        <p class="auth-sub">We sent a 6-digit code to <b>${email}</b>.</p>
        ${msg ? `<p class="auth-msg">${msg}</p>` : ''}
        <form id="auth-otp-form">
          <input id="auth-otp" class="auth-input auth-otp" type="text" inputmode="numeric" maxlength="6" placeholder="••••••" required autocomplete="one-time-code" />
          <input id="auth-name" class="auth-input" type="text" placeholder="Your name (optional)" autocomplete="name" />
          <button class="btn-primary auth-btn" type="submit">Verify &amp; sign in</button>
        </form>
        <button id="auth-back" class="auth-link">← use a different email</button>`);

    const blockedHtml = (msg) => authShell(`
        <img src="../assets/logo.png" class="auth-logo-img" alt="Drop AI" />
        <h2>Access blocked</h2>
        <p class="auth-sub">${msg || 'Your account has been blocked — contact support.'}</p>`);

    const expiredHtml = (plan) => authShell(`
        <img src="../assets/logo.png" class="auth-logo-img" alt="Drop AI" />
        <h2>Subscription ended</h2>
        <p class="auth-sub">Your ${plan || ''} plan has expired. Renew to keep using Drop AI.</p>
        <button id="auth-renew" class="btn-primary auth-btn">See plans</button>
        <button id="auth-logout" class="auth-link">Sign out</button>`);

    async function check() {
      try {
        const st = await window.dropai.auth.status();
        if (!st.loggedIn) { show(loginHtml()); wireLogin(); return; }
        if (st.code === 'ACCOUNT_BLOCKED') { show(blockedHtml(st.error)); return; }
        if (st.code === 'SUBSCRIPTION_REQUIRED') { show(expiredHtml(st.plan)); wireExpired(); return; }
        if (st.tokenStale) { show(loginHtml('Session expired — please sign in again.')); wireLogin(); return; }
        window.dropaiAuthUser = st.user;
        setProfileAvatar(st.user);
        hide();
        onAuthed();
      } catch (err) {
        show(loginHtml('Could not reach the server — check your connection and retry.'));
        wireLogin();
      }
    }

    function wireLogin() {
      const form = document.getElementById('auth-email-form');
      if (!form) return;
      document.getElementById('auth-email').focus();
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const email = document.getElementById('auth-email').value.trim();
        const btn = form.querySelector('button');
        btn.disabled = true;
        btn.textContent = 'Sending…';
        const res = await window.dropai.auth.requestOtp(email);
        if (res.error) {
          show(loginHtml(res.error));
          wireLogin();
          return;
        }
        show(otpHtml(email));
        wireOtp(email);
      });
    }

    function wireOtp(email) {
      const form = document.getElementById('auth-otp-form');
      document.getElementById('auth-back').addEventListener('click', () => { show(loginHtml()); wireLogin(); });
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const otp = document.getElementById('auth-otp').value.trim();
        const name = document.getElementById('auth-name').value.trim();
        const btn = form.querySelector('button');
        btn.disabled = true;
        btn.textContent = 'Verifying…';
        const res = await window.dropai.auth.verifyOtp(email, otp, name);
        if (res.error) {
          show(otpHtml(email, res.error));
          wireOtp(email);
          return;
        }
        window.dropaiAuthUser = res.user;
        setProfileAvatar(res.user);
        hide();
        onAuthed();
      });
      document.getElementById('auth-otp').focus();
    }

    function wireExpired() {
      document.getElementById('auth-renew').addEventListener('click', async () => {
        // v1: open the billing portal — plans shown in-app in Phase A desktop.
        // For now, direct the user to contact support; the upgrade UI lands
        // with the Phase C redesign.
        show(expiredHtml() + '');
      });
      document.getElementById('auth-logout').addEventListener('click', async () => {
        await window.dropai.auth.logout();
        show(loginHtml());
        wireLogin();
      });
    }

    check();
  }

  function initMain() {
    $('btn-start').addEventListener('click', () => window.dropai.start().then(applyStatus));
    $('btn-stop').addEventListener('click', () => window.dropai.stop().then(applyStatus));
    $('btn-retry').addEventListener('click', () => window.dropai.retry().then(applyStatus));
    initCepInstall();
    initPlugins();
    initHomeBanner();
    initNewChatScreen();
    initOtaUpdater();
    initPlansScreen();
    initSettingsScreen();
    initSidebar();
    $('btn-clear-logs').addEventListener('click', () => {
      window.dropai.clearLogs();
      logLines = [];
      renderLogs(false);
    });
    // Phase D: logs hidden behind a Details toggle — simple status is the default.
    const detailsBtn = $('btn-log-details');
    const detailsWrap = $('log-details-wrap');
    if (detailsBtn && detailsWrap) {
      detailsBtn.addEventListener('click', () => {
        const showing = detailsWrap.classList.toggle('hidden');
        detailsBtn.textContent = showing ? 'Details' : 'Hide details';
      });
    }

    $('btn-token-copy').addEventListener('click', async () => {
      await window.dropai.token.copy();
      $('token-note').textContent = 'Copied to clipboard.';
    });
    $('btn-token-reveal').addEventListener('click', async () => {
      const { token } = await window.dropai.token.reveal();
      stopReveal();
      $('token-value').textContent = token;
      $('token-note').textContent = 'Revealed — auto-remasking in 10 s. Never share this token.';
      revealTimer = setTimeout(() => {
        revealTimer = null;
        refreshMasked();
      }, 10_000);
    });
    $('btn-token-rotate').addEventListener('click', async () => {
      const masked = await window.dropai.token.rotate();
      stopReveal();
      $('token-value').textContent = masked;
      $('token-note').textContent = 'Token rotated. Update any remote clients using the old token.';
    });

    $('btn-http-toggle').addEventListener('click', async () => {
      const btn = $('btn-http-toggle');
      btn.disabled = true;
      try {
        const running = btn.dataset.running === '1';
        if (running) {
          // Stop everything: tunnel first, then the HTTP server.
          try { await window.dropai.tunnel.stop(); } catch { /* already stopped */ }
          const status = await window.dropai.http.stop();
          if (status && status.error) {
            $('http-note').textContent = `Could not stop the remote server: ${status.error}`;
          }
          $('tunnel-url-box').classList.add('hidden');
        } else {
          // One click: start the HTTP server, then the tunnel.
          btn.textContent = 'Starting server…';
          const status = await window.dropai.http.start();
          if (status && status.error) throw new Error(status.error);
          // Auto-start the tunnel (downloads cloudflared on first use).
          btn.textContent = 'Starting tunnel…';
          $('http-note').textContent = 'Starting secure tunnel… (first run downloads the tunnel helper)';
          try {
            window.dropai.tunnel.onProgress((msg) => {
              $('http-note').textContent = msg;
            });
            const tres = await window.dropai.tunnel.start();
            if (tres && tres.error) throw new Error(tres.error);
            const publicUrl = (tres.url || '') + '/mcp';
            $('tunnel-public-url').textContent = publicUrl;
            $('tunnel-url-box').classList.remove('hidden');
            $('http-note').textContent = 'Live! Copy the public URL above into Claude / ChatGPT / any LLM.';
          } catch (terr) {
            $('http-note').textContent = 'Server is running locally, but the tunnel failed: ' + terr.message;
          }
        }
      } catch (err) {
        $('http-note').textContent = `Could not start the remote server: ${err.message}`;
      } finally {
        btn.disabled = false;
        await refreshHttpStatus(false);
      }
    });
    // Copy the public tunnel URL.
    $('btn-tunnel-copy').addEventListener('click', async () => {
      const url = $('tunnel-public-url').textContent || '';
      if (!url) return;
      try {
        await navigator.clipboard.writeText(url);
        const btn = $('btn-tunnel-copy');
        const orig = btn.textContent;
        btn.textContent = 'Copied ✓';
        setTimeout(() => { btn.textContent = orig; }, 1500);
      } catch {
        // Fallback: select the text so the user can copy manually.
        const range = document.createRange();
        range.selectNodeContents($('tunnel-public-url'));
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      }
    });

    window.dropai.onStatus(applyStatus);
    // Keep the remote-server dot/button in sync when the HTTP child
    // crashes or restarts on its own. Note text is left alone here so
    // error messages survive status broadcasts.
    window.dropai.onStatus(() => refreshHttpStatus(false));
    window.dropai.onLog(appendLog);

    // ---- dock navigation ----
    for (const btn of document.querySelectorAll('.dock-item')) {
      btn.addEventListener('click', () => showScreen(btn.dataset.screen));
    }

    // ---- reference video ----
    $('btn-ref-refresh').addEventListener('click', refreshReferences);
    initLibraryTab();    $('btn-ref-pick').addEventListener('click', async () => {
      const btn = $('btn-ref-pick');
      btn.disabled = true;
      setNote('ref-note', '');
      $('ref-result').classList.add('hidden');
      $('ref-progress-wrap').classList.remove('hidden');
      $('ref-progress-fill').style.width = '0%';
      $('ref-progress-label').textContent = 'Starting analysis…';
      const off = window.dropai.reference.onProgress((_event, p) => {
        const label = (p && (p.message || p.phase)) || 'Working…';
        // Show real progress when the backend reports done/total (e.g. transitions)
        const done = p && typeof p.done === 'number' ? p.done : null;
        const total = p && typeof p.total === 'number' && p.total > 0 ? p.total : null;
        if (done !== null && total !== null) {
          $('ref-progress-label').textContent = `${label} (${done}/${total})`;
          $('ref-progress-fill').style.width = `${Math.round((done / total) * 100)}%`;
        } else {
          $('ref-progress-label').textContent = label;
          // Indeterminate: pulse the bar while phases run.
          $('ref-progress-fill').style.width = '45%';
        }
      });
      try {
        const res = await window.dropai.reference.analyze({});
        const errMsg = errorResult(res);
        if (errMsg) throw new Error(errMsg);
        if (res.canceled) {
          setNote('ref-note', 'No video selected.');
          return;
        }
        $('ref-progress-fill').style.width = '100%';
        $('ref-progress-label').textContent = 'Done.';
        const dnaRes = await window.dropai.reference.get(res.summary.slug);
        const dnaErr = errorResult(dnaRes);
        if (dnaErr) throw new Error(dnaErr);
        renderReferenceSummary(dnaRes.dna);
        refreshReferences();
      } catch (err) {
        setNote('ref-note', `Analysis failed: ${err.message}`, 'error');
      } finally {
        off();
        btn.disabled = false;
        window.setTimeout(() => $('ref-progress-wrap').classList.add('hidden'), 2000);
      }
    });

    // ---- knowledge ----
    $('btn-kb-upload').addEventListener('click', () => kbUpload(undefined));    $('btn-kb-search').addEventListener('click', kbSearch);
    $('kb-search-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') kbSearch();
    });

    // Knowledge folder button — opens the watch folder in Explorer
    $('btn-kb-watchdir').addEventListener('click', async () => {
      const res = await window.dropai.knowledge.openWatchDir();
      const errMsg = errorResult(res);
      if (errMsg) setNote('kb-note', errMsg, 'error');
    });
    // Manual scan button — picks up files the watcher might have missed
    $('btn-kb-scan').addEventListener('click', async () => {
      const btn = $('btn-kb-scan');
      btn.disabled = true;
      btn.textContent = 'Scanning…';
      try {
        const res = await window.dropai.knowledge.scanWatchDir();
        const errMsg = errorResult(res);
        if (errMsg) setNote('kb-note', errMsg, 'error');
        else {
          setNote('kb-note', 'Folder scanned.', 'ok');
          refreshKnowledge();
        }
      } finally {
        btn.disabled = false;
        btn.textContent = 'Scan folder';
      }
    });
    // Show the watch folder path in the hint
    window.dropai.knowledge.getWatchDir().then((res) => {
      if (res?.path) {
        $('kb-watch-hint').innerHTML = `Drop files into <code>${res.path}</code> and they appear here automatically.`;
      }
    }).catch(() => {});
    // Auto-refresh when the watch folder ingests a file
    window.dropai.knowledge.onWatchUpdate(({ filename, chunks }) => {
      setNote('kb-note', `"${filename}" added to knowledge (${chunks} chunks).`, 'ok');
      refreshKnowledge();
    });

    // Background ingestion progress — show live progress bar
    // (ingestProgress is module-level, shared with refreshKnowledge)
    window.dropai.knowledge.onIngestProgress((evt) => {
      const { source, phase, done, total, status, error } = evt;
      ingestProgress[source] = evt;
      const wrap = $('kb-ingest-progress-wrap');
      const fill = $('kb-ingest-progress-fill');
      const label = $('kb-ingest-progress-label');
      if (status === 'ready' || status === 'failed') {
        delete ingestProgress[source];
        // Refresh the list to show the new source (or failed status)
        refreshKnowledge();
        if (status === 'ready') {
          setNote('kb-note', `Ingestion complete: ${source}`, 'ok');
        } else {
          setNote('kb-note', `Ingestion failed for ${source}: ${error || 'unknown error'}`, 'error');
        }
      }
      // Show progress for any active ingestions
      const active = Object.values(ingestProgress);
      if (active.length > 0) {
        wrap.classList.remove('hidden');
        // Show the most recent one
        const latest = active[active.length - 1];
        const pct = latest.total > 0 ? Math.round((latest.done / latest.total) * 100) : 0;
        fill.style.width = `${pct}%`;
        const phaseLabel = { extracting: 'Extracting content…', chunking: 'Creating packets…', embedding: 'Embedding for search…' }[latest.phase] || latest.phase;
        label.textContent = `${latest.source}: ${phaseLabel} ${pct}%`;
      } else {
        wrap.classList.add('hidden');
      }
    });

    // Seed knowledge toggle
    const seedChk = $('chk-kb-seed');
    window.dropai.knowledge.getSeedEnabled().then((res) => {
      if (res && typeof res.enabled === 'boolean') seedChk.checked = res.enabled;
    }).catch(() => {});
    seedChk.addEventListener('change', async () => {
      const res = await window.dropai.knowledge.setSeedEnabled(seedChk.checked);
      const errMsg = errorResult(res);
      if (errMsg) {
        setNote('kb-note', errMsg, 'error');
        seedChk.checked = !seedChk.checked;
      } else {
        setNote('kb-note', seedChk.checked ? 'Preset guides will be included on next Reindex.' : 'Preset guides removed.', 'ok');
        refreshKnowledge();
      }
    });

    // Remove all button
    $('btn-kb-removeall').addEventListener('click', async () => {
      if (!window.confirm('Remove ALL knowledge sources? This cannot be undone.')) return;
      const res = await window.dropai.knowledge.removeAll();
      const errMsg = errorResult(res);
      if (errMsg) setNote('kb-note', errMsg, 'error');
      else {
        setNote('kb-note', `Removed ${res.removed ?? 0} source(s).`, 'ok');
        refreshKnowledge();
      }
    });

    $('btn-kb-reindex').addEventListener('click', async () => {
      const btn = $('btn-kb-reindex');
      btn.disabled = true;
      $('kb-progress-wrap').classList.remove('hidden');
      $('kb-progress-fill').style.width = '0%';
      $('kb-progress-label').textContent = 'Reindexing…';
      const off = window.dropai.knowledge.onProgress(({ file, done, total }) => {
        const pct = total > 0 ? Math.round((done / total) * 100) : 0;
        $('kb-progress-fill').style.width = `${pct}%`;
        $('kb-progress-label').textContent = file
          ? `${file} — ${done}/${total}`
          : `Reindexing… ${done}/${total}`;
      });
      try {
        const res = await window.dropai.knowledge.reindex();
        const errMsg = errorResult(res);
        if (errMsg) setNote('kb-note', errMsg, 'error');
        else {
          setNote('kb-note', `Reindex complete: ${res.files ?? '?'} files, ${res.chunks ?? '?'} chunks.`, 'ok');
          refreshKnowledge();
        }
      } catch (err) {
        setNote('kb-note', err.message, 'error');
      } finally {
        off();
        btn.disabled = false;
        window.setTimeout(() => $('kb-progress-wrap').classList.add('hidden'), 1500);
      }
    });

    const dropzone = $('kb-dropzone');
    dropzone.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropzone.classList.add('dropzone-over');
    });
    dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dropzone-over'));
    dropzone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropzone.classList.remove('dropzone-over');
      const paths = [...(e.dataTransfer?.files ?? [])]
        .map((f) => f.path)
        .filter((p) => typeof p === 'string' && p.length > 0);
      if (paths.length === 0) {
        setNote('kb-note', 'No files were dropped.', 'error');
        return;
      }
      kbUpload(paths);
    });

    // ---- assets ----
    $('btn-asset-add').addEventListener('click', () => {
      setNote('asset-modal-note', '');
      openModal('asset-modal');
    });
    $('btn-asset-pick').addEventListener('click', async () => {
      const btn = $('btn-asset-pick');
      btn.disabled = true;
      setNote('asset-modal-note', 'Choose a file…');
      try {
        const res = await window.dropai.assets.add({
          type: $('asset-type').value,
          tags: parseTagsInput($('asset-tags').value),
          description: $('asset-desc').value.trim(),
        });
        const errMsg = errorResult(res);
        if (errMsg) {
          setNote('asset-modal-note', errMsg, 'error');
        } else if (res && res.canceled) {
          setNote('asset-modal-note', '');
        } else {
          closeModal('asset-modal');
          setNote('asset-note', 'Asset added.', 'ok');
          refreshAssets();
        }
      } catch (err) {
        setNote('asset-modal-note', err.message, 'error');
      } finally {
        btn.disabled = false;
      }
    });
    $('asset-search-input').addEventListener('input', () => {
      window.clearTimeout(assetSearchTimer);
      assetSearchTimer = window.setTimeout(refreshAssets, 300);
    });

    // ---- place modal ----
    $('btn-place-confirm').addEventListener('click', async () => {
      if (!placeTarget) return;
      const btn = $('btn-place-confirm');
      btn.disabled = true;
      setNote('place-note', 'Placing on the timeline…');
      try {
        const res = await window.dropai.assets.place({
          assetId: placeTarget.id ?? placeTarget.assetId,
          trackType: $('place-track-type').value,
          trackIndex: Number($('place-track-index').value),
          positionTimecode: $('place-timecode').value.trim(),
          clipName: $('place-clip-name').value.trim(),
        });
        const errMsg = errorResult(res);
        if (errMsg) {
          setNote('place-note', errMsg, 'error');
        } else {
          const detail =
            res && res.result && typeof res.result === 'object'
              ? res.result.message ?? res.result.status ?? 'Placed successfully.'
              : 'Placed successfully.';
          setNote('place-note', String(detail), 'ok');
          window.setTimeout(() => closeModal('place-modal'), 1200);
        }
      } catch (err) {
        setNote('place-note', err.message, 'error');
      } finally {
        btn.disabled = false;
      }
    });

    // ---- modal dismissal ----
    for (const overlay of document.querySelectorAll('.modal-overlay')) {
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) overlay.classList.add('hidden');
      });
    }
    for (const closer of document.querySelectorAll('[data-close-modal]')) {
      closer.addEventListener('click', () => closer.closest('.modal-overlay').classList.add('hidden'));
    }
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        for (const overlay of document.querySelectorAll('.modal-overlay')) overlay.classList.add('hidden');
      }
    });

    window.dropai.getStatus().then(applyStatus).catch(() => {});
    window.dropai.getLogs(200).then((lines) => {
      logLines = Array.isArray(lines) ? lines : [];
      renderLogs(true);
    }).catch(() => {});
    refreshMasked();
    refreshHttpStatus();
    initConnectCenter();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
