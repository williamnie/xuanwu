export function commandMode(args: string[]): { serve: boolean; args: string[]; version: boolean } {
  if (args.length === 1 && args[0] === "--version") return { serve: false, args: [], version: true };
  if (args.length === 0 || args[0]?.startsWith("-")) return { serve: true, args, version: false };
  if (args[0] === "serve") return { serve: true, args: args.slice(1), version: false };
  return { serve: false, args, version: false };
}
