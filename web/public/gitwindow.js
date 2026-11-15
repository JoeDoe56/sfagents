/**
 * The Git workspace window: Changes and History for one repository and
 * working context, built from sfgl's components: the segmented tabs, grouped
 * rows (switches for inclusion, a dropdown for the compare branch), menus
 * for the branch and More, capsule buttons, a card field, and alerts and
 * dialogs instead of browser prompts.
 *
 * Tapping a file row shows its diff; its switch only changes inclusion in
 * the next commit. Drafts, exclusions and the chosen tab are remembered per
 * repository, and a refresh never switches tabs or clears them. Operations
 * are disabled with a reason while an agent works on the repository (the
 * server enforces the same rule).
 */

import { getJson, postJson } from './api.js';
import { openSheet } from './modalsheet.js';
import { renderDiff } from './chatdock.js';
import { showMenu, onHold } from './menu.js';
import { createTabs, createRow, createSection, createButton, createField, presentAlert, presentDialog } from './vendor/sfgl/src/ui/index.js';

const memory = new Map(); // repo id → { tab, excluded:Set, title, description, selected, compare, commitError }

function el(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text !== undefined) n.textContent = text;
  return n;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function summary(s) {
  const parts = [];
  if (s.conflicts) parts.push(plural(s.conflicts, 'conflict'));
  if (s.files.length) parts.push(`${plural(s.files.length, 'file')} changed locally`);
  if (s.ahead) parts.push(`${plural(s.ahead, 'commit')} waiting to be pushed`);
  if (s.behind) parts.push(plural(s.behind, 'incoming commit'));
  if (s.operation) parts.push(`${s.operation} in progress`);
  if (!s.upstream && !s.detached) parts.push('no upstream branch');
  return parts.join(' · ') || 'Clean';
}

const ago = (ms) => {
  if (ms === null || ms === undefined) return 'never fetched';
  const m = Math.round((Date.now() - ms) / 60000);
  return m < 1 ? 'fetched just now' : m < 60 ? `fetched ${m} min ago` : m < 1440 ? `fetched ${Math.round(m / 60)} h ago` : `fetched ${Math.round(m / 1440)} d ago`;
};

const KIND = { modified: 'Modified', added: 'Added', deleted: 'Deleted', renamed: 'Renamed', untracked: 'New', conflicted: 'Conflict', typechange: 'Type changed', submodule: 'Submodule' };

/** An sfgl alert with one text field; resolves the trimmed text, or null. */
async function ask(source, title, message, value, okLabel) {
  const r = await presentAlert({
    source,
    title,
    message,
    input: { value: value ?? '' },
    actions: [
      { label: 'Cancel', role: 'cancel', value: null },
      { label: okLabel, role: 'default', value: 'ok' },
    ],
  });
  return r.action === 'ok' && r.value.trim() ? r.value.trim() : null;
}

/** Runs after the menu that chose it has closed (a menu or alert may follow). */
const later = (fn) => () => setTimeout(fn, 0);

/** Glyphs the bundled symbols lack. */
const GLYPH = {
  branch: '<svg viewBox="0 0 16 16" width="19" height="19" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="4.5" cy="3.5" r="1.75"/><circle cx="4.5" cy="12.5" r="1.75"/><circle cx="11.5" cy="5" r="1.75"/><path d="M4.5 5.25v5.5M11.5 6.75c0 3-7 2.5-7 4"/></g></svg>',
  bolt: '<svg viewBox="0 0 16 16" width="19" height="19" aria-hidden="true"><path d="M9.4 1 3 9.2h4.4L6.5 15l6.5-8.4H8.6L9.4 1z" fill="currentColor"/></svg>',
};

/** A round sfgl glass button showing one of GLYPH. */
function glyphButton(name, aria, onClick) {
  const b = createButton({ aria, size: 'large', onClick });
  const g = el('span', 'gw-glyph');
  g.innerHTML = GLYPH[name];
  b.el.append(g);
  return b;
}

export function openGitWindow(repo, from) {
  const mem = memory.get(repo.id) ?? { tab: 'changes', excluded: new Set(), title: '', description: '', selected: null, compare: '', commitError: '' };
  memory.set(repo.id, mem);
  const hooks = { tab: () => {}, branch: () => {}, actions: () => {} };
  // The header: close, the Changes/History tabs, a branch button and an actions (lightning bolt) button.
  const tabs = createTabs({
    variant: 'segment',
    items: [
      { id: 'changes', label: 'Changes' },
      { id: 'history', label: 'History' },
    ],
    selected: mem.tab,
    onChange: (id) => hooks.tab(id),
  });
  const branchButton = glyphButton('branch', 'Branch', () => hooks.branch());
  const actionsButton = glyphButton('bolt', 'Actions', () => hooks.actions());
  openSheet({
    title: repo.name,
    from,
    className: 'git-window',
    detents: ['large'],
    headerItems: [
      { id: 'tabs', node: tabs, size: 'fill', height: 48 },
      { id: 'branch', node: branchButton.el, size: 44, height: 48 },
      { id: 'actions', node: actionsButton.el, size: 44, height: 48 },
    ],
    build: (ctx) => {
      const base = `/api/git/${encodeURIComponent(repo.id)}`;
      let data = null; // { status, busy, working, remotes, lastFetch }
      let commits = null;
      let branches = [];
      let selectedCommit = null;
      let diffToken = 0;
      const busy = () => data?.busy ?? null;

      // ---------------------------------------------------------- status
      const status = el('div', 'gw-status');
      status.title = repo.path;
      const repoLine = el('p', 'gw-repo', `${repo.name} · ${repo.branch || ''}`);
      const statusLine = el('p', 'gw-summary', 'Loading…');
      status.append(repoLine, statusLine);
      const lock = el('p', 'gw-lock');
      lock.hidden = true;
      const note = el('p', 'gw-note');
      note.hidden = true;
      const say = (t) => {
        note.textContent = t || '';
        note.hidden = !t;
      };
      const pane = el('div', 'gw-pane');
      ctx.body.append(status, lock, note, pane);

      hooks.tab = (id) => {
        mem.tab = id;
        show();
      };
      hooks.branch = () => pickBranch();
      hooks.actions = () => openActions();

      function updateOps() {
        const why = busy() || '';
        const s = data.status;
        branchButton.el.title = why || `Branch: ${s.detached ? 'detached' : s.branch}`;
        actionsButton.el.title = why || 'Fetch, pull, push and more';
      }

      async function run(action, body, label) {
        say(`${label}…`);
        try {
          const r = await postJson(`${base}/${action}`, body);
          say(r?.conflicts?.length ? `Merge conflicts in ${r.conflicts.join(', ')}. Resolve them in Changes.` : `${label} done.`);
          if (action === 'undo') {
            mem.title = r.title ?? '';
            mem.description = r.description ?? '';
            mem.tab = 'changes';
            tabs.select('changes', { notify: false });
          }
          if (r?.conflicts?.length) {
            mem.tab = 'changes';
            tabs.select('changes', { notify: false });
          }
        } catch (e) {
          say(e.message);
        }
        commits = null;
        await load();
      }

      async function load() {
        try {
          data = await getJson(`${base}/status`);
        } catch (e) {
          statusLine.textContent = e.message;
          return;
        }
        const s = data.status;
        const hasRemote = (data.remotes ?? []).length > 0;
        repoLine.textContent = `${repo.name} · ${s.detached ? `detached at ${s.head.slice(0, 7)}` : s.branch}${s.upstream ? ` → ${s.upstream}` : ''}`;
        statusLine.textContent = `${summary(s)} · ${hasRemote ? ago(data.lastFetch) : 'no remote'}`;
        lock.hidden = !data.busy;
        lock.textContent = data.busy ? `${data.busy}${data.working?.length ? ` (${data.working.join(', ')})` : ''}` : '';
        updateOps();
        await loadBranches();
        show();
      }

      async function loadBranches() {
        try {
          branches = (await getJson(`${base}/branches`)).branches;
        } catch {
          // keep the last list
        }
      }

      // ---------------------------------------------------------- menus
      function pickBranch() {
        const why = busy();
        const local = branches.filter((b) => !b.remote);
        const localNames = new Set(local.map((b) => b.name));
        // Remote branches without a local copy; picking one creates a local branch that tracks it.
        const remote = branches.filter((b) => b.remote && !localNames.has(b.name.replace(/^[^/]+\//, '')));
        showMenu({
          anchor: branchButton.el,
          align: 'end',
          title: why || 'Branch',
          groups: [
            local.map((b) => ({
              label: b.name,
              detail: b.worktree && !b.current ? 'Checked out in another worktree' : undefined,
              checked: b.current,
              disabled: !!why,
              action: () => b.current || run('checkout', { name: b.name }, `Switch to ${b.name}`),
            })),
            // Remote branches get their own submenu (sfgl menus have no titled groups).
            remote.length
              ? [
                  {
                    label: 'Remote Branches',
                    symbol: 'network',
                    disabled: !!why,
                    submenu: {
                      title: 'Remote Branches',
                      groups: [
                        remote.map((b) => {
                          const short = b.name.replace(/^[^/]+\//, '');
                          return {
                            label: short,
                            detail: `${b.name} · creates a local branch`,
                            action: () => run('checkout', { name: short }, `Switch to ${short}`),
                          };
                        }),
                      ],
                    },
                  },
                ]
              : [],
            [
              {
                label: 'New Branch…',
                symbol: 'plus',
                disabled: !!why || !data,
                action: later(async () => {
                  const name = await ask(branchButton.el, 'New Branch', `Created from ${data.status.branch || 'HEAD'} and checked out.`, '', 'Create');
                  if (name) await run('checkout', { name, create: true, from: 'HEAD' }, 'Create branch');
                }),
              },
            ],
          ],
        });
      }

      function openActions() {
        const why = busy();
        const s = data?.status;
        const off = !!why || !s;
        const hasRemote = (data?.remotes ?? []).length > 0;
        const remoteItems = [];
        if (!hasRemote) remoteItems.push({ label: 'Add Remote…', symbol: 'link', disabled: off, action: later(addRemote) });
        else {
          remoteItems.push({ label: 'Fetch', detail: ago(data.lastFetch), symbol: 'arrow.clockwise', disabled: off, action: () => run('fetch', {}, 'Fetch') });
          if (s?.upstream) {
            remoteItems.push({ label: s.behind ? `Pull ${plural(s.behind, 'Commit')}` : 'Pull', symbol: 'arrow.down', disabled: off, action: () => run('pull', {}, 'Pull') });
            remoteItems.push({ label: s.ahead ? `Push ${plural(s.ahead, 'Commit')}` : 'Push', symbol: 'arrow.up', disabled: off, action: () => run('push', {}, 'Push') });
          } else if (s && !s.detached) remoteItems.push({ label: 'Publish Branch', symbol: 'arrow.up', disabled: off, action: () => run('publish', {}, 'Publish') });
        }
        showMenu({
          anchor: actionsButton.el,
          align: 'end',
          title: why || undefined,
          groups: [
            remoteItems,
            [
              { label: 'Merge a Branch into This One…', disabled: off, action: later(mergeBranch) },
              { label: 'Undo Last Commit', detail: 'Only a commit that is not pushed', symbol: 'arrow.uturn.left', disabled: off, action: () => run('undo', {}, 'Undo') },
              { label: 'Revert Selected Commit', detail: selectedCommit ? undefined : 'Select one commit in History', disabled: off || !selectedCommit, action: () => run('revert', { commit: selectedCommit }, 'Revert') },
            ],
            [
              { label: 'Compare with a Branch…', disabled: !s, action: later(pickCompare) },
              { label: 'Pull Request…', symbol: 'arrow.up.right.square', disabled: !s, action: later(pullRequest) },
            ],
            [
              { label: 'Create a Repository…', symbol: 'folder.badge.plus', action: later(initRepo) },
              { label: 'Clone a Repository…', symbol: 'square.and.arrow.down', action: later(cloneRepo) },
            ],
          ],
        });
      }

      async function addRemote() {
        const url = await ask(actionsButton.el, 'Add Remote', 'The URL of the repository to push to and pull from (named origin).', '', 'Add');
        if (!url) return;
        try {
          await postJson(`${base}/remote`, { name: 'origin', url });
          say('Remote added.');
        } catch (e) {
          say(e.message);
        }
        await load();
      }

      function mergeBranch() {
        const others = branches.filter((b) => !b.current);
        if (!others.length) return say('There is no other branch to merge.');
        showMenu({
          anchor: actionsButton.el,
          align: 'end',
          title: `Merge into ${data.status.branch}`,
          groups: [others.map((b) => ({ label: b.name, action: () => run('merge', { source: b.name }, 'Merge') }))],
        });
      }

      function pickCompare() {
        const others = branches.filter((b) => !b.current);
        if (!others.length) return say('There is no other branch to compare with.');
        showMenu({
          anchor: actionsButton.el,
          align: 'end',
          title: `Compare ${data.status.branch} with`,
          groups: [
            others.map((b) => ({
              label: b.name,
              checked: mem.compare === b.name,
              action: () => {
                mem.compare = b.name;
                mem.tab = 'history';
                tabs.select('history', { notify: false });
                show();
              },
            })),
          ],
        });
      }

      async function pullRequest() {
        try {
          const { pulls, note: n } = await getJson(`${base}/pulls`);
          if (n) return say(n);
          if (pulls.length) return say(`Open: #${pulls[0].number} ${pulls[0].title} (${pulls[0].head} → ${pulls[0].base}) ${pulls[0].url}`);
          const baseBranch = await ask(actionsButton.el, 'Pull Request', `The branch to merge ${data.status.branch} into.`, 'main', 'Next');
          const title = baseBranch && (await ask(actionsButton.el, 'Pull Request', 'Title', mem.title || '', 'Next'));
          if (!title) return;
          const description = (await ask(actionsButton.el, 'Pull Request', 'Description (optional)', '', 'Open')) ?? '';
          const r = await postJson(`${base}/pull-request`, { base: baseBranch, title, description });
          say(`Opened #${r.number}: ${r.url}`);
        } catch (e) {
          say(e.message);
        }
      }

      const parentFolder = () => repo.path.replace(/[\\/][^\\/]*$/, '/');
      async function initRepo() {
        const p = await ask(actionsButton.el, 'Create a Repository', 'The full path of the folder, inside a folder attached to an agent.', parentFolder(), 'Create');
        if (!p) return;
        try {
          await postJson('/api/git/init', { path: p });
          say('Repository created.');
          dispatchEvent(new Event('git-repos-changed'));
        } catch (e) {
          say(e.message);
        }
      }
      async function cloneRepo() {
        const url = await ask(actionsButton.el, 'Clone a Repository', 'The repository URL.', '', 'Next');
        const p = url && (await ask(actionsButton.el, 'Clone a Repository', 'The full path to clone into, inside a folder attached to an agent.', parentFolder() + url.replace(/\.git$/, '').split('/').pop(), 'Clone'));
        if (!p) return;
        say('Cloning…');
        try {
          await postJson('/api/git/clone', { url, path: p });
          say('Cloned.');
          dispatchEvent(new Event('git-repos-changed'));
        } catch (e) {
          say(e.message);
        }
      }

      function show() {
        if (mem.tab === 'changes') showChanges();
        else showHistory();
        ctx.refresh();
      }

      // ---------------------------------------------------------- changes
      function showChanges() {
        pane.replaceChildren();
        pane.classList.remove('split');
        if (!data) return;
        const why = busy();
        const files = data.status.files;
        const side = el('div', 'gw-side');
        // A selection that no longer exists is reported, not replaced with another file.
        if (mem.selected && !files.some((f) => f.path === mem.selected)) {
          side.append(el('p', 'gw-note', `${mem.selected} is no longer changed.`));
          mem.selected = null;
        }
        const conflicted = files.filter((f) => f.kind === 'conflicted');
        if (data.status.operation || conflicted.length) {
          const rows = conflicted.map((f) => createRow({ title: `Mark ${f.path} Resolved`, tintTitle: true, disabled: !!why, onTap: () => run('resolve', { path: f.path }, 'Resolve') }));
          rows.push(createRow({ title: 'Continue Merge', tintTitle: true, disabled: !!why || conflicted.length > 0, onTap: () => run('merge-finish', { action: 'continue' }, 'Continue') }));
          rows.push(createRow({ title: 'Abort Merge', destructive: true, disabled: !!why, onTap: () => run('merge-finish', { action: 'abort' }, 'Abort') }));
          side.append(
            createSection({
              title: `${data.status.operation || 'Merge'} in progress`,
              rows,
              note: conflicted.length ? `${plural(conflicted.length, 'file')} with conflicts. Edit each file, then mark it resolved.` : 'All conflicts are resolved.',
            }).el,
          );
        }
        if (!files.length) {
          side.append(el('p', 'gw-empty', 'No uncommitted changes.'));
          pane.append(side);
          return;
        }
        const included = files.filter((f) => !mem.excluded.has(f.path));
        const refuse = (row, on) => {
          if (!why) return false;
          row.setChecked(!on);
          say(why);
          return true;
        };
        const allRow = createRow({
          title: `${included.length} of ${plural(files.length, 'File')} Included`,
          toggle: {
            checked: included.length === files.length,
            onChange: (on) => {
              if (refuse(allRow, on)) return;
              if (on) mem.excluded.clear();
              else for (const f of files) mem.excluded.add(f.path);
              show();
            },
          },
        });
        const rows = files.map((f) => {
          const row = createRow({
            leadingNode: el('span', `diff-status ${f.kind}`, KIND[f.kind] ?? f.kind),
            title: f.oldPath ? `${f.oldPath} → ${f.path}` : f.path,
            value: f.added === null ? 'binary' : `+${f.added} −${f.removed}`,
            toggle: {
              checked: !mem.excluded.has(f.path),
              onChange: (on) => {
                if (refuse(row, on)) return;
                if (on) mem.excluded.delete(f.path);
                else mem.excluded.add(f.path);
                show();
              },
            },
            onTap: () => {
              mem.selected = f.path;
              show();
            },
          });
          row.el.classList.add('gw-file');
          row.el.classList.toggle('sel', mem.selected === f.path);
          return row;
        });
        side.append(createSection({ title: 'Changes', rows: [allRow, ...rows], note: 'Tap a file to see its changes; the switch says whether it goes in the next commit.' }).el);
        const discardRow = createRow({
          title: included.length ? `Discard ${plural(included.length, 'Included Change')}…` : 'Discard Included Changes…',
          destructive: true,
          disabled: !!why || !included.length,
          onTap: async () => {
            const answer = await presentDialog({
              source: discardRow.el,
              title: `Discard changes in ${plural(included.length, 'file')}?`,
              message: 'Edits are lost; new files are deleted.',
              actions: [{ label: 'Discard', role: 'destructive', value: 'discard' }],
            });
            if (answer === 'discard') await run('discard', { paths: included.map((f) => f.path) }, 'Discard');
          },
        });
        side.append(createSection({ rows: [discardRow] }).el);
        const diffBox = el('div', 'gw-diff');
        pane.classList.add('split');
        pane.append(side, diffBox, commitForm(files));
        if (mem.selected) loadDiff(diffBox, mem.selected);
      }

      async function loadDiff(box, path) {
        const token = ++diffToken;
        box.textContent = 'Loading…';
        try {
          const d = await getJson(`${base}/file`, { path });
          if (token !== diffToken) return;
          if (d.gone) {
            box.textContent = `${path} is no longer changed.`;
            return;
          }
          const f = data.status.files.find((x) => x.path === path);
          if (d.unavailable) box.textContent = d.binary ? 'Binary file: no text diff.' : 'The diff is not available.';
          else renderDiff(box, { files: [{ path, status: f?.kind === 'untracked' ? 'added' : (f?.kind ?? 'modified'), added: f?.added ?? 0, removed: f?.removed ?? 0, patch: d.patch, binary: d.binary }] });
          ctx.refresh();
        } catch (e) {
          if (token === diffToken) box.textContent = e.message;
        }
      }

      function commitForm(files) {
        const box = el('div', 'gw-commit');
        const paths = () => files.filter((f) => !mem.excluded.has(f.path)).map((f) => f.path);
        const titleRow = createRow({
          title: 'Summary',
          input: {
            value: mem.title,
            placeholder: 'Required',
            onInput: (v) => {
              mem.title = v;
              mem.commitError = '';
              state();
            },
          },
        });
        const desc = createField({ look: 'card', multiline: true, maxRows: 8, placeholder: 'Description', value: mem.description, aria: 'Commit description', onInput: (v) => (mem.description = v) });
        const go = createButton({ label: 'Commit', tint: 'action', className: 'gw-go', onClick: () => submit() });
        const message = el('p', 'gw-error');
        function state() {
          const branch = data.status.detached ? 'HEAD' : data.status.branch;
          go.setLabel(`Commit to ${branch}`);
          const why = busy() || (data.status.conflicts ? 'Resolve the merge conflicts first.' : !paths().length ? 'Select at least one change.' : !mem.title.trim() ? 'Write a commit summary.' : '');
          go.setDisabled(!!why);
          go.el.title = why;
          message.textContent = mem.commitError || (mem.title.trim() ? why : '');
        }
        async function submit() {
          go.setDisabled(true);
          try {
            await postJson(`${base}/commit`, { paths: paths(), title: mem.title, description: mem.description });
            mem.title = mem.description = mem.commitError = '';
            mem.selected = null;
            commits = null;
          } catch (err) {
            // The draft and selection stay as they were.
            mem.commitError = err.message;
          }
          await load();
        }
        box.append(createSection({ title: 'Commit', rows: [titleRow] }).el, desc.el, go.el, message);
        state();
        return box;
      }

      // ---------------------------------------------------------- history
      async function showHistory() {
        pane.classList.remove('split');
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
        const side = el('div', 'gw-side');
        const detail = el('div', 'gw-diff');
        if (mem.compare && !branches.some((b) => b.name === mem.compare && !b.current)) mem.compare = '';
        let compareSection = null;
        if (mem.compare) {
          compareSection = createSection({ rows: [createRow({ title: `Comparing with ${mem.compare}`, value: 'Stop', onTap: () => { mem.compare = ''; show(); } })] });
          side.append(compareSection.el);
        }
        if (!commits.length) {
          side.append(el('p', 'gw-empty', 'No commits yet.'));
          pane.append(side);
          return;
        }
        let anchor = null;
        const rows = commits.map((c, i) => {
          const tag = c.pushed === null ? 'local' : c.pushed ? 'pushed' : 'not pushed';
          const row = createRow({
            title: c.title,
            subtitle: `${c.author} · ${new Date(c.date).toLocaleString()} · ${c.short}${c.checkpoint ? ' · checkpoint' : ''}`,
            value: tag,
            wrap: true,
            onTap: (_a, e) => select(i, !!e?.shiftKey),
          });
          row.el.classList.add('gw-commit-row');
          if (c.pushed === false) row.el.classList.add('gw-unpushed');
          if (c.id === selectedCommit) row.el.classList.add('sel');
          // Press and hold (touch) or right-click extends the selection to this commit.
          onHold(row.el, () => select(i, true));
          return row;
        });
        side.append(createSection({ title: 'Commits', rows, note: 'Press and hold a second commit to see the changes across a range (Shift-click with a mouse).' }).el);
        pane.classList.add('split');
        pane.append(side, detail);

        function select(i, extend) {
          if (mem.compare) {
            mem.compare = '';
            compareSection?.el.remove();
          }
          if (!extend || anchor === null) anchor = i;
          const [lo, hi] = [Math.min(anchor, i), Math.max(anchor, i)];
          rows.forEach((r, k) => r.el.classList.toggle('sel', k >= lo && k <= hi));
          selectedCommit = lo === hi ? commits[lo].id : null;
          // A contiguous range: the net diff from before the oldest to the newest.
          detail.textContent = 'Loading…';
          getJson(`${base}/commit`, { newest: commits[lo].id, oldest: commits[hi].id })
            .then((d) => {
              detail.replaceChildren();
              const c = commits[lo];
              if (lo === hi && c.body) detail.append(el('p', 'gw-body', c.body));
              for (const f of d.files) detail.append(el('p', 'gw-hist-file', `${f.path}  ${f.added === null ? 'binary' : `+${f.added} −${f.removed}`}`));
              const box = el('div');
              detail.append(box);
              renderDiff(box, { files: [{ path: '', status: 'modified', added: 0, removed: 0, patch: d.patch }] });
              ctx.refresh();
            })
            .catch((e) => (detail.textContent = e.message));
        }

        async function compare(other) {
          rows.forEach((r) => r.el.classList.remove('sel'));
          selectedCommit = null;
          detail.textContent = 'Loading…';
          try {
            const d = await getJson(`${base}/compare`, { base: other });
            detail.replaceChildren(el('p', 'gw-note', `Committed changes on ${data.status.branch} since its common ancestor with ${d.base} (${d.mergeBase.slice(0, 7)}), including unpushed commits: ${plural(d.commits.length, 'commit')}.`));
            for (const c of d.commits) detail.append(el('p', 'gw-hist-file', `${c.short}  ${c.title}`));
            for (const f of d.files) detail.append(el('p', 'gw-hist-file', `${f.path}  ${f.added === null ? 'binary' : `+${f.added} −${f.removed}`}`));
            if (d.patch) {
              const box = el('div');
              detail.append(box);
              renderDiff(box, { files: [{ path: '', status: 'modified', added: 0, removed: 0, patch: d.patch }] });
            }
            ctx.refresh();
          } catch (e) {
            detail.textContent = e.message;
          }
        }
        if (mem.compare) compare(mem.compare);
        ctx.refresh();
      }

      load();
      // Refresh in place while the window is open (not while the commit draft has focus).
      const timer = setInterval(() => {
        if (!ctx.body.isConnected) return clearInterval(timer);
        const typing = document.activeElement?.closest?.('.gw-commit');
        getJson(`${base}/status`)
          .then((d) => {
            const changed = JSON.stringify(d.status) !== JSON.stringify(data?.status) || d.busy !== data?.busy;
            if (changed && !typing) {
              commits = null;
              load();
            } else if (changed) data = d;
          })
          .catch(() => {});
      }, 4000);
    },
  });
}
