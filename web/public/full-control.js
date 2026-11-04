import { getJson, postJson } from './api.js';
import { openSheet } from './modalsheet.js';
import { confirmDialog, showError } from './dialogs.js';

let status = null;
const banner = document.createElement('div');
banner.className = 'full-control-banner';
banner.hidden = true;
banner.setAttribute('role', 'status');
const label = document.createElement('span');
const stop = document.createElement('button');
stop.textContent = 'Stop';
stop.onclick = () => postJson('/api/full-control', { action: 'stop' }).catch((e) => showError(e.message));
const review = document.createElement('button');
review.textContent = 'Review Files';
review.onclick = () => openFullControlJournal();
banner.append(label, stop, review);
document.body.append(banner);

function update() {
  banner.hidden = !status;
  if (!status) return;
  const seconds = Math.max(0, Math.ceil((status.expires - Date.now()) / 1000));
  label.textContent = `${status.agent} has full control · ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
setInterval(update, 1000);
export function setFullControl(next) {
  const ended = status && !next;
  status = next; update();
  if (ended) openFullControlJournal();
}

export function openFullControlJournal() {
  openSheet({ title: 'Full Control Files', detents: ['medium', 'large'], build(sheet) {
    const note = document.createElement('p');
    note.textContent = 'Files changed in the folders named in the plan. Credentials, dependencies, symlinks and actions inside apps are excluded from rollback.';
    sheet.body.append(note);
    getJson('/api/full-control').then(async ({ journals }) => {
      for (const journal of journals) {
        const section = document.createElement('details');
        const summary = document.createElement('summary');
        summary.textContent = `${journal.agent} · ${new Date(journal.started).toLocaleString()} · ${journal.reason || 'Active'}`;
        section.append(summary);
        section.addEventListener('toggle', async () => {
          if (!section.open || section.dataset.loaded) return;
          section.dataset.loaded = '1';
          try {
            const { files } = await getJson(`/api/full-control-diff?id=${encodeURIComponent(journal.id)}`);
            const pre = document.createElement('pre');
            pre.textContent = files.map((f) => `${f.before === null ? '+' : f.after === null ? '−' : '~'} ${f.path}${f.beforeText !== undefined && f.afterText !== undefined ? `\n--- Before\n${f.beforeText}\n+++ After\n${f.afterText}\n` : ' (binary or large file)'}`).join('\n') || 'No file changes.';
            section.append(pre);
            if (journal.ended && files.length) {
              const undo = document.createElement('button'); undo.textContent = 'Undo File Changes';
              undo.onclick = async () => {
                if (!await confirmDialog('Undo file changes?', 'Restore these files to their state before the session? Files edited since the session will stop the undo.', 'Undo', true)) return;
                try { await postJson('/api/full-control', { action: 'undo', id: journal.id }); pre.textContent = 'File changes undone.'; undo.remove(); }
                catch (e) { showError(e.message); }
              };
              section.append(undo);
            }
          } catch (e) { showError(e.message); }
        });
        sheet.body.append(section);
      }
      sheet.refresh?.();
    }).catch((e) => showError(e.message));
  } });
}
