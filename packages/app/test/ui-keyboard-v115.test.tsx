// @vitest-environment jsdom
/**
 * The shared UI kit works from the keyboard (v1.1.5, audit finding A-16).
 *
 * Sauda is sold to shops whose till is driven by the keyboard — barcode, quantity, Enter, next
 * customer. Before this pass:
 *
 *  - a dialog let Tab walk into the page behind it, and closing it dropped focus on `<body>`, so the
 *    cashier's next keystroke went nowhere;
 *  - the tab strip had no arrow-key behaviour, and every tab was a separate tab stop;
 *  - a clickable table row (open sale, edit product) could only be opened with a mouse;
 *  - a segmented control announced nothing about which option was selected.
 *
 * These are behaviour tests: they render the real components and drive them with keyboard events,
 * which is the only way to know a focus trap actually traps.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DataTable, Modal, Segmented, Tabs } from '../src/ui.js';

afterEach(cleanup);

function Harness() {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button onClick={() => setOpen(true)}>খুলুন</button>
      {open ? (
        <Modal title="পেমেন্ট" onClose={() => setOpen(false)}>
          <input aria-label="প্রথম" />
          <input aria-label="দ্বিতীয়" />
          <button onClick={() => setOpen(false)}>সম্পন্ন</button>
        </Modal>
      ) : null}
    </div>
  );
}

describe('Modal keeps the keyboard inside the dialog', () => {
  it('moves focus into the dialog when it opens', () => {
    render(<Harness />);
    fireEvent.click(screen.getByText('খুলুন'));
    expect(document.activeElement).toBe(screen.getByLabelText('প্রথম'));
  });

  it('cycles Tab and Shift+Tab inside the dialog instead of escaping to the page', () => {
    render(<Harness />);
    fireEvent.click(screen.getByText('খুলুন'));
    const last = screen.getByText('সম্পন্ন');
    last.focus();
    fireEvent.keyDown(document.activeElement!, { key: 'Tab' });
    // Tab from the last control wraps to the first one in the dialog (its close button)…
    const first = screen.getByLabelText('বন্ধ করুন');
    expect(document.activeElement).toBe(first);

    // …and Shift+Tab from the first control wraps back to the last one.
    fireEvent.keyDown(document.activeElement!, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
    // The trigger button behind the dialog was never reachable by Tab.
    expect(document.activeElement).not.toBe(screen.getByText('খুলুন'));
  });

  it('closes on Escape and puts focus back on the control that opened it', () => {
    render(<Harness />);
    const trigger = screen.getByText('খুলুন');
    trigger.focus();
    fireEvent.click(trigger);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('is announced as a dialog named by its title', () => {
    render(<Harness />);
    fireEvent.click(screen.getByText('খুলুন'));
    const dialog = screen.getByRole('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    const labelledBy = dialog.getAttribute('aria-labelledby');
    expect(labelledBy).toBeTruthy();
    expect(document.getElementById(labelledBy!)?.textContent).toBe('পেমেন্ট');
  });
});

describe('Tabs are one tab stop navigated with the arrow keys', () => {
  it('moves the selection with ArrowRight / ArrowLeft and wraps around', () => {
    function TabsHarness() {
      const [active, setActive] = useState<'a' | 'b' | 'c'>('a');
      return (
        <Tabs
          tabs={[
            { id: 'a', label: 'এক' },
            { id: 'b', label: 'দুই' },
            { id: 'c', label: 'তিন' },
          ]}
          active={active}
          onChange={setActive}
        />
      );
    }
    render(<TabsHarness />);
    const strip = screen.getByRole('tablist');
    expect(screen.getByRole('tab', { name: 'এক' }).getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(strip, { key: 'ArrowRight' });
    expect(screen.getByRole('tab', { name: 'দুই' }).getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(strip, { key: 'ArrowLeft' });
    fireEvent.keyDown(strip, { key: 'ArrowLeft' });
    // Wrapped from the first tab to the last one.
    expect(screen.getByRole('tab', { name: 'তিন' }).getAttribute('aria-selected')).toBe('true');
  });

  it('gives the active tab the only tab stop', () => {
    render(<Tabs tabs={[{ id: 'a', label: 'এক' }, { id: 'b', label: 'দুই' }]} active="b" onChange={() => undefined} />);
    expect(screen.getByRole('tab', { name: 'এক' }).getAttribute('tabindex')).toBe('-1');
    expect(screen.getByRole('tab', { name: 'দুই' }).getAttribute('tabindex')).toBe('0');
  });
});

describe('Segmented control states its selection', () => {
  it('marks the selected option as pressed', () => {
    render(
      <Segmented
        options={[
          { value: 'week', label: 'সপ্তাহ' },
          { value: 'month', label: 'মাস' },
        ]}
        value="month"
        onChange={() => undefined}
      />,
    );
    expect(screen.getByRole('button', { name: 'মাস' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'সপ্তাহ' }).getAttribute('aria-pressed')).toBe('false');
  });
});

describe('clickable table rows work from the keyboard', () => {
  const columns = [{ key: 'invoice_no', label: 'ইনভয়েস' }, { key: 'total_paisa', label: 'মোট', money: true, align: 'right' as const }];

  it('opens a row with Enter and with Space, and is a tab stop', () => {
    const onRowClick = vi.fn();
    render(
      <DataTable
        columns={columns}
        rows={[{ invoice_no: 'INV-1', total_paisa: 1_234_567 }]}
        rowKey={(row: { invoice_no: string }) => row.invoice_no}
        onRowClick={onRowClick}
      />,
    );
    const row = screen.getByRole('button', { name: /INV-1/ });
    expect(row.getAttribute('tabindex')).toBe('0');
    fireEvent.keyDown(row, { key: 'Enter' });
    fireEvent.keyDown(row, { key: ' ' });
    expect(onRowClick).toHaveBeenCalledTimes(2);
    // Money columns stay machine-aligned.
    const cell = screen.getByText(/12,345\.67/);
    expect(cell.className).toContain('num');
    expect(cell.className).toContain('right');
  });

  it('does not make a plain data row into a button', () => {
    render(<DataTable columns={columns} rows={[{ invoice_no: 'INV-2', total_paisa: 1 }]} />);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('announces the sort direction on the sorted column', () => {
    render(
      <DataTable
        columns={[...columns, { key: 'date', label: 'তারিখ' }]}
        rows={[{ invoice_no: 'INV-3', total_paisa: 1, date: '2026-01-01' }]}
        sort={{ key: 'date', dir: 'desc' }}
      />,
    );
    expect(screen.getByRole('columnheader', { name: 'তারিখ' }).getAttribute('aria-sort')).toBe('descending');
    expect(screen.getByRole('columnheader', { name: 'ইনভয়েস' }).getAttribute('aria-sort')).toBeNull();
  });
});
