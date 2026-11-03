/**
 * Git task workspaces (sfa-git): the list, and each task's review sheet.
 * A task is /workspaces/<repo>/<task> on branch sfagents/<task>; SF Agents
 * commits it after every run (a checkpoint). The review shows the work since
 * the last real commit, hunk by hunk, with Reject on each hunk (taken back
 * out as a checkpoint of its own), and an editable commit message drafted
 * from the runs. From there: undo the last run, update from main, squash
 * into one commit, push the branch or to main (never forced), pull into one
 * of the person's Project Folders, or remove the workspace.
 */

import { getJson, postJson } from './api.js';
import { openSheet } from './modalsheet.js';
import { confirmDialog, showError, toast } from './dialogs.js';
import { showMenu } from './menu.js';
import { createRow, createSection } from './vendor/sfgl/src/ui/index.js';

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const enc = encodeURIComponent;

/** The task as a diff pill (see chatdock.js): shown while it has work not on the default branch. */
export function workspacePills(list) {
  return (list ?? [])
    .filter((w) => w.changed > 0 || w.ahead > 0)
    .map((w) => ({ id: `ws:${w.repo}/${w.task}`, name: `${w.repo}/${w.task}${w.ci ? ` · CI ${w.ci.state === 'pass' ? '✓' : w.ci.state === 'fail' ? '✕' : w.ci.state === 'pending' ? '…' : w.ci.state}` : ''}${w.pr ? ` · PR #${w.pr.number} ${w.pr.checks}` : ''}`, branch: w.branch, files: w.changed, added: w.added ?? 0, removed: w.removed ?? 0, path: w.path, workspace: w }));
}

function stateText(w) {
  const parts = [`${w.ahead} ahead, ${w.behind} behind ${w.defaultBranch}`];
  if (w.checkpoints) parts.push(`${w.checkpoints} run checkpoint${w.checkpoints === 1 ? '' : 's'}`);
  if (w.dirty) parts.push('uncommitted changes');
  return parts.join(' · ');
}

/** Runs an action; a workflow push comes back with a question, asked here, then sent again. */
async function act(w, action, extra = {}) {
  const url = `/api/workspaces/${enc(w.repo)}/${enc(w.task)}`;
  let out = await postJson(url, { action, ...extra });
  if (out.question) {
    if (!(await confirmDialog('Push workflow changes?', out.question, 'Push'))) return null;
    out = await postJson(url, { action, ...extra, approve: true });
  }
  return out;
}

/** Every task workspace, newest first. */
export function openWorkspaces() {
  const ctx = openSheet({
    title: 'Workspaces',
    detents: ['medium', 'large'],
    className: 'st-sheet ws-sheet',
    build(sheet) {
      const body = sheet.body;
      body.append(el('p', 'diff-summary', 'Loading…'));
      getJson('/api/workspaces')
        .then(({ workspaces }) => {
          body.replaceChildren();
          if (!workspaces.length) {
            body.append(createSection({ rows: [createRow({ title: 'No task workspaces yet', disabled: true })], note: 'An agent at network level Git or Internet starts one with sfa-git clone <url>, then sfa-git task <repo> <task>.' }).el);
          } else {
            const rows = workspaces.map((w) =>
              createRow({ title: `${w.repo}/${w.task}`, subtitle: `${w.agent} · ${stateText(w)}`, value: w.changed ? `${w.changed} file${w.changed === 1 ? '' : 's'}` : '', accessory: 'chevron', wrap: true, onTap: (anchor) => openWorkspace(w, anchor) }),
            );
            body.append(createSection({ rows, note: 'Each task is its own folder and branch (sfagents/<task>). SF Agents commits it after every run.' }).el);
          }
          sheet.refresh?.();
        })
        .catch((error) => {
          body.replaceChildren(el('p', 'diff-empty', error.message));
        });
    },
  });
  return ctx;
}

/** One task: its changes hunk by hunk, the drafted message, and what can be done with it. */
export function openWorkspace(w, from) {
  let current = w;
  let folders = [];
  const ctx = openSheet({
    title: `${w.repo}/${w.task}`,
    from,
    detents: ['large'],
    className: 'diff-sheet ws-review',
    build(sheet) {
      const body = sheet.body;
      const summary = el('p', 'diff-summary', `${w.branch} · ${stateText(w)}`);
      const actions = el('div', 'ws-actions');
      const prActions = el('div', 'ws-actions');
      const prInfo = el('pre', 'ws-pr-info');
      const list = el('div', 'diff-list', 'Loading…');
      const message = el('textarea', 'ws-message');
      message.rows = 4;
      message.placeholder = 'Commit message';
      message.setAttribute('aria-label', 'Commit message');
      const finishNote = el('p', 'diff-note', 'Squash puts the run checkpoints (and anything uncommitted) into one commit with this message.');
      body.append(summary, actions, prActions, prInfo, list, el('h3', 'ws-heading', 'Commit message'), message, finishNote);

      const busy = (on) => body.classList.toggle('ws-busy', on);
      const run = async (label, action, extra, confirmText) => {
        if (confirmText && !(await confirmDialog(label, confirmText, label, action === 'remove' || action === 'undo'))) return;
        busy(true);
        try {
          const out = await act(current, action, extra);
          if (!out) return;
          if (out.text) toast(out.text, { symbol: 'checkmark', timeout: 3200 });
          const next = out.workspaces?.find((x) => x.repo === w.repo && x.task === w.task);
          if (action === 'remove' || !next) return ctx.close();
          current = next;
          summary.textContent = `${next.branch} · ${stateText(next)}`;
          await load();
        } catch (error) {
          showError(error.message, `${label} didn’t work`);
        } finally {
          busy(false);
        }
      };

      const button = (label, onClick, cls = '') => {
        const b = el('button', `ws-button ${cls}`.trim(), label);
        b.type = 'button';
        b.addEventListener('click', onClick);
        return b;
      };
      const pullButton = button('Pull into My Folder', async () => {
        if (!folders.length) return showError('Add the checkout as a Project Folder in Settings first.', 'No Project Folders');
        const pull = (folder) => run('Pull into My Folder', 'pull-into', { folder }, `Push ${current.branch} and fast-forward ${folder} to it? Nothing changes there if it has uncommitted changes or other commits.`);
        if (folders.length === 1) return pull(folders[0]);
        showMenu({ anchor: pullButton, align: 'start', groups: [folders.map((f) => ({ label: f, action: () => pull(f) }))] });
      });
      actions.append(
        button('Squash', () => run('Squash', 'finish', { message: message.value })),
        button('Push Branch', () => run('Push Branch', 'push')),
        button('Push to Main', () => run('Push to Main', 'push-main', {}, `Push this task to ${current.defaultBranch}? Only a fast-forward: squash and update from main first.`), 'primary'),
        button('Update from Main', () => run('Update from Main', 'update')),
        pullButton,
        button('Undo Last Run', () => run('Undo Last Run', 'undo', {}, 'Take the last run’s changes back out? They stay recoverable in Git (refs/sfagents/undo).')),
        button('Remove', () => run('Remove', 'remove', {}, 'Remove this workspace and its local branch? A pushed branch stays on the remote.'), 'destructive'),
      );

      async function load() {
        const [review, all] = await Promise.all([getJson(`/api/workspaces/${enc(w.repo)}/${enc(w.task)}`), getJson('/api/workspaces')]);
        folders = all.folders ?? [];
        current = all.workspaces.find((x) => x.repo === w.repo && x.task === w.task) ?? current;
        prActions.replaceChildren();
        const pr = current.pr;
        prInfo.textContent = pr ? `PR #${pr.number} · ${pr.state} · checks ${pr.checks}\n${pr.comments || 'No review comments.'}` : '';
        if (all.pullRequests) {
          prActions.append(button(pr ? 'Refresh PR and Reviews' : 'Open Draft PR', () => run('Pull Request', pr ? 'pr-refresh' : 'pr-open')));
          if (pr) {
            const link = el('a', 'ws-button', 'View on GitHub');
            link.href = pr.url; link.target = '_blank'; link.rel = 'noopener noreferrer';
            prActions.append(link, button('Send Reviews to Agent', () => run('Send Reviews', 'pr-reviews')));
            if (!['closed', 'merged'].includes(pr.state)) prActions.append(button('Merge PR', () => run('Merge PR', 'pr-merge', { sha: pr.sha }, `Merge PR #${pr.number} at ${pr.sha.slice(0, 7)} into ${current.defaultBranch}? A draft will be marked ready before merging.`)));
          }
        }
        if (!message.value || message.dataset.drafted === message.value) {
          message.value = review.message;
          message.dataset.drafted = review.message;
        }
        renderReview(list, review, (file, hunk) => run('Reject', 'reject', { file, hunk }));
        sheet.refresh?.();
      }
      load().catch((error) => {
        list.textContent = error.message;
      });
    },
  });
  return ctx;
}

/** The changes, file by file, each hunk with a Reject button. */
function renderReview(container, data, onReject) {
  container.replaceChildren();
  const files = data?.files ?? [];
  if (!files.length) {
    container.append(el('p', 'diff-empty', 'No changes since the last commit.'));
    return;
  }
  const STATUS = { modified: 'Modified', added: 'Added', deleted: 'Deleted', renamed: 'Renamed' };
  for (const f of files) {
    const section = el('details', 'diff-file');
    section.open = files.length <= 12;
    const head = el('summary', 'diff-file-head');
    head.append(el('span', `diff-status ${f.status}`, STATUS[f.status] ?? f.status), el('span', 'diff-path', f.path));
    section.append(head);
    const body = el('div', 'diff-body');
    if (f.binary) body.append(el('p', 'diff-note', 'Binary file'));
    f.hunks.forEach((h, i) => {
      const hunk = el('div', 'ws-hunk');
      const bar = el('div', 'ws-hunk-bar');
      const reject = el('button', 'ws-button small', 'Reject');
      reject.type = 'button';
      reject.setAttribute('aria-label', `Reject this change in ${f.path}`);
      reject.addEventListener('click', () => onReject(f.path, i));
      bar.append(el('span', 'diff-line hunk', h.header), reject);
      const pre = el('pre', 'diff-lines');
      for (const line of h.lines) {
        const kind = line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : line.startsWith('\\') ? 'note' : 'ctx';
        pre.append(el('span', `diff-line ${kind}`, line || ' '));
      }
      hunk.append(bar, pre);
      body.append(hunk);
    });
    section.append(body);
    container.append(section);
  }
}
