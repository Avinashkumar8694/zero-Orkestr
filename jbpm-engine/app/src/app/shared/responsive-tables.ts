// Phone layout for every data table, without touching each page: below 900px a table with a header row is shown as a
// stack of cards (one per row, each value labelled with its column header — see the `table[data-rt]` rules in
// styles.css). This reads the header texts once per table and stamps them onto the cells as `data-label`, and keeps
// doing so as rows are added (lists load asynchronously and re-render). A table opts out with `data-keep` (a matrix whose
// whole point is comparing columns side by side). Tables without a header row (key/value lists) are left as they are.
export function installResponsiveTables(root: Node = document.body): void {
  let queued = false;
  const apply = () => {
    queued = false;
    document.querySelectorAll<HTMLTableElement>('table').forEach((table) => {
      if (table.hasAttribute('data-keep')) { table.removeAttribute('data-rt'); return; }
      const heads = Array.from(table.querySelectorAll<HTMLTableCellElement>('thead th'));
      if (!heads.length) {
        // header-less list (e.g. deployments): not a card-per-row table, but its cells must wrap instead of squeezing
        table.removeAttribute('data-rt');
        const wide = !table.classList.contains('kv') && Array.from(table.rows).some((r) => r.cells.length >= 3);
        if (wide) table.setAttribute('data-rl', ''); else table.removeAttribute('data-rl');
        return;
      }
      table.removeAttribute('data-rl');
      const labels = heads.map((h) => (h.textContent || '').trim());
      table.setAttribute('data-rt', '');
      table.querySelectorAll<HTMLTableRowElement>('tbody tr').forEach((tr) => {
        let col = 0; let primary = false;
        Array.from(tr.cells).forEach((td) => {
          const label = labels[col] ?? '';
          if (td.getAttribute('data-label') !== label) td.setAttribute('data-label', label);
          // the first labelled, non-checkbox cell is the card's title (name / id): shown full width, without a label
          const isPrimary = !primary && !!label && !td.querySelector('input[type=checkbox]') && td.colSpan === 1;
          if (isPrimary) primary = true;
          if (td.hasAttribute('data-primary') !== isPrimary) td.toggleAttribute('data-primary', isPrimary);
          col += td.colSpan || 1;
        });
      });
    });
  };
  const schedule = () => { if (!queued) { queued = true; requestAnimationFrame(apply); } };
  new MutationObserver(schedule).observe(root, { childList: true, subtree: true, characterData: true });
  schedule();
}
