/**
 * Ordered admission gates for the `/api` transport. A gate decides whether one
 * request may proceed and whether it may reach a privileged method; Connection
 * runs the registry and holds no policy of its own.
 *
 * @module @deepseek-ai/dsh-client-connection/gates
 */

/** One request presented to the gates. */
export interface ApiGateRequest {
  /** Carrier the request arrived on. */
  readonly transport: 'http' | 'websocket'
  /** RPC method for an `/api/<method>` request; absent for an upgrade. */
  readonly method?: string
  /** Request headers, already folded to a `Headers` instance. */
  readonly headers: Headers
}

/** One gate's verdict on one request. */
export type ApiGateDecision =
  | { readonly allow: true; readonly principal: string; readonly privileged: boolean }
  | { readonly allow: false; readonly status: 401 | 403; readonly reason: string }

/** An admission gate contributed by a plugin. */
export interface ApiRequestGate {
  /** Ascending run order; a duplicate order is a registration error. */
  readonly order: number
  /**
   * Decide whether this request may proceed.
   * @param request - the request under consideration.
   * @returns the gate's decision; a rejected promise denies with 403.
   */
  authorize(request: ApiGateRequest): Promise<ApiGateDecision>
}

/** The registry's aggregate verdict over every registered gate. */
export type ApiGateVerdict =
  | { readonly admitted: true; readonly principals: readonly string[]; readonly privileged: boolean }
  | { readonly admitted: false; readonly status: 401 | 403; readonly reason: string }

/**
 * Fold a Node header map into `Headers`, joining repeated values the way the
 * Fetch carrier does.
 * @param raw - `IncomingMessage.headers`.
 * @returns an equivalent `Headers` instance.
 */
export function headersOf(raw: Readonly<Record<string, string | string[] | undefined>>): Headers {
  const headers = new Headers()
  for (const [name, value] of Object.entries(raw)) {
    if (value === undefined) continue
    headers.set(name, Array.isArray(value) ? value.join(', ') : value)
  }
  return headers
}

/**
 * Ordered set of admission gates. An empty registry admits every request with
 * full privilege, which is the behavior of a composition that registers none.
 */
export class ApiGateRegistry {
  private readonly gates = new Map<number, ApiRequestGate>()

  /**
   * Register one gate.
   * @param gate - the gate to consult, ordered by its `order`.
   * @returns the disposer releasing this registration.
   */
  register(gate: ApiRequestGate): () => void {
    if (this.gates.has(gate.order)) {
      throw new Error(`connection: an API gate is already registered at order ${gate.order}`)
    }
    this.gates.set(gate.order, gate)
    return () => { this.gates.delete(gate.order) }
  }

  /**
   * Run every gate in ascending order until one denies.
   * @param request - the request under consideration.
   * @returns the aggregate verdict; privilege is the conjunction of every allowing decision.
   */
  async authorize(request: ApiGateRequest): Promise<ApiGateVerdict> {
    const principals: string[] = []
    let privileged = true
    for (const [, gate] of [...this.gates.entries()].sort(([left], [right]) => left - right)) {
      let decision: ApiGateDecision
      try {
        decision = await gate.authorize(request)
      } catch {
        // A gate that fails open would defeat its purpose, so any throw denies
        // with 403. The thrown cause is discarded, not logged: this registry
        // has no logging channel of its own, and surfacing gate internals in
        // the denial reason would leak them to the caller that triggered it.
        return { admitted: false, status: 403, reason: 'gate failed' }
      }
      if (!decision.allow) return { admitted: false, status: decision.status, reason: decision.reason }
      principals.push(decision.principal)
      privileged &&= decision.privileged
    }
    return { admitted: true, principals, privileged }
  }
}
