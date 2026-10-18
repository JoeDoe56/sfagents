/** Minimal ANSI styling; disabled when the stream is not a TTY or NO_COLOR is set. */

export interface Style {
  dim(s: string): string;
  bold(s: string): string;
  red(s: string): string;
  green(s: string): string;
  yellow(s: string): string;
  cyan(s: string): string;
  magenta(s: string): string;
}

export function createStyle(stream: NodeJS.WriteStream | NodeJS.WritableStream): Style {
  const enabled =
    (stream as NodeJS.WriteStream).isTTY === true &&
    process.env['NO_COLOR'] === undefined &&
    process.env['TERM'] !== 'dumb';
  const wrap = (open: number, close: number) => (s: string) => (enabled ? `\u001b[${open}m${s}\u001b[${close}m` : s);
  return {
    dim: wrap(2, 22),
    bold: wrap(1, 22),
    red: wrap(31, 39),
    green: wrap(32, 39),
    yellow: wrap(33, 39),
    cyan: wrap(36, 39),
    magenta: wrap(35, 39),
  };
}
