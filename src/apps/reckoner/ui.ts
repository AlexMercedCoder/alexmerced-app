import { wireDataMenu } from '../../lib/dataMenu';
import { toast } from '../../lib/toast';
import {
  CalculationError,
  FUNCTIONS,
  bracketBalance,
  evaluate,
  formatNumber,
  type AngleMode,
} from './engine';
import {
  APP_ID,
  MEMORY_SLOTS,
  addTapeEntry,
  applyImport,
  buildExport,
  loadMemory,
  loadSettings,
  loadTape,
  saveMemory,
  saveSettings,
  saveTape,
  tapeToText,
  type MemoryBank,
  type Settings,
  type TapeEntry,
} from './store';

const KEYPAD: { label: string; insert?: string; action?: string; span?: number; tone?: string }[] = [
  { label: 'C', action: 'clear', tone: 'muted' },
  { label: '(', insert: '(' },
  { label: ')', insert: ')' },
  { label: '÷', insert: ' / ', tone: 'op' },
  { label: '7', insert: '7' },
  { label: '8', insert: '8' },
  { label: '9', insert: '9' },
  { label: '×', insert: ' * ', tone: 'op' },
  { label: '4', insert: '4' },
  { label: '5', insert: '5' },
  { label: '6', insert: '6' },
  { label: '−', insert: ' - ', tone: 'op' },
  { label: '1', insert: '1' },
  { label: '2', insert: '2' },
  { label: '3', insert: '3' },
  { label: '+', insert: ' + ', tone: 'op' },
  { label: '0', insert: '0' },
  { label: '.', insert: '.' },
  { label: '^', insert: '^' },
  { label: '=', action: 'equals', tone: 'accent' },
];

const FUNCTION_KEYS = [
  'sqrt(', 'pow(', 'ln(', 'log(', 'sin(', 'cos(', 'tan(',
  'abs(', 'round(', 'min(', 'max(', 'sum(', 'avg(', 'pctof(',
];

export function mountReckoner(root: HTMLElement): void {
  let settings: Settings = loadSettings();
  let tape: TapeEntry[] = loadTape();
  let memory: MemoryBank = loadMemory();

  const input = root.querySelector<HTMLInputElement>('#rk-input')!;
  const preview = root.querySelector<HTMLElement>('#rk-preview')!;
  const hint = root.querySelector<HTMLElement>('#rk-hint')!;
  const tapeList = root.querySelector<HTMLElement>('#rk-tape')!;
  const tapeEmpty = root.querySelector<HTMLElement>('#rk-tape-empty')!;
  const tapeCount = root.querySelector<HTMLElement>('#rk-tape-count')!;
  const keypad = root.querySelector<HTMLElement>('#rk-keypad')!;
  const functionBar = root.querySelector<HTMLElement>('#rk-functions')!;
  const memoryBar = root.querySelector<HTMLElement>('#rk-memory')!;
  const angleToggle = root.querySelector<HTMLButtonElement>('#rk-angle')!;
  const keypadToggle = root.querySelector<HTMLButtonElement>('#rk-keypad-toggle')!;

  const lastResult = () => (tape.length ? tape[0].result : 0);

  const variables = (): Record<string, number> => ({
    ans: lastResult(),
    last: lastResult(),
    ...memory,
  });

  function renderKeypad(): void {
    keypad.innerHTML = '';
    for (const key of KEYPAD) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `rk-key${key.tone ? ` rk-key--${key.tone}` : ''}`;
      button.textContent = key.label;
      if (key.insert) button.dataset.insert = key.insert;
      if (key.action) button.dataset.keyAction = key.action;
      keypad.appendChild(button);
    }

    functionBar.innerHTML = '';
    for (const token of FUNCTION_KEYS) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'rk-fn';
      button.textContent = token.replace('(', '');
      button.dataset.insert = token;
      const name = token.replace('(', '');
      button.title = FUNCTIONS[name]?.help ?? name;
      functionBar.appendChild(button);
    }
  }

  function renderMemory(): void {
    memoryBar.innerHTML = '';
    for (const slot of MEMORY_SLOTS) {
      const held = memory[slot];
      const cell = document.createElement('div');
      cell.className = `rk-mem${held === undefined ? '' : ' rk-mem--set'}`;

      const name = document.createElement('span');
      name.className = 'rk-mem__name';
      name.textContent = slot.toUpperCase();
      cell.appendChild(name);

      const value = document.createElement('button');
      value.type = 'button';
      value.className = 'rk-mem__value';
      value.textContent = held === undefined ? 'empty' : formatNumber(held, settings.precision);
      value.title = held === undefined ? `Store the current result in ${slot}` : `Insert ${slot} into the expression`;
      value.dataset.memorySlot = slot;
      cell.appendChild(value);

      const store = document.createElement('button');
      store.type = 'button';
      store.className = 'rk-mem__store';
      store.textContent = 'set';
      store.title = `Store the current result in ${slot}`;
      store.dataset.memoryStore = slot;
      cell.appendChild(store);

      if (held !== undefined) {
        const clear = document.createElement('button');
        clear.type = 'button';
        clear.className = 'rk-mem__clear';
        clear.textContent = '×';
        clear.setAttribute('aria-label', `Clear ${slot}`);
        clear.dataset.memoryClear = slot;
        cell.appendChild(clear);
      }

      memoryBar.appendChild(cell);
    }
  }

  function renderTape(): void {
    tapeCount.textContent = tape.length === 0 ? 'nothing yet' : `${tape.length} ${tape.length === 1 ? 'line' : 'lines'}`;
    tapeEmpty.hidden = tape.length > 0;
    tapeList.innerHTML = '';

    for (const item of tape) {
      const row = document.createElement('li');
      row.className = 'rk-tape__row';

      const expression = document.createElement('button');
      expression.type = 'button';
      expression.className = 'rk-tape__expr';
      expression.textContent = item.expression;
      expression.title = 'Put this expression back in the input';
      expression.dataset.reuseExpression = item.expression;

      const result = document.createElement('button');
      result.type = 'button';
      result.className = 'rk-tape__result';
      result.textContent = formatNumber(item.result, settings.precision);
      result.title = 'Insert this result into the expression';
      result.dataset.insert = String(item.result);

      const meta = document.createElement('span');
      meta.className = 'rk-tape__meta';
      meta.textContent = new Date(item.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'rk-tape__remove';
      remove.textContent = '×';
      remove.setAttribute('aria-label', `Remove ${item.expression}`);
      remove.dataset.removeTape = item.id;

      row.append(expression, result, meta, remove);
      tapeList.appendChild(row);
    }
  }

  function renderPreview(): void {
    const text = input.value.trim();
    if (!text) {
      preview.textContent = '';
      preview.dataset.state = 'idle';
      hint.textContent = 'Type an expression and press Enter. Try 2(3+4)^2 or pctof(15, 80).';
      return;
    }

    const depth = bracketBalance(text);
    try {
      const value = evaluate(text, { angleMode: settings.angleMode, variables: variables() });
      preview.textContent = `= ${formatNumber(value, settings.precision)}`;
      preview.dataset.state = 'ok';
      hint.textContent = depth > 0 ? `${depth} bracket${depth === 1 ? '' : 's'} still open` : 'Press Enter to keep this on the tape.';
    } catch (error) {
      preview.textContent = '';
      preview.dataset.state = 'pending';
      hint.textContent = error instanceof CalculationError ? error.message : 'Keep typing.';
    }
  }

  function commit(): void {
    const text = input.value.trim();
    if (!text) return;

    try {
      const value = evaluate(text, { angleMode: settings.angleMode, variables: variables() });
      tape = addTapeEntry(tape, text, value, settings.angleMode);
      saveTape(tape);
      input.value = '';
      renderTape();
      renderPreview();
      preview.textContent = `= ${formatNumber(value, settings.precision)}`;
      preview.dataset.state = 'ok';
      hint.textContent = 'Saved to the tape. "ans" now refers to that result.';
    } catch (error) {
      preview.dataset.state = 'error';
      preview.textContent = '';
      hint.textContent = error instanceof CalculationError ? error.message : 'That expression could not be worked out.';
      input.classList.add('is-shaking');
      window.setTimeout(() => input.classList.remove('is-shaking'), 350);
    }
  }

  function insert(fragment: string): void {
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? input.value.length;
    input.value = input.value.slice(0, start) + fragment + input.value.slice(end);
    const caret = start + fragment.length;
    input.setSelectionRange(caret, caret);
    input.focus();
    renderPreview();
  }

  function setAngleMode(mode: AngleMode): void {
    settings = { ...settings, angleMode: mode };
    saveSettings(settings);
    angleToggle.textContent = mode === 'deg' ? 'Degrees' : 'Radians';
    angleToggle.setAttribute('aria-pressed', String(mode === 'deg'));
    renderPreview();
  }

  function setKeypadVisible(visible: boolean): void {
    settings = { ...settings, showKeypad: visible };
    saveSettings(settings);
    root.dataset.keypad = visible ? 'on' : 'off';
    keypadToggle.setAttribute('aria-pressed', String(visible));
    keypadToggle.textContent = visible ? 'Hide keypad' : 'Show keypad';
  }

  root.addEventListener('click', (event) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>('[data-insert], [data-key-action], [data-reuse-expression], [data-remove-tape], [data-memory-slot], [data-memory-store], [data-memory-clear]');
    if (!target) return;

    if (target.dataset.insert !== undefined) { insert(target.dataset.insert); return; }

    if (target.dataset.reuseExpression !== undefined) {
      input.value = target.dataset.reuseExpression;
      input.focus();
      renderPreview();
      return;
    }

    if (target.dataset.removeTape) {
      tape = tape.filter((item) => item.id !== target.dataset.removeTape);
      saveTape(tape);
      renderTape();
      return;
    }

    if (target.dataset.memorySlot) {
      const slot = target.dataset.memorySlot;
      if (memory[slot] === undefined) {
        memory = { ...memory, [slot]: lastResult() };
        saveMemory(memory);
        renderMemory();
        toast(`Stored ${formatNumber(lastResult(), settings.precision)} in ${slot.toUpperCase()}.`);
      } else {
        insert(slot);
      }
      return;
    }

    if (target.dataset.memoryStore) {
      const slot = target.dataset.memoryStore;
      let value = lastResult();
      const typed = input.value.trim();
      if (typed) {
        try { value = evaluate(typed, { angleMode: settings.angleMode, variables: variables() }); } catch { /* keep ans */ }
      }
      memory = { ...memory, [slot]: value };
      saveMemory(memory);
      renderMemory();
      toast(`${slot.toUpperCase()} now holds ${formatNumber(value, settings.precision)}.`);
      return;
    }

    if (target.dataset.memoryClear) {
      const { [target.dataset.memoryClear]: _removed, ...rest } = memory;
      memory = rest;
      saveMemory(memory);
      renderMemory();
      return;
    }

    const action = target.dataset.keyAction;
    if (action === 'clear') { input.value = ''; renderPreview(); input.focus(); return; }
    if (action === 'equals') { commit(); input.focus(); }
  });

  input.addEventListener('input', renderPreview);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); commit(); return; }
    if (event.key === 'Escape') { input.value = ''; renderPreview(); return; }
    if (event.key === 'ArrowUp' && input.value === '' && tape.length) {
      event.preventDefault();
      input.value = tape[0].expression;
      renderPreview();
    }
  });

  angleToggle.addEventListener('click', () => setAngleMode(settings.angleMode === 'deg' ? 'rad' : 'deg'));
  keypadToggle.addEventListener('click', () => setKeypadVisible(!settings.showKeypad));

  root.querySelector('#rk-copy')?.addEventListener('click', async () => {
    if (!tape.length) { toast('There is nothing on the tape yet.'); return; }
    try {
      await navigator.clipboard.writeText(formatNumber(tape[0].result, settings.precision));
      toast('Latest result copied.', { kind: 'good' });
    } catch {
      toast('The browser would not let us reach the clipboard.', { kind: 'error' });
    }
  });

  root.querySelector('#rk-copy-tape')?.addEventListener('click', async () => {
    if (!tape.length) { toast('There is nothing on the tape yet.'); return; }
    try {
      await navigator.clipboard.writeText(tapeToText(tape));
      toast('Whole tape copied as text.', { kind: 'good' });
    } catch {
      toast('The browser would not let us reach the clipboard.', { kind: 'error' });
    }
  });

  root.querySelector('#rk-clear-tape')?.addEventListener('click', () => {
    if (!tape.length) return;
    const previous = tape;
    tape = [];
    saveTape(tape);
    renderTape();
    toast('Tape cleared.', {
      actionLabel: 'Undo',
      onAction: () => { tape = previous; saveTape(tape); renderTape(); },
    });
  });

  wireDataMenu(root, {
    app: APP_ID,
    buildExport: () => buildExport(),
    applyImport: (text, mode) => {
      const result = applyImport(text, mode);
      return `Imported. The tape now has ${result.tape} ${result.tape === 1 ? 'line' : 'lines'}.`;
    },
    onImported: () => {
      settings = loadSettings();
      tape = loadTape();
      memory = loadMemory();
      setAngleMode(settings.angleMode);
      setKeypadVisible(settings.showKeypad);
      renderTape();
      renderMemory();
      renderPreview();
    },
    onClearAll: () => {
      tape = [];
      memory = {};
      saveTape(tape);
      saveMemory(memory);
    },
    clearWarning: 'This clears the tape and every memory register stored on this device. Export first if you want a copy. Continue?',
  });

  renderKeypad();
  renderMemory();
  renderTape();
  setAngleMode(settings.angleMode);
  setKeypadVisible(settings.showKeypad);
  renderPreview();
  input.focus();
}
