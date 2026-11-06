import { hash } from './workspace.js';
import type { Proposal } from './workspace.js';

const MAX_TEXT_BYTES = 65536;
const CONTEXT_LINES = 3;
type LineEndings = 'none' | 'LF' | 'CRLF' | 'mixed';
export interface ReviewPreview extends Proposal {
  change: 'create' | 'modify' | 'unchanged';
  /** Display only: control characters are escaped. Apply the hash-bound proposal, never this text. */
  unifiedDiff: string;
  beforeLineEndings: LineEndings;
  afterLineEndings: LineEndings;
}
interface Line { text: string; newline: boolean }
function lines(text: string): Line[] {
  if (text === '') return [];
  const ended = text.endsWith('\n'), parts = text.split('\n');
  if (ended) parts.pop();
  return parts.map((text, index) => ({ text, newline: ended || index < parts.length - 1 }));
}
function endings(text: string): LineEndings {
  let lf = false, crlf = false;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') { if (text[i - 1] === '\r') crlf = true; else lf = true; }
  }
  return lf && crlf ? 'mixed' : crlf ? 'CRLF' : lf ? 'LF' : 'none';
}
function display(text: string): string {
  return text.replace(/./gs, char => {
    const code = char.charCodeAt(0);
    const control = code < 32 && code !== 9 || code >= 127 && code <= 159
      || code >= 0x2028 && code <= 0x202e || code >= 0x2066 && code <= 0x2069;
    return !control ? char : char === '\r' ? '\\r' : `\\u${code.toString(16).padStart(4, '0')}`;
  });
}
const equal = (left: Line, right: Line) => left.text === right.text && left.newline === right.newline;
function render(prefix: string, line: Line): string {
  return `${prefix}${display(line.text)}\n${line.newline ? '' : '\\ No newline at end of file\n'}`;
}

/** Linear in input size. One changed span avoids quadratic comparisons on adversarial files. */
export function previewProposal(proposal: Proposal): ReviewPreview {
  if (typeof proposal.path !== 'string' || proposal.path.length > 1000
      || typeof proposal.after !== 'string' || proposal.before !== null && typeof proposal.before !== 'string') {
    throw new Error('Invalid proposal text or path');
  }
  if (Buffer.byteLength(proposal.after) > MAX_TEXT_BYTES
      || proposal.before !== null && Buffer.byteLength(proposal.before) > MAX_TEXT_BYTES) {
    throw new Error('Proposal review size limit reached');
  }
  if (hash(proposal.after) !== proposal.afterHash
      || (proposal.before === null ? null : hash(proposal.before)) !== proposal.beforeHash) {
    throw new Error('Proposal integrity failed');
  }
  const change = proposal.before === null ? 'create' : proposal.before === proposal.after ? 'unchanged' : 'modify';
  const result: ReviewPreview = { ...proposal, change, unifiedDiff: '',
    beforeLineEndings: endings(proposal.before ?? ''), afterLineEndings: endings(proposal.after) };
  if (change === 'unchanged') return result;
  const before = lines(proposal.before ?? ''), after = lines(proposal.after);
  let prefix = 0, suffix = 0;
  while (prefix < before.length && prefix < after.length && equal(before[prefix], after[prefix])) prefix++;
  while (suffix < before.length - prefix && suffix < after.length - prefix
      && equal(before[before.length - suffix - 1], after[after.length - suffix - 1])) suffix++;
  const start = Math.max(0, prefix - CONTEXT_LINES);
  const beforeEnd = before.length - suffix, afterEnd = after.length - suffix;
  const context = Math.min(CONTEXT_LINES, suffix);
  const beforeCount = beforeEnd + context - start, afterCount = afterEnd + context - start;
  const output = [
    `--- ${proposal.before === null ? '/dev/null' : `a/${display(proposal.path)}`}\n`,
    `+++ b/${display(proposal.path)}\n`,
  ];
  if (beforeCount || afterCount) {
    output.push(`@@ -${beforeCount ? start + 1 : start},${beforeCount} +${afterCount ? start + 1 : start},${afterCount} @@\n`);
    for (let i = start; i < prefix; i++) output.push(render(' ', before[i]));
    for (let i = prefix; i < beforeEnd; i++) output.push(render('-', before[i]));
    for (let i = prefix; i < afterEnd; i++) output.push(render('+', after[i]));
    for (let i = 0; i < context; i++) output.push(render(' ', before[beforeEnd + i]));
  }
  result.unifiedDiff = output.join('');
  return result;
}
