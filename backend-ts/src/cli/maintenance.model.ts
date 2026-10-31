

export type Flags = Record<string, string>;

export type Report = Record<string, unknown>;

export type Command = { flags: string[]; run: (flags: Flags) => Report };
