export type ListenAddress = { hostname: string; port: number };

export function parseListenAddress(addr: string): ListenAddress {
  const trimmed = addr.trim();
  const separator = trimmed.lastIndexOf(":");
  if (separator <= 0) throw new Error(`Invalid listen address: ${addr}`);
  const hostname = trimmed.slice(0, separator);
  const port = Number(trimmed.slice(separator + 1));
  if (!Number.isInteger(port) || port <= 0) throw new Error(`Invalid listen port: ${addr}`);
  return { hostname, port };
}
