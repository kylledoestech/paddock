// Renders the Paddock icon (same shapes as public/icons/icon.svg) to PNG with no image deps.
// Run: node scripts/gen-icons.mjs
import { writeFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'

const BG = [0x0e, 0x0f, 0x11]
const RING = [0xe8, 0xe6, 0xe1]
const DOT = [0xe0, 0xa8, 0x4e]

function crc32(buf) {
  let c = ~0
  for (const b of buf) {
    c ^= b
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
  }
  return ~c >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}

// Full-bleed background so the same file works as a maskable icon.
function render(size) {
  const s = size / 512
  const raw = Buffer.alloc(size * (size * 4 + 1))
  const samples = 4
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0
    for (let x = 0; x < size; x++) {
      let acc = [0, 0, 0]
      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const px = (x + (sx + 0.5) / samples) / s
          const py = (y + (sy + 0.5) / samples) / s
          let c = BG
          const r = Math.hypot(px - 256, py - 256)
          if (Math.abs(r - 120) <= 14) c = RING
          if (Math.hypot(px - 316, py - 226) <= 18) c = DOT
          acc = acc.map((v, i) => v + c[i])
        }
      }
      const o = y * (size * 4 + 1) + 1 + x * 4
      const n = samples * samples
      raw[o] = acc[0] / n
      raw[o + 1] = acc[1] / n
      raw[o + 2] = acc[2] / n
      raw[o + 3] = 255
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

for (const size of [192, 512]) {
  writeFileSync(new URL(`../public/icons/icon-${size}.png`, import.meta.url), render(size))
}
