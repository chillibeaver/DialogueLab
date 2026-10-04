/**
 * Stands in for the runtime's `cloudflare:workers` module under Node, so the
 * real Durable Object classes can be tested with a fake storage.
 */
export class DurableObject<Env = unknown> {
  constructor(
    protected ctx: DurableObjectState,
    protected env: Env,
  ) {}
}
