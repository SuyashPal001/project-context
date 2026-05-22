import type { ServerResponse } from 'http';
import type { ProviderAdapter } from './adapters/base';
import { AdapterError } from './adapters/base';
import type { OpenAIRequest } from './types';

type State = 'closed' | 'open' | 'half-open';

interface CircuitBreakerOptions {
  failureThreshold: number;
  resetTimeoutMs: number;
}

/**
 * Tracks consecutive failures per adapter. After `failureThreshold` failures
 * the circuit opens and all requests skip this adapter immediately (no wait).
 * After `resetTimeoutMs` the circuit moves to half-open — one probe request is
 * allowed through. Success closes it; failure re-opens it.
 */
export class CircuitBreaker {
  readonly name: string;
  private state: State = 'closed';
  private failures = 0;
  private openedAt: number | null = null;
  private readonly threshold: number;
  private readonly resetTimeout: number;

  constructor(name: string, opts?: Partial<CircuitBreakerOptions>) {
    this.name = name;
    this.threshold = opts?.failureThreshold ?? 3;
    this.resetTimeout = opts?.resetTimeoutMs ?? 60_000;
  }

  isAvailable(): boolean {
    if (this.state === 'closed') return true;
    if (this.state === 'open') {
      if (Date.now() - this.openedAt! >= this.resetTimeout) {
        this.state = 'half-open';
        console.log(`[circuit-breaker] ${this.name} → half-open (probing)`);
        return true;
      }
      return false;
    }
    return true; // half-open: let one through
  }

  onSuccess(): void {
    if (this.state !== 'closed') {
      console.log(`[circuit-breaker] ${this.name} → closed (recovered)`);
    }
    this.state = 'closed';
    this.failures = 0;
    this.openedAt = null;
  }

  onFailure(): void {
    this.failures++;
    if (this.state === 'half-open' || this.failures >= this.threshold) {
      this.state = 'open';
      this.openedAt = Date.now();
      console.warn(`[circuit-breaker] ${this.name} → open after ${this.failures} failure(s)`);
    }
  }

  getStatus(): { state: State; failures: number; openedAt: number | null } {
    return { state: this.state, failures: this.failures, openedAt: this.openedAt };
  }
}

/**
 * Wraps a ProviderAdapter with a circuit breaker.
 * Throws AdapterError immediately when the circuit is open — no network call made.
 */
export class CircuitBreakerAdapter implements ProviderAdapter {
  constructor(
    private readonly inner: ProviderAdapter,
    private readonly breaker: CircuitBreaker,
  ) {}

  async handleCompletion(req: OpenAIRequest, res: ServerResponse): Promise<void> {
    if (!this.breaker.isAvailable()) {
      throw new AdapterError(503, `${this.breaker.name} circuit open — skipping to next adapter`);
    }
    try {
      await this.inner.handleCompletion(req, res);
      this.breaker.onSuccess();
    } catch (err) {
      this.breaker.onFailure();
      throw err;
    }
  }
}
