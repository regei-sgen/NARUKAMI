// Global, dependency-free activity bus. Anywhere a process produces output "on
// the project" (any terminal/run/build), the stream handler calls pulseActivity();
// the header ActivityWave subscribes and rides the pulses. A module singleton so
// there's no prop-drilling a callback through the whole terminal tree.

type Listener = (bytes: number) => void;

const listeners = new Set<Listener>();

/** Signal that a process just produced `bytes` of output. */
export function pulseActivity(bytes = 1): void {
  for (const listener of listeners) {
    try {
      listener(bytes);
    } catch {
      // A throwing subscriber must not stall the pulse for the others.
    }
  }
}

/** Subscribe to activity pulses. Returns an unsubscribe function. */
export function subscribeActivity(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
