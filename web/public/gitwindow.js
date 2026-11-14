/**
 * The Git workspace window: Changes and History for one repository and
 * working context. Clicking a file row shows its diff; its checkbox only
 * changes inclusion in the next commit. Drafts, exclusions and the chosen
 * tab are remembered per repository, and a refresh never switches tabs or
 * clears them. Operations are disabled with a reason while an agent works
 * on the repository (the server enforces the same rule).
 */

import { getJson, postJson } from './api.js';
import { openSheet } from './modalsheet.js';
import { renderDiff } from './chatdock.js';

const memory = new Map(); // repo id → { tab, excluded:Set, title, description, selected }

function el(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text !== undefined) n.textContent = text;
  return n;
}

function summary(s) {
  const parts = [];
  if (s.conflicts) parts.push(`${s.conflicts} conflict${s.conflicts === 1 ? '' : 's'}`);
  if (s.files.length) parts.push(`${s.files.length} file${s.files.length === 1 ? '' : 's'} changed locally`);
  if (s.ahead) parts.push(`${s.ahead} commit${s.ahead === 1 ? '' : 's'} waiting to be pushed`);
  if (s.behind) parts.push(`${s.behind} incoming commit${s.behind === 1 ? '' : 's'}`);
  if (s.operation) parts.push(`${s.operation} in progress`);
  if (!s.upstream && !s.detached) parts.push('no upstream branch');
  return parts.join(' · ') || 'Clean';
}

const KIND = { modified: 'Modified', added: 'Added', deleted: 'Deleted', renamed: 'Renamed', untracked: 'New', conflicted: 'Conflict', typechange: 'Type changed', submodule: 'Submodule' };

export function openGitWindow(repo, from) {
  const mem = memory.get(repo.id) ?? { tab: 'changes', excluded: new Set(), title: '', description: '', selected: null };
  memory.set(repo.id, mem);
  openSheet({
    title: repo.name,
    from,
    className: 'git-window',
    detents: ['large'],
    build: (ctx) => {
      const head = el('div', 'gw-head');
      const branchLine = el('p', 'gw-branch', repo.branch);
      branchLine.title = repo.path;
      const status = el('p', 'gw-status', 'Loading…');
      const lock = el('p', 'gw-lock');
      lock.hidden = true;
      const tabs = el('div', 'gw-tabs');
      const tabChanges = el('button', 'gw-tab', 'Changes');
      const tabHistory = el('button', 'gw-tab', 'History');
      for (const t of [tabChanges, tabHistory]) t.type = 'button';
      tabs.append(tabChanges, tabHistory);
      const bar = el('div', 'gw-remote');
      const note = el('p', 'gw-note');
      const branchSel = el('select', 'gw-branches');
      branchSel.setAttribute('aria-label', 'Branch');
      const mk = (label, action, body) => {
        const b = el('button', 'gw-op', label);
        b.type = 'button';
        b.dataset.action = action;
        b.addEventListener('click', async () => {
          b.disabled = true;
          note.textContent = `${label}…`;
          try {
            await postJson(`${base}/${action}`, body?.() ?? {});
            note.textContent = `${label} done.`;
            commits = null;
          } catch (e) {
            note.textContent = e.message;
          }
          await load();
        });
        return b;
      };
      const bFetch = mk('Fetch', 'fetch');
      const bPull = mk('Pull', 'pull');
      const bPush = mk('Push', 'push');
      const bPublish = mk('Publish branch', 'publish');
      branchSel.addEventListener('change', async () => {
        const v = branchSel.value;
        if (v === '__new') {
          const name = prompt('New branch name (created from the current branch)');
          if (!name) return load();
          try { await postJson(`${base}/checkout`, { name, create: true, from: 'HEAD' }); note.textContent = ''; } catch (e) { note.textContent = e.message; }
        } else {
          try { await postJson(`${base}/checkout`, { name: v }); note.textContent = ''; } catch (e) { note.textContent = e.message; }
        }
        commits = null;
        await load();
      });
      const more = el('select', 'gw-branches gw-more');
      more.setAttribute('aria-label', 'More actions');
      for (const [v, t] of [['', 'More…'], ['merge', 'Merge a branch into this one…'], ['undo', 'Undo last unpushed commit'], ['revert', 'Revert the selected commit']]) {
        const o = el('option', '', t);
        o.value = v;
        more.append(o);
      }
      let selectedCommit = null;
      async function run(action, body, label) {
        note.textContent = `${label}…`;
        try {
          const r = await postJson(`${base}/${action}`, body);
          note.textContent = r?.conflicts?.length ? `Merge conflicts in ${r.conflicts.join(', ')}. Resolve them below.` : `${label} done.`;
          if (action === 'undo') { mem.title = r.title; mem.description = r.description; mem.tab = 'changes'; }
        } catch (e) { note.textContent = e.message; }
        commits = null;
        await load();
      }
      more.addEventListener('change', async () => {
        const v = more.value;
        more.value = '';
        if (v === 'merge') {
          const source = prompt(`Merge which branch into ${data.status.branch}?`);
          if (source) await run('merge', { source }, 'Merge');
        } else if (v === 'undo') await run('undo', {}, 'Undo');
        else if (v === 'revert') {
          if (!selectedCommit) note.textContent = 'Select a commit in History first.';
          else await run('revert', { commit: selectedCommit }, 'Revert');
        }
      });
      bar.append(branchSel, bFetch, bPull, bPush, bPublish, more);
      async function loadBranches() {
        try {
          const list = (await getJson(`${base}/branches`)).branches;
          branchSel.replaceChildren();
          for (const b of list) {
            const o = el('option', '', b.name + (b.worktree ? ' (other worktree)' : ''));
            o.value = b.name;
            o.selected = b.current;
            branchSel.append(o);
          }
          const n = el('option', '', 'New branch…');
          n.value = '__new';
          branchSel.append(n);
        } catch {}
      }
      function updateOps() {
        const s = data.status;
        const why = busy() || '';
        bPull.textContent = s.behind ? `Pull ${s.behind}` : 'Pull';
        bPush.textContent = s.ahead ? `Push ${s.ahead} commit${s.ahead === 1 ? '' : 's'}` : 'Push';
        bPublish.hidden = !!s.upstream || s.detached;
        bPull.hidden = bPush.hidden = !s.upstream;
        for (const b of [bFetch, bPull, bPush, bPublish, branchSel, more]) {
          b.disabled = !!why;
          b.title = why;
        }
      }
      head.append(branchLine, status, lock, bar, note, tabs);
      const pane = el('div', 'gw-pane');
      ctx.body.append(head, pane);

      let data = null; // { status, busy, working }
      let commits = null;
      let diffToken = 0;
      let draftTitle;
      let draftDesc;
      let diffBox;

      const base = `/api/git/${encodeURIComponent(repo.id)}`;
      const busy = () => data?.busy ?? null;

      async function load() {
        try {
          data = await getJson(`${base}/status`);
        } catch (e) {
          status.textContent = e.message;
          return;
        }
        const s = data.status;
        branchLine.textContent = s.detached ? `Detached at ${s.head.slice(0, 7)}` : s.branch + (s.upstream ? ` → ${s.upstream}` : '');
        status.textContent = summary(s);
        updateOps();
        loadBranches();
        lock.hidden = !data.busy;
        lock.textContent = data.busy ? `${data.busy}${data.working?.length ? ` (${data.working.join(', ')})` : ''}` : '';
        show();
      }

      function setTab(t) {
        mem.tab = t;
        show();
      }

      function show() {
        tabChanges.classList.toggle('on', mem.tab === 'changes');
        tabHistory.classList.toggle('on', mem.tab === 'history');
        // Keep the commit draft typed so far across re-renders.
        if (draftTitle) mem.title = draftTitle.value;
        if (draftDesc) mem.description = draftDesc.value;
        if (mem.tab === 'changes') showChanges();
        else showHistory();
        ctx.refresh();
      }

      tabChanges.addEventListener('click', () => setTab('changes'));
      tabHistory.addEventListener('click', () => setTab('history'));

      // ---------------------------------------------------------- changes
      function showChanges() {
        pane.replaceChildren();
        draftTitle = draftDesc = undefined;
        if (!data) return;
        const files = data.status.files;
        if (!files.length) {
          pane.append(el('p', 'gw-empty', 'No uncommitted changes.'));
          return;
        }
        // A selection that no longer exists is reported, not replaced with another file.
        if (mem.selected && !files.some((f) => f.path === mem.selected)) {
          pane.append(el('p', 'gw-note', `${mem.selected} is no longer changed.`));
          mem.selected = null;
        }
        const conflicted = files.filter((f) => f.kind === 'conflicted');
        if (data.status.operation || conflicted.length) {
          const box = el('div', 'gw-conflicts');
          box.append(el('p', 'gw-note', `${data.status.operation || 'Merge'} in progress${conflicted.length ? `: ${conflicted.length} file${conflicted.length === 1 ? '' : 's'} with conflicts. Edit each file, then mark it resolved.` : '. All conflicts are resolved.'}`));
          for (const f of conflicted) {
            const b = el('button', 'gw-op', `Mark ${f.path} resolved`);
            b.type = 'button';
            b.disabled = !!busy();
            b.addEventListener('click', () => run('resolve', { path: f.path }, 'Resolve'));
            box.append(b);
          }
          const cont = el('button', 'gw-op', 'Continue merge');
          cont.disabled = !!busy() || conflicted.length > 0;
          cont.addEventListener('click', () => run('merge-finish', { action: 'continue' }, 'Continue'));
          const abort = el('button', 'gw-op', 'Abort merge');
          abort.disabled = !!busy();
          abort.addEventListener('click', () => run('merge-finish', { action: 'abort' }, 'Abort'));
          box.append(cont, abort);
          pane.append(box);
        }
        const included = files.filter((f) => !mem.excluded.has(f.path));
        const all = el('label', 'gw-all');
        const allBox = el('input');
        allBox.type = 'checkbox';
        allBox.checked = included.length === files.length;
        allBox.indeterminate = included.length > 0 && included.length < files.length;
        allBox.disabled = !!busy();
        allBox.addEventListener('change', () => {
          if (allBox.checked) mem.excluded.clear();
          else for (const f of files) mem.excluded.add(f.path);
          show();
        });
        all.append(allBox, el('span', '', `${included.length} of ${files.length} files included`));
        const list = el('div', 'gw-files');
        for (const f of files) {
          const row = el('div', 'gw-file');
          if (mem.selected === f.path) row.classList.add('sel');
          const box = el('input');
          box.type = 'checkbox';
          box.checked = !mem.excluded.has(f.path);
          box.disabled = !!busy();
          box.setAttribute('aria-label', `Include ${f.path} in the commit`);
          box.addEventListener('change', () => {
            if (box.checked) mem.excluded.delete(f.path);
            else mem.excluded.add(f.path);
            show();
          });
          const open = el('button', 'gw-file-open');
          open.type = 'button';
          const counts = f.added === null ? 'no line counts' : `+${f.added} −${f.removed}`;
          open.append(el('span', `diff-status ${f.kind}`, KIND[f.kind] ?? f.kind), el('span', 'diff-path', f.oldPath ? `${f.oldPath} → ${f.path}` : f.path), el('span', 'gw-counts', counts));
          open.addEventListener('click', () => {
            mem.selected = f.path;
            show();
          });
          row.append(box, open);
          list.append(row);
        }
        diffBox = el('div', 'gw-diff');
        if (mem.selected) loadDiff(mem.selected);
        pane.append(all, list, diffBox, commitForm(files));
      }

      async function loadDiff(path) {
        const token = ++diffToken;
        diffBox.textContent = 'Loading…';
        try {
          const d = await getJson(`${base}/file`, { path });
          if (token !== diffToken) return;
          if (d.gone) {
            diffBox.textContent = `${path} is no longer changed.`;
            return;
          }
          const f = data.status.files.find((x) => x.path === path);
          if (d.unavailable) diffBox.textContent = d.binary ? 'Binary file: no text diff.' : 'The diff is not available.';
          else renderDiff(diffBox, { files: [{ path, status: f?.kind === 'untracked' ? 'added' : (f?.kind ?? 'modified'), added: f?.added ?? 0, removed: f?.removed ?? 0, patch: d.patch, binary: d.binary }] });
          ctx.refresh();
        } catch (e) {
          if (token === diffToken) diffBox.textContent = e.message;
        }
      }

      function commitForm(files) {
        const form = el('form', 'gw-commit');
        draftTitle = el('input', 'gw-title');
        draftTitle.placeholder = 'Summary (required)';
        draftTitle.value = mem.title;
        draftDesc = el('textarea', 'gw-desc');
        draftDesc.placeholder = 'Description';
        draftDesc.rows = 3;
        draftDesc.value = mem.description;
        const go = el('button', 'gw-go');
        go.type = 'submit';
        const message = el('p', 'gw-error');
        const paths = () => files.filter((f) => !mem.excluded.has(f.path)).map((f) => f.path);
        const state = () => {
          const branch = data.status.detached ? 'HEAD' : data.status.branch;
          go.textContent = `Commit to ${branch}`;
          const why = busy() || (data.status.conflicts ? 'Resolve the merge conflicts first.' : !paths().length ? 'Select at least one change.' : !draftTitle.value.trim() ? 'Write a commit title.' : '');
          go.disabled = !!why;
          go.title = why;
          message.textContent = why && !draftTitle.value.trim() === false ? why : message.dataset.fail || '';
        };
        draftTitle.addEventListener('input', () => {
          mem.title = draftTitle.value;
          state();
        });
        draftDesc.addEventListener('input', () => (mem.description = draftDesc.value));
        form.addEventListener('submit', async (e) => {
          e.preventDefault();
          go.disabled = true;
          try {
            await postJson(`${base}/commit`, { paths: paths(), title: draftTitle.value, description: draftDesc.value });
            mem.title = mem.description = '';
            mem.selected = null;
            commits = null;
            await load();
          } catch (err) {
            // The draft and selection stay as they were.
            message.dataset.fail = err.message;
            await load();
          }
        });
        form.append(draftTitle, draftDesc, go, message);
        state();
        return form;
      }

      // ---------------------------------------------------------- history
      async function showHistory() {
        pane.replaceChildren(el('p', 'gw-note', 'Loading…'));
        if (!commits) {
          try {
            commits = (await getJson(`${base}/history`)).commits;
          } catch (e) {
            pane.replaceChildren(el('p', 'gw-error', e.message));
            return;
          }
        }
        if (mem.tab !== 'history') return;
        pane.replaceChildren();
        if (!commits.length) {
          pane.append(el('p', 'gw-empty', 'No commits yet.'));
          return;
        }
        const list = el('div', 'gw-commits');
        const detail = el('div', 'gw-diff');
        let anchor = null;
        const rows = [];
        const select = (i, extend) => {
          if (!extend || anchor === null) anchor = i;
          const [lo, hi] = [Math.min(anchor, i), Math.max(anchor, i)];
          rows.forEach((r, k) => r.classList.toggle('sel', k >= lo && k <= hi));
          selectedCommit = lo === hi ? commits[lo].id : null;
          // A contiguous range: the net diff from before the oldest to the newest.
          const newest = commits[lo].id;
          const oldest = commits[hi].id;
          detail.textContent = 'Loading…';
          getJson(`${base}/commit`, { newest, oldest }).then((d) => {
            detail.replaceChildren();
            const c = commits[lo];
            if (lo === hi && c.body) detail.append(el('p', 'gw-body', c.body));
            for (const f of d.files) detail.append(el('p', 'gw-hist-file', `${f.path}  ${f.added === null ? 'binary' : `+${f.added} −${f.removed}`}`));
            const box = el('div');
            detail.append(box);
            renderDiff(box, { files: [{ path: '', status: 'modified', added: 0, removed: 0, patch: d.patch }] });
            ctx.refresh();
          }).catch((e) => (detail.textContent = e.message));
        };
        commits.forEach((c, i) => {
          const row = el('button', 'gw-commit-row');
          row.type = 'button';
          const tag = c.pushed === null ? 'local' : c.pushed ? 'pushed' : 'not pushed';
          row.append(el('span', 'gw-ct', c.title), el('span', 'gw-cm', `${c.author} · ${new Date(c.date).toLocaleString()} · ${c.short}${c.checkpoint ? ' · checkpoint' : ''}`), el('span', `gw-tag ${tag.replace(' ', '-')}`, tag));
          row.addEventListener('click', (e) => select(i, e.shiftKey));
          rows.push(row);
          list.append(row);
        });
        pane.append(list, detail);
        ctx.refresh();
      }

      load();
      // Refresh in place while the window is open.
      const timer = setInterval(() => {
        if (!ctx.body.isConnected) return clearInterval(timer);
        const typing = document.activeElement?.closest?.('.gw-commit');
        getJson(`${base}/status`).then((d) => {
          const changed = JSON.stringify(d.status) !== JSON.stringify(data?.status) || d.busy !== data?.busy;
          if (changed && !typing) {
            commits = null;
            load();
          } else if (changed) data = d;
        }).catch(() => {});
      }, 4000);
    },
  });
}
