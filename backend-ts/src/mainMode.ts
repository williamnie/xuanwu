export function commandMode(args: string[]): { serve: boolean; args: string[] } {
  if (args.length === 0 || args[0]?.startsWith("-")) return { serve: true, args };
  if (args[0] === "serve") return { serve: true, args: args.slice(1) };
  return { serve: false, args };
}
