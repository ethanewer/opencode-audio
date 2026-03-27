export const logo = (() => {
  const glyph = {
    o: ["    ", "█▀▀█", "█__█", "▀▀▀▀"],
    p: ["    ", "█▀▀█", "█__█", "█▀▀▀"],
    e: ["    ", "█▀▀█", "█^^^", "▀▀▀▀"],
    n: ["    ", "█▀▀▄", "█__█", "▀~~▀"],
    c: ["    ", "█▀▀▀", "█___", "▀▀▀▀"],
    d: ["   ▄", "█▀▀█", "█__█", "▀▀▀▀"],
    dash: ["    ", "    ", "▀▀▀▀", "    "],
    a: ["    ", "▀▀▀█", "█^^█", "▀▀▀▀"],
    u: ["    ", "█  █", "█__█", "▀▀▀▀"],
    i: [" ", "▀", "█", "▀"],
  }
  const join = (list: string[][]) => [0, 1, 2, 3].map((i) => list.map((x) => x[i]).join(" "))
  const left = join([glyph.o, glyph.p, glyph.e, glyph.n, glyph.c, glyph.o, glyph.d, glyph.e])
  const right = join([glyph.dash, glyph.a, glyph.u, glyph.d, glyph.i, glyph.o])
  const max = (rows: string[]) => Math.max(...rows.map((r) => [...r].length))
  const pad = (rows: string[]) => {
    const m = max(rows)
    return rows.map((r) => r + " ".repeat(m - [...r].length))
  }
  return { left: pad(left), right: pad(right) }
})()

export const marks = "_^~"
