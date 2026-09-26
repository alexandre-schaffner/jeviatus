// Start a server on PORT, or on the first free port from 3000.
export function serveOnFreePort(options: Omit<Parameters<typeof Bun.serve>[0], "port">): ReturnType<typeof Bun.serve> {
  const wanted = process.env.PORT ? [Number(process.env.PORT)] : Array.from({ length: 20 }, (_, i) => 3000 + i);
  for (const port of wanted) {
    try {
      return Bun.serve({ ...options, port } as Parameters<typeof Bun.serve>[0]);
    } catch (err) {
      if ((err as { code?: string }).code !== "EADDRINUSE") throw err;
      if (wanted.length === 1) throw new Error(`Port ${port} is in use; pick another with PORT=…`);
    }
  }
  throw new Error(`Ports ${wanted[0]}–${wanted.at(-1)} are all in use; pick one with PORT=…`);
}
