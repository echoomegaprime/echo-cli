import {expect, it, vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

const source = readFileSync(
  new URL('../ui/echo-prime/activity.js', import.meta.url),
  'utf8',
);

interface FakeEvent {
  type: string;
  target: Node;
  currentTarget: Node;
  preventDefault(): void;
  stopPropagation(): void;
}

type EventListener = (this: Node, event: FakeEvent) => void;

class Node {
  readonly tagName: string;
  className = '';
  hidden = false;
  dataset: Record<string, string> = {};
  attributes: Record<string, string> = {};
  children: Node[] = [];
  events: Record<string, EventListener[]> = {};
  parent: Node | null = null;

  private ownText = '';

  constructor(tagName: string) {
    this.tagName = tagName.toUpperCase();
  }

  get parentNode(): Node | null {
    return this.parent;
  }

  get textContent(): string {
    return this.ownText + this.children.map(child => child.textContent).join('');
  }

  set textContent(value: string) {
    this.replaceChildren();
    this.ownText = String(value ?? '');
  }

  get id(): string {
    return this.getAttribute('id') ?? '';
  }

  set id(value: string) {
    this.setAttribute('id', value);
  }

  readonly classList = {
    add: (...tokens: string[]): void => {
      const classes = new Set(this.className.split(/\s+/).filter(Boolean));
      for (const token of tokens) classes.add(token);
      this.className = [...classes].join(' ');
    },
    remove: (...tokens: string[]): void => {
      const removed = new Set(tokens);
      this.className = this.className
        .split(/\s+/)
        .filter(token => token && !removed.has(token))
        .join(' ');
    },
    contains: (token: string): boolean => {
      return this.className.split(/\s+/).includes(token);
    },
    toggle: (token: string, force?: boolean): boolean => {
      const enabled = force ?? !this.classList.contains(token);
      if (enabled) this.classList.add(token);
      else this.classList.remove(token);
      return enabled;
    },
  };

  append(...nodes: Array<Node | string>): void {
    for (const value of nodes) {
      const child = typeof value === 'string' ? new Node('#text') : value;
      if (typeof value === 'string') child.textContent = value;

      child.remove();
      child.parent = this;
      this.children.push(child);
    }
  }

  replaceChildren(...nodes: Array<Node | string>): void {
    for (const child of this.children) child.parent = null;
    this.children = [];
    this.ownText = '';
    this.append(...nodes);
  }

  setAttribute(key: string, value: string): void {
    const text = String(value);
    this.attributes[key] = text;
    if (key === 'class') this.className = text;
  }

  getAttribute(key: string): string | null {
    if (key === 'class') return this.className || null;
    return Object.prototype.hasOwnProperty.call(this.attributes, key)
      ? this.attributes[key]!
      : null;
  }

  addEventListener(name: string, listener: EventListener): void {
    (this.events[name] ??= []).push(listener);
  }

  fire(name: string): void {
    const event: FakeEvent = {
      type: name,
      target: this,
      currentTarget: this,
      preventDefault() {},
      stopPropagation() {},
    };

    for (const listener of [...(this.events[name] ?? [])]) {
      listener.call(this, event);
    }
  }

  remove(): void {
    if (!this.parent) return;

    const siblings = this.parent.children;
    const index = siblings.indexOf(this);
    if (index !== -1) siblings.splice(index, 1);
    this.parent = null;
  }

  querySelector(selector: string): Node | null {
    for (const child of this.children) {
      if (child.matches(selector)) return child;
      const descendant = child.querySelector(selector);
      if (descendant) return descendant;
    }
    return null;
  }

  querySelectorAll(selector: string): Node[] {
    const matches: Node[] = [];
    for (const child of this.children) {
      if (child.matches(selector)) matches.push(child);
      matches.push(...child.querySelectorAll(selector));
    }
    return matches;
  }

  private matches(selector: string): boolean {
    // Supports tags, classes, and combinations such as ".activity-chip.pending".
    const [tag, ...classes] = selector.trim().split('.');
    const tagMatches = !tag || tag === '*' || this.tagName === tag.toUpperCase();
    return tagMatches && classes.every(token => this.classList.contains(token));
  }
}

interface ActivityHandle {
  tool(id: string, name: string): ActivityHandle;
  result(
    id: string,
    name: string,
    status: string,
    evidence: Record<string, unknown>,
  ): ActivityHandle;
  status(text: string): ActivityHandle;
  note(text: string): ActivityHandle;
  thinking(): ActivityHandle;
  answering(): ActivityHandle;
  done(summaryText?: string): ActivityHandle;
  fail(reason: string): ActivityHandle;
  elapsed(): number;
  readonly collapsed: boolean;
  remove(): ActivityHandle;
}

interface ActivityApi {
  start(container: Node, options: {label: string}): ActivityHandle;
  clear(container: Node): void;
}

function harness() {
  const window = {} as {EchoPrimeActivity: ActivityApi};
  const document = {
    createElement: (tag: string): Node => new Node(tag),
  };

  // Keep time deterministic within this VM without changing the test process.
  const epoch = 1_700_000_000_000;
  const Date = class extends globalThis.Date {
    constructor(value: string | number = epoch) {
      super(value);
    }

    static now(): number {
      return epoch;
    }
  };

  const context = {
    window,
    document,
    setInterval: vi.fn((_fn: () => void) => 0),
    clearInterval: vi.fn(() => {}),
    performance: {now: () => Date.now()},
    Date,
    Error,
  };

  runInNewContext(source, context);

  if (!window.EchoPrimeActivity) {
    throw new Error('activity.js did not expose window.EchoPrimeActivity');
  }

  const container = new Node('section');
  container.hidden = true;

  const makeHandle = (label = 'Test activity'): ActivityHandle => {
    return window.EchoPrimeActivity.start(container, {label});
  };

  const get = (selector: string, root: Node = container): Node => {
    const node = root.querySelector(selector);
    if (!node) throw new Error(`Missing element: ${selector}`);
    return node;
  };

  return {window, container, makeHandle, get};
}

it('start builds one strip, reveals the container, and defaults to collapsed details', () => {
  const {container, makeHandle, get} = harness();
  const previous = new Node('p');
  previous.textContent = 'Previous content';
  container.append(previous);

  const handle = makeHandle('Workspace activity');
  const strip = get('.activity-strip');

  expect(container.children).toEqual([strip]);
  expect(container.querySelectorAll('.activity-strip')).toHaveLength(1);
  expect(previous.parent).toBeNull();
  expect(container.hidden).toBe(false);
  expect(strip.dataset.collapsed).toBe('true');
  expect(get('.activity-details').hidden).toBe(true);
  expect(get('.activity-summary').getAttribute('aria-expanded')).toBe('false');
  expect(handle.collapsed).toBe(true);
});

it('clear empties the container and hides it', () => {
  const {window, container, makeHandle, get} = harness();
  makeHandle();
  const strip = get('.activity-strip');

  window.EchoPrimeActivity.clear(container);

  expect(container.children).toHaveLength(0);
  expect(container.hidden).toBe(true);
  expect(strip.parent).toBeNull();
});

it('tool adds a pending chip containing the tool name and an ellipsis', () => {
  const {makeHandle, get} = harness();
  const handle = makeHandle();
  const chips = get('.activity-chips');

  expect(chips.querySelectorAll('.activity-chip')).toHaveLength(0);

  handle.tool('workspace-1', 'workspace');

  expect(chips.querySelectorAll('.activity-chip')).toHaveLength(1);
  const chip = get('.activity-chip', chips);
  expect(chip.classList.contains('pending')).toBe(true);
  expect(chip.textContent).toContain('workspace');
  expect(chip.textContent).toContain('…');
});

it('result renders an observed tool as ok with a check mark', () => {
  const {makeHandle, get} = harness();
  const handle = makeHandle();

  handle.result('id', 'workspace', 'observed', {});

  const chip = get('.activity-chip');
  expect(chip.classList.contains('ok')).toBe(true);
  expect(chip.classList.contains('pending')).toBe(false);
  expect(chip.textContent).toContain('✓');
});

it('result renders an unknown tool as warn with an unknown failure mark', () => {
  const {makeHandle, get} = harness();
  const handle = makeHandle();

  handle.result('id', 'workspace', 'unknown', {});

  const chip = get('.activity-chip');
  expect(chip.classList.contains('warn')).toBe(true);
  expect(chip.textContent).toContain('✗');
  expect(chip.textContent).toContain('unknown');
});

it('result renders a failing status as fail', () => {
  const {makeHandle, get} = harness();
  const handle = makeHandle();

  handle.result('id', 'workspace', 'failed', {});

  const chip = get('.activity-chip');
  expect(chip.classList.contains('fail')).toBe(true);
  expect(chip.textContent).toContain('✗ failed');
});

it('tool followed by result for the same id updates the existing chip', () => {
  const {makeHandle, get} = harness();
  const handle = makeHandle();

  handle.tool('same-id', 'workspace');
  const originalChip = get('.activity-chip');

  handle.result('same-id', 'workspace', 'observed', {});

  expect(get('.activity-chips').querySelectorAll('.activity-chip')).toHaveLength(1);
  expect(get('.activity-chip')).toBe(originalChip);
  expect(originalChip.classList.contains('pending')).toBe(false);
  expect(originalChip.classList.contains('ok')).toBe(true);
});

it('two different tool ids produce two chips', () => {
  const {makeHandle, get} = harness();
  const handle = makeHandle();

  handle.tool('workspace-1', 'workspace');
  handle.tool('esh-1', 'esh');

  const chips = get('.activity-chips').querySelectorAll('.activity-chip');
  expect(chips).toHaveLength(2);
  expect(chips[0]!.textContent).toContain('workspace');
  expect(chips[1]!.textContent).toContain('esh');
});

it('result appends a detail row with readable text to the details panel', () => {
  const {makeHandle, get} = harness();
  const handle = makeHandle();
  const details = get('.activity-details');
  const previousCount = details.querySelectorAll('.activity-detail').length;

  handle.result('workspace-1', 'workspace', 'observed', {});

  const rows = details.querySelectorAll('.activity-detail');
  expect(rows).toHaveLength(previousCount + 1);
  expect(rows[rows.length - 1]!.textContent.trim().length).toBeGreaterThan(0);
});

it('status sets the activity line text', () => {
  const {makeHandle, get} = harness();
  const handle = makeHandle();

  handle.status('Inspecting the workspace');

  expect(get('.activity-line-text').textContent).toBe('Inspecting the workspace');
});

it('note appends a detail row containing the note text', () => {
  const {makeHandle, get} = harness();
  const handle = makeHandle();
  const details = get('.activity-details');
  const previousCount = details.querySelectorAll('.activity-detail').length;

  handle.note('Workspace inspection completed');

  const rows = details.querySelectorAll('.activity-detail');
  expect(rows).toHaveLength(previousCount + 1);
  expect(rows[rows.length - 1]!.textContent).toContain(
    'Workspace inspection completed',
  );
});

it('thinking sets the line text to start with Echo is thinking', () => {
  const {makeHandle, get} = harness();
  const handle = makeHandle();

  handle.thinking();

  expect(get('.activity-line-text').textContent).toMatch(/^Echo is thinking…/);
});

it('answering sets the line text to start with Echo is answering', () => {
  const {makeHandle, get} = harness();
  const handle = makeHandle();

  handle.answering();

  expect(get('.activity-line-text').textContent).toMatch(/^Echo is answering…/);
});

it('clicking the summary expands the details and updates aria-expanded', () => {
  const {makeHandle, get} = harness();
  const handle = makeHandle();
  const summary = get('.activity-summary');

  summary.fire('click');

  expect(get('.activity-strip').dataset.collapsed).toBe('false');
  expect(get('.activity-details').hidden).toBe(false);
  expect(summary.getAttribute('aria-expanded')).toBe('true');
  expect(handle.collapsed).toBe(false);
});

it('clicking the summary again collapses the details', () => {
  const {makeHandle, get} = harness();
  const handle = makeHandle();
  const summary = get('.activity-summary');

  summary.fire('click');
  summary.fire('click');

  expect(get('.activity-strip').dataset.collapsed).toBe('true');
  expect(get('.activity-details').hidden).toBe(true);
  expect(summary.getAttribute('aria-expanded')).toBe('false');
  expect(handle.collapsed).toBe(true);
});

it('done collapses an expanded strip and sets its state to done', () => {
  const {makeHandle, get} = harness();
  const handle = makeHandle();
  get('.activity-summary').fire('click');
  expect(get('.activity-details').hidden).toBe(false);

  handle.done();

  expect(get('.activity-strip').dataset.state).toBe('done');
  expect(get('.activity-strip').dataset.collapsed).toBe('true');
  expect(get('.activity-details').hidden).toBe(true);
  expect(get('.activity-summary').getAttribute('aria-expanded')).toBe('false');
  expect(handle.collapsed).toBe(true);
});

it('tool is a no-op after done', () => {
  const {makeHandle, get} = harness();
  const handle = makeHandle();
  handle.tool('existing-id', 'workspace');
  handle.result('existing-id', 'workspace', 'observed', {});
  handle.done();

  const chips = get('.activity-chips');
  const before = [...chips.children];
  const beforeText = chips.textContent;

  expect(handle.tool('late-id', 'late tool')).toBe(handle);

  expect(chips.children).toEqual(before);
  expect(chips.querySelectorAll('.activity-chip')).toHaveLength(1);
  expect(chips.textContent).toBe(beforeText);
});

it('status does not change the line text after done', () => {
  const {makeHandle, get} = harness();
  const handle = makeHandle();
  handle.done('Completed');
  const before = get('.activity-line-text').textContent;

  expect(handle.status('x')).toBe(handle);

  expect(get('.activity-line-text').textContent).toBe(before);
});

it('fail sets the failed state and displays the reason', () => {
  const {makeHandle, get} = harness();
  const handle = makeHandle();
  const reason = 'Workspace inspection failed';

  handle.fail(reason);

  expect(get('.activity-strip').dataset.state).toBe('failed');
  expect(get('.activity-line-text').textContent).toBe(reason);
});

it('fail marks a still-pending chip as warn with an unresolved mark', () => {
  const {makeHandle, get} = harness();
  const handle = makeHandle();
  handle.tool('pending-id', 'workspace');

  handle.fail('Stopped before the tool returned');

  const chip = get('.activity-chip');
  expect(chip.classList.contains('warn')).toBe(true);
  expect(chip.classList.contains('pending')).toBe(false);
  expect(chip.textContent).toContain('✗ unresolved');
});

it('fail preserves an already-ok chip while marking pending work unresolved', () => {
  const {makeHandle, get} = harness();
  const handle = makeHandle();

  handle.tool('completed-id', 'workspace');
  handle.result('completed-id', 'workspace', 'observed', {});
  const completedChip = get('.activity-chip');
  const completedText = completedChip.textContent;
  handle.tool('pending-id', 'esh');

  handle.fail('Another tool failed');

  expect(completedChip.classList.contains('ok')).toBe(true);
  expect(completedChip.classList.contains('warn')).toBe(false);
  expect(completedChip.textContent).toBe(completedText);

  const pendingChip = get('.activity-chip.warn');
  expect(pendingChip.textContent).toContain('esh');
  expect(pendingChip.textContent).toContain('✗ unresolved');
});

it('fail displays the supplied reason exactly without duplicating its retry sentence', () => {
  const {makeHandle, get} = harness();
  const handle = makeHandle();
  const reason = 'X. No automatic retry was made.';

  handle.fail(reason);

  expect(get('.activity-line-text').textContent).toBe(reason);
});

it('elapsed returns a finite nonnegative number of seconds', () => {
  const {makeHandle} = harness();
  const handle = makeHandle();

  const elapsed = handle.elapsed();

  expect(typeof elapsed).toBe('number');
  expect(Number.isFinite(elapsed)).toBe(true);
  expect(elapsed).toBeGreaterThanOrEqual(0);
});

it('the collapsed getter reflects the current collapse state', () => {
  const {makeHandle, get} = harness();
  const handle = makeHandle();
  const summary = get('.activity-summary');

  expect(handle.collapsed).toBe(true);

  summary.fire('click');
  expect(handle.collapsed).toBe(false);

  summary.fire('click');
  expect(handle.collapsed).toBe(true);

  summary.fire('click');
  expect(handle.collapsed).toBe(false);

  handle.done();
  expect(handle.collapsed).toBe(true);
});

it('remove detaches the strip from the container', () => {
  const {container, makeHandle, get} = harness();
  const handle = makeHandle();
  const strip = get('.activity-strip');

  expect(container.children).toContain(strip);

  handle.remove();

  expect(container.children).not.toContain(strip);
  expect(container.children).toHaveLength(0);
  expect(container.querySelector('.activity-strip')).toBeNull();
  expect(strip.parent).toBeNull();
});

it('the summary is a button whose aria-controls points to the details id', () => {
  const {makeHandle, get} = harness();
  makeHandle();

  const summary = get('.activity-summary');
  const details = get('.activity-details');

  expect(summary.tagName).toBe('BUTTON');
  expect(details.id).not.toBe('');
  expect(summary.getAttribute('aria-controls')).toBe(details.id);
});

it('observed and unknown chips render distinct compact success and unknown marks', () => {
  const {makeHandle, get} = harness();
  const handle = makeHandle();

  handle.tool('workspace-id', 'workspace');
  handle.tool('esh-id', 'esh');
  handle.result('workspace-id', 'workspace', 'observed', {});
  handle.result('esh-id', 'esh', 'unknown', {});

  const chips = get('.activity-chips').querySelectorAll('.activity-chip');
  expect(chips).toHaveLength(2);

  const workspaceChip = chips[0]!;
  const eshChip = chips[1]!;

  expect(workspaceChip.classList.contains('ok')).toBe(true);
  expect(workspaceChip.textContent).toContain('workspace');
  expect(workspaceChip.textContent).toContain('✓');
  expect(workspaceChip.textContent).not.toContain('✗');
  expect(workspaceChip.textContent).not.toMatch(/[\r\n]/);

  expect(eshChip.classList.contains('warn')).toBe(true);
  expect(eshChip.textContent).toContain('esh');
  expect(eshChip.textContent).toContain('✗ unknown');
  expect(eshChip.textContent).not.toContain('✓');
  expect(eshChip.textContent).not.toMatch(/[\r\n]/);
});

it('result neither updates an existing chip nor adds chips or details after done', () => {
  const {makeHandle, get} = harness();
  const handle = makeHandle();

  handle.tool('existing-id', 'workspace');
  handle.result('existing-id', 'workspace', 'observed', {});
  handle.done();

  const chip = get('.activity-chip');
  const chips = get('.activity-chips');
  const details = get('.activity-details');
  const beforeClass = chip.className;
  const beforeChipText = chip.textContent;
  const beforeChips = [...chips.children];
  const beforeDetails = [...details.children];
  const beforeDetailsText = details.textContent;
  const beforeLine = get('.activity-line-text').textContent;

  expect(handle.result('existing-id', 'workspace', 'failed', {})).toBe(handle);
  expect(handle.result('new-id', 'esh', 'unknown', {})).toBe(handle);

  expect(chips.children).toEqual(beforeChips);
  expect(chips.querySelectorAll('.activity-chip')).toHaveLength(1);
  expect(chip.className).toBe(beforeClass);
  expect(chip.textContent).toBe(beforeChipText);
  expect(details.children).toEqual(beforeDetails);
  expect(details.textContent).toBe(beforeDetailsText);
  expect(get('.activity-line-text').textContent).toBe(beforeLine);
  expect(get('.activity-strip').dataset.state).toBe('done');
});

it('result treats ok as a successful status', () => {
  const {makeHandle, get} = harness();
  const handle = makeHandle();

  handle.tool('id', 'workspace');
  handle.result('id', 'workspace', 'ok', {});

  const chip = get('.activity-chip');
  expect(chip.classList.contains('ok')).toBe(true);
  expect(chip.classList.contains('pending')).toBe(false);
  expect(chip.textContent).toContain('✓');
});

it('result treats unconfirmed as a warning and names the real status word', () => {
  const {makeHandle, get} = harness();
  const handle = makeHandle();

  handle.tool('id', 'workspace');
  handle.result('id', 'workspace', 'unconfirmed', {});

  const chip = get('.activity-chip');
  expect(chip.classList.contains('warn')).toBe(true);
  expect(chip.classList.contains('pending')).toBe(false);
  expect(chip.textContent).toContain('✗ unconfirmed');
});

it('the handle mutation methods are chainable', () => {
  const {makeHandle} = harness();
  const handle = makeHandle();

  expect(handle.tool('id', 'workspace')).toBe(handle);
  expect(handle.result('id', 'workspace', 'observed', {})).toBe(handle);
  expect(handle.status('Working')).toBe(handle);
  expect(handle.note('A detail')).toBe(handle);
  expect(handle.thinking()).toBe(handle);
  expect(handle.answering()).toBe(handle);
  expect(handle.done('Completed')).toBe(handle);
  expect(handle.remove()).toBe(handle);
});

it('fail is chainable', () => {
  const {makeHandle} = harness();
  const handle = makeHandle();

  expect(handle.fail('Unable to continue')).toBe(handle);
});
