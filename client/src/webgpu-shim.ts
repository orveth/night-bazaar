/**
 * WebGPU constant-enum shim — MUST be the first import of the entry module.
 *
 * In INSECURE contexts (plain http on a tailnet IP, exactly how the bazaar
 * is served) the browser defines none of the WebGPU globals, and
 * `three.webgpu.js` reads `GPUShaderStage.VERTEX` etc. at module scope —
 * without this shim the whole bundle throws on load and the page is black.
 * (On localhost it works by accident: localhost is a secure context, so the
 * enums exist even when no adapter does.)
 *
 * Values are the WebGPU spec constants. Defining them never enables WebGPU;
 * `navigator.gpu` stays absent and the renderer takes its WebGL2 fallback.
 */

const g = globalThis as Record<string, unknown>;

g.GPUShaderStage ??= { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 };
g.GPUBufferUsage ??= {
  MAP_READ: 0x0001,
  MAP_WRITE: 0x0002,
  COPY_SRC: 0x0004,
  COPY_DST: 0x0008,
  INDEX: 0x0010,
  VERTEX: 0x0020,
  UNIFORM: 0x0040,
  STORAGE: 0x0080,
  INDIRECT: 0x0100,
  QUERY_RESOLVE: 0x0200,
};
g.GPUTextureUsage ??= {
  COPY_SRC: 0x01,
  COPY_DST: 0x02,
  TEXTURE_BINDING: 0x04,
  STORAGE_BINDING: 0x08,
  STORAGE: 0x08, // legacy alias three still touches
  RENDER_ATTACHMENT: 0x10,
};
g.GPUMapMode ??= { READ: 0x1, WRITE: 0x2 };
g.GPUColorWrite ??= { RED: 0x1, GREEN: 0x2, BLUE: 0x4, ALPHA: 0x8, ALL: 0xf };

export {};
