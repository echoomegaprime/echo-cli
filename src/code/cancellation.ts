/** Cancellation is local settlement, never proof that a remote operation stopped. */
export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Operation interrupted; inspect any dispatched work before retrying', 'AbortError');
}

/**
 * Bound an awaited phase even when its transport ignores cancellation. Register
 * first, refuse dispatch after an already-observed abort, and consume late
 * settlement without allowing it to become a successful result or a retry.
 * Work that performs more than one external action must also check the signal
 * between those actions.
 */
export function abortable<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (done: () => void) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', aborted);
      done();
    };
    const aborted = () => finish(() => reject(new DOMException('Operation interrupted; inspect any dispatched work before retrying', 'AbortError')));
    signal?.addEventListener('abort', aborted, { once: true });
    if (signal?.aborted) { aborted(); return; }
    let pending: Promise<T>;
    try {
      throwIfAborted(signal);
      pending = work();
    } catch (error) { finish(() => reject(error)); return; }
    Promise.resolve(pending).then(value => {
      if (signal?.aborted) aborted();
      else finish(() => resolve(value));
    }, error => finish(() => reject(error)));
  });
}
