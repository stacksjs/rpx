const c = (open: number, close: number): (str: string) => string => (str: string): string => `\x1B[${open}m${str}\x1B[${close}m`

export const colors: {
  bold: (str: string) => string
  dim: (str: string) => string
  green: (str: string) => string
  cyan: (str: string) => string
} = {
  bold: c(1, 22),
  dim: c(2, 22),
  green: c(32, 39),
  cyan: c(36, 39),
}
