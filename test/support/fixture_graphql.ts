// In-process fixture GraphQL server (real HTTP via Bun.serve). Answers every POST
// with {data: payload} (+ optional errors), records request bodies. Ports the Python
// JsonGraphQLServer so the real GraphQLHttpTool(url) can drive it unchanged.

export class FixtureGraphQLServer {
  private readonly server: ReturnType<typeof Bun.serve>;
  readonly url: string;
  readonly requests: unknown[] = [];

  constructor(payload: Record<string, unknown>, errors: Record<string, unknown>[] = []) {
    const requests = this.requests;
    this.server = Bun.serve({
      port: 0,
      async fetch(req) {
        try {
          requests.push(await req.json());
        } catch {
          requests.push(null);
        }
        const body: Record<string, unknown> = { data: payload };
        if (errors.length > 0) body.errors = errors;
        return Response.json(body);
      },
    });
    this.url = `http://127.0.0.1:${this.server.port}/graphql`;
  }

  close(): void {
    this.server.stop(true);
  }
}
