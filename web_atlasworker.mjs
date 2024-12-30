// web_atlasworker.mjs :: entry point for "atlas worker".
// the atlas worker renders new atlasses in the background.
// the atlas is an image containing all the UI/text bitmap graphics required to
// run kor, including: font glyphs; blurred/scaled font glyphs (used for
// HDR/bloom); ...

const assert = (p,m) => { console.assert(p,m); if(!p) throw "ASSERTION FAILED"; }
const panic = (m) => { console.error(m); throw "PANIC"; }

class RectPack {
	constructor(width, height, num_nodes) {
		this.nodes = [];
		for (let i=0; i < num_nodes  ; ++i) this.nodes[i] = {x:0,y:0,next:null};
		for (let i=0; i < num_nodes-1; ++i) this.nodes[i].next = this.nodes[i+1];
		this.free_head = this.nodes[0];
		this.extra = [null,null];
		this.extra[1] = {
			x:width, y:null,
			next:null,
		};
		this.extra[0] = {
			x:0, y:0,
			next:this.extra[1],
		};
		this.active_head = this.extra[0];
		this.width = width;
		this.height = height;
		this.num_nodes = num_nodes;

		// JS implementation of "&" in C I guess :-)
		this.GettySetty = class {
			constructor(obj, field) {
				this.obj = obj;
				this.field = field;
			}

			get() {
				return this.obj[this.field];
			}

			set(new_value) {
				this.obj[this.field] = new_value;
			}
		}
	}

	_skyline_find_min_y(first, x0, width) {
		let node = first;
		const x1 = x0+width;
		ASSERT(first.x <= x0);
		ASSERT(node.next.x > x0);
		ASSERT(node.x <= x0);
		let min_y=0;
		while (node.x < x1) {
			ASSERT(node.y !== null);
			if (node.y > min_y) min_y = node.y;
			node = node.next;
		}
		return min_y;
	}

	_skyline_find_best_pos(width, height) {
		let best_y=null;

		// if it can't possibly fit, bail immediately
		if (width > this.width || height > this.height) return {prev_link:null};

		let node = this.active_head;
		let prev = new this.GettySetty(this, "active_head");
		let best = null;
		while ((node.x + width) <= this.width) {
			const y = this._skyline_find_min_y(node, node.x, width);
			if (best_y === null || y < best_y) {
				best_y = y;
				best = prev;
			}
			prev = new this.GettySetty(node, "next");
			node = node.next;
		}
		let best_x = (best === null) ? 0 : best.get().x;

		return { prev_link:best, x:best_x, y:best_y };
	}

	_skyline_pack_rectangle(width, height) {
		const res = this._skyline_find_best_pos(width, height);
		if (res.prev_link === null || res.y+height > this.height || this.free_head === null) {
			res.prev_link = null;
			return res;
		}

		let node = this.free_head;
		node.x = res.x;
		node.y = (res.y + height);
		this.free_head = node.next;

		// insert the new node into the right starting point, and
		// let 'cur' point to the remaining nodes needing to be
		// stiched back in

		let cur = res.prev_link.get();
		if (cur.x < res.x) {
			let next = cur.next;
			cur.next = node;
			cur = next;
		} else {
			res.prev_link.set(node);
		}

		// from here, traverse cur and free the nodes, until we get to one
		// that shouldn't be freed
		while (cur.next && cur.next.x <= res.x + width) {
			let next = cur.next;
			// move the current node to the free list
			cur.next = this.free_head;
			this.free_head = cur;
			cur = next;
		}

		// stitch the list back in
		node.next = cur;

		if (cur.x < res.x + width) {
			cur.x = (res.x + width);
		}

		const DEBUG = true; // XXX change to false at some point?
		if (DEBUG) {
			cur = this.active_head;
			while (cur.x < this.width) {
				ASSERT(cur.x < cur.next.x);
				cur = cur.next;
			}
			ASSERT(cur.next === null);
			{
				let count=0;
				cur = this.active_head;
				while (cur) {
					cur = cur.next;
					++count;
				}
				cur = this.free_head;
				while (cur) {
					cur = cur.next;
					++count;
				}
				ASSERT(count === this.num_nodes+2);
			}
		}

		return res;
	}

	pack(rects) {
		const num_rects = rects.length;

		// we use the 'was_packed' field internally to allow
		// sorting/unsorting
		for (let i=0; i < num_rects; ++i) rects[i].was_packed = i;

		// sort according to heuristic
		rects.sort((a,b) => ((a.h>b.h)?-1:(a.h<b.h)?1:(a.w>b.w)?-1:(a.w<b.w)?1:0));

		for (let r of rects) {
			if (r.w === 0 || r.h === 0) {
				r.x = r.y = 0;  // empty rect needs no space
			} else {
				const fr = this._skyline_pack_rectangle(r.w, r.h);
				if (fr.prev_link) {
					r.x = fr.x;
					r.y = fr.y;
				} else {
					r.x = r.y = null;
				}
			}
		}

		// unsort (restore original order)
		rects.sort((a,b) => (a.was_packed - b.was_packed));

		let all_rects_packed = true;
		for (let r of rects) {
			r.was_packed = (r.x !== null && r.y !== null);
			if (!r.was_packed) all_rects_packed = false;
		}
		return all_rects_packed;
	}
	// class RectPack is Public Domain (www.unlicense.org)
	// Port of stb_rect_pack.h to JavaScript by: Anders Kaare Straadt
	// (Only the default bottom-left/BL packer heuristic was ported; not the
	// best-fit/BF one; original C version by Sean T. Barrett)
}

class WASMMemory {
	constructor(initial_64k_page_count) {
		if (!initial_64k_page_count || initial_64k_page_count<2) initial_64k_page_count = 2;
		this._mem = new WebAssembly.Memory({ initial: initial_64k_page_count });
	}

	get_env_mem() { return this._mem; }

	grow(num_64k_pages) {
		const sz0 = this._mem.buffer.byteLength;
		if (num_64k_pages <= 0) return sz0;
		this._mem.grow(num_64k_pages);
		const sz1 = this._mem.buffer.byteLength;
		console.info(`wasm grow :: ${num_64k_pages}×64kB :: ${sz0}B -> ${sz1}B`);
		return sz1;
	}

	// unsafe_TYPEarr(base,n) returns an TypedArray view of the wasm memory;
	// type is determined by TYPE; `base` is the address of the first element
	// (in bytes); `n` is the length of the array. RE: "unsafe": if grow() is
	// called, the underlying ArrayBuffer of all views are /detached/; this
	// invalidates the view! it leads to bad bugs that are somewhat similar to
	// realloc()-bugs in C; the kind where you have pointers lying around that
	// occassionally get invalidated because realloc() returns a new pointer.
	// (XXX the underlying ArrayBuffer has a `detached` field that becomes
	// `true` when this happens; I'm unsure if this implies it actually makes
	// sense to "cache" the TypedArray? currently I'm assuming these views are
	// basically free to construct like in C)
	unsafe_u8arr(base,  n) { return new Uint8Array(this._mem.buffer, base, n); }
	unsafe_i8arr(base,  n) { return new Int8Array(this._mem.buffer, base, n); }
	unsafe_f32arr(base, n) { return new Float32Array(this._mem.buffer, base, n); }
	unsafe_u32arr(base, n) { return new Uint32Array(this._mem.buffer, base, n); }
	unsafe_i32arr(base, n) { return new Int32Array(this._mem.buffer, base, n); }

	get_f32(base,index)       { return this.unsafe_f32arr(base)[index]; }
	set_f32(base,index,value) { this.unsafe_f32arr(base)[index] = value; }

	// extract zero-terminated C string at `pointer` to UTF-8 string
	get_cstr(pointer) {
		const msg = this.unsafe_u8arr(pointer);
		let len=0;
		while (msg[len] !== 0) len++;
		return (new TextDecoder()).decode(msg.slice(0,len));
	}
}

let _font_face_serial = 0;
let _font_cache = {};
const FC_LOADING = 1;
const FC_READY   = 2;
const FC_FAILED  = 3; // XXX unused
const fetch_font = (url) => new Promise((resolve, reject) => {
	const c = _font_cache[url];
	if (c) {
		if (c[0] === FC_LOADING) {
			c[1].push([resolve,reject]);
		} else if (c[0] === FC_READY) {
			resolve(c[2]);
		} else {
			throw new Error("bad state");
		}
		return;
	}
	const face = "FontFace" + (++_font_face_serial);
	let fe = [
		FC_LOADING,
		[[resolve,reject]],
		face,
	];
	_font_cache[url] = fe;

	const ff = new FontFace(face, 'url(' + url + ')');
	ff.load().then(font => {
		if (globalThis.document) globalThis.document.fonts.add(font);
		if (globalThis.fonts) globalThis.fonts.add(font);
		for (const [fn,_] of fe[1]) fn(face);
	}).catch(err => {
		for (const [_,fn] of fe[1]) fn(err);
	});
});

const must_resolve_font_to_face = (font) => {
	if (font.source === "face") {
		return font.ref;
	} else if (font.source === "url") {
		const cf = _font_cache[font.ref];
		assert(cf, `expected cached font for url ${ref}`);
		assert(cf[0] === FC_READY, `font cache entry for url ${ref} not ready (st=${cf[0]})`);
		return cf[2];
	} else {
		panic(`unhandled font source: ${font.source}`);
	}
};

let wasm_program;

const API = {

make_atlas : (atlas_config) => new Promise((resolve,reject) => {
	let font_set = new Set();
	for (const d of [...atlas_config.terminal_font_set]) font_set.add(d);
	font_set = [...font_set.values()];
	font_set.sort();

	let promised_font_faces = [];
	for (const fd of font_set) {
		decode_font_identifier
	}
	/*
	const resolve_font_set = (font_set) => {
		for (const font of font_set) {
			if (font.source !== "url") continue;
			promised_font_faces.push(fetch_font(font.ref));
		}
	}
	resolve_font_set(atlas_config.terminal_font_set);
	*/

	let then_render_atlas; // forward declaration
	Promise.all(promised_font_faces).then(_ => {
		then_render_atlas();
	}).catch(reject);

	then_render_atlas = () => {
		// initial atlas dimensions; grows to accommodate the size requirements
		// (the ideal initial values are probably slightly lower than the
		// average? idk)
		let atlas_width_log2 = 7;
		let atlas_height_log2 = 7;

		let canvas = new OffscreenCanvas(1<<atlas_width_log2, 1<<atlas_height_log2);
		let ctx = canvas.getContext("2d");

		//const font_desc = font.size + "px " + face;
		//ctx.font = font_desc;

		let rects = [];

		for (const [font_id, font_face] of font_pairs) {
			// XXX RE: "try_stupid_hack_for_missing_glyph_detection": Like,
			// wouldn't it be nice if in JS you had access to features already
			// present in your browser? In general? Your browser definitely knows
			// when a glyph is missing (mine shows a box with the codepoint in hex
			// inside) but despite having a Font Loading API and canvas's
			// measureText() there's no "official" (or reliable) way to detect
			// whether a codepoint glyph exists in a font. FontFace has a
			// "unicodeRange" field but it's always "U+0-10FFFF" (so utterly
			// useless). But maybe writing my own WOFF2 font parser isn't so hard?
			// Lets find out... oh it's only ~1k lines of JS and it requires a
			// Brotli decompressor; cool! My browser has one! Except... it's not
			// available in JS! SEE A PATTERN HERE? I'm already pulling in a WASM
			// image scaler! Browsers have excellent image scalers (judging by
			// zooming out) but the only one that's available to you is the canvas
			// one (drawImage()) and downscaling gives ugly results in Firefox.

			// OK, long story short: the "stupid hack for missing glyph detection"
			// is to assume that missing glyph images share the same bounding box
			// and that no other glyph has the same bounding box. It seems to work,
			// but I'm not going to leave it on by default because it'll remove
			// "random" glyphs if they happen have the same bbox.

			let m0;
			if (font.try_stupid_hack_for_missing_glyph_detection) {
				// XXX assuming that codepoint=0 has no glyph
				m0 = ctx.measureText(String.fromCodePoint(0));
			}

			const num_hdr = font.hdr_config.length;
			let hdr_rects = [];
			let hdr_nfo = [];
			let passes = [];
			for (let i=0; i<num_hdr; ++i) {
				hdr_rects.push([]);
				hdr_nfo.push({});
				const cfg = font.hdr_config[i] || {
					post_multiplier: 1,
				};
				passes.push({
					post_multiplier: cfg.post_multiplier || 1,
				});
			}

			const mW = ctx.measureText("W");

			// go through requested codepoint ranges. extract glyph info via
			// canvas.

			let cp_src_rect_map = {};
			let cp_dst_rects_map = {};
			let cps = [];
			let lookup = {};
			for (const [cp0,cp1] of font.codepoint_ranges) {
				for (let cp=cp0; cp<=cp1; ++cp) {
					const m = cp < 0 ? mW : ctx.measureText(String.fromCodePoint(cp));

					let left = m.actualBoundingBoxLeft;
					let right = m.actualBoundingBoxRight;
					let ascent = m.actualBoundingBoxAscent;
					let descent = m.actualBoundingBoxDescent;
					let w = right+left;
					let h = ascent+descent;
					if (w === 0 || h === 0) continue;

					cps.push(cp);

					if (
						font.try_stupid_hack_for_missing_glyph_detection &&
						left === m0.actualBoundingBoxLeft &&
						right === m0.actualBoundingBoxRight &&
						ascent === m0.actualBoundingBoxAscent &&
						descent === m0.actualBoundingBoxDescent
					) continue;

					for (let hdr_index=0; hdr_index<num_hdr; ++hdr_index) {
						let hdr = font.hdr_config[hdr_index];
						let render_glyph = false;
						let inner_width,inner_height;
						if (hdr === null) {
							render_glyph = true;
							hdr_nfo[hdr_index] = undefined;
							inner_width = w;
							inner_height = h;
						} else {
							const s = hdr.scale;
							const r = hdr.blur_radius;
							const blurpx = Math.ceil(r*s);
							inner_width = Math.ceil(w*s);
							inner_height = Math.ceil(h*s);
							w = inner_width + 2*blurpx;
							h = inner_height + 2*blurpx;
							let nfo = hdr_nfo[hdr_index];
							nfo.blurpx = blurpx;
							if (nfo.max_width  === undefined || w > nfo.max_width)  nfo.max_width  = w;
							if (nfo.max_height === undefined || h > nfo.max_height) nfo.max_height = h;
						}
						if (lookup[cp] === undefined) {
							let a = [];
							for (let i=0; i<num_hdr; ++i) a[i]=null;
							lookup[cp] = a;
						}
						lookup[cp][hdr_index] = {
							// XXX these are not needed, but dx/dy are? can I
							// calculate those here?
							//inner_width,
							//inner_height,
						};
						const rect = { cp, hdr_index, render_glyph, left, right, ascent, descent, w, h };
						rects.push(rect);
						hdr_rects[hdr_index].push(rect);
						if (hdr === null) {
							assert(cp_src_rect_map[cp] === undefined);
							cp_src_rect_map[cp] = rect;
						} else {
							if (cp_dst_rects_map[cp] === undefined) cp_dst_rects_map[cp] = [];
							cp_dst_rects_map[cp].push(rect);
						}
					}
				}
			}
			cps.sort();
		}


		for (;;) {
			let w = 1 << atlas_width_log2;
			let h = 1 << atlas_height_log2;
			let rp = new RectPack(w,h,w);
			if (rp.pack(rects)) {
				break;
			} else {
				// RectPack was unable to pack all rects; double the atlas area
				// and try again; prefer width over height (better for debug
				// display I suppose because displays are wider than they're
				// tall, but I'm not sure if it's better for packing? although
				// I suspect it may be due to glyph dimensions and/or packing
				// direction?)
				if (atlas_height_log2 >= atlas_width_log2) {
					atlas_width_log2++;
				} else {
					atlas_height_log2++;
				}
			}
		}

		// XXX I'm not sure what I'm doing here is for the best:
		//  - I'm trying to determine a good height (actually line spacing) for
		//    the font
		//  - (mW.actualBoundingBoxAscent+mW.actualBoundingBoxDescent) isn't
		//    tall enough (glyphs overlap)
		//  - (mW.fontBoundingBoxAscent+mW.fontBoundingBoxDescent) seems a bit
		//    too tall (but glyphs never overlap)
		//  - so here I'm finding the extremes of
		//    actualBoundingBoxAscent/Descent for a couple of chars that goes
		//    above and below the base area... what could possibly go wrong!
		const good_ones = ["j","l","]","|"].map(x=>ctx.measureText(x));
		const common_ascent  = Math.max(...good_ones.map(x=>x.actualBoundingBoxAscent))
		const common_descent = Math.max(...good_ones.map(x=>x.actualBoundingBoxDescent))

		for (const rect of rects) {
			const lu = lookup[rect.cp][rect.hdr_index];
			lu.u = rect.x;
			lu.v = rect.y;
			lu.w = rect.w;
			lu.h = rect.h;
		}

		for (const rect of rects) {
			if (rect.hdr_index !== 0) continue;
			const lu = lookup[rect.cp][0];
			lu.dx = lu.dy = 0;
			if (rect.left)   lu.dx = -rect.left;
			if (rect.ascent) lu.dy = -rect.ascent + common_ascent;
			lu.w2=lu.w;
			lu.h2=lu.h;
		}

		for (const rect of rects) {
			if (rect.hdr_index === 0) continue;
			const lu0 = lookup[rect.cp][0];
			const lu = lookup[rect.cp][rect.hdr_index];

			const p = font.hdr_config[rect.hdr_index].blur_radius;
			//const p = hdr_nfo[rect.hdr_index].blurpx;
			const p2 = 2*p;
			lu.dx = lu0.dx-p;
			lu.dy = lu0.dy-p;
			lu.w2 = lu0.w2+p2;
			lu.h2 = lu0.h2+p2;
		}

		const width  = canvas.width  = 1<<atlas_width_log2;
		const height = canvas.height = 1<<atlas_height_log2;

		const DEBUG = false;

		ctx.clearRect(0,0,width,height);
		//ctx.font = font_desc; // XXX
		if (DEBUG) {
			ctx.fillStyle = '#000';
			ctx.fillRect(0,0,width,height);
		}

		for (const r of rects) {
			if (DEBUG) {
				ctx.fillStyle = '#' + (2+Math.random()*2|0) + (2+Math.random()*2|0) + (2+Math.random()*2|0);
				ctx.fillRect(r.x, r.y, r.w, r.h);
			}
			ctx.fillStyle = '#fff';
			if (r.render_glyph) {
				if (r.cp >= 0) {
					ctx.fillText(String.fromCodePoint(r.cp), r.x+r.left, r.y+r.ascent);
				} else if (r.cp === CUSTOM_CODEPOINT_BOX) {
					ctx.fillRect(r.x, r.y, r.w, r.h);
				} else {
					panic(`unhandled codepoint ${r.cp}`);
				}
			}
		}

		let max_num_rects = 0;
		let ser2rectpair = [];
		{
			let k2ser = {};
			let next_ser = 0;
			for (const cp of cps) {
				const src_rect = cp_src_rect_map[cp];
				assert(src_rect);
				for (const dst_rect of cp_dst_rects_map[cp]) {
					const blurpx2 = 2*hdr_nfo[dst_rect.hdr_index].blurpx;
					const dw = dst_rect.w - blurpx2;
					const dh = dst_rect.h - blurpx2;
					const k = src_rect.w+"x"+src_rect.h+">"+dw+"x"+dh+"s"+(font.hdr_config[dst_rect.hdr_index].scale.toFixed(4));
					let ser = k2ser[k];
					if (ser === undefined) {
						ser = k2ser[k] = (next_ser++);
						ser2rectpair[ser] = [];
					}
					ser2rectpair[ser].push([src_rect,dst_rect]);
					const n = ser2rectpair[ser].length;
					if (n > max_num_rects) max_num_rects = n;
				}
			}
		}

		const whusm = wasm_program.instance.exports;
		whusm.heap_reset();
		const num_pixels = width*height;
		const stride = width;
		const bitmap_baseptr = whusm.allocate_and_set_current_monochrome_bitmap(width, height);
		const io_ptrs_baseptr = whusm.heap_alloc_ptr(2*max_num_rects);

		{ // copy canvas bitmap to wasm memory
			let bitmap = wasm_memory.unsafe_u8arr(bitmap_baseptr, num_pixels);
			const canvas_bitmap = ctx.getImageData(0,0,width,height).data;
			for (let i=0; i<num_pixels; i++) {
				bitmap[i] = canvas_bitmap[i*4+3];
			}
		}

		for (const rectpairs of ser2rectpair) {
			const [s0,d0] = rectpairs[0];
			const num = rectpairs.length;

			const P = hdr_nfo[d0.hdr_index].blurpx;
			const P2 = 2*P;

			{
				let io_ptrs = wasm_memory.unsafe_u32arr(io_ptrs_baseptr, 2*max_num_rects);
				for (let i = 0; i < num; i++) {
					const [s,d] = rectpairs[i];
					const xy2p = (x,y) => bitmap_baseptr+x+y*stride;
					io_ptrs[i*2+0] = xy2p(s.x,s.y);
					io_ptrs[i*2+1] = xy2p(d.x+P, d.y+P);
				}
			}

			whusm.resize_multiple_monochrome_subbitmaps(
				num,
				s0.w, s0.h,
				d0.w-P2, d0.h-P2,
				font.hdr_config[d0.hdr_index].scale,
				io_ptrs_baseptr,
				stride);
		}
		for (let hdr_index=0; hdr_index<num_hdr; ++hdr_index) {
			let hdr = font.hdr_config[hdr_index];
			const nfo = hdr_nfo[hdr_index]
			if (!nfo) continue;
			whusm.heap_save();
			const n0 = nfo.blurpx;
			const n1 = n0*2+1;
			const fp = whusm.s2c_setup(n0, nfo.max_width, nfo.max_height);
			{
				let kernel = wasm_memory.unsafe_f32arr(fp, n1);
				for (let i = 0; i <= n0; i++) {
					const x = ((-n0+i)/n0)*3;
					const y = gaussian(hdr.blur_variance, x) * hdr.pre_multiplier;
					// XXX should the gaussian also be "windowed"? cosine,
					// kaiser-bessel, whatever?
					kernel[i] = y;
					kernel[n1-i-1] = y;
				}
			}
			for (const r of hdr_rects[hdr_index]) {
				whusm.s2c_execute(
					bitmap_baseptr + r.x + r.y*stride,
					r.w,
					r.h,
					stride
				);
			}
			whusm.heap_restore();
		}

		resolve({
			image: {
				data: wasm_memory.unsafe_u8arr(bitmap_baseptr, num_pixels),
				width,
				height,
			},
			glyphdim: {
				width:  mW.width,
				height: Math.round(common_ascent + common_descent),
			},
			passes,
			lookup,
		});
	};
}),

};

// worker message handler / rpc
addEventListener("message", (message) => {
	const { serial, fn, args } = message.data;
	let ff = API[fn];
	if (ff) {
		ff(...args).then((result, transfer) => {
			postMessage({
				serial,
				ok:true,
				result,
			}, transfer);
		}).catch(error => {
			console.error(error);
			postMessage({
				serial,
				error: error.message + "\n" + error.stack,
			});
		});
	} else {
		postMessage({
			serial,
			error: "no such function: " + fn,
		});
	}
});

// simple fetch() wrapper for GETs that also promotes status>=400 to reject()'d
// promise
const GET = (url) => new Promise((resolve,reject) => {
	fetch(url).then((response) => {
		if (response.status >= 400) {
			response.text().then((body) => {
				reject(`GET ${url} => ${response.status} / ${body}`);
			}).catch((error) => {
				reject(`GET ${url} => ${response.status} ?? ${error}`);
			});
			return;
		}
		resolve(response);
	}).catch((error) => {
		reject(`GET ${url} => ERR/FETCH ${error}`);
	});
});

const wasm_memory = new WASMMemory();
const cstr = (ptr) => wasm_memory.get_cstr(ptr);
const wasm_promise = WebAssembly.instantiateStreaming(GET("./atlasworker_c.wasm"), { // XXX:URLHARDCODED
	env: {
		memory: wasm_memory.get_env_mem(),
		js_print: function(message_pointer) {
			console.info("[WASM] " + cstr(message_pointer));
		},
		js_panic: function(message_pointer) {
			const msg = cstr(message_pointer);
			console.error(msg);
			throw new Error("[WASM PANIC] " + msg);
		},
		js_grow_memory: function(num_64k_pages) {
			return wasm_memory.grow(num_64k_pages);
		}
	},
});

wasm_promise.then(r => {
	wasm_program = r;
	console.log("what.wasm :: " + Object.keys(r.instance.exports).join(" "));
	postMessage({status:"READY"});
}).catch(error => {
	postMessage({status:"ERROR",error});
});
