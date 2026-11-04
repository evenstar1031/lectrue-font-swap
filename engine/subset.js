// HarfBuzz hb-subset(WebAssembly)으로 글꼴을 필요한 글자만 남겨 줄인다. 글리프 번호는 그대로 유지(retain-gids).
let hb = null;

export async function initSubsetter(wasmSource) {
  if (hb) return hb;
  let mod;
  if (wasmSource instanceof Uint8Array || wasmSource instanceof ArrayBuffer) mod = await WebAssembly.instantiate(wasmSource, {});
  else if (typeof WebAssembly.instantiateStreaming === 'function') {
    try { mod = await WebAssembly.instantiateStreaming(fetch(wasmSource), {}); }
    catch (e) { mod = await WebAssembly.instantiate(await (await fetch(wasmSource)).arrayBuffer(), {}); }
  } else mod = await WebAssembly.instantiate(await (await fetch(wasmSource)).arrayBuffer(), {});
  hb = mod.instance.exports;
  if (hb._initialize) hb._initialize();
  return hb;
}

const FLAG_NO_HINTING = 0x1;
const FLAG_RETAIN_GIDS = 0x2;

/**
 * @param {Uint8Array} fontBytes
 * @param {Iterable<number>} unicodes
 * @param {Iterable<number>} gids
 * @returns {Uint8Array|null}
 */
export function subsetFont(fontBytes, unicodes, gids) {
  if (!hb) throw new Error('subsetter not ready');
  const ptr = hb.malloc(fontBytes.byteLength);
  new Uint8Array(hb.memory.buffer).set(fontBytes, ptr);
  const blob = hb.hb_blob_create(ptr, fontBytes.byteLength, 2 /* writable */, 0, 0);
  const face = hb.hb_face_create(blob, 0);
  hb.hb_blob_destroy(blob);
  const input = hb.hb_subset_input_create_or_fail();
  let out = null;
  try {
    const us = hb.hb_subset_input_unicode_set(input);
    for (const u of unicodes) hb.hb_set_add(us, u);
    const gs = hb.hb_subset_input_glyph_set(input);
    hb.hb_set_add(gs, 0);
    for (const g of gids) hb.hb_set_add(gs, g);
    hb.hb_subset_input_set_flags(input, FLAG_RETAIN_GIDS | FLAG_NO_HINTING);
    const sub = hb.hb_subset_or_fail(face, input);
    if (sub) {
      const rblob = hb.hb_face_reference_blob(sub);
      const off = hb.hb_blob_get_data(rblob, 0);
      const len = hb.hb_blob_get_length(rblob);
      if (len > 0) out = new Uint8Array(hb.memory.buffer, off, len).slice();
      hb.hb_blob_destroy(rblob);
      hb.hb_face_destroy(sub);
    }
  } finally {
    hb.hb_subset_input_destroy(input);
    hb.hb_face_destroy(face);
    hb.free(ptr);
  }
  return out;
}
