// Staff roster. Maintained once so the nightly tip table is dropdowns instead
// of retyped names, and so the payroll tracker can show a $0 row for anyone who
// did not work. Colours carry over from the Tip Tracker tab's row shading.

import { el, clear, uuid } from '../util.js';
import { store, STAFF_COLORS, STAFF_ROLES } from '../store.js';

export async function renderRoster(ctx) {
  const root = clear(ctx.root);
  root.append(el('div.spinner'));
  const staff = await store().listStaff();

  const rerender = () => renderRoster(ctx);

  const list = el('ul.rowlist');
  for (const person of staff) {
    const nameInput = el('input', { value: person.name, style: 'font-weight:600' });
    const roleSelect = el('select', { style: 'max-width:150px' });
    for (const role of STAFF_ROLES) {
      roleSelect.append(el('option', { value: role, selected: role === person.role }, role));
    }
    const colorInput = el('input', { type: 'color', value: person.color ?? '#c8352b', style: 'width:44px;height:38px;padding:2px;border:1px solid var(--border-strong);border-radius:8px;background:var(--surface-2)' });
    const aliasInput = el('input', {
      value: (person.aliases ?? []).join(', '),
      placeholder: 'also known as',
      style: 'max-width:170px',
      title: 'Shorthand this person gets called, comma separated',
    });
    const poolBox = el('input', { type: 'checkbox', checked: person.in_tip_pool });
    const activeBox = el('input', { type: 'checkbox', checked: person.active });
    const saveBtn = el('button.btn.btn-sm', { type: 'button' }, 'Save');
    const delBtn = el('button.btn.btn-sm.btn-danger', { type: 'button' }, 'Remove');
    const note = el('span.progress');

    saveBtn.addEventListener('click', async () => {
      saveBtn.disabled = true;
      try {
        await store().upsertStaff({
          ...person,
          name: nameInput.value.trim() || person.name,
          role: roleSelect.value,
          color: colorInput.value,
          aliases: aliasInput.value.split(',').map((a) => a.trim()).filter(Boolean),
          in_tip_pool: poolBox.checked,
          active: activeBox.checked,
        });
        note.textContent = 'Saved';
        ctx.reloadRefs();
        setTimeout(() => { note.textContent = ''; }, 2500);
      } catch (err) { note.textContent = err.message; }
      saveBtn.disabled = false;
    });

    delBtn.addEventListener('click', async () => {
      if (!confirm(`Remove ${person.name} from the roster? Past sheets keep their name and numbers.`)) return;
      await store().deleteStaff(person.id);
      ctx.reloadRefs();
      rerender();
    });

    list.append(el('li', {},
      colorInput,
      el('div.grow', {}, nameInput),
      aliasInput,
      roleSelect,
      el('label', { style: 'display:flex;gap:6px;align-items:center;font-size:13px;white-space:nowrap' }, poolBox, 'Tip pool'),
      el('label', { style: 'display:flex;gap:6px;align-items:center;font-size:13px;white-space:nowrap' }, activeBox, 'Active'),
      note, saveBtn, delBtn));
  }
  if (!staff.length) {
    list.append(el('li', {}, el('p.hint', 'No staff yet. Add the servers and bartenders who share tips.')));
  }

  // ------------------------------------------------------------------- add new
  const newName = el('input', { placeholder: 'Full name' });
  const newRole = el('select', { style: 'max-width:150px' });
  for (const role of STAFF_ROLES) newRole.append(el('option', { value: role, selected: role === 'Server' }, role));
  const newColor = el('input', {
    type: 'color',
    value: STAFF_COLORS[staff.length % STAFF_COLORS.length],
    style: 'width:44px;height:38px;padding:2px;border:1px solid var(--border-strong);border-radius:8px;background:var(--surface-2)',
  });
  const newPool = el('input', { type: 'checkbox', checked: true });
  const addBtn = el('button.btn.btn-primary', { type: 'button' }, 'Add to roster');
  const addNote = el('span.progress');

  // Kitchen is not in the tip pool here — untick it by default when picked.
  newRole.addEventListener('change', () => {
    if (newRole.value === 'Kitchen' || newRole.value === 'Manager') newPool.checked = false;
  });

  addBtn.addEventListener('click', async () => {
    const name = newName.value.trim();
    if (!name) { addNote.textContent = 'Name required'; return; }
    addBtn.disabled = true;
    try {
      await store().upsertStaff({
        id: uuid(), name, role: newRole.value, color: newColor.value,
        aliases: [], in_tip_pool: newPool.checked, active: true,
      });
      ctx.reloadRefs();
      rerender();
      return;
    } catch (err) { addNote.textContent = err.message; }
    addBtn.disabled = false;
  });

  clear(root);
  root.append(
    el('div.cal-head', {}, el('h1', 'Staff'), el('span.spacer', { style: 'flex:1' }),
      el('span.progress', `${staff.filter((s) => s.active && s.in_tip_pool).length} in the tip pool`)),
    el('div.card', {},
      el('div.card-head', {}, el('h2', 'Roster')),
      el('div.card-body', {},
        el('p.hint', 'Anyone with “Tip pool” ticked appears in the nightly tip table and on the payroll tracker. Kitchen is not part of the pool. Untick “Active” for someone who has left — their past nights stay intact.'),
        el('p.hint', '“Also known as” is for shorthand — put “Nate” on Nathan and an import that says Nate lands on the right person.')),
      el('div.card-body.tight', {}, list)),
    el('div.card', {},
      el('div.card-head', {}, el('h2', 'Add someone')),
      el('div.card-body', {}, el('div.btn-row', {},
        newColor, newName, newRole,
        el('label', { style: 'display:flex;gap:6px;align-items:center;font-size:13px' }, newPool, 'Tip pool'),
        addBtn, addNote))),
  );
}
