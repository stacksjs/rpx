declare module 'picocolors' {
  interface Colors {
    cyan: (s: string) => string
    bold: (s: string) => string
    green: (s: string) => string
    dim: (s: string) => string
    red: (s: string) => string
    yellow: (s: string) => string
    white: (s: string) => string
    gray: (s: string) => string
    [key: string]: (s: string) => string
  }
  const colors: Colors
  export default colors
}
